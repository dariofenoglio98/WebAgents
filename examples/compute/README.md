# compute.v0 examples

What a package needs to run code under [compute.v0](../../spec/compute-v0.md): two example modules
built from committed sources by real toolchains, the hand-assembled modules of the enforcement
cases, and the test package the conformance suite runs on both runtimes. Nothing here is shipped
in `dist/`; the packages that use modules for real are T22's (Literature Review 0.2.9, WebAir
0.7.0).

| Path | What it is |
|---|---|
| [`fares-as/`](fares-as/) | **AssemblyScript 0.28.20**: fare totals in integer cents, with a strict JSON reader and writer of the module's own. `npm ci && npm run build` writes `dist/fares.wasm` (and `dist/fares.wat`, the same module as text, for reading). |
| [`bookkeeping-rs/`](bookkeeping-rs/) | **Rust** (`wasm32-unknown-unknown`, `serde_json`): `assign_ids` (handles `P1…` and exact deduplication by normalized DOI, arXiv id, URL or title) and `match_quotes` (whitespace-normalized exact quote search). `./build.sh` writes `dist/bookkeeping.wasm`. |
| [`cases/`](cases/) | `build_cases.py` emits the modules of the enforcement cases from the binary format directly (no toolchain); `cases.json` lists every case with its stage and code; `modules/*.wasm` are the committed bytes. |
| `compute-test/`, `compute-test.agent.pkg` | The test package `org.webagents.compute-test` 0.1.0 (model-free: compute nodes over both example modules, in one wave and in a map step), signed 2026-10-17 with the development key `examples/keys/compute-test-publisher.pub.pem` (`sha256:ee5e23fd…f0a9`): package digest `3d174d573a8f7d36be2e4700e5319de280788bec101613816a301e6b2387decd`, archive SHA-256 `8bbbd42a9c50c27b339e00653990449781fac5d58694216c890585561a800ff4`, 134,982 bytes. |

## The committed binaries

Each binary is reproducible from its sources with the compiler named here; the check script
(`scripts/verify_compute.py`) and `agentpkg/tests/test_compute_module.py` read every one with the
reference's module reader, and the hashes below are the ones the graphs declare.

| Module | SHA-256 | Size | Built with |
|---|---|---|---|
| `fares-as/dist/fares.wasm` | `ef7e813b9ac330575c89c75d96aa63bfe25d77da8d3a699cf4718879a8f123c0` | 8,303 bytes | AssemblyScript 0.28.20 (`asconfig.json`, target `release`), Node 26.9.0, 2026-10-16; two builds identical |
| `bookkeeping-rs/dist/bookkeeping.wasm` | `5b9db688c2cf9c60c818ac7eaf748d98ee60b8ecc564d76c37199da68e13735e` | 106,940 bytes | rustc 1.99.1 (58cf8f9c3 2026-10-13), `wasm32-unknown-unknown`, `Cargo.lock` as committed, `./build.sh` (release profile of `Cargo.toml`, paths remapped), 2026-10-16; two builds identical |

## Running one

```sh
agentpkg/.venv/bin/python -m pip install -e './agentpkg[compute]'    # wasmtime, once
agentpkg/.venv/bin/agentpkg run examples/compute/compute-test.agent.pkg --mode fixture \
  --grants examples/compute/compute-test-grants.json --out examples/my-compute-test
```

`audit.json` holds `compute.called` and `compute.completed` for every call, with the module hash,
the effective limits, the bytes in and out, the memory pages and the engine's own figures; the
module runs for real in fixture mode, as in every mode (C-50).
