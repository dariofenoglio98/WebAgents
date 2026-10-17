// What "the same behaviour" means between the two runtimes (D-063), as data rather than as
// assertions, so the runner can report every difference instead of stopping at the first.
//
// Dropped before comparing: run ids, timestamps, sequence numbers and hashes (each runtime's own
// audit chain is checked for linkage instead), the output directory in the success report, and
// `provenance.interpreter`, which names the runtime. Folded: worker instance numbers in `usage`
// (`Role:7` -> `Role:*`, because concurrency decides spawn order). The audit is compared as an
// ordered backbone (runtime and workflow events, `state.committed` with its sorted node list,
// `memory.cleared`) plus, per wave, a sorted multiset of the other events' facts, because a wave's
// concurrent nodes record their events in whichever order their asynchronous validation settles.
// Everything else must be equal.

export const HOST_FILES = ["result.json", "audit.json", "usage.json", "provenance.json"];
const BACKBONE = /^(?:runtime|workflow)\./u;
// memory.v0 (M-61): the conformance backbone gains these, with their facts.
const MEMORY_BACKBONE = new Set(["memory.proposed", "memory.agent.committed", "memory.agent.discarded"]);
const MEMORY_FACTS = ["count", "types", "proposals_sha256", "offered", "reason", "package_id", "bytes", "body_sha256"];
// compute.v0 (C-46): a call's events compare everything the format determines (the module, the
// function, the bytes in and out, the memory's size after the call, the effective page and time
// bounds, the failure's reason, trap and detail) and nothing the engine decides: `engine` and
// `limits.fuel` are dropped. Two engine differences D-244 documents are folded: a runaway module is
// `fuel_exhausted` on a metering engine and `deadline` on one that only has a wall bound, and a
// call that was stopped from outside reports the memory size the engine could still read, which
// a terminated Worker cannot (T22, D-250), so after either reason `memory_pages` is the engine's.
const COMPUTE_EVENTS = new Set(["compute.called", "compute.completed", "compute.failed"]);
const COMPUTE_FACTS = ["module", "module_sha256", "function", "input_bytes", "output_bytes", "trap_code", "detail", "error"];
const BOUND_REASONS = new Set(["fuel_exhausted", "deadline"]);

/** `Role:7` -> `Role:*`. */
const instance = (worker) => (typeof worker === "string" ? worker.replace(/:\d+$/u, ":*") : worker);

/** D-063's view of a usage report: worker rows folded by role; `tokens` zeroed when allowlisted. */
export function normalizeUsage(usage, allowTokens = false) {
  const rows = {};
  const workers = Object.entries(usage?.workers ?? {})
    .map(([worker, row]) => [instance(worker), row])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [worker, row] of workers) {
    const existing = rows[worker] ?? { tokens: 0, remote_calls: 0, tool_calls: {} };
    const toolCalls = { ...existing.tool_calls };
    for (const [tool, count] of Object.entries(row.tool_calls ?? {})) toolCalls[tool] = (toolCalls[tool] ?? 0) + count;
    rows[worker] = { tokens: allowTokens ? 0 : existing.tokens + row.tokens, remote_calls: existing.remote_calls + row.remote_calls, tool_calls: toolCalls };
  }
  return { ...usage, tokens: allowTokens ? 0 : usage?.tokens, workers: rows };
}

/** D-063's view of an audit: the backbone in order, the rest per wave as a sorted multiset. */
export function normalizeAudit(audit, allowTokens = false) {
  const view = [];
  let wave = [];
  const flush = () => {
    if (wave.length > 0) view.push([...wave].sort());
    wave = [];
  };
  for (const event of audit) {
    const action = String(event.action);
    if (BACKBONE.test(action) || action === "state.committed" || action === "memory.cleared" || MEMORY_BACKBONE.has(action)) {
      flush();
      const entry = { action, node_id: event.node_id ?? null };
      if (action === "state.committed") entry.nodes = [...(event.nodes ?? [])].sort();
      if (typeof event.error_code === "string") entry.error_code = event.error_code;
      // memory.v0 (M-61): what a run proposed and what became of the agent document, never a value.
      for (const key of MEMORY_FACTS) if (MEMORY_BACKBONE.has(action) && key in event) entry[key] = event[key];
      if (action === "workflow.failed") for (const key of ["reason", "proposal_index"]) if (key in event) entry[key] = event[key];
      view.push(entry);
      continue;
    }
    const facts = [action, event.node_id ?? null, event.role ?? null, event.task ?? event.tool ?? event.permission ?? null];
    if (action === "permission.checked") facts.push(event.allowed ?? null, event.grant ?? null);
    // A refusal's reason and the record and pointer it names (M-36, M-37), never a value.
    if (action === "permission.checked" || action === "model.refused" || action === "memory.read") {
      for (const key of ["reason", "record_id", "pointer", "permission_id"]) if (key in event) facts.push(`${key}=${event[key]}`);
    }
    if (action === "model.completed" && !allowTokens) facts.push(event.tokens ?? null);
    if (COMPUTE_EVENTS.has(action)) {
      for (const key of COMPUTE_FACTS) if (key in event) facts.push(`${key}=${event[key]}`);
      const bound = BOUND_REASONS.has(event.reason);
      if ("reason" in event) facts.push(`reason=${bound ? "bound_reached" : event.reason}`);
      if ("memory_pages" in event && !bound) facts.push(`memory_pages=${event.memory_pages}`);
      if (event.limits && typeof event.limits === "object") facts.push(`limits=${event.limits.memory_pages}/${event.limits.wall_seconds}`);
    }
    wave.push(JSON.stringify(facts));
  }
  flush();
  return view;
}

/** Whether every event of one audit is hash-linked to its predecessor; the first broken index otherwise. */
export function chainBreak(events) {
  for (const [at, event] of events.entries()) {
    if (event.sequence !== at + 1) return at;
    if ((event.previous_hash ?? null) !== (at === 0 ? null : events[at - 1].event_hash)) return at;
  }
  return null;
}

/** The structural differences between two JSON values, as `path: left != right` lines (at most `limit`). */
export function diff(left, right, path = "$", out = [], limit = 20) {
  if (out.length >= limit) return out;
  const kind = (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
  if (kind(left) !== kind(right)) {
    out.push(`${path}: ${short(left)} != ${short(right)}`);
    return out;
  }
  if (Array.isArray(left)) {
    if (left.length !== right.length) out.push(`${path}: length ${left.length} != ${right.length}`);
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) diff(left[index], right[index], `${path}[${index}]`, out, limit);
    return out;
  }
  if (kind(left) === "object") {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(key in left)) out.push(`${path}.${key}: missing != ${short(right[key])}`);
      else if (!(key in right)) out.push(`${path}.${key}: ${short(left[key])} != missing`);
      else diff(left[key], right[key], `${path}.${key}`, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  if (!Object.is(left, right) && !(left === 0 && right === 0)) out.push(`${path}: ${short(left)} != ${short(right)}`);
  return out;
}

function short(value) {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

/**
 * Compare two runs' written files (`{name: Uint8Array}`) under D-063's normalization. Returns
 * `{checks: [{name, passed, detail}]}`; `allowTokens` is Literature Review's integral-float
 * allowlist, whose two numbers the caller prints.
 */
export function compareArtifacts(python, node, { allowTokens = false } = {}) {
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  check("file set", diff(Object.keys(python).sort(), Object.keys(node).sort()));
  if (!python["result.json"] || !node["result.json"]) {
    check("result.json written", [`python ${Boolean(python["result.json"])}, node ${Boolean(node["result.json"])}`]);
    return { checks, tokens: { python: null, node: null } };
  }
  const pyResult = decode(python["result.json"]);
  const nodeResult = decode(node["result.json"]);
  check("interpreter names its runtime", [
    ...(pyResult.provenance?.interpreter === "agentpkg.workflow.Workflow" ? [] : [`python interpreter ${pyResult.provenance?.interpreter}`]),
    ...(nodeResult.provenance?.interpreter === "chrome-agent-browser.workflow.Workflow" ? [] : [`node interpreter ${nodeResult.provenance?.interpreter}`]),
  ]);
  for (const [name, section] of [["usage.json", "usage"], ["provenance.json", "provenance"]]) {
    if (!python[name] && !node[name]) continue;
    check(`${name} equals its own result section`, [...diff(decode(python[name]), pyResult[section], "$python"), ...diff(decode(node[name]), nodeResult[section], "$node")]);
  }
  check("usage (workers folded by role)", diff(normalizeUsage(pyResult.usage, allowTokens), normalizeUsage(nodeResult.usage, allowTokens)));
  const strip = (result) => {
    const { audit: _audit, ...rest } = result;
    return { ...rest, provenance: rest.provenance ? { ...rest.provenance, interpreter: "<interpreter>" } : rest.provenance, usage: normalizeUsage(rest.usage, allowTokens) };
  };
  check("result.json without the audit", diff(strip(pyResult), strip(nodeResult)));
  for (const name of Object.keys(python).sort()) {
    if (HOST_FILES.includes(name) || !node[name]) continue;
    if (name.endsWith(".json")) check(`export ${name}`, diff(decode(python[name]), decode(node[name])));
    else check(`export ${name}`, Buffer.from(python[name]).equals(Buffer.from(node[name])) ? [] : ["bytes differ"]);
  }
  const pyAudit = pyResult.audit ?? [];
  const nodeAudit = nodeResult.audit ?? [];
  check("audit.json equals the result's audit", [...diff(decode(python["audit.json"]), pyAudit, "$python"), ...diff(decode(node["audit.json"]), nodeAudit, "$node")]);
  check("audit length", pyAudit.length === nodeAudit.length ? [] : [`${pyAudit.length} != ${nodeAudit.length}`]);
  check("audit backbone and per-wave multisets", diff(normalizeAudit(pyAudit, allowTokens), normalizeAudit(nodeAudit, allowTokens)));
  const breaks = [["python", chainBreak(pyAudit)], ["node", chainBreak(nodeAudit)]].filter(([, at]) => at !== null);
  check("each audit chain is linked", breaks.map(([runtime, at]) => `${runtime} breaks at event ${at + 1}`));
  return { checks, tokens: { python: pyResult.usage?.tokens ?? null, node: nodeResult.usage?.tokens ?? null } };
}

/**
 * A failure inside a concurrent wave (D-092): which siblings got how far before the first failure
 * cancelled them is the scheduler's choice in either runtime, so their partial events and the
 * tokens they reserved are not compared. Compared: the file set, the outcome (`status`,
 * `error_code`), the provenance, the ordered backbone (runtime and workflow events,
 * `state.committed`, `memory.cleared`; the failing node is the backbone's `workflow.failed`), and
 * each audit chain's linkage. The two token totals are returned for the report.
 */
export function compareFailureRace(python, node) {
  const checks = [];
  const check = (name, differences) => checks.push({ name, passed: differences.length === 0, detail: differences });
  check("file set", diff(Object.keys(python).sort(), Object.keys(node).sort()));
  if (!python["result.json"] || !node["result.json"]) {
    check("result.json written", [`python ${Boolean(python["result.json"])}, node ${Boolean(node["result.json"])}`]);
    return { checks, tokens: { python: null, node: null } };
  }
  const pyResult = decode(python["result.json"]);
  const nodeResult = decode(node["result.json"]);
  check("outcome (status, error_code)", diff({ status: pyResult.status, error_code: pyResult.error_code }, { status: nodeResult.status, error_code: nodeResult.error_code }));
  const masked = (result) => ({ ...result.provenance, interpreter: "<interpreter>" });
  check("provenance", diff(masked(pyResult), masked(nodeResult)));
  const backbone = (audit) => normalizeAudit(audit).filter((entry) => !Array.isArray(entry));
  check("audit backbone (runtime and workflow events, commits)", diff(backbone(pyResult.audit ?? []), backbone(nodeResult.audit ?? [])));
  const breaks = [["python", chainBreak(pyResult.audit ?? [])], ["node", chainBreak(nodeResult.audit ?? [])]].filter(([, at]) => at !== null);
  check("each audit chain is linked", breaks.map(([runtime, at]) => `${runtime} breaks at event ${at + 1}`));
  return { checks, tokens: { python: pyResult.usage?.tokens ?? null, node: nodeResult.usage?.tokens ?? null } };
}
