// Contract-enforcement experiment: the trusted host half, as production builds it.
//
// This process imports the OpenClaw Agent Browser plugin's own compiled modules
// (built from openclaw-agent-browser/src into a private directory by
// harness/build.py) and drives the real `AgentBrowserBackend` — page operations,
// `ExecutionService.start`, the preflight `revalidate`, the `ExecutionBridge` /
// `ChildBridge` framing, the `ToolBroker` and `completeWithBoundModel` — over a
// private JSON-lines RPC from the Python harness.
//
// Only the seams the plugin already exposes for its own tests are substituted:
//
//   BackendOptions.transport           -> the control plane, in the Python harness
//                                         process (agentpkg.browser.server.BrowserAPI)
//   BackendOptions.supervisor          -> a supervisor that reports "running"
//   BackendOptions.modelHost.browse    -> the case's OpenClaw catalog rows
//   BackendOptions.llm                 -> the synthetic provider in the Python harness
//   createExecutionBridge              -> the real ExecutionBridge, whose spawnImpl
//                                         returns a child whose stdio is the
//                                         in-process agentpkg runner in the harness
//   toolDefinitions / toolTransport    -> the built-in bindings; a recording
//                                         transport that reaches synthetic services
//   pdfReader                          -> a recording parser of synthetic PDFs
//
// node:dns.lookup is replaced by a recording resolver, and every other way out
// of the process (sockets, TLS, HTTP(S), fetch, child processes) is refused and
// counted. Paths the case declares sensitive are refused and counted on open.
//
// Usage: node host_helper.mjs <build-dir>
// Experiment-only. Never part of the plugin.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, resolve as resolvePath } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const BUILD = resolvePath(process.argv[2] ?? "");
const DIST = join(BUILD, "dist");

// -- RPC ----------------------------------------------------------------------
let nextId = 1;
const pending = new Map();
const requestHandlers = new Map();
const notificationHandlers = new Map();
const realStdoutWrite = process.stdout.write.bind(process.stdout);
// stdout is the RPC channel and nothing else writes to it: anything a module
// prints goes to stderr, so a stray log line can never be read as a frame.
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
for (const name of ["log", "info", "warn", "debug", "trace"]) {
  console[name] = (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`);
}

function send(message) {
  realStdoutWrite(`${JSON.stringify(message)}\n`);
}

function call(method, params = {}) {
  const id = `js-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: "req", id, m: method, p: params });
  });
}

function notify(method, params = {}) {
  send({ t: "ntf", m: method, p: params });
}

function errorJson(error) {
  if (error && typeof error === "object") {
    return {
      code: String(error.code ?? error.name ?? "helper_error"),
      message: String(error.message ?? error),
      data: error.data ?? null,
    };
  }
  return { code: "helper_error", message: String(error), data: null };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) onLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function onLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("host_helper: unparsable line\n");
    return;
  }
  if (message.t === "res") {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.r);
    else {
      const error = new Error(message.e?.message ?? "rpc error");
      error.code = message.e?.code ?? "rpc_error";
      error.data = message.e?.data ?? null;
      waiter.reject(error);
    }
  } else if (message.t === "req") {
    const handler = requestHandlers.get(message.m);
    Promise.resolve()
      .then(() => {
        if (!handler) throw Object.assign(new Error(`no handler ${message.m}`), { code: "rpc_unknown_method" });
        return handler(message.p ?? {});
      })
      .then(
        (result) => send({ t: "res", id: message.id, ok: true, r: result ?? null }),
        (error) => send({ t: "res", id: message.id, ok: false, e: errorJson(error) }),
      );
  } else if (message.t === "ntf") {
    const handler = notificationHandlers.get(message.m);
    if (handler) {
      try {
        handler(message.p ?? {});
      } catch (error) {
        process.stderr.write(`host_helper: notification ${message.m} failed: ${error}\n`);
      }
    }
  }
}

// -- guards and canaries -------------------------------------------------------
const guard = {
  refused: [],
  dnsLookups: [],
  fsOpens: [],
  fsSensitive: [],
  sensitive: [],
};

function refuse(kind, detail) {
  guard.refused.push({ kind, detail: String(detail).slice(0, 300) });
  const error = new Error(`contract_enforcement experiment refused ${kind}`);
  error.code = "EXPERIMENT_GUARD";
  throw error;
}

function describeTarget(args) {
  const first = args[0];
  if (first && typeof first === "object") return String(first.host ?? first.hostname ?? first.path ?? "?");
  return String(first);
}

const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const childProcess = require("node:child_process");
const dns = require("node:dns");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");

net.connect = (...args) => refuse("net.connect", describeTarget(args));
net.createConnection = (...args) => refuse("net.createConnection", describeTarget(args));
net.Socket.prototype.connect = function connect(...args) {
  return refuse("net.Socket.connect", describeTarget(args));
};
tls.connect = (...args) => refuse("tls.connect", describeTarget(args));
http.request = (...args) => refuse("http.request", describeTarget(args));
http.get = (...args) => refuse("http.get", describeTarget(args));
https.request = (...args) => refuse("https.request", describeTarget(args));
https.get = (...args) => refuse("https.get", describeTarget(args));
globalThis.fetch = async (...args) => refuse("fetch", describeTarget(args));
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = (...args) => refuse(`child_process.${name}`, describeTarget(args));
}

// The broker resolves a binding's hostname with node:dns before its address
// policy runs. The case answers instead of a resolver, and every question is
// recorded.
dns.lookup = (hostname, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  const all = typeof options === "object" && options !== null && options.all === true;
  guard.dnsLookups.push(String(hostname));
  call("net.resolve", { hostname: String(hostname) }).then(
    (answer) => {
      const addresses = (answer?.addresses ?? []).map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }));
      if (addresses.length === 0) {
        const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        error.code = "ENOTFOUND";
        done(error);
      } else if (all) done(null, addresses);
      else done(null, addresses[0].address, addresses[0].family);
    },
    (error) => done(error),
  );
};
for (const name of [
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCname",
  "resolveMx",
  "resolveNs",
  "resolveTxt",
  "reverse",
]) {
  dns[name] = (...args) => refuse(`dns.${name}`, describeTarget(args));
}
dns.promises.lookup = (...args) => refuse("dns.promises.lookup", describeTarget(args));

// Sensitive paths: configured per case by the harness (canary files and the
// classic secrets an attack string names). Every other open is recorded.
let sensitivePrefixes = [];
let sensitiveSubstrings = [];

function sensitive(path) {
  const text = String(path);
  let absolute;
  try {
    absolute = resolvePath(text);
  } catch {
    absolute = text;
  }
  return (
    sensitivePrefixes.some((prefix) => absolute.startsWith(prefix) || text.startsWith(prefix)) ||
    sensitiveSubstrings.some((needle) => text.includes(needle))
  );
}

function watchPath(kind, path) {
  if (typeof path !== "string" && !(path instanceof URL) && !Buffer.isBuffer(path)) return;
  const text = path instanceof URL ? path.pathname : String(path);
  if (guard.fsOpens.length < 2000) guard.fsOpens.push(text.slice(0, 300));
  if (sensitive(text)) {
    guard.fsSensitive.push({ kind, path: text.slice(0, 300) });
    refuse(kind, text);
  }
}

for (const [owner, names] of [
  [fs, ["openSync", "readFileSync", "createReadStream"]],
  [fsPromises, ["open", "readFile"]],
]) {
  for (const name of names) {
    const original = owner[name];
    owner[name] = function guarded(path, ...rest) {
      watchPath(`fs.${name}`, path);
      return original.call(this, path, ...rest);
    };
  }
}
{
  const originalOpen = fs.open;
  fs.open = function guarded(path, ...rest) {
    watchPath("fs.open", path);
    return originalOpen.call(this, path, ...rest);
  };
  const originalReadFile = fs.readFile;
  fs.readFile = function guarded(path, ...rest) {
    watchPath("fs.readFile", path);
    return originalReadFile.call(this, path, ...rest);
  };
}
syncBuiltinESMExports();

// -- the plugin's own modules ----------------------------------------------------
async function load(name) {
  return import(pathToFileURL(join(DIST, `${name}.js`)).href);
}
const backendModule = await load("backend");
const executionModule = await load("execution");
const bridgeModule = await load("execution-bridge");
const registryModule = await load("tool-registry");
const runManagerModule = await load("run-manager");
const toolBrokerModule = await load("tool-broker");

const { AgentBrowserBackend } = backendModule;
const { ExecutionService, resolvePolicy } = executionModule;
const { ExecutionBridge } = bridgeModule;
const { BUILT_IN_BINDINGS } = registryModule;
const { RunManager } = runManagerModule;
const { ToolBroker } = toolBrokerModule;

// Observation only: which directory a run was given, so the in-process runner
// can open the same one the real `execute` opened. Behaviour is unchanged.
const originalPrepareDirectory = RunManager.prototype.prepareDirectory;
RunManager.prototype.prepareDirectory = async function prepareDirectory(runId) {
  const directory = await originalPrepareDirectory.call(this, runId);
  if (current) current.lastRunDir = directory;
  return directory;
};
// Observation only: a refused start's `revalidated` list, which the feature
// error view does not carry. The refusal itself is rethrown unchanged.
const originalStart = ExecutionService.prototype.start;
ExecutionService.prototype.start = async function start(...args) {
  try {
    return await originalStart.apply(this, args);
  } catch (error) {
    if (current) {
      current.startErrors.push({
        code: String(error?.code ?? ""),
        detail: String(error?.detail ?? error?.message ?? "").slice(0, 2000),
        revalidated: Array.isArray(error?.revalidated) ? [...error.revalidated] : null,
      });
    }
    throw error;
  }
};

// Observation only: which tool calls reached the host broker, with their
// argument *names* (never values) and whether the broker served them.
const originalBrokerCall = ToolBroker.prototype.call;
ToolBroker.prototype.call = async function call(params, signal) {
  const args = params && typeof params === "object" ? params.args : undefined;
  const entry = {
    tool_id: typeof params?.tool_id === "string" ? params.tool_id.slice(0, 64) : null,
    arg_keys:
      args && typeof args === "object" && !Array.isArray(args)
        ? Object.keys(args).slice(0, 32).map((key) => String(key).slice(0, 64)).sort()
        : null,
    ok: null,
    code: null,
  };
  if (current && current.brokerCalls.length < 500) current.brokerCalls.push(entry);
  try {
    const result = await originalBrokerCall.call(this, params, signal);
    entry.ok = true;
    return result;
  } catch (error) {
    entry.ok = false;
    entry.code = String(error?.code ?? "").slice(0, 64);
    throw error;
  }
};

const log = {
  info: () => {},
  warn: (message, fields) => {
    if (current && current.warnings.length < 200) current.warnings.push({ message, fields: fields ?? null });
  },
  error: (message, fields) => {
    if (current && current.warnings.length < 200) current.warnings.push({ message, fields: fields ?? null, level: "error" });
  },
  debug: () => {},
};

// -- the in-process runner's stdio -------------------------------------------------
let nextSpawn = 1;
const children = new Map();

class InProcessChild extends EventEmitter {
  constructor(sid) {
    super();
    this.sid = sid;
    this.pid = 70000 + sid;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    const child = this;
    this.stdin = new Writable({
      write(chunk, _encoding, callback) {
        notify("runner.stdin", { sid: child.sid, data: chunk.toString("utf8") });
        callback();
      },
      final(callback) {
        notify("runner.stdin_end", { sid: child.sid });
        callback();
      },
    });
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    notify("runner.kill", { sid: this.sid, signal: String(signal) });
    return true;
  }
}

notificationHandlers.set("runner.stdout", ({ sid, data }) => {
  children.get(sid)?.stdout.write(data);
});
notificationHandlers.set("runner.stderr", ({ sid, data }) => {
  children.get(sid)?.stderr.write(data);
});
notificationHandlers.set("runner.exit", ({ sid, code, signal }) => {
  const child = children.get(sid);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.exitCode = signal ? null : (code ?? 0);
  child.signalCode = signal ?? null;
  child.stdout.end();
  child.stderr.end();
  setImmediate(() => {
    child.emit("exit", child.exitCode, child.signalCode);
    child.emit("close", child.exitCode, child.signalCode);
  });
});

function inProcessSpawn(command, args) {
  const sid = nextSpawn++;
  const child = new InProcessChild(sid);
  children.set(sid, child);
  if (current) current.spawns.push({ sid, command: String(command), args: (args ?? []).map(String) });
  notify("runner.spawn", {
    sid,
    lease_path: current?.lastLeasePath ?? null,
    run_dir: current?.lastRunDir ?? null,
  });
  return child;
}

// -- one case ----------------------------------------------------------------------
let current = null;

function catalogData(host, view) {
  const rows = host.rows ?? [];
  const byProvider = new Map();
  const source = view === "default" ? (host.picker ?? host.routable ?? {}) : (host.routable ?? {});
  for (const [provider, models] of Object.entries(source)) byProvider.set(provider, new Set(models));
  const modelNames = new Map(Object.entries(host.names ?? {}));
  const [provider, model] = String(host.default ?? "").split("/");
  return {
    byProvider,
    providers: [...byProvider.keys()],
    modelNames,
    modelCatalog: rows,
    ...(provider && model ? { resolvedDefault: { provider, model } } : {}),
  };
}

function modelHostFor(spec) {
  return {
    get config() {
      return { plugins: { entries: { "agent-browser": { llm: current.modelHost.plugin_llm ?? {} } } } };
    },
    get runtimeVersion() {
      return current.modelHost.runtime_version ?? null;
    },
    browse: async (_config, _agentId, options) => catalogData(current.modelHost, options?.view ?? "all"),
  };
}

function hostLlm() {
  return {
    complete: (params) =>
      new Promise((resolve, reject) => {
        const id = `llm-${nextId++}`;
        const signal = params.signal;
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          notify("provider.abort", { id });
          const error = new Error("The model call was aborted");
          error.code = "LLM_COMPLETION_ABORTED";
          reject(error);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        call("provider.complete", {
          id,
          model: params.model ?? null,
          system: params.systemPrompt ?? "",
          user: params.messages?.[0]?.content ?? "",
          messages: (params.messages ?? []).length,
          max_tokens: params.maxTokens ?? null,
          reasoning: params.reasoning ?? null,
          response_format: Boolean(params.responseFormat),
          purpose: params.purpose ?? null,
        }).then(
          (answer) => {
            signal?.removeEventListener("abort", onAbort);
            if (settled) return;
            settled = true;
            if (answer && answer.error_code) {
              const error = new Error(answer.message ?? "provider failure");
              error.code = answer.error_code;
              reject(error);
              return;
            }
            resolve(answer);
          },
          (error) => {
            signal?.removeEventListener("abort", onAbort);
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      }),
  };
}

const transport = (options) =>
  new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    call("net.transport", {
      hostname: options.hostname,
      address: options.address,
      path: options.path,
      method: options.method,
      headers: options.headers,
      body: options.body,
      timeout_ms: options.timeoutMs,
      max_response_bytes: options.maxResponseBytes,
    }).then(
      (answer) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ status: answer.status, contentType: answer.content_type ?? null, body: answer.body ?? "" });
      },
      (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });

const pdfReader = async (data) => {
  const sha256 = createHash("sha256").update(data).digest("hex");
  return call("file.parse", { sha256, bytes: data.length });
};

const controlTransport = async (_endpoint, path, options) => {
  const answer = await call("cp.dispatch", {
    method: options.method,
    path,
    body: options.body === undefined ? null : options.body,
  });
  if (
    current &&
    options.method === "POST" &&
    /\/execution-lease$/u.test(path) &&
    answer.status >= 200 &&
    answer.status < 300
  ) {
    try {
      current.lastLeasePath = JSON.parse(answer.body).lease?.path ?? null;
    } catch {
      current.lastLeasePath = null;
    }
  }
  return { status: answer.status, body: answer.body };
};

function supervisor() {
  return {
    snapshot: () => ({ state: "running", detail: "experiment in-process control plane", since: null, starts: 1 }),
    ensureRunning: async () => ({ url: "http://127.0.0.1:9", token: "experiment-in-process" }),
    stop: async () => {},
    get trustStore() {
      return "experiment-in-process";
    },
  };
}

function definitionsFor(spec) {
  // Always a fresh, mutable array: the backend reads it on every call, and a
  // host change between plan and start replaces its contents in place.
  return [...(Array.isArray(spec.tool_definitions) ? spec.tool_definitions : BUILT_IN_BINDINGS)];
}

function executionBridgeFactory(policyConfig) {
  const policy = resolvePolicy(policyConfig ?? {});
  return (options) =>
    new ExecutionBridge({
      agentpkgPath: "agentpkg-in-process-runner",
      modelId: options.modelId,
      llm: current.llm,
      logger: log,
      packageFd: options.packageFd,
      artifactsFd: options.artifactsFd,
      broker: options.broker,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      // The limits `ExecutionService.execute` passes to the bridge it builds
      // itself when no seam is supplied (execution.ts); a fidelity test
      // compares these two expressions with that source.
      limits: {
        maxOutputTokens: policy.maxOutputTokensPerCall,
        completionTimeoutMs: (policy.modelCallTimeoutSeconds + 30) * 1000,
        sessionTimeoutMs: (policy.runTimeoutSeconds + 120) * 1000,
      },
      spawnImpl: inProcessSpawn,
    });
}

requestHandlers.set("helper.hello", async () => ({
  node: process.version,
  build: BUILD,
  built_in_bindings: BUILT_IN_BINDINGS,
  pid: process.pid,
}));

requestHandlers.set("helper.configure", async ({ sensitive_prefixes, sensitive_substrings }) => {
  sensitivePrefixes = (sensitive_prefixes ?? []).map(String);
  sensitiveSubstrings = (sensitive_substrings ?? []).map(String);
  return { ok: true };
});

requestHandlers.set("case.begin", async (spec) => {
  if (current) throw Object.assign(new Error("a case is already active"), { code: "case_active" });
  current = {
    ref: spec.case_ref,
    modelHost: spec.model_host,
    config: spec.config,
    lastLeasePath: null,
    lastRunDir: null,
    spawns: [],
    startErrors: [],
    warnings: [],
    brokerCalls: [],
    guardMark: {
      refused: guard.refused.length,
      dnsLookups: guard.dnsLookups.length,
      fsOpens: guard.fsOpens.length,
      fsSensitive: guard.fsSensitive.length,
    },
  };
  current.llm = hostLlm();
  current.definitions = definitionsFor(spec);
  current.backend = new AgentBrowserBackend({
    config: spec.config,
    logger: log,
    stateDir: spec.state_dir,
    transport: controlTransport,
    supervisor: supervisor(),
    modelHost: modelHostFor(spec),
    llm: current.llm,
    createExecutionBridge: executionBridgeFactory(spec.config?.execution),
    toolDefinitions: current.definitions,
    toolTransport: transport,
    pdfReader,
  });
  await current.backend.initialize();
  return { ok: true };
});

requestHandlers.set("case.update", async (update) => {
  if (!current) throw Object.assign(new Error("no active case"), { code: "no_case" });
  if (update.model_host) current.modelHost = { ...current.modelHost, ...update.model_host };
  if ("tools" in update) {
    if (update.tools === null) delete current.config.tools;
    else current.config.tools = update.tools;
  }
  if (Array.isArray(update.tool_definitions)) {
    // The backend reads `toolDefinitions` from its options on every call.
    current.definitions.length = 0;
    current.definitions.push(...update.tool_definitions);
  }
  return { ok: true };
});

const BACKEND_METHODS = new Set([
  "openLocal",
  "getPackage",
  "getPermissions",
  "getAuthorization",
  "authorize",
  "closeSession",
  "selectFile",
  "evaluateModels",
  "evaluateTools",
  "prepareRunPlan",
  "getRunPlan",
  "clearRunPlan",
  "validateInput",
  "runReadiness",
  "startExecution",
  "cancelExecution",
  "getExecution",
  "pinSessionPublisher",
  "removeTrust",
  "listTrust",
]);

requestHandlers.set("backend.call", async ({ method, args }) => {
  if (!current) throw Object.assign(new Error("no active case"), { code: "no_case" });
  if (!BACKEND_METHODS.has(method)) throw Object.assign(new Error(`not a page operation: ${method}`), { code: "bad_method" });
  return current.backend[method](...(args ?? []));
});

requestHandlers.set("case.observe", async () => {
  if (!current) return null;
  const mark = current.guardMark;
  return {
    spawns: current.spawns,
    start_errors: current.startErrors,
    warnings: current.warnings,
    broker_calls: current.brokerCalls,
    guard: {
      refused: guard.refused.slice(mark.refused),
      dns_lookups: guard.dnsLookups.slice(mark.dnsLookups),
      fs_sensitive: guard.fsSensitive.slice(mark.fsSensitive),
      fs_open_count: guard.fsOpens.length - mark.fsOpens,
    },
  };
});

requestHandlers.set("case.end", async () => {
  if (!current) return { ok: true };
  const backend = current.backend;
  try {
    await backend.stop();
  } finally {
    for (const child of children.values()) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    children.clear();
    current = null;
  }
  return { ok: true };
});

requestHandlers.set("helper.guards", async () => ({
  refused: guard.refused,
  dns_lookups: guard.dnsLookups.length,
  fs_sensitive: guard.fsSensitive,
}));

// Test support: try each operation the guards exist to refuse, against
// unroutable or experiment-owned targets only, and report what happened.
requestHandlers.set("helper.selftest", async ({ canary }) => {
  const attempts = {
    "net.connect": () => net.connect({ host: "192.0.2.1", port: 9 }),
    "net.Socket.connect": () => new net.Socket().connect({ host: "192.0.2.1", port: 9 }),
    "tls.connect": () => tls.connect({ host: "192.0.2.1", port: 9 }),
    "http.request": () => http.request("http://192.0.2.1:9/"),
    "https.get": () => https.get("https://192.0.2.1:9/"),
    fetch: () => globalThis.fetch("https://192.0.2.1:9/"),
    "child_process.spawn": () => childProcess.spawn("true"),
    "dns.resolve4": () => dns.resolve4("example.invalid", () => {}),
    "fs.readFileSync(canary)": () => fs.readFileSync(canary),
    "fsPromises.readFile(canary)": () => fsPromises.readFile(canary),
  };
  const before = guard.refused.length;
  const outcome = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    try {
      const result = attempt();
      if (result && typeof result.then === "function") await result;
      outcome[name] = "allowed";
    } catch (error) {
      outcome[name] = error?.code === "EXPERIMENT_GUARD" ? "refused" : `error:${error?.code ?? error}`;
    }
  }
  const refused = guard.refused.splice(before);
  guard.fsSensitive.splice(0);
  return { outcome, refused: refused.length };
});

notify("helper.ready", { node: process.version, build: BUILD });
