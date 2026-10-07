/**
 * The authorize view (T3, Demo 2), shared by the side panel and the full page: profile cards →
 * one summary card → "Use this agent"; the underlined "Customize your settings" link expands
 * the full view (permissions with deny / once / session, tool approvals, your data per type,
 * the model picker with verdicts, budgets); the trust prompt when the publisher is unknown;
 * "Ready to run" with the plan id and hash under Technical details.
 *
 * A thin view (D-035): everything it shows comes from the worker's `AuthorizationView` and
 * `ModelsView`; what it sends back is ordinary decisions, approvals, picks and the provenance of
 * each (D-053). Nothing here decides anything: a profile card shows what it would grant, the
 * person presses. Every package string reaches the document through `textContent`.
 */
import type { Decided } from "../../core/authorization.js";
import type { ModelCompatibility } from "../../core/compatibility.js";
import type { Profile } from "../../core/profiles.js";
import { PROVENANCE_SCHEMA, type DecidedBy, type Decision, type Provenance, type Reason } from "../../core/types.js";
import type { ResourceRequest } from "../../core/hostresources.js";
import type { AuthorizationView, ModelsView, SessionView } from "../messages.js";
import { pinControls } from "./agent-page.js";
import { button, card, chip, definition, details, el, list, row, shortHash, whenText, type Child } from "./dom.js";

export interface AuthorizeState {
  /** The profile card the person pressed (the first one by default when profiles exist). */
  selectedProfile: string | null;
  /** Whether "Customize your settings" is open. */
  customize: boolean;
  /** The customize view's working copy, or null until it is opened. */
  draft: { decisions: Record<string, Decision>; approvals: Record<string, boolean>; decidedBy: Record<string, DecidedBy>; approvedBy: Record<string, DecidedBy>; base: { profile_id: string | null; profile_title: string | null } } | null;
  /** The person's picks per resource-bearing permission (never pre-filled). */
  picks: Record<string, string>;
  selectedModel: string | null;
  /** Local notice after an action. */
  notice: { text: string; tone: "good" | "warn" | "bad" } | null;
}

export function newAuthorizeState(): AuthorizeState {
  return { selectedProfile: null, customize: false, draft: null, picks: {}, selectedModel: null, notice: null };
}

export interface AuthorizeActions {
  onUseProfile: (profileId: string, picks: Record<string, string>) => void;
  /** `modelId` is the model picked in the customize view; null prepares the plan on the default model. */
  onAuthorize: (decisions: Record<string, Decision>, approvals: Record<string, boolean>, picks: Record<string, string>, provenance: Provenance, modelId: string | null) => void;
  onPrepare: (modelId: string) => void;
  onRefreshModels: () => void;
  onClearPlan: () => void;
  onOpenSettings: (section: "models" | "policies" | "data") => void;
  onTrust?: (scope: "package" | "publisher") => void;
  /** Re-render after a local state change. */
  rerender: () => void;
}

export interface AuthorizeInput {
  session: SessionView;
  view: AuthorizationView;
  models: ModelsView | null;
  busy: string | null;
  compact?: boolean;
}

const DECISION_LABELS: Record<Decision, string> = { deny: "Deny", once: "Allow once", session: "Allow for session" };
const PRESET_TITLES: Record<string, string> = { "privacy-first": "Privacy first", balanced: "Balanced", convenience: "Convenience" };

/** What a granted permission lets the agent do, in a person's words (D-052). */
function authorityWords(view: AuthorizationView, permission: AuthorizationView["request"]["permissions"][number], decision: Decision): string {
  const once = decision === "once" ? ", once" : "";
  switch (permission.kind) {
    case "network":
      return `contact ${permission.linked_domains.join(", ") || permission.resources.join(", ")}${once}`;
    case "model":
      return `use your model${once}`;
    case "memory":
      return "keep working notes for this run only";
    case "personal.read": {
      const request = view.resources.requests.find((item) => item.permission_id === permission.id);
      return `read your ${request?.type_display_name?.toLowerCase() ?? permission.resources.join(", ")} (you choose which)${once}`;
    }
    case "payment": {
      // Generic on purpose: this host cannot know whether a package's payment is real, so it
      // says where a payment would go and through which tool; the publisher's own account of it
      // is quoted, attributed, on the summary card (D-052 as amended).
      const through = permission.linked_tools.length > 0 ? ` through ${permission.linked_tools.join(", ")}` : "";
      const hosts = permission.linked_domains.length > 0 ? permission.linked_domains : permission.resources;
      return `make a payment${through}${hosts.length > 0 ? ` at ${hosts.join(", ")}` : ""}${decision === "once" ? ", one run only" : ""}`;
    }
    case "files.read":
      return `read files you pick${once}`;
    case "files.write":
      return `write files where you allow${once}`;
    default:
      return `${permission.kind}: ${permission.description}`;
  }
}

function provenanceFrom(state: NonNullable<AuthorizeState["draft"]>, preset: Provenance["preset"], picks: Record<string, string>): Provenance {
  return {
    schema: PROVENANCE_SCHEMA,
    profile_id: state.base.profile_id,
    profile_title: state.base.profile_title,
    preset,
    decisions: { ...state.decidedBy },
    tool_approvals: { ...state.approvedBy },
    resource_selections: Object.fromEntries(Object.keys(picks).map((id) => [id, "user" as const])),
  };
}

function draftFrom(decided: Decided, base: { profile_id: string | null; profile_title: string | null }): NonNullable<AuthorizeState["draft"]> {
  return {
    decisions: { ...decided.decisions },
    approvals: { ...decided.tool_approvals },
    decidedBy: { ...decided.provenance.decisions },
    approvedBy: { ...decided.provenance.tool_approvals },
    base,
  };
}

function reasons(items: readonly Reason[], title: string): HTMLElement | null {
  if (items.length === 0) return null;
  return el(
    "div",
    { className: "ab-reasons" },
    el("h4", { text: title }),
    list(items.map((reason) => el("div", {}, el("code", { text: reason.code }), " ", el("span", { text: reason.message })))),
  );
}

// -- profiles and the summary card --------------------------------------------------------------
function profileCard(view: AuthorizationView, entry: { profile: Profile; decided: Decided }, selected: boolean, onSelect: () => void): HTMLElement {
  const profile = entry.profile;
  const estimate = profile.estimate;
  const parts: string[] = [];
  if (estimate?.model_calls !== undefined) parts.push(`${estimate.model_calls} model call${estimate.model_calls === 1 ? "" : "s"}`);
  if (estimate?.tool_calls !== undefined) parts.push(`${estimate.tool_calls} tool call${estimate.tool_calls === 1 ? "" : "s"}`);
  if (estimate?.tokens !== undefined) parts.push(`about ${estimate.tokens.toLocaleString()} tokens`);
  const granted = view.request.permissions.filter((permission) => entry.decided.decisions[permission.id] !== "deny");
  const node = el(
    "button",
    { className: `ab-profile-card${selected ? " ab-profile-selected" : ""}`, attrs: { type: "button", "data-profile": profile.id, "aria-pressed": selected ? "true" : "false" } },
    el("span", { className: "ab-profile-card-title", text: profile.title }),
    el("span", { className: "ab-profile-card-text", text: profile.description }),
    // The members, not only the words (spec §5): what it gets, in plain words.
    el("span", { className: "ab-profile-card-gets", text: `Gets: ${granted.map((permission) => authorityWords(view, permission, entry.decided.decisions[permission.id]!)).join("; ") || "nothing"}` }),
    el("span", { className: "ab-hint", text: parts.length > 0 ? `Publisher's estimate: ${parts.join(", ")}` : "No estimate stated" }),
  );
  node.addEventListener("click", onSelect);
  return node;
}

function summaryCard(input: AuthorizeInput, state: AuthorizeState, actions: AuthorizeActions, decided: Decided, profile: Profile | null): HTMLElement {
  const view = input.view;
  const granted = view.request.permissions.filter((permission) => decided.decisions[permission.id] !== "deny");
  const denied = view.request.permissions.filter((permission) => decided.decisions[permission.id] === "deny");
  const deniedTools = view.request.tool_approvals.filter((tool) => !decided.tool_approvals[tool.tool_id]).map((tool) => tool.tool_id);
  const personal = view.resources.requests.filter((request) => decided.decisions[request.permission_id] !== "deny");
  const model = input.models?.evaluation.models.find((item) => item.model_id === view.default_model) ?? null;
  const pickers = personal.map((request) => resourcePicker(request, state, actions, decided.decisions[request.permission_id]!));
  const trust = input.session.page.trust;
  const canUse = trust.trust_status === "trusted";
  return card(
    profile ? `Use it to: ${profile.title}` : "What you are about to allow",
    el(
      "div",
      { className: "ab-summary" },
      el("h4", { text: "This agent will be able to" }),
      list(granted.map((permission) => authorityWords(view, permission, decided.decisions[permission.id]!))),
      ...granted
        .filter((permission) => permission.kind === "payment")
        .map((permission) => el("p", { className: "ab-hint ab-payment-claim", text: `About this payment, in the publisher's words: “${permission.description}”` })),
      denied.length > 0 || deniedTools.length > 0
        ? el("p", { className: "ab-hint", text: `It will not: ${[...denied.map((permission) => authorityWords(view, permission, "session")), ...(deniedTools.length > 0 ? [`use ${deniedTools.join(", ")}`] : [])].join("; ")}.` })
        : null,
      ...pickers,
      row(
        "Model",
        view.default_model
          ? el("span", {}, el("code", { text: view.default_model }), model ? chip(model.status, model.status === "compatible" ? "good" : model.status === "unverified" ? "warn" : "bad") : null, model?.properties.local === true ? chip("local, free") : model ? chip("hosted, metered", "warn") : null)
          : el("span", {}, "none chosen yet — ", linkButton("choose one in Settings → Models", () => actions.onOpenSettings("models"))),
      ),
      row("Preset", `${PRESET_TITLES[view.preset] ?? view.preset} (payments stay single-use; nothing is granted beyond what is listed)`),
      row("Decided by", profile ? `the “${profile.title}” profile, with the ${PRESET_TITLES[view.preset] ?? view.preset} preset's durations` : `the ${PRESET_TITLES[view.preset] ?? view.preset} preset's defaults`),
      el(
        "div",
        { className: "ab-summary-actions" },
        button(
          "Use this agent",
          () => {
            const picks = pickState(state, personal);
            if (profile) actions.onUseProfile(profile.id, picks);
            else actions.onAuthorize(decided.decisions, decided.tool_approvals, picks, decided.provenance, null);
          },
          { variant: "primary", disabled: input.busy !== null || !canUse, title: canUse ? "Record these decisions and prepare a run plan" : "Trust the publisher first" },
        ),
        linkButton(state.customize ? "Hide the detailed settings" : "Customize your settings", () => {
          state.customize = !state.customize;
          if (state.customize && !state.draft) state.draft = draftFrom(decided, { profile_id: profile?.id ?? null, profile_title: profile?.title ?? null });
          actions.rerender();
        }),
      ),
      el("p", { className: "ab-hint", text: "Using the agent records your decisions and prepares a run plan. Nothing runs yet, and nothing is granted beyond what is listed above." }),
    ),
  );
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", { className: "ab-link", text });
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function pickState(state: AuthorizeState, requests: readonly ResourceRequest[]): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const request of requests) {
    const pick = state.picks[request.permission_id];
    if (pick && request.options.some((option) => option.resource_id === pick)) picks[request.permission_id] = pick;
  }
  return picks;
}

/** The host resource a permission would share, chosen by the person; the value itself never reaches the page. */
function resourcePicker(request: ResourceRequest, state: AuthorizeState, actions: AuthorizeActions, decision: Decision): HTMLElement {
  const kind = request.type_display_name ?? "record";
  if (request.status !== "offered") {
    const why =
      request.status === "empty"
        ? `You have no ${kind.toLowerCase()} in Your data yet; add one, or this permission stays unusable.`
        : request.status === "kind_mismatch"
          ? `The package requests a ${kind.toLowerCase()} under a different permission kind than this browser reads it with, so it cannot be granted.`
          : "The package's request names more than one kind of record, so it cannot be granted.";
    return el("div", { className: "ab-resource-choice" }, el("p", { className: "ab-hint", text: why }), request.status === "empty" ? linkButton("Open Your data", () => actions.onOpenSettings("data")) : null);
  }
  const select = el("select", { className: "ab-select", attrs: { name: `resource-${request.permission_id}`, "aria-label": `${kind} for ${request.permission_id}` } });
  const placeholder = el("option", { text: `Choose a ${kind.toLowerCase()}…`, attrs: { value: "" } });
  select.append(placeholder);
  for (const option of request.options) select.append(el("option", { text: option.label, attrs: { value: option.resource_id } }));
  const current = state.picks[request.permission_id] ?? "";
  select.value = request.options.some((option) => option.resource_id === current) ? current : "";
  select.addEventListener("change", () => {
    if (select.value) state.picks[request.permission_id] = select.value;
    else delete state.picks[request.permission_id];
  });
  return el(
    "div",
    { className: "ab-resource-choice" },
    el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: `${kind}${decision === "once" ? " (one run)" : ""}: ` }), select),
    el("p", { className: "ab-hint", text: `Held in this browser, not by the package. Only the one you choose is shared, and only with ${request.linked_tools.join(", ") || "the tools that link this permission"}.` }),
  );
}

// -- the customize view -------------------------------------------------------------------------
function permissionRow(view: AuthorizationView, draft: NonNullable<AuthorizeState["draft"]>, permission: AuthorizationView["request"]["permissions"][number], state: AuthorizeState, actions: AuthorizeActions): HTMLElement {
  const select = el("select", { className: "ab-select ab-decision", attrs: { name: `decision-${permission.id}`, "aria-label": `Decision for ${permission.id}` } });
  for (const option of ["deny", "once", "session"] as const) select.append(el("option", { text: DECISION_LABELS[option], attrs: { value: option } }));
  select.value = draft.decisions[permission.id] ?? "deny";
  select.addEventListener("change", () => {
    draft.decisions[permission.id] = select.value as Decision;
    draft.decidedBy[permission.id] = "user";
    actions.rerender();
  });
  const request = view.resources.requests.find((item) => item.permission_id === permission.id);
  return el(
    "div",
    { className: "ab-permission", attrs: { "data-permission": permission.id } },
    select,
    el(
      "div",
      { className: "ab-permission-body" },
      el("div", { className: "ab-access-head" }, el("code", { className: "ab-id", text: permission.id }), chip(permission.kind), chip(permission.required ? "Required" : "Optional", permission.required ? "warn" : "neutral"), chip(`decided by ${draft.decidedBy[permission.id] ?? "preset"}`, draft.decidedBy[permission.id] === "user" ? "good" : "neutral")),
      el("p", { className: "ab-access-text", text: permission.description }),
      request && draft.decisions[permission.id] !== "deny" ? resourcePicker(request, state, actions, draft.decisions[permission.id]!) : null,
      permission.linked_domains.length > 0 ? el("p", { className: "ab-hint", text: `Network: ${permission.linked_domains.join(", ")}` }) : null,
      permission.linked_tools.length > 0 ? el("p", { className: "ab-hint", text: `Used by: ${permission.linked_tools.join(", ")}` }) : null,
    ),
  );
}

function toolRow(view: AuthorizationView, draft: NonNullable<AuthorizeState["draft"]>, tool: AuthorizationView["request"]["tool_approvals"][number], actions: AuthorizeActions): HTMLElement {
  const offer = view.tools.find((item) => item.tool_id === tool.tool_id);
  const checkbox = el("input", { attrs: { type: "checkbox", name: `approve-${tool.tool_id}`, "aria-label": `Approve ${tool.tool_id}` } });
  checkbox.checked = draft.approvals[tool.tool_id] === true;
  checkbox.addEventListener("change", () => {
    draft.approvals[tool.tool_id] = checkbox.checked;
    draft.approvedBy[tool.tool_id] = "user";
    actions.rerender();
  });
  const status = offer?.status ?? "unknown";
  return el(
    "label",
    { className: "ab-approval", attrs: { "data-tool": tool.tool_id } },
    checkbox,
    el(
      "span",
      { className: "ab-approval-body" },
      el("span", { className: "ab-access-head" }, el("code", { className: "ab-id", text: tool.tool_id }), chip(tool.side_effects === "write" ? "writes" : "reads", tool.side_effects === "write" ? "warn" : "neutral"), tool.approval_required ? chip("approval required", "warn") : null, chip(status === "bound" ? "this browser can run it" : status, status === "bound" ? "good" : "bad"), chip(`decided by ${draft.approvedBy[tool.tool_id] ?? "preset"}`, draft.approvedBy[tool.tool_id] === "user" ? "good" : "neutral")),
      el("span", { className: "ab-hint", text: offer?.display_name ?? offer?.reason ?? tool.binding }),
      el("span", { className: "ab-hint", text: `Needs: ${tool.permissions.join(", ") || "no permission"}` }),
    ),
  );
}

function compatibilityTone(status: string): "good" | "warn" | "bad" {
  return status === "compatible" ? "good" : status === "unverified" ? "warn" : "bad";
}

function modelRow(model: ModelCompatibility, state: AuthorizeState, actions: AuthorizeActions, localOnly: boolean): HTMLElement {
  const notLocal = localOnly && model.properties.local !== true;
  const selectable = model.selectable_for_run_plan && !notLocal;
  const input = el("input", { attrs: { type: "radio", name: "agent-browser-model", value: model.model_id } });
  input.checked = state.selectedModel === model.model_id;
  input.disabled = !selectable;
  input.addEventListener("change", () => {
    state.selectedModel = model.model_id;
    actions.rerender();
  });
  const facts: string[] = [`Provider ${model.provider_id}`];
  facts.push(model.limits.context_tokens !== null ? `context ${model.limits.context_tokens.toLocaleString()} tokens` : "context not reported");
  if (model.limits.max_output_tokens !== null) facts.push(`output up to ${model.limits.max_output_tokens.toLocaleString()}`);
  if (!model.available && model.availability_reason) facts.push(`unavailable: ${model.availability_reason}`);
  facts.push(...model.properties.tags);
  return el(
    "div",
    { className: `ab-model-row${state.selectedModel === model.model_id ? " ab-model-selected" : ""}`, attrs: { "data-model": model.model_id } },
    el(
      "label",
      { className: "ab-model-label" },
      input,
      el("span", { className: "ab-model-head" }, el("strong", { text: model.display_name }), el("code", { className: "ab-model-id", text: model.model_id }), chip(model.status, compatibilityTone(model.status)), model.available ? null : chip("Not available", "bad"), model.properties.local === true ? chip("Local, free", "good") : chip("Hosted, metered", "warn"), notLocal ? chip("excluded by the privacy-first preset", "warn") : null),
    ),
    el("p", { className: "ab-hint", text: facts.join(" · ") }),
    model.status === "unverified" ? el("p", { className: "ab-hint", text: `Not enough is known to confirm: ${model.unknown.join(", ")}. State the model's limits in Settings → Models to make it usable.` }) : null,
    model.status === "incompatible" ? el("p", { className: "ab-hint", text: `Requirement not satisfied: ${model.violated.join(", ")}.` }) : null,
    details(
      "Compatibility details",
      false,
      definition(model.checks.map((check) => [check.id, `${check.status} · host says ${check.host_value === null ? "nothing" : String(check.host_value)} (${check.basis}${check.source ? `, ${check.source}` : ""})`])),
    ),
  );
}

function customizeView(input: AuthorizeInput, state: AuthorizeState, actions: AuthorizeActions): HTMLElement {
  const view = input.view;
  const draft = state.draft!;
  const required = view.request.permissions.filter((permission) => permission.required);
  const optional = view.request.permissions.filter((permission) => !permission.required);
  const models = input.models;
  const personal = view.resources.requests.filter((request) => draft.decisions[request.permission_id] !== "deny");
  const budget = input.session.page.cost;
  const trusted = input.session.page.trust.trust_status === "trusted";
  return card(
    "Customize your settings",
    el("p", { className: "ab-hint", text: "Every permission starts denied unless a profile or your preset granted it. Trust and permission are separate decisions: a trusted publisher is granted nothing until you choose it here. “Always” is not offered; nothing outlives this session." }),
    el("h4", { text: "Required" }),
    ...required.map((permission) => permissionRow(view, draft, permission, state, actions)),
    optional.length > 0 ? el("h4", { text: "Optional" }) : null,
    ...optional.map((permission) => permissionRow(view, draft, permission, state, actions)),
    el("h4", { text: "Tool approvals" }),
    el("p", { className: "ab-hint", text: "A permission allows a class of authority; an approval names the one implementation of one tool this browser would run. A tool you do not approve is denied: the runtime refuses any call to it." }),
    ...view.request.tool_approvals.map((tool) => toolRow(view, draft, tool, actions)),
    el("h4", { text: "Model" }),
    models
      ? el(
          "div",
          { className: "ab-models", attrs: { role: "radiogroup" } },
          el("p", { className: "ab-hint", text: `${models.evaluation.counts.available ?? 0} of ${models.evaluation.counts.total ?? 0} models available · ${models.evaluation.counts.compatible ?? 0} compatible, ${models.evaluation.counts.unverified ?? 0} unverified, ${models.evaluation.counts.incompatible ?? 0} incompatible. The package names no provider; you choose.` }),
          ...models.evaluation.notes.map((note) => el("p", { className: "ab-hint" }, el("code", { text: note.code }), " ", el("span", { text: note.detail ?? "" }))),
          ...models.evaluation.models.map((model) => modelRow(model, state, actions, models.local_models_only)),
          button("Refresh models", actions.onRefreshModels),
        )
      : el("p", { className: "ab-hint" }, "Models are listed once the catalog is read. ", linkButton("Read it now", actions.onRefreshModels)),
    el("h4", { text: "Declared limits" }),
    definition([
      ["Estimated tokens", budget.estimated_tokens.toLocaleString()],
      ["Hard token limit", budget.hard_tokens.toLocaleString()],
      ["Max remote calls", String(budget.max_remote_calls)],
      ["Cost", budget.text],
    ]),
    el(
      "div",
      { className: "ab-summary-actions" },
      button(
        "Authorize with these settings",
        () => actions.onAuthorize(draft.decisions, draft.approvals, pickState(state, personal), provenanceFrom(draft, view.preset, pickState(state, personal)), state.selectedModel),
        { variant: "primary", disabled: input.busy !== null || !trusted, title: trusted ? "Record these decisions and prepare a run plan with the selected model" : "Trust the publisher first" },
      ),
      state.selectedModel && view.receipt
        ? button("Prepare run plan with the selected model", () => actions.onPrepare(state.selectedModel!), { disabled: input.busy !== null })
        : null,
    ),
    el("p", { className: "ab-hint", text: "Authorizing runs nothing. Changed decisions are recorded as your own." }),
  );
}

// -- the receipt and the plan -----------------------------------------------------------------
function planCard(input: AuthorizeInput, actions: AuthorizeActions): HTMLElement | null {
  const view = input.view;
  if (!view.receipt) return null;
  const receipt = view.receipt;
  const plan = view.run_plan;
  const ready = plan?.preflight.ready === true;
  const headline = plan ? (ready ? "Ready to run" : plan.preflight.stale ? "The run plan is stale" : "The run plan is not ready") : receipt.runnable ? "Authorized, no run plan yet" : "Cannot run with these decisions";
  const tone = ready ? "good" : plan || !receipt.runnable ? "warn" : "neutral";
  const problems = plan ? [...plan.preflight.stale_reasons, ...plan.preflight.blocking_reasons] : receipt.blocking_reasons;
  return card(
    "Run plan",
    el("div", { className: `ab-banner ab-banner-${tone}`, attrs: { role: "status" } }, el("strong", { text: headline }), el("p", { text: ready ? "Everything this run needs is bound and current. Running arrives with the execution host (T5); nothing has run." : plan ? "This plan cannot be used as it stands; the reasons are below." : receipt.runnable ? "Choose a model under Customize your settings, or a default model in Settings → Models, to prepare a run plan." : "Adjust the decisions, or resolve the reasons below, then authorize again." })),
    reasons(problems, "Why not"),
    plan
      ? definition([
          ["Agent", `${plan.run_plan.package.name} ${plan.run_plan.package.version}`],
          ["Publisher", `${plan.run_plan.publisher.trust_status === "trusted" ? "trusted" : plan.run_plan.publisher.trust_status} · ${plan.run_plan.publisher.claimed_name}`],
          ["Model", plan.run_plan.model_binding ? `${plan.run_plan.model_binding.display_name} (${plan.run_plan.model_binding.host_model_id})` : "none"],
          ["Tools it may call", plan.run_plan.execution.required_tool_ids.join(", ") || "none"],
          ["Tools it may not call", plan.run_plan.execution.denied_tool_ids.join(", ") || "none"],
          ["Your data", plan.run_plan.resource_grants.map((grant) => grant.permission_id).join(", ") || "none"],
          ["Decided by", receipt.provenance ? `${receipt.provenance.profile_title ? `profile “${receipt.provenance.profile_title}”` : "your own settings"}, ${PRESET_TITLES[receipt.provenance.preset] ?? receipt.provenance.preset} preset` : "the receipt states no provenance"],
        ])
      : null,
    details(
      "Technical details",
      false,
      definition([
        ["Receipt", el("code", { text: receipt.receipt_id })],
        ["Receipt hash", el("code", { text: `sha256:${receipt.receipt_sha256}` })],
        ["Issued", whenText(receipt.issued_at)],
        ["Expires", whenText(receipt.expires_at)],
        ["Decisions", Object.entries(receipt.decisions).map(([id, decision]) => `${id}=${decision}`).join(" · ")],
        ["Tool approvals", Object.entries(receipt.tool_approvals).map(([id, approved]) => `${id}=${approved}`).join(" · ")],
        ["Host resources", receipt.resource_grants.map((grant) => `${grant.permission_id} → ${grant.resource_id} (${shortHash(grant.resource_digest)})`).join(" · ") || "none"],
        ["Runnable", receipt.runnable ? "yes" : "no"],
        ...(plan
          ? ([
              ["Run plan", el("code", { text: plan.run_plan.run_plan_id })],
              ["Run plan hash", el("code", { text: `sha256:${plan.run_plan.run_plan_sha256}` })],
              ["Prepared", whenText(plan.run_plan.created_at)],
              ["Preflight", `${plan.preflight.state} · checked ${whenText(plan.preflight.checked_at)}`],
              ["Model still offered", plan.preflight.model_still_available === null ? "unknown" : plan.preflight.model_still_available ? "yes" : "no"],
              ["Tool bindings", `${plan.preflight.tool_bindings.bound} bound · ${plan.preflight.tool_bindings.current ? "current" : "changed"}`],
              ["Trust store changed since", plan.preflight.trust_store_changed ? "yes" : "no"],
            ] as Array<[string, Child]>)
          : []),
      ]),
    ),
    plan ? button("Discard run plan", actions.onClearPlan, { variant: "danger" }) : null,
  );
}

/** The trust prompt when the publisher is unknown: the two-press pin control, or why the agent cannot be used. */
function trustPrompt(input: AuthorizeInput, actions: AuthorizeActions): HTMLElement | null {
  const trust = input.session.page.trust;
  if (trust.trust_status === "trusted") return null;
  return card(
    "Before you use this agent",
    el("div", { className: "ab-trust-head" }, chip(trust.headline, trust.tone)),
    el("p", { text: trust.detail }),
    trust.can_pin && actions.onTrust ? pinControls(input.session.page, actions.onTrust) : el("p", { className: "ab-hint", text: "This browser does not run agents whose publisher key it does not trust." }),
  );
}

/** Build the authorize view for one session. */
export function renderAuthorizeView(input: AuthorizeInput, state: AuthorizeState, actions: AuthorizeActions): HTMLElement {
  const view = input.view;
  const profiles = view.profiles;
  if (profiles && profiles.length > 0 && state.selectedProfile === null) state.selectedProfile = profiles[0]!.profile.id; // least authority first (spec §4 rule 5)
  const selected = profiles?.find((entry) => entry.profile.id === state.selectedProfile) ?? null;
  const decided: Decided = selected ? selected.decided : view.defaults;
  const children: Child[] = [];
  if (state.notice) children.push(el("div", { className: `ab-banner ab-banner-${state.notice.tone}`, attrs: { role: "status" } }, el("span", { text: state.notice.text })));
  children.push(trustPrompt(input, actions));
  if (profiles && profiles.length > 0) {
    children.push(
      card(
        "Ways to use it",
        el("p", { className: "ab-hint", text: "The publisher groups what this agent needs into a few choices. Pick one; the full detailed view is one click away." }),
        el(
          "div",
          { className: "ab-profile-cards" },
          ...profiles.map((entry) =>
            profileCard(view, entry, entry.profile.id === state.selectedProfile, () => {
              state.selectedProfile = entry.profile.id;
              // An open detailed view follows the chosen profile rather than vanishing behind a
              // link that still reads "Hide the detailed settings" (review 1, nit 15).
              state.draft = state.customize ? draftFrom(entry.decided, { profile_id: entry.profile.id, profile_title: entry.profile.title }) : null;
              actions.rerender();
            }),
          ),
        ),
      ),
    );
  } else if (view.profile_notes.length > 0) {
    children.push(el("p", { className: "ab-hint", text: view.profile_notes.join(" ") }));
  }
  children.push(summaryCard(input, state, actions, decided, selected?.profile ?? null));
  if (state.customize && state.draft) children.push(customizeView(input, state, actions));
  children.push(planCard(input, actions));
  return el("section", { className: `ab-authorize${input.compact ? " ab-authorize-compact" : ""}`, attrs: { "data-session": input.session.session.id } }, ...children);
}
