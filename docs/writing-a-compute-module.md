# Writing a compute module

A package may ship code since agentpkg 0.5.0: a WebAssembly **core module** under `modules/`,
run by `compute` nodes of its `workflow.v0` graph under [compute.v0](../spec/compute-v0.md). The
module is a pure function: it imports nothing, sees one JSON text and returns one JSON text, and
the runtime validates both against schemas the package declares, bounds the call's memory, time
and (on the reference) instructions, and records every call in the audit. This page is the
publisher's side of it: when to write one, what it must look like, how to build it with the two
toolchains the examples use, and how the graph runs it.

## When a module is the right tool

A model answers questions; a tool reaches a service; a module **transforms data exactly**. Use one
for what a model should never be asked (it would be slow, expensive and occasionally wrong) and a
service should not be needed for: exact deduplication and identifier assignment, arithmetic with
money or time, quote matching, sorting and grouping, format conversions, checksums. Literature
Review's bookkeeping and WebAir's fare totals are the shipped examples (T22). Do not use one for
anything that needs the outside world: a tier-1 module has no clock, no randomness, no network,
no file and no host function, by construction (the import section must be empty).

## The contract in one screen

```text
exports:  memory                         the module's own linear memory, maximum declared
          alloc(len: i32) -> i32         a region of len bytes the host writes the input into
          <function>(ptr, len) -> i64    runs on the input; returns (out_ptr << 32) | out_len
input:    the node's constructed value, validated against input_schema, as RFC 8785 canonical JSON
output:   one strict JSON text at out_ptr..out_ptr+out_len, validated against output_schema
limits:   memory pages (the module's declared maximum must fit the host's), wall seconds, fuel
failure:  a trap, exhausted fuel, a passed deadline, an ABI violation, output that is not JSON
          → the node fails compute_error; schema misses → schema_validation
```

Each call is a **fresh instance**: globals and data segments start from the module's bytes, so
there is no `free`, no state between calls and nothing to clean up. A start function, if your
toolchain emits one, runs at instantiation inside the call's limits. Signal failure by trapping
(`unreachable`, an abort): a module never returns half an answer, and the runtime records the
trap by name without any text the module wrote.

Allowed instructions: the WebAssembly MVP plus sign extension, non-trapping float-to-int, bulk
memory, multi-value, reference types and mutable globals. SIMD, threads, GC, exceptions, tail
calls, memory64 and multi-memory are refused at validation by name. Floats are allowed; a result
that depends on a NaN's bit pattern is not portable between engines.

## Declaring it in the package

```json
// graph.json (excerpt)
"modules": [
  {"id": "fares", "path": "modules/fares.wasm", "sha256": "<sha256 of the file>"}
],
"nodes": [
  {"id": "totals", "type": "compute", "worker": "Coordinator", "depends_on": [],
   "module": "fares", "function": "run",
   "input": {"from": "state", "path": "/request/fare"},
   "input_schema": "schemas/fare-input.schema.json",
   "output_schema": "schemas/fare-output.schema.json",
   "timeout_seconds": 30,
   "limits": {"wall_seconds": 2},
   "writes": {"/totals": {"from": "result", "path": ""}}}
]
```

```json
// policy/policy.json (excerpt): exactly one permission of kind compute, naming every module
{"id": "compute.modules", "kind": "compute", "required": true,
 "description": "Run the package's WebAssembly modules, which can only compute.",
 "resources": ["fares"]}
```

And `runtime.minimum_version` at least `0.5.0` in `MANIFEST.agent`. The hash in the graph must be
the file's; every `.wasm` member must be declared; every declared module must be run by a node;
a node's `limits` can only lower the host's bounds and may not name less memory than the module's
own maximum. `agentpkg validate` tells you which rule a package breaks, by its code.

## Building one

**AssemblyScript** ([`examples/compute/fares-as/`](../examples/compute/fares-as/)): `npm ci` and
`npm run build`. The options that matter are in `asconfig.json`: `"runtime": "stub"` (a bump
allocator, enough for one call per instance), `"use": ["abort="]` (no `env.abort` import: a failed
assertion becomes `unreachable`), `"initialMemory": 1, "maximumMemory": 64` (the declared maximum
the host checks), `"exportStart": false` (the compiler's start function runs at instantiation).
The example carries its own strict JSON reader and writer in about 250 lines; a transform like
fare totals needs no library.

**Rust** ([`examples/compute/bookkeeping-rs/`](../examples/compute/bookkeeping-rs/)):
`rustup target add wasm32-unknown-unknown`, then `./build.sh`. `Cargo.toml` makes a `cdylib` with
`panic = "abort"` (a panic traps instead of unwinding), `opt-level = "z"`, LTO, one codegen unit
and stripped symbols; `serde_json` reads and writes the JSON; `std::process::abort()` is the
module's refusal. The build script remaps paths so the binary carries nothing of the machine that
built it.

Either way, **record the compiler and the SHA-256** of the binary you commit (the examples do so
in [`examples/compute/README.md`](../examples/compute/README.md)) and build twice before you sign:
the bytes must match, because the hash in the graph is what the agent page shows and what the
runtime runs. Check a module before packaging it:

```sh
agentpkg/.venv/bin/python -c 'from agentpkg.compute import check_module; import sys
print(check_module(open(sys.argv[1], "rb").read(), functions=("run",)).as_json())' modules/fares.wasm
```

## What the person sees and what the runtime enforces

The agent page states the permission in words ("runs code that can only compute") with each
module's id, hash and functions; the person grants it like any other permission, and presets or a
policy subscription may deny the kind. Before the run, the host checks that every module's
declared memory fits its ceiling and that it has an engine at all; it refuses rather than lowering
a module's bound. During the run, every call is `compute.called` and `compute.completed` (or
`compute.failed` with the reason) in the audit, with the effective limits and the bytes in and
out; in fixture mode the module runs for real. The enforcement cases both runtimes must refuse
identically are listed in [`examples/compute/cases/cases.json`](../examples/compute/cases/cases.json)
and demonstrated by `scripts/verify_compute.py`.
