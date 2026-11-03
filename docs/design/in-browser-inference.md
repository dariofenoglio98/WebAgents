# In-browser inference: the default local route

*Design document, T40 (2026-11-02). Status: at the gate. Decisions D-440…D-448 are recorded in
`DECISIONS.md` when the gate approves them; the build is T41.*

A person installs the extension once. From then on, a package that needs a model can run on an
open-weight model that the extension itself executes on the machine's GPU, inside the browser,
with no Ollama, no helper and no server (D-310, D-311). The model's weights are a visible,
evictable browser cache, never an installation. This document settles what T41 builds: the engine,
where it runs, the contract the core sees, the catalog, the recommendations, consent and cache, the
route card's words, the installer, the Web Store reading and the risks. Every fact marked
**[measured]** comes from the spike report `examples/verification/chrome-inbrowser-spike-t40.json`
(headless Chrome 156.0.8078.48 on this M3 Max, 36 GB), **[V]** from a primary source read on
2026-11-02, **[S]** from a secondary source, **[U]** is unverified.

The vision in one sentence (`private/documents/program/vision.md` §1): *an agent published anywhere
runs in any person's agent browser, with that person's own model, memory, tools and money, under
that browser's rules, with nothing installed and nothing left behind except what the person chose
to keep.* The web's answer to "where does the program run" is the browser's own engine on the
person's hardware; the agent web's answer to "where does the model run" must be the same.

## 1. Requirements from the contract

The route is one more `ProviderAdapter` behind the bound router (`src/core/models/router.ts`), so
everything the contract already demands of Ollama, OpenAI, Anthropic and the built-in model holds
here unchanged:

| Requirement | Where it comes from | What the engine must give |
|---|---|---|
| Structured output under JSON Schema | every `llm` node has an `output_schema`; the router requests a constrained answer, then parses and validates against the full package schema, failing closed (D-062; `structured_output` is `derived` for every route) | a constraint derived from the bundled schema (`schema-format.ts::constraintSchema` with this route's rules); the answer text alone, no fences |
| The re-ask loop | up to two re-asks with a `feedback` line when an answer is not accepted (D-150, D-151) | a fresh completion per ask, no state between calls |
| Context windows | the packages declare 16,000 tokens per task (WebAir 0.8.0, Literature Review 0.2.9); the runtime reserves `utf8 bytes + max_output_tokens` per call and refuses a call above the bound model's context (D-055); Literature Review's heaviest PDF calls need up to 65,536 (STATE.md §5) | a context chosen at load (`n_ctx`), reported as the binding's `context_tokens`, never exceeded silently |
| The compatibility facts | `compatibility.ts` evaluates `capabilities.structured_output`, `capabilities.reasoning`, `limits.context_tokens`, `properties.local` with a basis each (`declared`, `host_default`, `derived`, `absent`) | one descriptor per catalog entry with those facts and their basis (§4) |
| Usage accounting | `usage.ts::projectUsage`: a completion with neither a total nor both counts is `model_usage_unavailable` and the runtime charges the whole reservation; reasoning tokens must be in the output count (principle 7) | the engine's own prompt and completion counts, thinking tokens included |
| Budgets | the plan's token and call budgets; `max_output_tokens` per node | the cap enforced by the engine (`max_tokens`); a `length` finish fails the node as truncated |
| Cancellation and timeouts | the router's per-request deadline (`DEFAULT_REQUEST_TIMEOUT_SECONDS`), a run's cancel (`host.cancel`) | an abort that stops generation at once **[measured: 306 ms after the request, 2,000-token budget]** |
| No silent fallback | principle 6: a model that is not available refuses the run with the reason | a load that fails or does not fit refuses before the run; never another model |
| Determinism | not required (the answer is the model's; the authority is the contract's) | temperature 0 by default; nothing promised |
| Privacy | the person's data goes to the bound model only; the observer (D-028) sees every request | the request never leaves the extension; the observer still sees it (§4) |

## 2. Engine matrix

Versions read from the npm registry on 2026-11-02 **[V]**.

| | wllama (llama.cpp on WebGPU) | WebLLM / MLC | Transformers.js v4 |
|---|---|---|---|
| Version, date, licence | 3.8.1, 2026-10-02, MIT | 0.2.87, 2026-10-30, Apache-2.0 | 4.3.2, 2026-10-27, Apache-2.0 (+ onnxruntime-web 1.31.1, MIT) |
| What it runs | **any GGUF file llama.cpp supports** (the bulk of open-weight releases on Hugging Face ship GGUF) | models compiled by MLC only: 167 prebuilt entries (`config.ts`) | ONNX exports only (`onnx-community`); about 200 architectures |
| Structured output | `response_format.json_schema` on the OpenAI-compatible chat API, converted to a grammar **inside the engine** (llama.cpp's `oaicompat_chat_params_parse`); grammar-constrained sampling **[V, measured]** | `response_format: {type: "json_object", schema}` through XGrammar in the wasm model library **[V]** | experimental `@huggingface/transformers-structured-output` (v4.3, 2026-09-16), a logits processor; "one generated sequence at a time" **[V]** |
| Code that ships | one wasm, 8,763,949 bytes (`esm/wasm/wllama.wasm`, SHA-256 `551f1343…`), plus a 375 KB bundle; **no eval, no `new Function`** **[measured: `engine.bundle_has_eval` false]** | the runtime (6.5 MB `lib/index.js`) and **one wasm model library per model, fetched at run time from `raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/`** (`modelLibURLPrefix`, `v0_2_87/base`) **[V]** | the runtime plus ORT's wasm (bundled or from a CDN); the WebGPU runtime rewritten in C++ **[V]** |
| WebGPU features needed | runs on the core limits; uses f16 and subgroups when present (LlamaWeb kernels) | `shader-f16` for the `q4f16` entries | WebGPU EP; threads want cross-origin isolation |
| Speed (this machine) | **[measured]** Qwen3-0.6B Q4_0: prefill 483 tok/s, decode 87 tok/s, load 2.5 s from a local file; §11 for the 4B class | Llama-3.1-8B q4f16: 41 tok/s on an M3 Max (arXiv 2412.15803) **[V]**; LlamaWeb: wllama decodes about 54 % faster than WebLLM, prefills at 49 % of it (arXiv 2605.20706) **[V]** | gpt-oss-20B q4f16 about 60 tok/s on a top M4 (vendor post) **[V]** |
| Per-file limits | README: 2 GB per file ("ArrayBuffer restriction"), split with `llama-gguf-split` **[V]**; verified against the 2.5 GB Qwen3-4B file in §11 | model artifacts are sharded by MLC | ONNX external data above 2 GiB |
| Maintenance | llama.cpp synced per release; a research paper (LlamaWeb, UCSC and MSR) on its WebGPU kernels | MLC team; model list refreshed per release | Hugging Face with the ONNX Runtime team |
| Worker model | creates its Worker from a `blob:` URL of bundled code; **runs under the extension's CSP** **[measured: blob and nested blob Workers run on `chrome-extension://`, WebGPU inside]** | `WebWorkerMLCEngine` over a Worker the caller creates | ORT spawns its own |
| Remote-code reading (§10) | wasm bundled, weights are data: **clean**; the bundle carries two `cdn.jsdelivr.net` string constants for the Firefox/Safari compat build, never fetched in Chrome **[measured: `bundle_remote_urls`]** | **a model library wasm fetched from GitHub at run time is remote code**; bundling 5 curated libraries costs about 10–25 MB in the zip and still runs only MLC models | ORT wasm must be bundled (default is a CDN) |

**Recommendation (D-440): wllama 3.8.1 is the v1 engine, the only one.** Three facts decide it.
(1) It is the only engine that runs *any* open-weight GGUF, which is what D-311 promised the person
("any open-weight model"). (2) Its structured output is llama.cpp's own JSON-schema grammar, the path
Ollama's `format` already uses for the accepted local Literature Review runs, and the spike shows it
holds the contract: a WebAir `interpret` answer valid against `plan.schema.json` on a 0.6B model,
with and without thinking **[measured]**. (3) It ships as one wasm the extension bundles, with no
run-time code fetch, so the Web Store reading is clean. WebLLM is faster at prefill on its curated
set but fetches a per-model wasm library from GitHub at run time, which is remote code under the
Manifest V3 policy unless every curated library is bundled; Transformers.js's structured output is
experimental and ONNX-only. Both stay candidates for a later *curated fast engine* behind the same
port (B-270): the adapter contract names the engine per catalog entry (`engine: "wllama"`), so a
second engine is a new entry format, not a new route.

Pinned: `@wllama/wllama` 3.8.1 exact (`package.json` `devDependencies` for the spike; T41 moves it
to `dependencies`), its wasm SHA-256 `551f13439366eff11e057b1b91fe46a7fdac29d56d67372d4c5f19a549dfe70c`
recorded in the report and asserted by `check-pack` once it ships.

## 3. Placement and lifetime

**Where (D-441).** One *engine Worker* inside the offscreen document `execution.html`, the context
where runs already execute (D-070). The spike proves the "[U]" of `feasibility/inference.md`:
a dedicated Worker of the offscreen document has `navigator.gpu`, gets the Metal adapter (not a
fallback) with `shader-f16`, `subgroups`, `subgroup-size-control`, `timestamp-query`,
`maxBufferSize` and `maxStorageBufferBindingSize` 4,294,967,292 bytes, and a device
**[measured: `probe`]**; wllama's own Worker, nested inside it from a `blob:` URL, runs the wasm and
the WebGPU kernels there **[measured: `load`]**. Headless Chrome needs no flag: `navigator.gpu` is
absent only on non-secure contexts (the first probe used an opaque `about:blank`), and the extension
origin is a secure context.

**Who creates it.** The offscreen *page* (`execution-page.ts`), not a run's Worker: the engine must
outlive a run so that the next run finds the model loaded (a 5 GB model takes seconds to tens of
seconds to load from the cache; the spike's 0.6B took 2.5 s from a served file and 1.1 s on
reload **[measured]**). `execution-page.ts` gains an `EngineHost` that owns at most one engine Worker
and knows which catalog entry it holds.

**How a run reaches it.** At `host.start`, when the plan's binding is `in-browser/<entry>`, the page
asks the `EngineHost` to ensure that entry is loaded (load it from the cache if the slot is free or
holds another model that no run is using; refuse if a run is using another model, with
`model_unavailable` and the reason "another in-browser model is in use by run …"), then creates a
`MessageChannel` and transfers one port to the run's Worker inside the start message. The run's
Worker wraps it as the core's `InBrowserEnginePort` (§4), exactly as `builtin-port.ts` wraps the
Prompt API. The run Worker never spawns an engine; it only talks over the port. A run on a different
route gets no port.

**Single slot, serial calls (v1).** One model loaded at a time; one completion at a time (requests
queue in arrival order; a map step's parallel workers wait, as they did behind Ollama's single slot,
STATE.md §5). llama.cpp's `n_parallel` could serve several sequences later (B-271).

**Lifetime.** The model stays loaded while the offscreen document lives (no time limit, STATE.md
§10) until: the person unloads it (Settings → Models → "Unload"), an idle timeout passes (default
10 minutes after the last run; a setting), a run needs another entry and no run uses the loaded one,
or the extension unloads. A Worker that dies (out of memory: Chrome kills the renderer, "Aw, Snap")
is reported by `onerror`; the run in flight fails `model_unavailable` with reason
`engine_worker_died`, the `EngineHost` marks the entry "failed to run at <context>; try a smaller
context or model" and never retries by itself (principle 6).

**GPU memory budget and "does it fit".** No web API reports GPU memory, and a load that does not fit
ends as a dead Worker or a crawl, not an error. The design is therefore *estimate before, measure
after*: before a load, `estimate = weights bytes + KV cache bytes + overhead` where
`KV = 2 × n_layer × n_ctx × n_kv_heads × head_dim × 2 bytes (f16)` from the GGUF header (read by the
shell from the cached file's first bytes: the GGUF key-value section lists `*.block_count`,
`*.attention.head_count_kv`, `*.embedding_length`, `*.context_length`), overhead 15 % of the weights
plus 512 MB; the budget is the machine class of §6; a load whose estimate exceeds the budget is
refused *before the run* with both numbers in the message. After a successful load, the entry
records "ran at n_ctx N on this machine" (`measured`), which outranks the estimate next time.

**Context at load.** `n_ctx` is the entry's **chosen context**: the person's choice in Settings
(default: the recommendation's largest value that fits, capped at the model's training context
`n_ctx_train` and at 65,536), the plan's `context_tokens`. The runtime's reservation (D-055)
refuses a call above it, as it does for Ollama's 32,768 cap today. Changing the chosen context
changes the descriptor, so a frozen plan re-verifies against it (the existing re-verification).

**Thinking.** The existing "Let local models think" switch (D-085) maps to wllama's `reasoning`
load parameter; thinking tokens are separated by the engine (`reasoning_content`), the grammar
binds the answer, and the completion count includes them **[measured: 425 completion tokens with
thinking vs 179 without, both schema-valid]**. Changing the switch reloads the model.

## 4. The adapter contract in the core

`src/core/models/adapters/in-browser.ts` (this task ships the interface, the errors, the usage
mapping, the facts and a fixture port; T41 ships the shell's port):

```ts
export interface InBrowserEnginePort {
  /** What the engine holds now; never loads. */
  status(): Promise<{ loaded: string | null; busy: boolean }>;
  /** One completion on the loaded entry; refuses `model_unavailable` when `entry` is not the loaded one. */
  complete(request: InBrowserCompletionRequest, signal: AbortSignal): Promise<InBrowserCompletion>;
}
export interface InBrowserCompletionRequest {
  entry: string;                    // the catalog entry id the plan bound
  system: string; user: string;     // the rendered request (render.ts), as for every adapter
  schema: JsonObject | null;        // the constraint copy (schema-format.ts, GGUF_GRAMMAR_RULES)
  max_tokens: number;               // the node's cap; the engine stops there
  think: boolean;                   // D-085 as the engine was loaded
}
export interface InBrowserCompletion {
  text: string | null;              // the answer (content only; reasoning stays in the engine)
  finish_reason: "stop" | "length" | "abort" | string | null;
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null };
  timings: { prompt_per_second: number | null; predicted_per_second: number | null } | null;
  constrained: boolean;             // whether the engine applied the grammar
}
```

`InBrowserAdapter implements ProviderAdapter`: `provider_id = "in-browser"`, `model_id` = the entry
id, `host_model_id = "in-browser/<entry>"`, `remote = false`, `domains = []`, `pricing = null`,
`context_window` and `reasoning` from the binding (D-130: never a default), `thinking` as the switch.
`complete` builds the constraint with `GGUF_GRAMMAR_RULES` (keywords as given, objects not closed,
array roots allowed: llama.cpp's converter takes the schema as is; the spike's schema used `enum`
with `null`, type lists, `pattern`, `minimum`/`maximum`, `minLength`/`maxLength`, `required`,
`additionalProperties: false` **[measured: valid]**), calls the port, maps the answer: `finish_reason
"length"` → stop reason `length` (the router fails the node as truncated); `usage` through
`projectUsage` (a missing count is `model_usage_unavailable`, never zero); `constrained` true with the
detail "llama.cpp grammar from the bundled output schema; the answer is parsed and validated by the
router regardless". **Prompt cache off** for the accounting: with it on, the engine's `prompt_n` counts
only uncached tokens **[measured: `prompt_n` 1, `cache_n` 2916 on the second call]**; the non-streamed
`usage.prompt_tokens` with `cache_prompt: false` equals the streamed `prompt_n + cache_n`
**[measured: 2,913 = 2,913 + 0]**. T41 may turn the cache back on once the adapter reports
`prompt_n + cache_n` as the input count (a re-ask repeats the prompt, where the cache pays).

**Errors** (`AdapterError` codes already in the vocabulary): `model_unavailable` (no port, the entry
is not loaded, the engine died: detail `engine_worker_died`), `model_request_invalid` (the request
does not fit `n_ctx`: the engine's error, after the runtime's own reservation check),
`model_usage_unavailable`, `model_response_invalid` (no text). No `model_transport_error`: there is no
transport.

**The facts the descriptor reports** (`catalog.ts::inBrowserDescriptor(entry, cache state,
machine)`): `id: "in-browser/<entry>"`, `available` when the weights are cached, verified and the
estimate fits (else `availability_reason` says which: "not downloaded (2.5 GB)", "digest mismatch:
delete and download again", "needs about 7.1 GB of GPU memory; this machine's budget is 6 GB"),
`selectable` as `available`; `capabilities.structured_output` **derived** (the grammar plus the
router's validation), `capabilities.reasoning` **declared** from the entry (`reasoning: true` for the
Qwen3 family, as Ollama's `/api/show` declares `thinking`; a person's override in Settings stays
`declared`), `tool_use` absent; `limits.context_tokens` = the chosen context (`declared`),
`native_context_window` = `n_ctx_train`, `max_output_tokens` = the override or null; `properties`
`local: true`, `privacy_class: "local"`, `cost_class: "free"`, `status: "cached" | "not_downloaded" |
"loaded"`, tags `["local", "in-browser", "gguf", "curated" | "uncurated", "limits:settings"?]`.

**Transport facts and the observer.** The route has no `HttpTransport`: no URL gate, no address
policy, nothing to refuse. The `ModelRequestObserver` (D-028) is still called with
`provider_id: "in-browser"`, `url: "in-browser:<entry>"` and the request body, so the live
harness's "no sealed value in any model request" assertion covers this route too, and test mode
records the request. The egress view (T44) shows the route as **"stayed in this browser: no outbound
call"**, from the absence of any `model.called` destination, not from a claim the adapter makes.

**Fixture implementation.** `FixtureInBrowserPort` answers from a table keyed by `(entry, sha256 of
system + user)` with recorded usage, for the adapter's tests; the core's boundary test
(`test/core/boundary.test.ts`) keeps `navigator`, `self` and WebGPU out of `src/core`: the port is
the only thing the core knows.

## 5. The catalog

**Entry format (D-442)**, `agentpkg-in-browser-model-v0`, one JSON object:

| Field | Meaning |
|---|---|
| `id` | `[a-z0-9][a-z0-9.-]{1,63}`, e.g. `qwen3-4b-q4_k_m` |
| `display_name`, `family`, `parameters` | "Qwen3 4B (Q4_K_M)", `qwen3`, `4000000000` |
| `format`, `engine`, `quantization` | `gguf`, `wllama`, `Q4_K_M` |
| `files[]` | in load order: `{ name, url, bytes, sha256 }`; a split model lists every part |
| `weights_digest` | §4 of D-447: the canonical hash of the sorted file digests |
| `bytes_total` | the sum |
| `context` | `{ train: n_ctx_train, default: the recommended chosen context, max: min(train, 65536) }` |
| `capabilities` | `{ structured_output: true, reasoning: boolean, tool_use: null }` (the engine gives the first; the family the second) |
| `license` | `{ id: "apache-2.0", name, url }` as the repository's model card states it |
| `source` | `{ repository: "Qwen/Qwen3-4B-GGUF", revision: "main", api: "https://huggingface.co/api/models/…" }` |
| `curated` | `true` for the signed list, `false` for a pasted repository |
| `gpu_memory_estimate_bytes` | at `context.default`, by the §3 formula, from the header values recorded in the entry (`n_layer`, `n_kv_heads`, `head_dim`) |
| `notes` | one line: what it is good for, what it is not |

**The curated list is a signed document**, like the index and the policy bundles (D-442: the
project's `webagents-catalog` key, `document sign --type model-catalog`, `version` monotone, shipped
inside the extension and refreshable from the project's origin). A newer list can add, change or
remove entries; it widens nothing: an entry names weights by hash and a licence, and the person still
clicks the download. Refusing a stale or unsigned list falls back to the shipped one.

**Curated entries for v1**, chosen for the machine classes of `feasibility/inference.md` §8, all
Apache-2.0, all from repositories that publish per-file SHA-256 (sizes and digests read from the
Hugging Face API on 2026-11-02 **[V]**; the exact hex goes into the signed list from the API, never
typed):

| Entry | Repository and file | Bytes | Class | Why |
|---|---|---|---|---|
| `qwen3-0.6b-q4_0` | `ggml-org/Qwen3-0.6B-GGUF` `Qwen3-0.6B-Q4_0.gguf` | 428,970,080 | everywhere | the smoke and demo tier; the spike's model **[measured]** |
| `qwen3-4b-q4_k_m` | `Qwen/Qwen3-4B-GGUF` `Qwen3-4B-Q4_K_M.gguf` | 2,497,280,256 | 16 GB | the default on a 16 GB machine; §11 for its measurement |
| `qwen3-8b-q4_k_m` | `Qwen/Qwen3-8B-GGUF` `Qwen3-8B-Q4_K_M.gguf` | 5,027,783,488 | 16 GB (tight), 24 GB+ | the 7–9B class of §8 |
| `gpt-oss-20b-mxfp4` | `ggml-org/gpt-oss-20b-GGUF` `gpt-oss-20b-MXFP4.gguf` | 12,109,566,624 | 32 GB+ | the 20B MoE class |
| `qwen3-30b-a3b-q4_k_m` | `Qwen/Qwen3-30B-A3B-GGUF` `Qwen3-30B-A3B-Q4_K_M.gguf` | 18,556,685,824 | 36 GB+ | the family of the only local model that met Literature Review's exact-copy contract (`qwen3:30b`, STATE.md §5) |

Whether the entries above 2 GiB need split files is settled by the 4B measurement in §11; the
policy either way: **the catalog never re-hosts weights.** An entry points at the publisher's own
repository; if a file is too large for the engine and the repository ships no split, the entry is
not curated until it does (an upstream request, not a mirror).

**"Paste a Hugging Face repository."** The person pastes `owner/repo` (or the page's URL). The
shell asks `https://huggingface.co/api/models/<owner>/<repo>?blobs=true` (one declared destination,
host permission requested at the first paste with Chrome's prompt; the API answers CORS), lists the
`.gguf` files with their sizes and LFS SHA-256, shows the model card's `license`, and marks the
model **gated** if the API says so (a gated file needs a token: not supported in v1). The person
picks a file; the shell reads the GGUF header after the download for the context and layer facts
(the API has no header), builds an entry with `curated: false`, `reasoning` from a family table
(`qwen3`, `deepseek-r1`, `gpt-oss` → true; else absent, the person may state it), and the card says
"Not reviewed by WebAgents: check the licence and the model's quality yourself." Only
`huggingface.co` in v1; a second host is a new declared destination (B-272).

## 6. Recommendations

**Inputs the runtime can know (D-443)**, each recorded with its basis:

| Input | Source | Basis |
|---|---|---|
| GPU vendor, architecture, features, limits | `navigator.gpu.requestAdapter()` in the engine Worker | measured |
| Memory hint | `navigator.deviceMemory` (8 GB cap on web pages; the extension context reported 32 on this 36 GB machine **[measured]**; treated as a hint either way) | hint |
| Storage free | `navigator.storage.estimate()` (quota 64.8 GB here **[measured]**) | measured |
| A short kernel benchmark | a fixed WebGPU matmul (f16 when available, 2 × 512×512×512, under 300 ms) once per session; the result is a bandwidth class, not a tok/s promise | measured |
| Measured speed per entry | after each load: prefill and decode tok/s of the first completion, kept per entry per machine | measured |
| The package's requirements | the existing compatibility evaluation (`compatibility.ts`) | declared |
| The person's statement | Settings → Models → "This machine's GPU memory", optional | declared |

**The GPU memory budget** (the number that decides "fits"): the person's statement when given; else
by platform from the adapter's `vendor`/`architecture` and the hint: Apple Silicon `0.65 ×
max(hint, 8 GB)` (the Metal working set is about two thirds to three quarters of RAM **[S]**),
elsewhere a conservative `6 GB` until the person states more (an 8 GB discrete card, an integrated
GPU: §11). The number is shown with its basis next to every verdict ("budget 6 GB, assumed; state
your GPU memory in Settings to change it").

**The algorithm** ranks every entry (curated and pasted) into three bins with reasons:

1. `estimate = gpu_memory_estimate_bytes(entry, context)`; `context` = the largest of the entry's
   `context.default`, then halves down to 4,096, at which the estimate fits `0.8 × budget`.
2. **too large**: no context fits, or `bytes_total > storage free − 1 GB`. Reason: the numbers.
3. **possible**: fits; the package's requirements evaluate `compatible` or `unverified`; no
   measured speed yet, or measured decode under 8 tok/s, or the context that fits is below the
   package's declared need.
4. **recommended**: fits at the package's declared context (16,000 for the shipped packages) with
   `compatible`; measured decode ≥ 8 tok/s when measured, else the kernel class is "fast" or
   "medium"; already cached entries rank first, then smaller `bytes_total`.

The picker shows the bins with the reasons; nothing downloads by itself. The default suggestion on
a fresh install is the smallest **recommended** curated entry for the opened package.

## 7. Consent and cache

**Download (D-444).** A download starts only from the person's click on a card that shows: the
name, `bytes_total` ("2.5 GB"), the licence with its link, the repository, the number of files, the
digest list (collapsed), the storage free before and after, and the budget verdict. Progress per
file; **resume** with HTTP `Range` where the server answers `206` (Hugging Face does), restarting the
file otherwise; **every file's SHA-256 is computed while streaming** (`@noble/hashes` sha256,
incremental, already a dependency) and compared with the entry's before the file is kept; a
mismatch deletes the file and shows "the bytes did not match the digest the catalog states", never
"try anyway". The shell's own downloader writes the file into the extension's **Origin Private File
System** under `models/<sha256>` (OPFS, `unlimitedStorage`), not wllama's cache: its cache verifies
size only and keys by URL; ours keys by digest, which is what provenance (T42) and Cross-Origin
Storage (§7, D-448) both want. Loading hands the OPFS file handles to the engine as Blobs
(`wllama.loadModel(blobs)`), no copy. Entries, their files, `downloaded_at`, `last_used`,
`verified_at` and the measured facts live in IndexedDB (`models` store, schema version bump).

**Settings → Models → "Models in this browser".** One row per cached entry: name, size, last use,
"loaded now" when it is, actions **Load / Unload**, **Verify** (re-hash the files; the digests and
`verified_at` are shown), **Delete** (removes the files and the row; a loaded model is unloaded
first; a plan that bound it re-verifies as `model_unavailable` next time). A total line and the
storage estimate.

**"Nothing left behind", the words for the docs.** *A model you download is a cache the browser
keeps for this extension, like any site's cached files: you can see every model, its size and when
it was last used in Settings → Models, delete any of them, and uninstalling the extension removes
them all. An agent never installs anything; it runs on the model you chose, and the weights never
leave this browser.* Storage facts: the extension origin's OPFS persists until the extension is
uninstalled (the `unlimitedStorage` permission lifts the quota; Chrome's eviction removes whole
origins under pressure, and extension origins are not evicted while installed **[S]**).

**Cross-Origin Storage (D-448).** We join as a consumer; v1 does not depend on it. The keys match:
COS hands out a `FileSystemFileHandle` for a SHA-256 of the bytes **[V]**, and our cache is already
keyed by that digest, so a native COS is a backend swap (`read(sha256)` before `fetch`; `write` with
`create: true` after a verified download). The polyfill is a second Chrome extension the person
would have to install, which breaks one installation (D-310), so it is not a default; T41 keeps a
feature detect for `navigator.crossOriginStorage` behind a setting, off. wllama's own `COSBackend`
takes the same path (COS when present, OPFS otherwise **[V]**), which confirms the shape.

## 8. The route card and the demotion of Ollama

The model picker (the Customize view, Settings → Models) shows four kinds of route, in this order
when each is available, with these words (D-446):

| Route | Card line | Subline |
|---|---|---|
| In this browser | **In this browser** · Qwen3 4B · free | Runs inside this extension on your GPU. No network: nothing leaves this browser. |
| Chrome's built-in model | **Chrome's built-in model** (Gemini Nano) · free | Run by Chrome on this device; a small model, Chrome's own. |
| Ollama | **Ollama on this computer** · qwen3:30b · free | A separate application: it runs outside the browser's protection, and this browser cannot bound what it does with your data. |
| Hosted | **Hosted by OpenAI** · gpt-5.6-luna · metered | Your key; the request leaves this device to the provider. |

"Runs outside the browser's protection" is D-319's wording and names a fact, not a judgement:
Ollama is a process of the person's account that the runtime does not contain; a person who already
has it keeps it as a binding they chose (D-310). The default recommendation is in-browser when a
**recommended** entry is cached; else the picker proposes that entry's download card; a person who
prefers Ollama or a hosted model picks it once and the choice is remembered per package as today.
`docs/getting-started.md` §3 and `docs/chrome-agent-browser.md` lead with the in-browser route;
Ollama moves to a "Other local routes" subsection with the `OLLAMA_ORIGINS` setup it needs.

## 9. The installer

(D-446) T17's installer loses its Ollama component: `ollama-pin.env`, `ollama-origins.sh`, the
LaunchAgent `org.webagents.ollama-origins.plist`, the `ollama-setup` receipt and the Ollama choice
leave `installer/macos/`; D-202 and D-203's Ollama parts are superseded. The installer stays, as
the **optional** installer of the native helper only (D-181: keychain unlock; the helper's
`ollama.status` operation stays as a read-only report for people who run Ollama, since it changes
nothing on the machine). It is not retired: keychain unlock is the helper's own value, and the
`.pkg` is the only path to it. The uninstall script removes what the new installer writes; an
earlier install's Ollama LaunchAgent is removed by the new uninstall too (it knows the path). The
`OLLAMA_ORIGINS` command stays documented in Settings → Models and `docs/getting-started.md` for
people who choose Ollama.

## 10. Web Store

The remote-code policy (Manifest V3, `feasibility/platform.md`) forbids executing code fetched at run
time, "even when they arrive as data". This design's reading, for the reviewer note (T51):

- **The engine's WebAssembly is bundled** in the extension (`wllama.wasm`, one file, hash asserted by
  `check-pack`), compiled under the existing `'wasm-unsafe-eval'` CSP (D-253). No wasm or script is
  fetched at run time; the bundle contains no `eval` and no `new Function`
  **[measured: `bundle_has_eval` false]**. The two `cdn.jsdelivr.net` strings in wllama's bundle
  belong to its Firefox/Safari compat build; T41 removes them with an esbuild `define` so the
  reviewer sees none.
- **Weights are data**: tensors a fixed program reads, fetched only when the person clicks Download,
  from the repository the card names, verified by digest. A model changes what the agent *says*,
  never what the extension *can do*: the contract (what can be reached, spent, remembered) is the
  runtime's, and the model's output is data that may propose and never act (principle 11).
- **A grammar is data** derived from the package's schema by the engine.
- The host permission for `huggingface.co` is requested at the first download, with Chrome's prompt,
  and named in the listing.

## 11. Risks and limits

| Risk | What is known | What T41 measures |
|---|---|---|
| **Prefill on long contexts** | 483 tok/s prefill on the 0.6B **[measured]**; LlamaWeb: 2–10× slower than native; a 16-page PDF node reserves up to 81,066 tokens (STATE.md §5) | the 4B and 8B entries at 16k and 32k contexts: prefill tok/s and the time of one Literature Review `extract` call; the docs state the minutes |
| **GPU memory on 8–16 GB machines** | the budget is an estimate (§6); a load that does not fit kills the Worker | U16: a 16 GB Mac and an 8 GB-VRAM Windows laptop with the 4B and 8B entries; the estimate's error |
| **The 2 GB per-file limit** | README: 2 GB per file **[V]**; the 4B Q4_K_M file is 2.50 GB | §11 result below; if refused, the curated list keeps only sub-2 GiB files until the repositories ship splits (§5 policy) |
| **Thermal and battery** | no measurement; WebKit's objection to the Prompt API cites it | a 25-minute run's CPU/GPU time and the fan (observed); the docs say "plug in" |
| **Threads** | the offscreen Worker is not cross-origin isolated, yet wllama reported `multithread: true` **[measured]**; the GPU does the work either way | whether `SharedArrayBuffer` is usable in extension Workers without COOP/COEP (Chrome's extension exemption **[U]**), and whether the manifest keys are needed |
| **Safari and Firefox** | WebGPU in both; wllama needs its compat build there (JSPI, memory64) | out of scope for the extension shell (Chrome); noted for the reference browser (B-273) |
| **memory64 and heap growth** | memory64 and JSPI available in the Worker **[measured]**; a wasm heap never shrinks | the Worker's memory after unload; whether a reload needs a new Worker (the spike reloaded in the same Worker in 1.1 s **[measured]**) |
| **Small models and the contract** | the 0.6B answered the `interpret` schema validly in every spike call, with a plausible but invented `unsupported_reason` string | the WebAir search e2e on the 4B (acceptance); Literature Review needs the 30B class, as with Ollama |
| **Accounting under prompt caching** | counts are complete only with the cache off or `prompt_n + cache_n` **[measured]** | the adapter's test asserts the sum |
| **Headless CI** | headless Chrome has WebGPU here with no flag **[measured]**; GitHub's runners have no GPU | the e2e harness runs locally; CI runs the fixture port |

**The 4B-class measurement** (`Qwen/Qwen3-4B-GGUF` `Qwen3-4B-Q4_K_M.gguf`, 2,497,280,256 bytes,
`--ctx 16384`): *pending at the time of writing; filled in from the scratch report when the
background run completes.*

### What the spike measured (the report, by path)

`examples/verification/chrome-inbrowser-spike-t40.json`, profile `chrome-inbrowser-spike-t40-v0`:

| Fact | Value |
|---|---|
| Context | headless Chrome 156.0.8078.48, the real offscreen document (`background_page` target, `execution.html`), a module Worker started in it; no Chrome flag |
| WebGPU in that Worker | `has_webgpu` true; adapter `apple` / `metal-3`, not a fallback; features include `shader-f16`, `subgroups`, `subgroup-size-control`, `timestamp-query`; `maxBufferSize` 4,294,967,292; a device created |
| Platform | secure context, `crossOriginIsolated` false, memory64 true, JSPI true, 14 hardware threads, storage quota 64.8 GB |
| Engine | wllama 3.8.1, wasm 8,763,949 bytes, bundle 375 KB over 19 inputs, no eval |
| Model | Qwen3-0.6B Q4_0, 428,970,080 bytes, SHA-256 verified against Hugging Face's LFS digest, served by a local HTTPS origin |
| Load | 2,456 ms (n_ctx 8,192, 28 layers); reload after unload 1,056 ms |
| Constrained `interpret` | 2,917 prompt tokens, 179 completion tokens, prefill 482.9 tok/s, decode 87.4 tok/s, `finish_reason` stop, valid against `plan.schema.json`, intent/destination/date/passengers as asked |
| Unconstrained, same request | fenced ` ```json ` block: not parseable as given (the router's fenced reading would take it; the product validates either way) |
| Non-streamed, cache off | `usage.prompt_tokens` 2,913 = streamed `prompt_n` + `cache_n`; valid |
| Abort | stopped 306 ms after the request, 194 ms after the first token |
| Thinking on (scratch run, not committed) | 425 completion tokens, `reasoning_content` separated, the answer valid; decode 83 tok/s |
