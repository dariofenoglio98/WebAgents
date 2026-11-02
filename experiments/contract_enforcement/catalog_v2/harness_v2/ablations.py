"""The ten enforcement profiles of catalog v2 (D-301; T27 §2): the full system and nine
single-mechanism removals, each in both runtimes.

A profile removes **one mechanism everywhere it is enforced** in the Python reference and in the
Chrome core, and nothing else. A site is an exact single-line source patch on a private copy
(`build.py`) that must match exactly once: a refusing `if CONDITION:` becomes `if False:`, an
`if (COND)` becomes `if (ablatedNever() && (COND))` (v1's `py_if` / `ts_if`, imported), and a few
sites replace a validation call or a bound by its no-op. The diff of every profile is stored with
each run's results (`patches/<profile>/{py,ts}.diff`). No production module, CLI flag,
configuration key or environment variable can select a patched copy (`tests/test_isolation.py`).

Mechanisms some cases depend on that no profile removes (the permission mediator, per-tool and
per-role budgets, schema validation of answers, engine traps, the container rules) are kept by
every profile; a case whose primary guard is one of them names no primary ablation, and its row
shows which profiles leave it blocked.
"""

from __future__ import annotations

from dataclasses import dataclass

from .paths import ensure_v1_on_path

ensure_v1_on_path()

from harness.ablations import py_if, sub, ts_if  # noqa: E402,F401
from harness.build import Patch  # noqa: E402


@dataclass(frozen=True)
class Profile:
    name: str
    label: str
    description: str
    py: tuple[Patch, ...] = ()
    ts: tuple[Patch, ...] = ()

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "label": self.label,
            "description": self.description,
            "sites": {
                "py": [p.as_json() for p in self.py],
                "ts": [p.as_json() for p in self.ts],
            },
        }


FULL = Profile("full", "Full system", "Every mechanism in place; no patch.")

DECL_VALIDATION = Profile(
    "decl_validation",
    "-Declaration validation",
    "The feature validators run at load (compute, conversation and network declarations, the "
    "memory graph check: M-38's proposal export and M-67's minimum version) and the runtime "
    "minimum-version gate. Container rules, the base workflow.v0 validator and "
    "`memory_declarations` stay: its result is what the graph check and every memory run consume, "
    "and a memory run calls it again when it opens (its refusals are kept, as v1 kept parsing).",
    py=(
        py_if(
            "D.min_version",
            "validation.py",
            '    if release(manifest["runtime"]["minimum_version"]) > release(__version__):',
        ),
        sub(
            "D.compute",
            "workflow_validation.py",
            "    check_compute_declarations(manifest, graph, policy, files)\n",
            "    pass  # ABLATED D.compute\n",
        ),
        sub(
            "D.network",
            "workflow_validation.py",
            "    check_network_declarations(\n",
            "    (lambda *_a, **_k: None)(  # ABLATED D.network\n",
        ),
        sub(
            "D.conversation",
            "workflow_validation.py",
            "    check_conversation_declarations(\n",
            "    (lambda *_a, **_k: None)(  # ABLATED D.conversation\n",
        ),
        sub(
            "D.memory_graph",
            "validation.py",
            "    check_memory_graph(manifest, graph, memory_declared)\n",
            "    pass  # ABLATED D.memory_graph\n",
        ),
    ),
    ts=(
        ts_if(
            "D.min_version",
            "core/validation.ts",
            "  if (compareRelease(String(runtime.minimum_version), SUPPORTED_RUNTIME_VERSION) > 0) {",
        ),
        sub(
            "D.compute",
            "core/workflow-static.ts",
            "  checkComputeDeclarations(manifest, graph, policy, files);\n",
            "  void 0; /* ABLATED D.compute */\n",
        ),
        sub(
            "D.network",
            "core/workflow-static.ts",
            "  await checkNetworkDeclarations(manifest, graph, policy, { documents, schema, expression, operation, nodes, files, schemaPaths });\n",
            "  void 0; /* ABLATED D.network */\n",
        ),
        sub(
            "D.conversation",
            "core/workflow-static.ts",
            "  await checkConversationDeclarations(manifest, graph, policy, tools, { documents, schema, expression: (value, env, label) => expression(value, env, label), ancestors, nodes, files, schemaPaths });\n",
            "  void 0; /* ABLATED D.conversation */\n",
        ),
        sub(
            "D.memory_graph",
            "core/validation.ts",
            "  checkMemoryGraph(manifest, graph, memoryDeclared);\n",
            "  void 0; /* ABLATED D.memory_graph */\n",
        ),
    ),
)

EGRESS_SCAN = Profile(
    "egress_scan",
    "-Egress scan",
    "M-36's scans of the run's sealed values in a tool's arguments and in a model request "
    "(N11). The shared scanner stays: the proposals check (M-40 step 7) uses it too.",
    py=(
        sub(
            "E.tool_arguments",
            "runtime.py",
            "        hits = find_all_sealed(payload, memory.scan)\n",
            "        hits = []  # ABLATED E.tool_arguments\n",
        ),
        sub(
            "E.model_request",
            "runtime.py",
            "        hit = find_sealed(request, memory.scan)\n",
            "        hit = None  # ABLATED E.model_request\n",
        ),
    ),
    ts=(
        sub(
            "E.tool_arguments",
            "core/workflow/runtime.ts",
            "    const hits = findAllSealed(payload, memory.scan);\n",
            "    const hits = [] as ReturnType<typeof findAllSealed>; /* ABLATED E.tool_arguments */\n",
        ),
        sub(
            "E.model_request",
            "core/workflow/runtime.ts",
            "    const hit = findSealed(request, memory.scan);\n",
            "    const hit = null as ReturnType<typeof findSealed>; /* ABLATED E.model_request */\n",
        ),
    ),
)

PROPOSAL_CHECK = Profile(
    "proposal_check",
    "-Proposal check",
    "M-40's checks of the proposals document (its schema: the marker line, a supersedes link, "
    "the shape; the type declared under memory.write; sealed fields; the update target granted; "
    "every link and body link granted; a #n naming another proposal; no sealed value anywhere) "
    "and the denied memory.write's `offered: 0`.",
    py=(
        sub(
            "P.schema",
            "memory/proposals.py",
            '    failure = first_failure("memory-proposals.schema.json", document)\n',
            "    failure = None  # ABLATED P.schema\n",
        ),
        py_if(
            "P.type",
            "memory/proposals.py",
            "        if type_id not in declared or type_id in RESERVED_TYPES:",
        ),
        py_if(
            "P.sealed_field",
            "memory/proposals.py",
            '            if pointer_get(proposal["fields"], pointer) is not None:',
        ),
        py_if(
            "P.target",
            "memory/proposals.py",
            '        if proposal["action"] == "update" and granted.get(proposal["target"]) != type_id:',
        ),
        py_if(
            "P.sibling",
            "memory/proposals.py",
            "                if sibling == index or sibling >= len(proposals):",
        ),
        py_if(
            "P.link", "memory/proposals.py", "            elif to != SELF_ID and to not in granted:"
        ),
        sub(
            "P.sealed_value",
            "memory/proposals.py",
            "    hit = find_sealed(document, scan)\n",
            "    hit = None  # ABLATED P.sealed_value\n",
        ),
        sub(
            "P.write_denied",
            "memory/run.py",
            "            write_denied=self.write_denied,\n",
            "            write_denied=False,  # ABLATED P.write_denied\n",
        ),
    ),
    ts=(
        ts_if(
            "P.schema",
            "core/memory/proposals.ts",
            '  if (schemaProblem !== null) throw new ProposalRefusal("schema_validation", null, `proposals.json does not match memory-proposals.schema.json: ${schemaProblem}`);',
        ),
        ts_if(
            "P.type",
            "core/memory/proposals.ts",
            "    if (!input.declared.has(typeId) || RESERVED_TYPES.has(typeId)) {",
        ),
        ts_if(
            "P.sealed_field",
            "core/memory/proposals.ts",
            '      if (pointerGet(proposal.fields, pointer) !== undefined) throw new ProposalRefusal("schema_validation", "memory_proposal_sealed_field", `${where}: carries the sealed field ${pointer}`, index);',
        ),
        ts_if(
            "P.target",
            "core/memory/proposals.ts",
            '    if (proposal.action === "update" && input.granted.get(proposal.target!) !== typeId) {',
        ),
        ts_if(
            "P.sibling",
            "core/memory/proposals.ts",
            '        if (sibling === index || sibling >= parsed.proposals.length) throw new ProposalRefusal("schema_validation", null, `${where}: link ${to} names no other proposal`, index);',
        ),
        sub(
            "P.link",
            "core/memory/proposals.ts",
            "      } else if (to !== SELF_ID && !input.granted.has(to)) {\n",
            "      } else if (ablatedNever() /* ABLATED P.link */ && (to !== SELF_ID && !input.granted.has(to))) {\n",
        ),
        sub(
            "P.sealed_value",
            "core/memory/proposals.ts",
            "  const hit = findSealed(document, input.scan);\n",
            "  const hit = null as ReturnType<typeof findSealed>; /* ABLATED P.sealed_value */\n",
        ),
        ts_if(
            "P.write_denied",
            "core/memory/run.ts",
            '    if (this.writeDenied) reason = "permission_denied";',
        ),
    ),
)

MODULE_GATE = Profile(
    "module_gate",
    "-Module gate",
    "The static module check (compute.v0 C-19): no imports, exactly one memory with a declared "
    "maximum, the memory, alloc and node-function exports with their signatures, the declared "
    "SHA-256, and the feature refusals a single line can lift (shared-memory limits, tail calls' "
    "return_call, the v128 type). SIMD and atomic instructions are refused inside the decoder "
    "(no single-line site); the container rules stay; agentpkg's wasmtime configuration "
    "repeats the feature refusals at compile (the engine's own, kept).",
    py=(
        py_if("G.imports", "compute/module.py", "    if info.imports:"),
        py_if("G.memory_count", "compute/module.py", "    if len(info.memories) != 1:"),
        sub(
            "G.maximum",
            "compute/module.py",
            "    if maximum is None:\n",
            "    if (maximum := 0 if maximum is None else maximum) is None:  # ABLATED G.maximum\n",
        ),
        sub(
            "G.memory_export",
            "compute/module.py",
            '    memory = required("memory", "memory")\n',
            '    memory = exports.get("memory") or Export("memory", "memory", 0)  # ABLATED G.memory_export\n',
        ),
        sub(
            "G.alloc",
            "compute/module.py",
            '    signature("alloc", _ALLOC)\n',
            "    pass  # ABLATED G.alloc\n",
        ),
        sub(
            "G.run",
            "compute/module.py",
            "        signature(name, _RUN)\n",
            "        pass  # ABLATED G.run\n",
        ),
        py_if("G.hash", "compute/declarations.py", '        if actual != module["sha256"]:'),
        sub(
            "G.shared",
            "compute/module.py",
            "        flag = self.byte()\n",
            "        flag = self.byte() & ~0x02  # ABLATED G.shared\n",
        ),
        sub(
            "G.tail_call",
            "compute/module.py",
            "_U32_OPCODES = {0x0C, 0x0D, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xD2}\n",
            "_U32_OPCODES = {0x0C, 0x0D, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xD2}  # ABLATED G.tail_call\n",
        ),
        sub(
            "G.v128",
            "compute/module.py",
            '_VALUE_TYPES = {_I32: "i32", _I64: "i64", _F32: "f32", _F64: "f64"}\n',
            '_VALUE_TYPES = {_I32: "i32", _I64: "i64", _F32: "f32", _F64: "f64", _V128: "v128"}  # ABLATED G.v128\n',
        ),
    ),
    ts=(
        ts_if("G.imports", "core/compute/module.ts", "  if (info.imports.length > 0) {"),
        ts_if(
            "G.memory_count",
            "core/compute/module.ts",
            '  if (info.memories.length !== 1) throw new ModuleError("module_memory_count", `the module defines ${info.memories.length} memories; exactly one is required`);',
        ),
        # As agentpkg's twin: a memory with no declared maximum is read as maximum 0 (the next
        # line's refusal then never fires; the type stays `number`).
        sub(
            "G.maximum",
            "core/compute/module.ts",
            "  const [minimum, maximum] = info.memories[0]!;\n",
            "  const [minimum, declaredMaximum] = info.memories[0]!; const maximum = declaredMaximum ?? 0; /* ABLATED G.maximum */\n",
        ),
        sub(
            "G.memory_export",
            "core/compute/module.ts",
            '  const memory = required("memory", "memory");\n',
            '  const memory: Export = exports.get("memory") ?? { name: "memory", kind: "memory", index: 0 }; /* ABLATED G.memory_export */\n',
        ),
        sub(
            "G.alloc",
            "core/compute/module.ts",
            '  signature("alloc", ALLOC);\n',
            "  void 0; /* ABLATED G.alloc */\n",
        ),
        sub(
            "G.run",
            "core/compute/module.ts",
            "    signature(name, RUN);\n",
            "    void 0; /* ABLATED G.run */\n",
        ),
        ts_if(
            "G.hash",
            "core/compute/declarations.ts",
            '    if (actual !== module.sha256) throw refuse("module_hash_mismatch", `module ${pyRepr(id)}: ${path} has SHA-256 ${actual}, the graph declares ${String(module.sha256)}`);',
        ),
        sub(
            "G.shared",
            "core/compute/module.ts",
            "    const flag = this.byte();\n",
            "    const flag = this.byte() & ~0x02; /* ABLATED G.shared */\n",
        ),
        sub(
            "G.tail_call",
            "core/compute/module.ts",
            "const U32_OPCODES = new Set([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xd2]);\n",
            "const U32_OPCODES = new Set([0x0c, 0x0d, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xd2]); /* ABLATED G.tail_call */\n",
        ),
        sub(
            "G.v128",
            "core/compute/module.ts",
            '  [F64, "f64"],\n',
            '  [F64, "f64"], [V128, "v128"], /* ABLATED G.v128 */\n',
        ),
    ),
)

COMPUTE_LIMITS = Profile(
    "compute_limits",
    "-Compute limits",
    "The bounds of a compute call: the host page ceiling (the runtime's preflight and both "
    "execution layers' check, and agentpkg's store limit), fuel and the call's wall bound, and "
    "the output bounds (zero length, range, size). The node's own timeout stays (a general "
    "mechanism): agentpkg's engine then stops at the node timeout plus its grace (B-224), the "
    "core terminates the call's Worker when the node times out.",
    py=(
        py_if(
            "L.preflight_pages", "runtime.py", "            if maximum > effective.memory_pages:"
        ),
        py_if(
            "L.layer_pages", "execution/policy.py", "        if maximum > effective.memory_pages:"
        ),
        sub(
            "L.store_pages",
            "compute/engine.py",
            "        store.set_limits(memory_size=limits.memory_pages * PAGE_BYTES, memories=1, instances=1)\n",
            "        store.set_limits(memories=1, instances=1)  # ABLATED L.store_pages\n",
        ),
        sub(
            "L.fuel",
            "compute/engine.py",
            "        store.set_fuel(limits.fuel)\n",
            "        limits = type(limits)(limits.memory_pages, limits.wall_seconds, 1 << 62); store.set_fuel(limits.fuel)  # ABLATED L.fuel\n",
        ),
        sub(
            "L.wall",
            "runtime.py",
            '            deadline = min(limits.wall_seconds, operation["timeout_seconds"] + TIMEOUT_GRACE)\n',
            '            deadline = operation["timeout_seconds"] + TIMEOUT_GRACE  # ABLATED L.wall\n',
        ),
        py_if(
            "L.output_range",
            "compute/engine.py",
            "                if out_len == 0 or out_ptr + out_len > size:",
        ),
        py_if(
            "L.output_size", "compute/engine.py", "                if out_len > MAX_OUTPUT_BYTES:"
        ),
    ),
    ts=(
        ts_if(
            "L.preflight_pages",
            "core/workflow/runtime.ts",
            "    if (maximum > effective.memory_pages) {",
        ),
        ts_if(
            "L.layer_pages",
            "core/execution/policy.ts",
            "    if (maximum > effective.memory_pages) {",
        ),
        sub(
            "L.wall",
            "core/compute/engine.ts",
            "Math.max(0, limits.wall_seconds * 1000));\n",
            "2147483647 /* ABLATED L.wall */);\n",
        ),
        sub(
            "L.output_range",
            "core/compute/worker-body.ts",
            "    if (outLen === 0 || outPtr + outLen > size) return ",
            "    if (ablatedNever() /* ABLATED L.output_range */ && (outLen === 0 || outPtr + outLen > size)) return ",
        ),
        sub(
            "L.output_size",
            "core/compute/worker-body.ts",
            "    if (outLen > MAX_OUTPUT_BYTES) return ",
            "    if (ablatedNever() /* ABLATED L.output_size */ && (outLen > MAX_OUTPUT_BYTES)) return ",
        ),
    ),
)

CONSENT_GATE = Profile(
    "consent_gate",
    "-Consent gate",
    "V-9's per-permission gate before a gated tool, V-13's once spent across turns (the next "
    "turn forgets what earlier turns spent: the step is asked again and the tool may use it "
    "again), and the transcript-against-plan check's consent_not_authorized. Within a turn, "
    "`once` and a denied grant stay (the permission mediator). The transcript check's unknown "
    "step stays: without it the check reads the step's permissions of nothing.",
    py=(
        sub(
            "V.gate",
            "runtime.py",
            '                self._check_consent(ctx, tool_id, tool["permissions"])\n',
            "                pass  # ABLATED V.gate\n",
        ),
        sub(
            "V.once_across_turns",
            "runtime.py",
            "        self._once_used = set(turn.spent) if turn is not None else set()\n",
            "        self._once_used = set()  # ABLATED V.once_across_turns\n",
        ),
        py_if(
            "V.transcript_denied",
            "conversation/transcript.py",
            "            if accepted and denied:",
        ),
    ),
    ts=(
        sub(
            "V.gate",
            "core/workflow/runtime.ts",
            "      this.checkConsent(ctx, toolId, permissionIds);\n",
            "      void 0; /* ABLATED V.gate */\n",
        ),
        sub(
            "V.once_across_turns",
            "core/workflow/runtime.ts",
            "    this.onceUsed = new Set(turn?.spent ?? []);\n",
            "    this.onceUsed = new Set<string>(); /* ABLATED V.once_across_turns */\n",
        ),
        ts_if(
            "V.transcript_denied",
            "core/conversation/transcript.ts",
            "        if (accepted && denied.length > 0) {",
        ),
    ),
)

CONVERSATION_BOUNDS = Profile(
    "conversation_bounds",
    "-Conversation bounds",
    "The conversation's turn cap, its token and remote-call budgets (a turn reserved against "
    "what is left), and its per-tool caps across turns (each turn gets the package's per-turn "
    "cap again; the per-turn cap itself stays).",
    py=(
        py_if("B.turn_cap", "conversation/runner.py", "        if index > self.limits.max_turns:"),
        py_if(
            "B.tokens",
            "conversation/runner.py",
            "        if self.tokens + hard_tokens > self.limits.hard_tokens:",
        ),
        py_if(
            "B.remote",
            "conversation/runner.py",
            "        if self.remote_calls + remote > self.limits.max_remote_calls:",
        ),
        py_if(
            "B.tool_caps",
            "runtime.py",
            '                if tool_id in self.budget["max_calls_per_tool"]:',
        ),
    ),
    ts=(
        ts_if(
            "B.turn_cap",
            "core/conversation/runner.ts",
            '  if (turnsRun >= limits.max_turns) return "conversation_turn_limit";',
        ),
        ts_if(
            "B.tokens",
            "core/conversation/runner.ts",
            '  if (spent.tokens + hardTokens > limits.hard_tokens) return "conversation_budget_exhausted";',
        ),
        ts_if(
            "B.remote",
            "core/conversation/runner.ts",
            '  if (spent.remote_calls + remote > limits.max_remote_calls) return "conversation_budget_exhausted";',
        ),
        ts_if(
            "B.tool_caps",
            "core/workflow/runtime.ts",
            "        if (Object.hasOwn(caps, toolId)) caps[toolId] = Math.min(caps[toolId] as number, remaining);",
        ),
    ),
)

TRANSITION_CHECK = Profile(
    "transition_check",
    "-Transition check",
    "network.v0's run-time transition checks: the hop cap, an edge's max_uses (model and fixed "
    "routes), a role's max_activations, and the write view of a role's patch. The route's enum "
    "is enforced by the route answer's own output schema (and its edge lookup), which no "
    "profile removes; the read view is structural (a role's environment holds its view only).",
    py=(
        py_if("T.hops", "delegation/runner.py", '    elif walk.hop >= network["max_hops"]:'),
        py_if(
            "T.edge",
            "delegation/runner.py",
            '        if walk.uses[(role_id, target)] >= edge["max_uses"]:',
        ),
        py_if(
            "T.role",
            "delegation/runner.py",
            "        elif cap is not None and walk.activations[target] >= cap:",
        ),
        py_if(
            "T.write_view",
            "delegation/runner.py",
            '        if set(patch) - set(rt.roles[role_id]["state_write"]):',
        ),
    ),
    ts=(
        sub(
            "T.hops",
            "core/network/runner.ts",
            "  } else if (walk.hop >= (network.max_hops as number)) {\n",
            "  } else if (ablatedNever() /* ABLATED T.hops */ && (walk.hop >= (network.max_hops as number))) {\n",
        ),
        ts_if(
            "T.edge",
            "core/network/runner.ts",
            '    if (walk.count(walk.uses, edgeKey(roleId, to)) >= (edge.max_uses as number)) reason = "edge_exhausted";',
        ),
        sub(
            "T.role",
            "core/network/runner.ts",
            '    else if (cap !== undefined && walk.count(walk.activations, to) >= cap) reason = "role_exhausted";\n',
            '    else if (ablatedNever() /* ABLATED T.role */ && (cap !== undefined && walk.count(walk.activations, to) >= cap)) reason = "role_exhausted";\n',
        ),
        ts_if(
            "T.write_view",
            "core/network/runner.ts",
            "    if (Object.keys(patch).some((key) => !stateWrite.includes(key))) throw new PolicyError(`role ${roleId} state write exceeds its state_write view`);",
        ),
    ),
)

ENVELOPE_RESERVATION = Profile(
    "envelope_reservation",
    "-Envelope reservation",
    "network.v0's envelope: the worst case against the package's own budget at validation "
    "(R-22, tokens and remote calls) and the reservation of the worst case against what the run "
    "has left before the first activation (R-17); `network.started` is still recorded.",
    py=(
        py_if(
            "R.validation_tokens",
            "delegation/declarations.py",
            '    if bound["relaxation"]["tokens"] > budget["hard_tokens"]:',
        ),
        py_if(
            "R.validation_remote",
            "delegation/declarations.py",
            '    if bound["relaxation"]["remote_calls"] > budget["max_remote_calls"]:',
        ),
        py_if("R.reservation", "runtime.py", "            if reason is not None:"),
    ),
    ts=(
        ts_if(
            "R.validation_tokens",
            "core/network/declarations.ts",
            "  if (bound.relaxation.tokens > (budget.hard_tokens as number)) {",
        ),
        ts_if(
            "R.validation_remote",
            "core/network/declarations.ts",
            "  if (bound.relaxation.remote_calls > (budget.max_remote_calls as number)) {",
        ),
        ts_if("R.reservation", "core/workflow/runtime.ts", "    if (reason !== null) {"),
    ),
)

PROFILES: tuple[Profile, ...] = (
    FULL,
    DECL_VALIDATION,
    EGRESS_SCAN,
    PROPOSAL_CHECK,
    MODULE_GATE,
    COMPUTE_LIMITS,
    CONSENT_GATE,
    CONVERSATION_BOUNDS,
    TRANSITION_CHECK,
    ENVELOPE_RESERVATION,
)
BY_NAME = {profile.name: profile for profile in PROFILES}
ABLATIONS = tuple(profile for profile in PROFILES if profile.name != "full")
# The smoke preset runs the full system and each family's primary ablation.
SMOKE_PROFILES = ("full", "egress_scan", "module_gate", "consent_gate", "transition_check")
