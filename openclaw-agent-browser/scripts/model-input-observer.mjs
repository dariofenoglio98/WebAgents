/**
 * Operator diagnostic: what reached a model provider from this process, without keeping it.
 *
 * Preload into a Gateway started for an acceptance session:
 *
 *   NODE_OPTIONS="--import=file:///abs/path/model-input-observer.mjs" \
 *   AGENT_BROWSER_MODEL_OBSERVER_OUT=/private/dir/model-inputs.jsonl \
 *   AGENT_BROWSER_MODEL_OBSERVER_NEEDLES=/private/dir/needles.json \
 *   node … openclaw/dist/index.js gateway --port 18789
 *
 * It watches outbound requests at dispatch — `globalThis.fetch` and undici's
 * `undici:request:create` diagnostics channel, the same observation points as
 * `transport-observer.mjs` — and, for a package model call (a request to a
 * model route whose instructions carry the agentpkg router's `## Task` line;
 * nothing else is recorded), appends one JSON line: when, which route, the
 * task, the body's SHA-256 and size, how many values of each needle class the
 * whole body and its conversation input contain, and whether it holds a
 * card-number-like digit run.
 *
 * With `AGENT_BROWSER_TOOL_OBSERVER_HOSTS=<host>[,<host>]` it also summarizes
 * each `node:https` request to exactly those hosts — the Agent Browser's tool
 * broker sends its calls that way — as one `tool_request` line: path, method,
 * body digest and size, and the same needle counts. That is how a live run can
 * show which values reached which tool endpoint without anyone keeping them.
 *
 * It never changes a request, never reads a header (so never a credential),
 * never reads a response, and never writes request text or a matched value:
 * the needles file is the only place the values exist, and it stays with the
 * operator. Nothing here is specific to a package, a site or a provider
 * account; with neither variable set it does nothing at all.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createRequire, syncBuiltinESMExports } from "node:module";

const OUT = process.env.AGENT_BROWSER_MODEL_OBSERVER_OUT;
const NEEDLES_FILE = process.env.AGENT_BROWSER_MODEL_OBSERVER_NEEDLES;
// Optional: tool hosts whose requests (sent with node:https, as the Agent Browser's tool
// broker sends them) are also summarized, comma-separated, exact hostnames.
const TOOL_HOSTS = new Set(
  (process.env.AGENT_BROWSER_TOOL_OBSERVER_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
);
const CARD_LIKE = /(?:\d[ -]?){13,19}/u;

export function modelRoute(url) {
  if (url.protocol === "https:" && url.hostname === "api.openai.com" && url.pathname === "/v1/responses") {
    return "openai_api_responses";
  }
  if (url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/responses") {
    return "chatgpt_codex_responses";
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/api/chat") {
    return "local_ollama_chat";
  }
  if (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/v1/messages")) return "other_model_api";
  return null;
}

/** Every string value in a JSON document, decoded, so escaping cannot hide a match. */
function strings(value, found = [], depth = 0) {
  if (depth > 64 || found.length > 100_000) return found;
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, found, depth + 1);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, found, depth + 1);
  return found;
}

/**
 * The instruction text and the conversation text of a chat or responses request, apart, so a
 * value the package's own instructions mention can still be checked for in what the model was
 * handed as input. Unknown shapes leave both empty; the whole-body counts still apply.
 */
function byRole(document) {
  const parts = { system: [], user: [] };
  const push = (role, content) => {
    const target = role === "system" || role === "developer" ? parts.system : parts.user;
    if (typeof content === "string") target.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") target.push(part);
        else if (part && typeof part.text === "string") target.push(part.text);
      }
    }
  };
  if (document && typeof document === "object") {
    if (typeof document.instructions === "string") parts.system.push(document.instructions);
    if (typeof document.system === "string") parts.system.push(document.system);
    for (const list of [document.messages, document.input]) {
      if (Array.isArray(list)) for (const message of list) if (message && typeof message === "object") push(message.role, message.content);
    }
  }
  return { system: parts.system.join("\n"), user: parts.user.join("\n") };
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * How many of each class's values occur. A class whose name ends in `_word` matches whole
 * words only (a short name inside a longer word is not a match); every other class matches
 * any occurrence.
 */
function count(needles, ...texts) {
  const counts = {};
  for (const [name, values] of Object.entries(needles)) {
    const found = name.endsWith("_word")
      ? (value) => {
          const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}_])`, "u");
          return texts.some((text) => pattern.test(text));
        }
      : (value) => texts.some((text) => text.includes(value));
    counts[name] = values.filter(found).length;
  }
  return counts;
}

export function observe(urlValue, body, needles) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }
  const route = modelRoute(url);
  if (!route) return null;
  let decoded = body;
  let roles = { system: "", user: "" };
  try {
    const document = JSON.parse(body);
    decoded = strings(document).join("\n");
    roles = byRole(document);
  } catch {
    // Not JSON: scan the text as sent.
  }
  const task = /^## Task\n(.+)$/mu.exec(roles.system || decoded)?.[1]?.trim().slice(0, 64) ?? null;
  // Only a package model call (the agentpkg router names its task); anything else this
  // process sends — the operator's own agents and channels — is not looked at further.
  if (task === null) return null;
  return {
    at: new Date().toISOString(),
    route,
    task,
    body_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
    body_bytes: Buffer.byteLength(body, "utf8"),
    user_bytes: Buffer.byteLength(roles.user, "utf8"),
    // Whole request: instructions, input, schema, everything that left.
    needle_matches: count(needles, decoded, body),
    // Only what the model was handed as conversation input.
    user_needle_matches: count(needles, roles.user),
    card_like_digits: CARD_LIKE.test(decoded),
  };
}

function bodyText(body) {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return null;
}

if (OUT) {
  const needles = NEEDLES_FILE ? JSON.parse(readFileSync(NEEDLES_FILE, "utf8")) : {};
  const record = (url, body, point) => {
    try {
      const text = bodyText(body);
      if (text === null) return;
      const facts = observe(url, text, needles);
      if (facts) appendFileSync(OUT, `${JSON.stringify({ ...facts, observation_point: point, pid: process.pid })}\n`);
    } catch {
      // An observer must never affect the request it watches.
    }
  };
  // A fetch body usually reaches undici as a stream, so it is reassembled from the chunks undici
  // reports as sent (copies; the request itself is untouched), for model routes only, bounded.
  const pending = new WeakMap();
  const MAX_BODY = 4 * 1024 * 1024;
  channel("undici:request:create").subscribe(({ request }) => {
    const url = String(request.origin) + request.path;
    if (bodyText(request.body) !== null) {
      record(url, request.body, "undici_dispatch");
      return;
    }
    try {
      if (modelRoute(new URL(url))) pending.set(request, { url, chunks: [], size: 0 });
    } catch {
      // not a URL this observer understands
    }
  });
  channel("undici:request:bodyChunkSent").subscribe(({ request, chunk }) => {
    const entry = pending.get(request);
    if (!entry || entry.size > MAX_BODY) return;
    const copy = Buffer.from(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    entry.size += copy.length;
    entry.chunks.push(copy);
  });
  channel("undici:request:bodySent").subscribe(({ request }) => {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    if (entry.size <= MAX_BODY) record(entry.url, Buffer.concat(entry.chunks), "undici_body_sent");
  });
  const original = globalThis.fetch;
  if (typeof original === "function") {
    globalThis.fetch = function observedFetch(input, init) {
      const url = input instanceof Request ? input.url : String(input);
      record(url, init?.body, "fetch_dispatch");
      return original.apply(this, arguments);
    };
  }

  // Tool requests to the configured hosts: one line per request with its path, method, body
  // digest and needle counts. The request is passed through untouched; only copies of the
  // bytes it writes are hashed and scanned, and no header is read.
  if (TOOL_HOSTS.size > 0) {
    const https = createRequire(import.meta.url)("node:https");
    const request = https.request;
    https.request = function observedHttpsRequest(...args) {
      const outgoing = request.apply(this, args);
      try {
        const options = args.find((arg) => arg && typeof arg === "object" && !(arg instanceof URL)) ?? {};
        const host = options.servername ?? options.hostname ?? options.host;
        if (TOOL_HOSTS.has(host)) {
          const chunks = [];
          const copy = (chunk) => {
            if (typeof chunk === "string") chunks.push(Buffer.from(chunk, "utf8"));
            else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
          };
          const write = outgoing.write;
          const end = outgoing.end;
          outgoing.write = function observedWrite(chunk, ...rest) {
            copy(chunk);
            return write.call(this, chunk, ...rest);
          };
          outgoing.end = function observedEnd(chunk, ...rest) {
            if (chunk !== undefined && typeof chunk !== "function") copy(chunk);
            try {
              const body = Buffer.concat(chunks).toString("utf8");
              let decoded = body;
              try {
                decoded = strings(JSON.parse(body)).join("\n");
              } catch {
                // not JSON
              }
              appendFileSync(
                OUT,
                `${JSON.stringify({
                  at: new Date().toISOString(),
                  kind: "tool_request",
                  host,
                  method: options.method ?? "GET",
                  path: String(options.path ?? "").split("?")[0].slice(0, 256),
                  body_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
                  body_bytes: Buffer.byteLength(body, "utf8"),
                  needle_matches: count(needles, decoded, body),
                  card_like_digits: CARD_LIKE.test(decoded),
                  observation_point: "https_request_end",
                  pid: process.pid,
                })}\n`,
              );
            } catch {
              // An observer must never affect the request it watches.
            }
            return end.call(this, chunk, ...rest);
          };
        }
      } catch {
        // as above
      }
      return outgoing;
    };
    syncBuiltinESMExports();
  }
}
