# Agent Package v0 implementation plan

Historical milestone-1 document. Current generic execution, reference packages and
verification results are documented in [workflow migration](workflow-migration.md),
[workflow.v0](../spec/workflow-v0.md), and the [new report](workflow-report.md).
The former host-specific execution path is now explicitly retained under `agentpkg.dev`.


Primary input: *Portable AI Agents and the OpenClaw Agent-Native Browser*, all 31 pages, supplied 2026-09-19. This is an experimental implementation, not an official OpenClaw/NANDA standard.

1. Canonical, strict JSON `MANIFEST.agent` + `graph.json` + referenced policy/tool/schema/skill/eval documents. Generic version 0.1, closed security fields, namespaced noncritical extensions. HOCON is a possible future compiler input, not a second authority.
2. ZIP_STORED deterministic archives (sorted ASCII paths, fixed timestamp/modes); hashes cover every payload member; an Ed25519 signature signs a domain-separated canonical integrity statement. Explicit host-pinned public keys establish trust; embedded public keys alone do not.
3. A Python reference runtime mediates all declared worker/tool/model operations. No downloaded Python/JS or executable imports. Host-provided handler registry, capability grants, task-local state views, bounded parallel workers and depth, atomic token/call accounting, and privacy-conscious audit. Package requests are intersected with host authority.
4. Literature review is an application-specific package and a host-installed workflow adapter. It supplies seven instruction skills, state schemas, tool contracts, graph, eval definitions. Resolver semantics and response shape are reused without copying resolver business logic. Offline fixtures are clearly synthetic; live scholarly and model integrations are explicit configurations.
5. A thin OpenClaw integration verifies and stages an immutable package and compatible skill/config metadata without changing OpenClaw core or current personal configuration. Native enforcement and adapter enforcement are distinguished.
6. Validate schemas/references, archive attacks, cryptographic tampering, authority denial, budgets/delegation/memory, workflow grounding and ambiguity, deterministic evals, installed OpenClaw staging, then run and record the reference demo.

## Internal module ownership / API contract

Generic package core: `agentpkg/src/agentpkg/package.py`, `validation.py`, `signing.py`, `cli.py`, `schemas/`; exposes `Package` with `manifest`, `graph`, `policy`, `tools` dicts and `files: dict[str, bytes]`; `load_package(path)` validates source or artifact and returns Package. `Package.json(path)` decodes a member. `Package.digest` is the SHA-256 of the canonical integrity statement. Generic errors derive from `AgentPkgError` in `errors.py`.

Manifest fields: `spec_version`, `package_id`, `name`, `version`, `description`, `publisher` {id,name}, `created_at`, `runtime` {api,minimum_version}, `capabilities`, `entrypoint` (host handler ID), `graph` (path), `policy` (path), `skills` [{id,version,path}], `tools` [{id,path}], `schemas` [{id,path}], `model_requirements`, `evals` [{id,kind,path}], `attestations` [path], `dependencies` [], `update` {channel,locator}, `extensions` {}.

Graph: `spec_version`, `coordinator` (role ID), `workers` [{id,kind:'packaged',skills:[id],tools:[id],max_instances:int,budget:{tokens,remote_calls},state_read:[top-level-key],state_write:[top-level-key]}], `stages` [{id,worker,depends_on:[stage-id],parallel:bool,merge:'append'|'replace'|'deduplicate',extensions:{}}], `extensions` {}. Coordinator is declared in workers; workers only spawned by coordinator, depth 1. Runtime roles are independent of skills.

Policy: `spec_version`, `permissions` [{id,kind:'network'|'files.read'|'files.write'|'model'|'memory'|'shell'|'payment',description,required:bool,resources:[string]}], `network` {allowed_domains:[host],https_only:true,allow_redirects:false}, `memory` {scope,retention,raw_documents:false,state_schema:path,sharing:'explicit_views'}, `budget` {estimated_tokens,hard_tokens,max_remote_calls,max_calls_per_tool:{id:int},max_parallel_workers,estimated_cost_usd:null,approval_threshold_tokens:null}, `delegation` {max_depth,approved_roles:[id],allow_remote:false}, `extensions` {}.

Tools: `spec_version`, `id`, `version`, `description`, `execution` ('local'|'remote'|'agent'), `binding` (host handler ID), `endpoint` (HTTPS full URL or null), `method` ('GET'|'POST'|null), `input_schema` and `output_schema` (package paths), `permissions` [ID], `domains` [host], `timeout_seconds`, `retries` (0 in v0), `side_effects` ('read'|'write'), `approval_required` bool, `extensions` {}. Configuration overrides live in host config, never silently extend grants.

Runtime: `Runtime(package, grants: dict[permission_id, 'once'|'session'|'always'|'deny'], handlers: dict[tool_binding, async callable], router=None, limits=None)`. `async run_worker(role, inputs:dict, operation: async callable(context,inputs), parent=None, depth=1)` checks policy, passes only permitted state keys, records worker trace. `async map_workers(role, list_of_inputs, operation, parent=None)` bounded execution. Context: `worker_id`, `role`, `async tool(tool_id,payload)`, `async model(task,payload,output_schema,max_output_tokens=...)`; runtime owns coordinator context/root, shared `state`, `audit` list and `usage` snapshot. Worker returns a state patch; only declared `state_write` accepted. Workflow may use returned patch and coordinator merges deterministically; no worker gets mutable shared state. Runtime API can add helpers without weakening boundaries.

Literature workflow: `agentpkg/literature.py` exposes `async run_review(package, question, *, mode='fixture', grants=None, seeds=None, pdfs=None, router=None, limits=None, ...) -> dict` containing `state`, `related_work`, `bibliography`, `evidence_table`, `unresolved`, `audit`, `usage`, `evals`. It must execute declared graph stages, never assume arbitrary package code. CLI wires `run`/`eval` to this explicit host handler. For file output use explicit new host output directory, and refuse overwrites/symlinks.

The implemented CLI owns command dispatch; runtime and literature modules own enforcement and workflow behavior. The only existing resolver change is the separately documented hosted-skill origin repair. Completion evidence and remaining research limits are recorded in [the implementation report](implementation-report.md).
