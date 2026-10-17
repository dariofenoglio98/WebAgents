# compute.v0: WebAssembly modules as pure functions inside workflow.v0

Status: experimental, normative for agentpkg **0.5.0** and the Chrome core **0.3.0** (D-185,
D-240…D-244; the Chrome port is T22). The enclosing agent.pkg format stays 0.1 with one amendment
(§3.1: a binary member class for modules), and `workflow.v0` stays the execution profile: this
document adds one node type, one permission kind, one failure code and three audit events. Machine
contracts live beside it in [`spec/compute-v0/`](compute-v0/): RFC 6902 patches for
`workflow.schema.json` (the `modules` list, the `compute` node and step), `policy.schema.json` (the
kind), `audit-event.schema.json` (the code) and the policy-bundle schema (the decision), and
[`cases.json`](../examples/compute/cases/cases.json), the enforcement cases both runtimes must
refuse identically, with the hand-assembled modules they use. `scripts/verify_compute.py` checks
the live schemas against the patches, the committed modules against their generator, and every
case against the reference. Rules are numbered **C-n** so that a test can cite one; negative cases
**N-n** in §10 map to `cases.json` ids.

Vocabulary. A **module** is one WebAssembly core module the package ships, named in the graph by
an id and its SHA-256. A **compute node** (or step) runs one exported **function** of one module on
one constructed input. A **call** is one such run: a fresh instance, the input bytes in, the
output bytes out. **Limits** bound a call: memory pages, wall time and, on an engine that meters
instructions, fuel. The **engine** is the host's WebAssembly implementation (wasmtime in the
reference, V8 in Chrome); a module never chooses it. Nothing a package carries is ever authority
(D-005): a package declares modules and the nodes that run them, the person grants the `compute`
permission, the host sets the ceilings, and both runtimes enforce the intersection (D-180).

## 1. Purpose and what tier 1 refuses

Publishers need deterministic transformations that a model should not be asked to do and a remote
tool should not be needed for: exact deduplication, identifier assignment, fare arithmetic, quote
matching. A tier-1 module is such a transformation and nothing else: it **imports nothing**, so it
has no clock, no randomness, no file, no network and no host function; it sees the bytes the graph
constructs for it and returns bytes the graph validates. WebAssembly's capability model in its
strongest form (D-185).

C-1. **Refused in v0:** an import of any kind (WASI, the component model, host functions:
capability imports are tier 2, B-185); more than one memory; a shared or 64-bit memory; a memory
without a declared maximum; a module the graph does not declare, or declares and no node runs; a
compute node in a package without the `compute` permission; a module whose declared memory
maximum is above the host's ceiling (refused, never lowered); any proposal outside the instruction
set of §3.3. A runtime that implements this specification refuses each of these before the
boundary it protects, with the codes of §2–§6.

## 2. Declarations

### 2.1 The graph's modules

C-2. A graph declares its modules in the optional top-level `modules` array (at most 16):

```json
"modules": [
  {"id": "fares", "path": "modules/fares.wasm",
   "sha256": "ef7e813b9ac330575c89c75d96aa63bfe25d77da8d3a699cf4718879a8f123c0"}
]
```

`id` is a package identifier (the usual pattern), `path` a package member whose name ends in
`.wasm` (conventionally under `modules/`), `sha256` the SHA-256 of that member's bytes, in
lowercase hex. The hash is in the graph so that the document a person reads binds the bytes the
engine runs, and so that an agent page can show it without reading the module.

C-3. Ids are unique and so are paths (`module_duplicate`); a declared path must exist
(`module_file_missing`) and hash as declared (`module_hash_mismatch`).

C-4. Every member whose name ends in `.wasm` is declared exactly once (`module_undeclared`); a
package whose execution profile is not `workflow.v0` carries no module (the same code).

C-5. Every declared module is run by at least one node (`module_unused`), so that every hash a
page shows is a hash that runs.

### 2.2 The compute node

C-6. A node of `type: "compute"` carries, beside the fields every node has (`id`, `worker`,
`depends_on`, `input`, `output_schema`, `timeout_seconds`, `writes`, optional `when` and
`otherwise`):

| Field | Meaning |
|---|---|
| `module` | A declared module id (`module_unknown` otherwise). |
| `function` | The export the call runs: `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; one module may serve several nodes with different functions. |
| `input_schema` | A declared package schema the constructed input must match before the call (as a tool's `input_schema`). |
| `limits` | Optional; any of `memory_pages` (1…65,536), `wall_seconds` (a positive number ≤ 300), `fuel` (1…10¹²). A node can only lower the host's bounds (§5). |

`task`, `max_output_tokens`, `tool`, `item_schema`, `max_items`, `max_parallel`, `steps`,
`yield`, `select`, `unique_by`, `limit`, `assertions` and `checks` are refused on a compute node;
`module`, `function`, `input_schema` and `limits` are refused on every other type (the workflow
schema's conditionals).

C-7. A compute operation is allowed as a top-level node and as a map step, on any role, the
coordinator included: it carries no authority of its own (the role only scopes what state it may
read and write), like `validate` and `join`. The usual scope rules apply to `input` (the role's
`state_read`; `item` and earlier `steps` inside a map) and to `writes`.

C-8. `limits.memory_pages` on a node must be at least the module's declared memory maximum
(`compute_limits_below_module`): a node may not promise less memory than the module says it needs.

### 2.3 The permission

C-9. A graph with compute nodes declares **exactly one** permission of kind `compute`
(`compute_permission_missing`, `compute_permission_duplicate`) whose `resources` are exactly the
declared module ids (`compute_permission_resources`); a `compute` permission in a graph without
modules is refused (`compute_permission_unused`). The runtime authorizes it before every call,
exactly as it authorizes a tool's permissions: `deny` fails the call `permission_denied` before the
engine sees a byte; `once` is spent by the first call, so a graph with two calls cannot run under
it (an execution host refuses the plan as `execution_grant_unsupported`, as it does for a model
permission used twice); `session` covers the run. A policy bundle may decide the kind
(`policy-bundle-v0.schema.patch.json`, applied by T22). The agent page states the permission in
words: *runs code that can only compute*, with each module's id, hash and functions.

### 2.4 Versions

C-10. A graph with any of §2.1–§2.3 declares `runtime.minimum_version` **0.5.0** or later
(`compute_minimum_version`), so that an older runtime refuses the package by its version with a
reason a person can act on, before it meets a node type it does not know (D-188). One honest
limit of the container amendment (§3.1): agentpkg 0.4.0 and earlier read the archive before the
version, so they refuse such a package at the member rule ("only declared UTF-8 data formats
allowed, never executable payloads") rather than by version.

## 3. Modules

### 3.1 The member (the agent.pkg 0.1 amendment)

C-11. A member whose name ends in `.wasm` is the one **binary** member class of the container: it
is admitted when it begins with the WebAssembly header (`\0asm` and version 1), is at most
**4 MiB** (`MAX_MODULE_BYTES`), and is declared in the graph (C-4). It is never decoded as text;
the container's credential scan still reads its bytes. Every other member stays UTF-8 text of
the declared suffixes. A `.wasm` member that is not a module, or is too large, is refused while
the archive or source tree is read, before validation (the messages of
`examples/compute/cases/cases.json`, stage `container`).

C-12. The integrity statement, the package digest and the signature cover a module like every
other member: a changed byte is `content integrity mismatch` (N-21).

### 3.2 Structure

Both runtimes read a module **without an engine** (`agentpkg.compute.module`; the Chrome core's
port of it) and require:

C-13. A **core module**, binary version 1, with its sections in the format's order. The tag
section (exception handling) and unknown section ids are refused.

C-14. An **empty import section** (`module_import`). This is the whole of tier 1's isolation: with
no import, the module has no instruction that reaches outside its own memory.

C-15. **Exactly one memory** (`module_memory_count`), 32-bit and unshared, **with a declared
maximum** (`module_memory_undeclared_maximum`) of at most 65,536 pages; the maximum is the
module's own memory bound, and the host's ceiling is checked against it (§5).

C-16. The **exports**: `memory` (the memory; `module_export_missing`, `module_export_kind`),
`alloc` with the type `(i32) -> (i32)`, and every function a node names with the type
`(i32, i32) -> (i64)` (`module_export_signature`). A node may not name `alloc`. Other exports
(functions, globals, tables) are allowed and never called by a host.

C-17. A **start function is allowed**: it runs at instantiation, inside the call's limits (§4,
C-29); toolchains emit one to initialize their runtime (AssemblyScript does). Tables, element
segments, globals and data segments are allowed.

### 3.3 The feature gate

C-18. Every function body and every constant expression is **decoded** at validation, and only
these are admitted: the MVP instruction set, sign extension, non-trapping float-to-int
conversions, bulk memory, multi-value, reference types (`funcref`, `externref`, typed `select`,
table instructions) and mutable globals. Refused by name (`module_feature_refused`, naming the
proposal): SIMD (the `0xFD` prefix, `v128`), threads and atomics (`0xFE`, shared memory), the GC
proposal (`0xFB`, its types), exception handling, tail calls, function references, memory64,
multi-memory, custom page sizes, memory control and extended constant expressions. An unknown
opcode or a malformed encoding is `module_malformed`.

C-19. The reference engine's configuration mirrors the gate (every refused proposal disabled;
NaN canonicalization on), so a module the reader accepted and the engine compiles are the same
set; a module the engine still refuses is `module_invalid`. The gate is what makes two engines
compute the same thing (§8): everything admitted is deterministic except floating-point NaN
payloads, which §8 addresses.

## 4. A call

C-20. **A fresh instance per call.** Each call instantiates the module anew: data segments and
globals start from the module's own bytes, and nothing survives from one call to the next, so two
calls of one module cannot observe each other and no `free` exists in the ABI.

C-21. **The input.** The node's `input` is constructed as for every node, validated against
`input_schema` (`schema_validation` with the adapter code `compute_input_invalid`; nothing is
called), and serialized as **RFC 8785 canonical JSON** (JCS) in UTF-8: both runtimes produce the
same bytes for the same value, so a module sees identical input everywhere.

C-22. **`alloc`.** The host calls `alloc(len)` with the input's byte length (never zero: a JSON
value is at least one byte). The module returns a nonzero pointer `p` with `p + len` inside its
memory, which the host then fills with the input. Any other answer is an `abi_violation` (detail
`alloc`). `alloc` may grow the memory within its declared maximum and the call's page bound.

C-23. **The function.** The host calls `<function>(p, len)`. The result `r` is one i64 read as
unsigned 64 bits: `out_ptr = r >> 32`, `out_len = r & 0xFFFFFFFF`. The function may grow the
memory; the host re-reads the memory's size after the call.

C-24. **The output range.** `out_len` is at least 1 and `out_ptr + out_len` is inside the memory
after the call (`abi_violation`, detail `output_range`); an output longer than 64 MiB is refused
unread (detail `output_too_large`).

C-25. **The output text.** The bytes are one strict JSON text read by the runtime's own reader
(UTF-8 without BOM, no duplicate member names, no NaN or Infinity, bounded nesting) or the call
fails `output_not_json`; the value is then validated against `output_schema` (`schema_validation`
with the adapter code `compute_output_invalid`) and becomes the node's result, which the usual
`writes` carry into state.

C-26. **Nothing else.** The host passes no argument but the input, calls no export but `alloc`,
the named function and (implicitly) the start function, and reads no memory but the output range.
A module has no clock, no entropy, no identity of the host or the run, no environment, no way to
learn whether it runs in fixture or live mode.

C-27. **Concurrency.** Calls in one wave may run in parallel, each on its own instance; the wave
and map rules of workflow.v0 §6 are unchanged. A call does not hold the interpreter's event loop
(the reference runs it on a worker thread; Chrome in a Worker).

C-28. **Cancellation.** A cancelled run abandons the call; the engine stops it at the latest at
the call's wall bound. The audit records `compute.failed` with `error: CancelledError` (the
reference) and the node fails `cancelled`.

C-29. **The start function**, when present, runs at instantiation under the same page, fuel and
wall bounds as the rest of the call; a trap or a bound reached there is reported as for the
function.

## 5. Limits

C-30. Three figures bound every call: **memory pages** (the memory's size, in 64 KiB pages),
**wall seconds** (elapsed time from instantiation to return) and **fuel** (instructions, on an
engine that meters them). Every engine has the first two; fuel is `null` where the engine does
not meter (D-244), and the wall bound is then the only CPU bound.

C-31. **Memory.** The module's declared maximum (C-15) must be **at most** the effective page
bound; otherwise the run is **refused before it starts** (`compute_limit_exceeded` from the
reference's preflight, `execution_compute_limit_exceeded` from an execution host), never run with
a lowered memory, because a module whose growth fails behaves differently from the one the
publisher tested (a bound that refuses instead of lowering, like `max_output_tokens_per_call`).
Within the bound, growth that the engine refuses returns −1 to the module as the format says, and
the module decides what to do (the example modules abort).

C-32. **Wall time.** When the bound passes, the engine interrupts the call (`deadline`): the
reference by an epoch deadline advanced every 10 ms, Chrome by terminating the Worker. The node's
own `timeout_seconds` and the workflow deadline still apply around the call and give `timeout`.

C-33. **Fuel.** On the reference, the store is given the fuel bound and the call ends
`fuel_exhausted` when it is spent; `compute.completed` and `compute.failed` carry what was
consumed, which is deterministic for a deterministic module (the same input gives the same
figure). After a deadline the engine's figure is stale and none is reported.

C-34. **A node only lowers.** The effective bound of a call is `min(host, node)` for each figure
the node declares; a node figure above the host's is ignored (`compute.called` records the
effective limits, so the audit says what applied).

C-35. **Host defaults and maxima** (D-242):

| Figure | Default | Maximum a host may set | Where measured |
|---|---|---|---|
| `memory_pages` | 1,024 (64 MiB) | 65,536 | — |
| `wall_seconds` | 10 | 300 | — |
| `fuel` | 5 × 10¹⁰ | 10¹² | wasmtime 49 charges 5 units per iteration of a counting loop and burns about 6.5 × 10⁹ units per second of it on an Apple M3 Max: the default is about eight seconds of the simplest code there, more of anything heavier, and the same figure on every machine, which wall time is not. |

C-36. **Host keys.** The reference's `Runtime(limits=…)` and `agentpkg run --limits` take
`compute_memory_pages`, `compute_wall_seconds`, `compute_fuel`; an execution host's limits carry
the same three (`HostExecutionLimits`, shown under `limits.host` of the run record beside the
other host bounds). A host's figure above the maximum is refused, as every host limit is. A
package declares no compute budget: there is no per-run total in v0 (§12).

## 6. Failures

C-40. A compute operation fails with one of workflow.v0's codes, or the one this profile adds:

| Code | When |
|---|---|
| `compute_error` (new) | The module's own failure: a trap, exhausted fuel, a passed deadline, an ABI violation, output that is not one JSON text, instantiation the engine refused. |
| `schema_validation` | The constructed input outside `input_schema` (before the call), the output outside `output_schema` (after it). |
| `permission_denied` | The `compute` permission denied or spent, a module or function the graph does not declare. |
| `timeout` | The node's or the workflow's deadline around the call. |
| `cancelled` | The run cancelled during the call. |

C-41. **Reasons.** `compute.failed` names why, with one of: `trap`, `fuel_exhausted`, `deadline`,
`abi_violation`, `instantiation_failed`, `output_not_json`, `compute_input_invalid`,
`compute_output_invalid`; `abi_violation` adds `detail` (`alloc`, `result`, `output_range`,
`output_too_large`). `node.failed` and `workflow.failed` for a `compute_error` carry
`compute: {reason, trap_code?, detail?}`.

C-42. **Traps.** A `trap` carries `trap_code` from this vocabulary, each engine mapping its own
names onto it: `unreachable`, `memory_out_of_bounds`, `stack_overflow`,
`integer_division_by_zero`, `integer_overflow`, `bad_conversion_to_integer`,
`indirect_call_to_null`, `bad_signature`, `table_out_of_bounds`, `null_reference`, `other`.

C-43. **What a message carries.** Codes, reasons, the module id and hash, the function, byte
counts, the figures of §5. Never the module's output bytes, never the input: a module that fails
by writing text has written nothing anyone reads.

## 7. Audit

C-44. `compute.called` precedes every call that reached the engine: `module`, `module_sha256`,
`function`, `input_hash` (the digest of the constructed value), `input_bytes`, `limits` (the
effective three, C-34), `permissions`. The permission check that authorized it precedes it
(`permission.checked`), as for a tool. Every event of a call, its permission checks included,
carries the `node_id` of the operation it serves: the node's id, or `<map>/<step>` for a map step,
on the coordinator as on a worker. The coordinator's one context serves every coordinator node, and
a wave runs them concurrently, so an implementation takes the identity from the operation, never
from state stored on that shared context.

C-45. `compute.completed`: the identity, `output_hash` (the digest of the parsed value),
`output_bytes`, `memory_pages` (the memory's size after the call), `engine: {id, elapsed_ms,
fuel_consumed}` and `status: "ok"`. `engine.id` names the engine and its version
(`wasmtime-py/49.0.0`); `fuel_consumed` is `null` on an engine that does not meter.

C-46. `compute.failed`: the identity, `error` (the exception's name), `status: "error"`, the
reason of C-41 with its facts, and, when the engine ran, `memory_pages`, `output_bytes` and
`engine`. A failure before the engine (the permission, the input schema) carries the reason and
nothing of the engine.

The run's `usage` gains `compute_calls` exactly when the graph declares modules, so every earlier
package's usage is unchanged. When two runtimes' audits are compared (the conformance suite, D-063),
`engine` and `limits.fuel` are dropped and `memory_pages` is compared: it is a property of the
module's growth, which the format makes deterministic.

## 8. Determinism

C-47. For a module that uses only the admitted instruction set, the same input bytes give the
same output bytes on every conforming engine, with two exceptions the publisher owns: the bit
pattern of a NaN produced by a floating-point operation (the format leaves it open; the reference
canonicalizes it, Chrome's engine may not), and behaviour after a refused `memory.grow`, which
depends on the effective page bound of the call (C-31 makes the module's own maximum the bound
in practice). A module whose output depends on either is not deterministic across engines, and
the conformance suite will show it.

C-48. Fixture mode changes nothing: a module runs for real in every mode (§9). A fixture carries
no answer for a compute node.

C-49. What is **not** promised: elapsed time and fuel are the engine's; a module may legitimately
run slower on one engine and reach the wall bound there; a stack overflow's depth differs between
engines (both report `stack_overflow`).

## 9. Fixture mode and conformance

C-50. In fixture mode the model router and the tool handlers replay the package's fixture; a
compute node **runs its module** on the constructed input, under the same limits and audit as a
live run. The fixture document is unchanged (`workflow-fixture.schema.json` has no compute key).

C-51. The conformance suite (T22) runs the test package `org.webagents.compute-test`
(`examples/compute/compute-test.agent.pkg`, model-free: two compute nodes in one wave and a
compute map step over the example modules) and the cases of §10 on both CLIs, comparing outputs,
exports and audits under D-063 with the exceptions of C-46. Until the Chrome core reaches 0.5.0,
such cases are *pending* when the Chrome CLI refuses the package as too old (by version, or at the
member rule of C-11, which an older runtime reaches first, C-10) and the Python half passed on its
own (D-234 generalized: the runner's `requires`).

C-52. **Without an engine** (the `wasmtime` extra not installed), the reference validates and
inspects a package with modules and refuses to run it before it starts
(`compute_engine_unavailable`; an execution host: `compute_not_supported`).

## 10. Negative cases

Each row is a case of [`cases.json`](../examples/compute/cases/cases.json) (`id`), with the
module it uses (hand-assembled by `build_cases.py`, committed under `cases/modules/`) and the
stage and code both runtimes must agree on. `container`: refused while the archive or tree is
read; `validation`: refused when the package is validated, the message starting with the code;
`preflight`: refused when the run is prepared; `run`: the node fails with the code and
`compute.failed` names the reason.

| N | `cases.json` id | Stage | Code (reason) |
|---|---|---|---|
| N-1 | `module-import` | validation | `module_import` |
| N-2 | `module-no-memory-maximum` | validation | `module_memory_undeclared_maximum` |
| N-3 | `module-two-memories` | validation | `module_memory_count` |
| N-4 | `module-memory-not-exported` | validation | `module_export_missing` |
| N-5 | `module-missing-alloc` | validation | `module_export_missing` |
| N-6 | `module-bad-run-signature` | validation | `module_export_signature` |
| N-7 | `module-shared-memory`, `module-simd`, `module-tail-call`, `module-threads` | validation | `module_feature_refused` (threads, simd, tail-call, threads) |
| N-8 | `module-hash-mismatch` | validation | `module_hash_mismatch` |
| N-9 | `module-undeclared-member` | validation | `module_undeclared` |
| N-10 | `module-unknown-in-node` | validation | `module_unknown` |
| N-11 | `module-unused` | validation | `module_unused` |
| N-12 | `permission-missing`, `permission-resources` | validation | `compute_permission_missing`, `compute_permission_resources` |
| N-13 | `minimum-version` | validation | `compute_minimum_version` |
| N-14 | `limits-below-module` | validation | `compute_limits_below_module` |
| N-15 | `module-too-large`, `module-bad-magic` | container | the member rule (C-11) |
| N-16 | `tampered-archive` | container | `content integrity mismatch` (C-12) |
| N-17 | `memory-over-host-cap` | preflight | `compute_limit_exceeded` |
| N-18 | `engine-unavailable` | preflight | `compute_engine_unavailable` |
| N-19 | `permission-denied` | run | `permission_denied` |
| N-20 | `fuel-exhausted` | run | `compute_error` (`fuel_exhausted`; `deadline` on an engine without fuel) |
| N-21 | `deadline` | run | `compute_error` (`deadline`) |
| N-22 | `trap-unreachable`, `stack-overflow`, `memory-growth-refused` | run | `compute_error` (`trap`: `unreachable`, `stack_overflow`, `unreachable` at the module's 64 pages) |
| N-23 | `output-not-json`, `output-not-utf8` | run | `compute_error` (`output_not_json`) |
| N-24 | `output-zero-length`, `output-out-of-range`, `alloc-returns-zero`, `alloc-out-of-range` | run | `compute_error` (`abi_violation`) |
| N-25 | `output-schema-miss` | run | `schema_validation` (`compute_output_invalid`) |
| N-26 | `input-schema-miss` | run | `schema_validation` (`compute_input_invalid`), nothing called |

The controls `echo` and `with-start` complete. The reference asserts every row
(`agentpkg/tests/test_compute_cases.py`); the catalog v2's compute family starts from this table
(D-189).

## 11. The example modules and their toolchains (D-243)

Two modules show the two ways a publisher writes one; both are built from committed sources with
the build recorded, and both are tier-1 modules the reader accepts.

| Module | Language and toolchain | What it does | Where |
|---|---|---|---|
| `fares` | AssemblyScript 0.28.20 (`npm ci && npm run build`; `asconfig.json`: runtime `stub`, no abort import, memory 1…64 pages, `optimizeLevel` 3, `shrinkLevel` 1) | Fare totals in integer cents with a strict JSON reader and writer of its own; every failed check is a trap | [`examples/compute/fares-as/`](../examples/compute/fares-as/) |
| `bookkeeping` | Rust (`rustup target add wasm32-unknown-unknown`; `./build.sh`: `serde_json`, `opt-level = "z"`, LTO, one codegen unit, `panic = "abort"`, stripped, paths remapped) | `assign_ids` (handles and exact deduplication by normalized DOI, arXiv id, URL or title) and `match_quotes` (whitespace-normalized exact quote search) | [`examples/compute/bookkeeping-rs/`](../examples/compute/bookkeeping-rs/) |

The committed binaries' SHA-256 and the compiler that built them are recorded in
[`examples/compute/README.md`](../examples/compute/README.md); a rebuild with the same compiler and
lockfile reproduces the bytes (checked once for each at the time of writing). The negative modules
of §10 need no toolchain: `examples/compute/cases/build_cases.py` emits them from the binary format
directly, and the test suite regenerates them and asserts the committed bytes.

## 12. Versions, deliberate limits, prior art

**Versions.** agentpkg 0.5.0 implements this document; packages that use it declare
`runtime.minimum_version: "0.5.0"`. The Chrome core implements it at 0.3.0 (T22), its
`SUPPORTED_RUNTIME_VERSION` moving to 0.5.0. The agent.pkg format stays 0.1 with the amendment of
§3.1. The 0.2.2 wheel of the paper line (`paper-cic2026`) is untouched.

**Deliberate limits of v0.** No imports (tier 2, B-185: capability imports shown and approved like
tools); no per-run compute total (each call is bounded; the graph bounds the number of calls:
nodes, and map items by `max_items`); no module-to-module calls, no shared memory between calls,
no streaming output; no module in a legacy-profile package; one memory; 4 MiB per module and 16
modules per graph; wall time up to 300 s per call. The engine is trusted: this profile bounds what
a module can do through the format and the engine's limits, not through an OS sandbox; a bug in
the engine is a bug in the host, and the threat model says so.

**Prior art.** WebAssembly core specification 2.0 (binary format, instructions, memory limits);
WASI and the component model (what tier 2 would import); wasmtime's fuel and epoch interruption;
Extism and similar plugin ABIs (a packed pointer and length in one i64 is a common convention);
RFC 8785 (JCS) for the input bytes.
