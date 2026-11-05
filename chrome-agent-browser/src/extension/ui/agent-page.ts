/**
 * The agent page (D-034), rendered from the core's model with DOM calls only.
 *
 * A person-first card first: name, publisher and trust in words, what it does, what it will
 * be able to access grouped by kind, where it came from, the cost. Then "Technical details"
 * behind a disclosure, which also lists each declared profile's members; the profiles themselves
 * are chosen in the authorize view's "Ways to use it" (D-111). Every package string reaches the document
 * through `textContent`; the README goes through the copied Markdown sanitizer only.
 */
import type { AccessGroup, AgentPageModel, DelegationRole, Tone } from "../../core/agent-page.js";
import type { Profile } from "../../core/profiles.js";
import type { SessionView } from "../messages.js";
import { button, bytes, card, chip, definition, details, el, list, row, shortHash, whenText, type Child } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

export interface AgentPageActions {
  onTrust?: (scope: "package" | "publisher") => void;
  onClose?: () => void;
  onOpenFullPage?: () => void;
  compact?: boolean;
}

const MAX_RAW_MANIFEST = 64 * 1024;

function layerChip(status: string): HTMLElement {
  const tone: Tone = status === "valid" || status === "compatible" ? "good" : status === "not_evaluated" ? "neutral" : "bad";
  const words: Record<string, string> = { valid: "Valid", invalid: "Invalid", compatible: "Compatible", incompatible: "Not runnable here", not_evaluated: "Not evaluated" };
  return chip(words[status] ?? status, tone);
}

function accessGroup(group: AccessGroup): HTMLElement {
  return el(
    "div",
    { className: "ab-access-group", attrs: { "data-kind": group.kind } },
    el("h4", { className: "ab-access-title", text: group.title }),
    el("p", { className: "ab-hint", text: group.explanation }),
    list(
      group.items.map((item) =>
        el(
          "div",
          { className: "ab-access-item" },
          el(
            "div",
            { className: "ab-access-head" },
            el("code", { className: "ab-id", text: item.id }),
            chip(item.required ? "Required" : "Optional", item.required ? "neutral" : "good"),
          ),
          el("p", { className: "ab-access-text", text: item.description }),
          item.resources.length > 0 ? el("p", { className: "ab-hint", text: `Scope: ${item.resources.join(", ")}` }) : null,
          item.linked_tools.length > 0 ? el("p", { className: "ab-hint", text: `Used by: ${item.linked_tools.join(", ")}` }) : null,
        ),
      ),
      "ab-access-list",
    ),
  );
}

/**
 * A profile's estimate in one short line, in the order a person reads cost (D-111): model calls,
 * tokens, tool calls. Empty when the publisher stated none of them.
 */
export function estimateLine(estimate: Profile["estimate"]): string {
  const parts: string[] = [];
  if (estimate?.model_calls !== undefined) parts.push(`${estimate.model_calls} model call${estimate.model_calls === 1 ? "" : "s"}`);
  if (estimate?.tokens !== undefined) parts.push(`about ${estimate.tokens.toLocaleString()} tokens`);
  if (estimate?.tool_calls !== undefined) parts.push(`${estimate.tool_calls} tool call${estimate.tool_calls === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * Everything a profile declares, by id, under Technical details (D-111): the chooser itself lives
 * in the authorize view's "Ways to use it", and nothing a profile declares is lost from the page.
 */
function profileDetails(profile: Profile): HTMLElement {
  return el(
    "div",
    { className: "ab-profile", attrs: { "data-profile": profile.id } },
    el("h5", { className: "ab-profile-title" }, el("code", { text: profile.id }), ` ${profile.title}`),
    el("p", { className: "ab-hint", text: profile.description }),
    definition([
      ["Permissions", profile.permissions.join(", ") || "none"],
      ["Tools", profile.tools.join(", ") || "none"],
      ["Your data", profile.resources.join(", ") || "none"],
      ["Publisher's estimate", estimateLine(profile.estimate) || "not stated"],
      ...(profile.estimate?.notes ? ([["Estimate notes", profile.estimate.notes]] as Array<[string, Child]>) : []),
    ]),
  );
}

function trustCard(model: AgentPageModel, actions: AgentPageActions): HTMLElement {
  const trust = model.trust;
  const children: Child[] = [
    el("div", { className: `ab-trust-head ab-tone-${trust.tone}` }, chip(trust.headline, trust.tone)),
    el("p", { className: "ab-trust-detail", text: trust.detail }),
    row("Claimed publisher", `${model.identity.publisher_name} (${model.identity.publisher_id})`),
    row("Signer key", trust.signer_fingerprint ? el("code", { text: shortHash(trust.signer_fingerprint, 20) }) : "none"),
  ];
  if (trust.can_pin && actions.onTrust) {
    children.push(pinControls(model, actions.onTrust));
  }
  return el("div", { className: "ab-trust", attrs: { "data-trust": trust.trust_status, "data-signature": trust.signature_status } }, ...children);
}

/** Two deliberate presses, narrowest scope first; the key never travels through the page. */
export function pinControls(model: AgentPageModel, onTrust: (scope: "package" | "publisher") => void): HTMLElement {
  const container = el("div", { className: "ab-pin" });
  let armed = false;
  const scope = el("select", { className: "ab-select", attrs: { name: "trust-scope", "aria-label": "Trust scope" } });
  scope.append(
    el("option", { text: `Only this agent (${model.identity.package_id})`, attrs: { value: "package" } }),
    el("option", { text: `Any agent from ${model.identity.publisher_name}`, attrs: { value: "publisher" } }),
  );
  const confirm = button("Trust this publisher key", () => {
    if (!armed) {
      armed = true;
      confirm.textContent = "Press again to trust this key";
      confirm.className = "ab-button ab-button-danger";
      return;
    }
    onTrust(scope.value === "publisher" ? "publisher" : "package");
  }, { variant: "primary" });
  container.append(
    el("p", { className: "ab-hint", text: "Trusting a key is a lasting decision on this device; it does not grant the agent any permission. Permissions are decided per run." }),
    el("label", { className: "ab-field" }, "Scope ", scope),
    confirm,
  );
  return container;
}

/** What one activation of a role may spend, naming only what it may spend at all. */
function perActivation(role: DelegationRole): string {
  const parts: string[] = [];
  if (role.model_calls_per_activation > 0) parts.push(`up to ${role.model_calls_per_activation} model call${role.model_calls_per_activation === 1 ? "" : "s"}`);
  if (role.tools.length > 0) parts.push(`${role.tools.length === 1 ? "the tool" : "the tools"} ${role.tools.join(", ")}`);
  if (role.tokens_per_activation > 0) parts.push(`${role.tokens_per_activation.toLocaleString("en-US")} tokens`);
  if (role.remote_calls_per_activation > 0) parts.push(`${role.remote_calls_per_activation} remote call${role.remote_calls_per_activation === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(", ") : "no model call, no tool";
}

/** The person-first card and the technical details for one open package. */
export function renderAgentPage(view: SessionView, actions: AgentPageActions = {}): HTMLElement {
  const model = view.page;
  const compact = actions.compact ?? false;
  const header = el(
    "header",
    { className: "ab-agent-head" },
    el("div", { className: "ab-agent-title" }, el("h2", { text: model.identity.name }), chip(`v${model.identity.version}`, "neutral")),
    el("p", { className: "ab-agent-publisher", text: `by ${model.identity.publisher_name}` }),
    el(
      "div",
      { className: "ab-agent-actions" },
      actions.onOpenFullPage ? button("Open in full page", actions.onOpenFullPage) : null,
      actions.onClose ? button("Close", actions.onClose) : null,
    ),
  );

  const about = el(
    "div",
    { className: "ab-about" },
    el("p", { className: "ab-description", text: model.about.description }),
    model.about.readme ? details("Read more (from the package)", false, renderMarkdown(model.about.readme)) : null,
  );

  const access = el(
    "div",
    { className: "ab-access" },
    el("h3", { text: "What it will be able to access" }),
    el("p", { className: "ab-hint", text: "Everything below is a request. Nothing is granted by opening this page; you decide when you run it." }),
    ...model.access.map(accessGroup),
    model.tools.remote.length > 0
      ? el(
          "p",
          { className: "ab-hint", text: `Websites it may contact: ${[...new Set(model.tools.remote.flatMap((tool) => tool.domains))].sort().join(", ")}` },
        )
      : null,
  );

  // network.v0 (R-24, D-291): the envelope before any run, in words and in figures.
  const delegation = model.delegation;
  const delegates =
    delegation === null
      ? null
      : el(
          "div",
          { className: "ab-delegation", attrs: { "data-entry": delegation.entry } },
          el("p", { className: "ab-delegation-sentence", text: delegation.sentence }),
          el("h4", { text: "At most, in any run" }),
          definition([
            ["Handoffs", String(delegation.at_most.handoffs)],
            ["Model calls", String(delegation.at_most.model_calls)],
            ["Tool calls", Object.keys(delegation.at_most.tool_calls).length > 0 ? Object.entries(delegation.at_most.tool_calls).map(([tool, count]) => `${tool} ${count}`).join(", ") : "none"],
            ["Remote calls", String(delegation.at_most.remote_calls)],
            ["Tokens", delegation.at_most.tokens.toLocaleString("en-US")],
          ]),
          el("h4", { text: "Roles" }),
          list(
            delegation.roles.map((role) =>
              el(
                "div",
                { className: "ab-role", attrs: { "data-role": role.id } },
                el("strong", { text: role.id }),
                role.id === delegation.entry ? chip("starts", "neutral") : null,
                " ",
                chip(`at most ${role.at_most} ${role.at_most === 1 ? "time" : "times"}`, "neutral"),
                el("p", { className: "ab-hint", text: role.description }),
                el("p", { className: "ab-hint", text: `${role.chosen_by === "model" ? `The model chooses what follows: ${[...role.edges.map((edge) => `${edge.to} (at most ${edge.max_uses}×)`), ...(role.may_end ? ["done"] : [])].join(", ")}` : `Then ${role.next === "done" ? "done" : role.next}, fixed by the package`}. Each time: ${perActivation(role)}.` }),
              ),
            ),
          ),
          el("p", { className: "ab-hint", text: "Every figure is computed from the signed declaration: a run can stay below it and cannot pass it. A model call counts once here even when its answer is refused and the model is asked again (up to twice more); the run page counts every attempt. Each handoff is checked before the next role runs and recorded with the reason it was allowed." }),
        );

  const where = el(
    "div",
    { className: "ab-source" },
    row("Where it came from", model.source.display ?? "unknown"),
    model.source.advertised_on ? row("Advertised on", model.source.advertised_on) : null,
    row("Created", whenText(model.identity.created_at)),
    row("Cost", model.cost.text),
  );

  const technical = details(
    "Technical details",
    false,
    el(
      "div",
      { className: "ab-technical" },
      el("h4", { text: "Verification" }),
      row("Container", layerChip(model.technical.validation.container_status)),
      row("Integrity", layerChip(model.technical.validation.integrity_status)),
      row("Schema", layerChip(model.technical.validation.schema_status)),
      row("Runtime", layerChip(model.technical.validation.runtime_status)),
      row("Signature", chip(model.trust.signature_status === "valid" ? "Cryptographically valid" : model.trust.signature_status, model.trust.signature_status === "valid" ? "good" : "bad")),
      row("Publisher trust", chip(model.trust.trust_status, model.trust.tone)),
      row("Package digest", el("code", { text: model.technical.digest })),
      row("Archive SHA-256", el("code", { text: model.technical.archive_sha256 ?? "unknown" })),
      row("Signer fingerprint", el("code", { text: model.technical.signer_fingerprint ?? "none" })),
      row("Execution profile", model.identity.execution_profile),
      row("Payload", `${model.technical.payload.file_count} files, ${bytes(model.technical.payload.total_bytes)}`),
      row("Extensions", model.technical.extension_keys.join(", ") || "none"),
      ...(model.technical.modules.length > 0
        ? [
            // compute.v0 (C-9): the hashes a person can compare against the signed graph.
            el("h4", { text: "Code it runs (WebAssembly modules)" }),
            list(
              model.technical.modules.map((module) =>
                el(
                  "div",
                  { className: "ab-module", attrs: { "data-module": module.id } },
                  el("strong", { text: module.id }),
                  el("span", { text: ` · ${module.path} · ${bytes(module.size)} · calls ${module.functions.join(", ")} · memory ${module.memory_min_pages}–${module.memory_max_pages} pages · no imports` }),
                  el("br"),
                  el("code", { text: module.sha256 }),
                ),
              ),
            ),
          ]
        : []),
      el("h4", { text: "Tools" }),
      list(
        [...model.tools.remote, ...model.tools.local].map((tool) =>
          el(
            "div",
            {},
            el("code", { className: "ab-id", text: tool.id }),
            " ",
            chip(tool.execution, "neutral"),
            " ",
            chip(tool.side_effects === "write" ? "writes" : "reads", tool.side_effects === "write" ? "warn" : "neutral"),
            tool.approval_required ? chip("approval required", "warn") : null,
            el("p", { className: "ab-hint", text: tool.description }),
            tool.domains.length > 0 ? el("p", { className: "ab-hint", text: `Hosts: ${tool.domains.join(", ")}` }) : null,
          ),
        ),
      ),
      el("h4", { text: "Profiles (declared by the publisher)" }),
      model.profiles ? el("div", { className: "ab-profiles" }, ...model.profiles.map(profileDetails)) : el("p", { className: "ab-hint", text: model.profile_notes.join(" ") || "none declared" }),
      el("h4", { text: "Workers" }),
      list(model.technical.workers.map((worker) => `${String(worker.id)} (${String(worker.kind)}${worker.is_coordinator ? ", coordinator" : ""}), up to ${String(worker.max_instances)} at once`)),
      el("h4", { text: "Workflow" }),
      definition([
        ["Profile", String(model.technical.workflow.profile ?? "")],
        ["Nodes", String(model.technical.workflow.node_count ?? model.technical.workflow.stage_count ?? "")],
        ["Deadline", model.technical.workflow.deadline_seconds !== undefined ? `${String(model.technical.workflow.deadline_seconds)} s` : "n/a"],
        ["Exports", Array.isArray(model.technical.workflow.exports) ? String(model.technical.workflow.exports.length) : "0"],
      ]),
      el("h4", { text: "Evals and attestations (declarations, not verified by this browser)" }),
      list([
        ...model.technical.evals.map((item) => `eval ${String(item.id)} (${String(item.kind)}), ${String(item.case_count)} cases`),
        ...model.technical.attestations.map((item) => `attestation ${String(item.path)}, ${String(item.bytes)} bytes`),
      ]),
      el("h4", { text: "Warnings" }),
      list(model.technical.warnings.map((warning) => el("div", {}, chip(warning.severity, warning.severity === "critical" ? "bad" : warning.severity === "warning" ? "warn" : "neutral"), " ", el("span", { text: warning.message })))),
      details("Raw manifest", false, el("pre", { className: "ab-pre", text: JSON.stringify(model.technical.manifest, null, 2).slice(0, MAX_RAW_MANIFEST) })),
    ),
  );

  return el(
    "article",
    { className: `ab-agent${compact ? " ab-agent-compact" : ""}`, attrs: { "data-session": view.session.id, "data-trust": model.trust.trust_status } },
    header,
    card("Publisher", trustCard(model, actions)),
    card("What it does", about),
    card("Access", access),
    delegates !== null ? card("How it delegates", delegates) : null,
    card("Origin and cost", where),
    technical,
    el("p", { className: "ab-hint ab-execution-note", text: view.execution.note }),
  );
}
