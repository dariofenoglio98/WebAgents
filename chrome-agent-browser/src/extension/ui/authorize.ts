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
import { envelopeText } from "../../core/agent-page.js";
import type { Decided } from "../../core/authorization.js";
import type { ModelCompatibility } from "../../core/compatibility.js";
import type { Profile } from "../../core/profiles.js";
import { PROVENANCE_SCHEMA, type DecidedBy, type Decision, type Provenance, type Reason } from "../../core/types.js";
import type { ResourceRequest } from "../../core/hostresources.js";
import type { AuthorizationView, ModelsView, RecallView, SessionView } from "../messages.js";
import { lastUseWords } from "../../core/memory/words.js";
import { fill, STRINGS } from "./memory/strings.js";
import { estimateLine, pinControls } from "./agent-page.js";
import { button, card, chip, definition, details, el, list, row, shortHash, whenText, type Child } from "./dom.js";

export interface AuthorizeState {
  /** The profile card the person pressed (the first one by default when profiles exist). */
  selectedProfile: string | null;
  /** Whether "Customize your settings" is open. */
  customize: boolean;
  /** The customize view's working copy, or null until it is opened. */
  draft: { decisions: Record<string, Decision>; approvals: Record<string, boolean>; decidedBy: Record<string, DecidedBy>; approvedBy: Record<string, DecidedBy>; base: { profile_id: string | null; profile_title: string | null } } | null;
  /** The person's picks per resource-bearing permission; a recall card may pre-select one (memory.v0 M-52), recorded as `preset` when the convenience preset chose it. */
  picks: Record<string, string>;
  /** Recall cards opened on "Change…" (the full candidate list), by permission id. */
  recallOpen: Record<string, boolean>;
  /** "Don't share one" per permission: the permission is denied when the agent is used. */
  declined: Record<string, boolean>;
  /** Picks the convenience preset made (`preset` in the provenance, M-53), by permission id. */
  autoPicked: Record<string, boolean>;
  selectedModel: string | null;
  /** Local notice after an action. */
  notice: { text: string; tone: "good" | "warn" | "bad" } | null;
  /** Origins a refusal named (T16, D-193): the notice offers Allow for them. */
  allowOrigins: string[] | null;
}

export function newAuthorizeState(): AuthorizeState {
  return { selectedProfile: null, customize: false, draft: null, picks: {}, recallOpen: {}, declined: {}, autoPicked: {}, selectedModel: null, notice: null, allowOrigins: null };
}

export interface AuthorizeActions {
  onUseProfile: (profileId: string, picks: Record<string, string>, presetSelections?: string[]) => void;
  /** `modelId` is the model picked in the customize view; null prepares the plan on the default model. */
  onAuthorize: (decisions: Record<string, Decision>, approvals: Record<string, boolean>, picks: Record<string, string>, provenance: Provenance, modelId: string | null, presetSelections?: string[]) => void;
  onPrepare: (modelId: string) => void;
  onRefreshModels: () => void;
  onClearPlan: () => void;
  onOpenSettings: (section: "models" | "policies" | "data" | "memory" | "security") => void;
  onTrust?: (scope: "package" | "publisher") => void;
  /**
   * Ask Chrome for these origins before the decisions are sent (T16, D-193): called inside the
   * click, where the gesture Chrome requires is in force. Absent in tests without a `chrome`.
   */
  requestOrigins?: (origins: string[]) => Promise<boolean>;
  /** Open the Unlock sheet (T16): the store is locked and a record must be chosen. */
  onUnlock?: () => void;
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

/** Who decided, in words: the policy is named by id and version (T8, D-102). */
function decidedByText(by: DecidedBy | undefined, view: AuthorizationView): string {
  if (by === "policy") return `decided by policy ${view.policy?.label ?? "(no longer in force)"}`;
  return `decided by ${by ?? "preset"}`;
}

function decidedByTone(by: DecidedBy | undefined): "good" | "neutral" {
  return by === "user" ? "good" : "neutral";
}
const PRESET_TITLES: Record<string, string> = { "privacy-first": "Privacy first", balanced: "Balanced", convenience: "Convenience" };

/** What a granted permission lets the agent do, in a person's words (D-052). */
function authorityWords(view: AuthorizationView, permission: AuthorizationView["request"]["permissions"][number], decision: Decision, picks: Record<string, string> | null = null, autoPicked: Record<string, boolean> | null = null): string {
  const once = decision === "once" ? ", once" : "";
  switch (permission.kind) {
    case "network":
      return `contact ${permission.linked_domains.join(", ") || permission.resources.join(", ")}${once}`;
    case "model":
      return `use your model${once}`;
    case "memory":
      if (permission.resources.length === 1 && permission.resources[0] === "agent") return view.preset === "privacy-first" ? STRINGS["agent.words.no_notes"] : STRINGS["agent.words.notes"];
      return "keep working notes for this run only";
    case "personal.read":
    case "memory.read": {
      const request = view.resources.requests.find((item) => item.permission_id === permission.id);
      const recall = view.recall.find((item) => item.permission_id === permission.id);
      const type = (recall?.display_name ?? request?.type_display_name ?? permission.resources.join(", ")).toLowerCase();
      const chosen = picks?.[permission.id];
      const title = chosen ? recall?.candidates.find((candidate) => candidate.id === chosen)?.title ?? request?.options.find((option) => option.resource_id === chosen)?.label ?? null : null;
      if (title) return `${fill("agent.words.use", { title })}${autoPicked?.[permission.id] ? ` (${STRINGS["memory.recall.auto"]})` : ""}${once}`;
      return `${fill("agent.words.read", { type })}${once}`;
    }
    case "memory.write": {
      const names = permission.resources.map((type) => view.recall.find((item) => item.resource_type === type)?.display_name?.toLowerCase() ?? type.replace(/^[a-z]+\./u, "").replace(/_/gu, " ")).map((name) => `${name}s`);
      return `${fill("agent.words.propose", { types: names.join(", ") })}${once}`;
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
  const estimate = estimateLine(profile.estimate);
  const granted = view.request.permissions.filter((permission) => entry.decided.decisions[permission.id] !== "deny");
  const node = el(
    "button",
    { className: `ab-profile-card${selected ? " ab-profile-selected" : ""}`, attrs: { type: "button", "data-profile": profile.id, "aria-pressed": selected ? "true" : "false" } },
    el("span", { className: "ab-profile-card-title", text: profile.title }),
    el("span", { className: "ab-profile-card-text", text: profile.description }),
    // The members, not only the words (spec §5, D-052): what it gets, in plain words.
    el("span", { className: "ab-profile-card-gets", text: `Gets: ${granted.map((permission) => authorityWords(view, permission, entry.decided.decisions[permission.id]!)).join("; ") || "nothing"}` }),
    // One short line from the publisher (D-111); the notes and the member ids are under the agent page's Technical details.
    estimate ? el("span", { className: "ab-hint ab-profile-card-estimate", text: `Estimate: ${estimate}` }) : null,
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
  for (const request of personal) preselect(view, state, request.permission_id);
  const pickers = personal.map((request) => recallCard(request, view, state, actions, decided.decisions[request.permission_id]!, view.secrets !== "unlocked"));
  const trust = input.session.page.trust;
  const canUse = trust.trust_status === "trusted";
  return card(
    profile ? `Use it to: ${profile.title}` : "What you are about to allow",
    el(
      "div",
      { className: "ab-summary" },
      el("h4", { text: "This agent will be able to" }),
      list(granted.map((permission) => authorityWordsNode(view, permission, decided.decisions[permission.id]!, state, actions))),
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
          ? el("span", {}, el("code", { text: view.default_model }), model ? (model.available ? chip(model.status, compatibilityTone(model.status)) : chip("not available", "bad")) : null, model?.properties.local === true ? chip("local, free") : model ? chip("hosted, metered", "warn") : null)
          : el("span", {}, "none chosen yet — ", linkButton("choose one in Settings → Models", () => actions.onOpenSettings("models"))),
      ),
      row("Preset", `${PRESET_TITLES[view.preset] ?? view.preset} (payments stay single-use; nothing is granted beyond what is listed)`),
      view.policy
        ? row(
            "Your policy",
            el("span", {}, `${view.policy.reference.title} `, el("code", { text: view.policy.label }), `: ${[...view.policy.limits_capped, view.policy.local_only ? "local models only" : null, view.policy.max_cost_usd_per_run !== null ? `models at most $${view.policy.max_cost_usd_per_run} per run` : null, view.policy.bindings_restricted ? "only the services it lists" : null].filter(Boolean).join("; ") || "no limits of its own"}.`),
          )
        : null,
      row("Decided by", decidedByLine(view, decided, profile)),
      el(
        "div",
        { className: "ab-summary-actions" },
        button(
          "Use this agent",
          () => {
            const picks = pickState(state, personal);
            const auto = Object.keys(picks).filter((id) => state.autoPicked[id]);
            const declined = personal.filter((request) => state.declined[request.permission_id]).map((request) => request.permission_id);
            withOrigins(actions, originsFor(view, decided.tool_approvals, null), () => {
              if (profile && declined.length === 0) actions.onUseProfile(profile.id, picks, auto);
              else {
                // "Don't share one": the permission is denied, as the person's own decision (M-34).
                const decisions = { ...decided.decisions };
                const provenance = { ...decided.provenance, decisions: { ...decided.provenance.decisions } };
                for (const id of declined) {
                  decisions[id] = "deny";
                  provenance.decisions[id] = "user";
                }
                actions.onAuthorize(decisions, decided.tool_approvals, picks, provenance, null, auto);
              }
            });
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

/** "Decided by" in one line: the profile or the preset's defaults, and the policy for what it decided. */
function decidedByLine(view: AuthorizationView, decided: Decided, profile: Profile | null): string {
  const preset = PRESET_TITLES[view.preset] ?? view.preset;
  const base = profile ? `the “${profile.title}” profile, with the ${preset} preset's durations` : `the ${preset} preset's defaults`;
  const byPolicy = [...Object.values(decided.provenance.decisions), ...Object.values(decided.provenance.tool_approvals)].filter((by) => by === "policy").length;
  if (!view.policy || byPolicy === 0) return base;
  return `${base}; ${byPolicy} item${byPolicy === 1 ? "" : "s"} pre-decided by your policy ${view.policy.reference.title} (${view.policy.label}). Change any of them under Customize your settings and it is recorded as yours.`;
}

function linkButton(text: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", { className: "ab-link", text });
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

/**
 * The origins these decisions would need (D-193): the package's own, every approved remote tool's,
 * and the model's provider (the chosen one, else the default). Computed from the worker's
 * per-part answer so the page asks Chrome for exactly this set, in the click.
 */
export function originsFor(view: AuthorizationView, approvals: Record<string, boolean>, modelId: string | null): string[] {
  const origins = new Set<string>();
  if (view.origins.package) origins.add(view.origins.package);
  for (const [toolId, toolOrigins] of Object.entries(view.origins.tools)) if (approvals[toolId] === true) for (const origin of toolOrigins) origins.add(origin);
  const model = modelId ?? view.default_model;
  const provider = model?.split("/")[0] ?? null;
  const providerOrigin = provider === null ? null : (view.origins.providers[provider] ?? null);
  if (providerOrigin) origins.add(providerOrigin);
  return [...origins].sort();
}

/** Run `send` after Chrome was asked for the origins (a refusal is not an error: the worker refuses by name and the notice offers Allow). */
function withOrigins(actions: AuthorizeActions, origins: string[], send: () => void): void {
  if (!actions.requestOrigins || origins.length === 0) {
    send();
    return;
  }
  void actions.requestOrigins(origins).then(send, send);
}

function pickState(state: AuthorizeState, requests: readonly ResourceRequest[]): Record<string, string> {
  const picks: Record<string, string> = {};
  for (const request of requests) {
    const pick = state.picks[request.permission_id];
    if (pick && request.options.some((option) => option.resource_id === pick)) picks[request.permission_id] = pick;
  }
  return picks;
}

/** M-52: a propose or auto card pre-selects the top candidate once; the person's own pick or "Don't share one" is never overridden. */
function preselect(view: AuthorizationView, state: AuthorizeState, permissionId: string): void {
  const recall = view.recall.find((item) => item.permission_id === permissionId);
  if (!recall || recall.mode === "ask" || state.picks[permissionId] || state.declined[permissionId] || state.recallOpen[permissionId]) return;
  const top = recall.candidates.find((candidate) => !candidate.signals.expired) ?? recall.candidates[0];
  if (!top) return;
  state.picks[permissionId] = top.id;
  if (recall.mode === "auto") state.autoPicked[permissionId] = true;
}

/** A granted permission's line; a convenience auto-selection carries its "change" link (M-52). */
function authorityWordsNode(view: AuthorizationView, permission: AuthorizationView["request"]["permissions"][number], decision: Decision, state: AuthorizeState, actions: AuthorizeActions): Child {
  const text = authorityWords(view, permission, decision, state.picks, state.autoPicked);
  if (!state.autoPicked[permission.id] || state.recallOpen[permission.id]) return text;
  return el("span", {}, el("span", { text: `${text} · ` }), linkButton("change", () => {
    state.recallOpen[permission.id] = true;
    actions.rerender();
  }));
}

function signalChips(candidate: RecallView["candidates"][number]): HTMLElement[] {
  const chips: HTMLElement[] = [];
  if (candidate.signals.about_self) chips.push(chip("about you"));
  if (candidate.signals.same_package) chips.push(chip(`used by this package`));
  if (candidate.signals.linked_to.length > 0) chips.push(chip(`linked to a selected record`));
  if (candidate.signals.recently_read) chips.push(chip("read recently"));
  if (candidate.signals.expired) chips.push(chip("expired", "warn"));
  if (candidate.demo) chips.push(chip("demo", "warn"));
  return chips;
}

/**
 * The recall card per `memory.read` (or alias) request (design §4, M-34, M-52): under balanced the
 * top candidate pre-selected and one click confirms; under privacy first (and for every sealed
 * type) a choice with nothing pre-selected; under convenience an unsealed type is chosen and the
 * summary line says so. The full list shows each candidate's signals, so the ranking is legible.
 */
function recallCard(request: ResourceRequest, view: AuthorizationView, state: AuthorizeState, actions: AuthorizeActions, decision: Decision, locked: boolean): HTMLElement | null {
  const recall = view.recall.find((item) => item.permission_id === request.permission_id);
  if (!recall) return resourcePicker(request, state, actions, decision, locked);
  const kind = (recall.display_name ?? request.type_display_name ?? "record").toLowerCase();
  if (locked) return resourcePicker(request, state, actions, decision, locked);
  const id = request.permission_id;
  if (request.status !== "offered" || recall.candidates.length === 0) {
    return el(
      "div",
      { className: "ab-resource-choice ab-recall ab-recall-empty", attrs: { "data-permission": id } },
      el("p", { className: "ab-hint", text: fill("memory.recall.empty", { type: kind }) }),
      el("div", { className: "ab-inline" }, linkButton("Create one", () => actions.onOpenSettings("memory")), el("span", { className: "ab-muted", text: " · " }), linkButton("Continue without", () => {
        state.declined[id] = true;
        delete state.picks[id];
        actions.rerender();
      })),
    );
  }
  const sealedLine = recall.sealed ? el("p", { className: "ab-hint", text: fill("memory.recall.sealed", { fields: recall.sealed_fields.map((pointer) => pointer.slice(1).replace(/_/gu, " ")).join(", "), tools: request.linked_tools.join(", ") || "the tools that link this permission" }) }) : null;
  const picked = state.picks[id] ?? null;
  const declined = state.declined[id] === true;
  const open = recall.mode === "ask" || state.recallOpen[id] === true || declined;
  const candidateLine = (candidate: RecallView["candidates"][number]): string => `${lastUseWords(candidate.last_use === null ? null : { package_id: candidate.last_use.package_id, at: candidate.last_use.at })} · ${candidate.provenance}`;
  if (recall.mode === "auto" && !open) return null; // the summary line carries it (M-52)
  if (!open && picked) {
    const chosen = recall.candidates.find((candidate) => candidate.id === picked)!;
    return el(
      "div",
      { className: "ab-resource-choice ab-recall ab-recall-propose", attrs: { "data-permission": id, "data-record": chosen.id } },
      el("div", { className: "ab-recall-head" }, el("strong", { text: fill("memory.recall.use", { title: chosen.title }) }), chip(recall.display_name ?? kind), chosen.signals.about_self ? chip("about you") : null, decision === "once" ? chip("one run") : null),
      el("p", { className: "ab-hint", text: candidateLine(chosen) }),
      sealedLine,
      el("div", { className: "ab-inline" }, linkButton(STRINGS["memory.recall.change"], () => {
        state.recallOpen[id] = true;
        actions.rerender();
      }), el("span", { className: "ab-muted", text: " · " }), linkButton(STRINGS["memory.recall.none"], () => {
        state.declined[id] = true;
        delete state.picks[id];
        delete state.autoPicked[id];
        actions.rerender();
      })),
    );
  }
  const radios = recall.candidates.map((candidate) => {
    const input = el("input", { attrs: { type: "radio", name: `resource-${id}`, value: candidate.id } });
    input.checked = picked === candidate.id && !declined;
    input.addEventListener("change", () => {
      state.picks[id] = candidate.id;
      delete state.declined[id];
      delete state.autoPicked[id];
      actions.rerender();
    });
    return el("label", { className: "ab-recall-option", attrs: { "data-record": candidate.id } }, input, el("span", {}, el("strong", { text: candidate.title }), ...signalChips(candidate), el("span", { className: "ab-hint", text: ` ${candidateLine(candidate)}` })));
  });
  const none = el("input", { attrs: { type: "radio", name: `resource-${id}`, value: "" } });
  none.checked = declined;
  none.addEventListener("change", () => {
    state.declined[id] = true;
    delete state.picks[id];
    delete state.autoPicked[id];
    actions.rerender();
  });
  return el(
    "div",
    { className: "ab-resource-choice ab-recall ab-recall-ask", attrs: { "data-permission": id, role: "group", "aria-label": fill("memory.recall.ask", { type: kind }) } },
    el("p", {}, el("strong", { text: fill("memory.recall.ask", { type: kind }) }), recall.sealed ? chip("🔒", "neutral") : null),
    ...radios,
    el("label", { className: "ab-recall-option" }, none, el("span", { text: "None" })),
    sealedLine,
  );
}

/** The host resource a permission would share, chosen by the person; the value itself never reaches the page. */
function resourcePicker(request: ResourceRequest, state: AuthorizeState, actions: AuthorizeActions, decision: Decision, locked = false): HTMLElement {
  const kind = request.type_display_name ?? "record";
  if (locked) {
    return el("div", { className: "ab-resource-choice ab-resource-locked" }, el("p", { className: "ab-hint", text: `Unlock your keys and records to choose which ${kind.toLowerCase()} to share.` }), actions.onUnlock ? linkButton("Unlock", actions.onUnlock) : null);
  }
  if (request.status !== "offered") {
    const why =
      request.status === "empty"
        ? `You have no ${kind.toLowerCase()} in your memory yet; add one, or this permission stays unusable.`
        : request.status === "kind_mismatch"
          ? `The package requests a ${kind.toLowerCase()} under a different permission kind than this browser reads it with, so it cannot be granted.`
          : "The package's request names more than one kind of record, so it cannot be granted.";
    return el("div", { className: "ab-resource-choice" }, el("p", { className: "ab-hint", text: why }), request.status === "empty" ? linkButton("Open Memory", () => actions.onOpenSettings("memory")) : null);
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
      el("div", { className: "ab-access-head" }, el("code", { className: "ab-id", text: permission.id }), chip(permission.kind), chip(permission.required ? "Required" : "Optional", permission.required ? "warn" : "neutral"), chip(decidedByText(draft.decidedBy[permission.id], view), decidedByTone(draft.decidedBy[permission.id]))),
      el("p", { className: "ab-access-text", text: permission.description }),
      request && draft.decisions[permission.id] !== "deny" ? (view.recall.some((item) => item.permission_id === permission.id) ? recallCard(request, view, { ...state, recallOpen: { ...state.recallOpen, [permission.id]: true } }, actions, draft.decisions[permission.id]!, view.secrets !== "unlocked") : resourcePicker(request, state, actions, draft.decisions[permission.id]!, view.secrets !== "unlocked")) : null,
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
      el("span", { className: "ab-access-head" }, el("code", { className: "ab-id", text: tool.tool_id }), chip(tool.side_effects === "write" ? "writes" : "reads", tool.side_effects === "write" ? "warn" : "neutral"), tool.approval_required ? chip("approval required", "warn") : null, chip(status === "bound" ? "this browser can run it" : status, status === "bound" ? "good" : "bad"), chip(decidedByText(draft.approvedBy[tool.tool_id], view), decidedByTone(draft.approvedBy[tool.tool_id]))),
      el("span", { className: "ab-hint", text: offer?.display_name ?? offer?.reason ?? tool.binding }),
      el("span", { className: "ab-hint", text: `Needs: ${tool.permissions.join(", ") || "no permission"}` }),
    ),
  );
}

function compatibilityTone(status: string): "good" | "warn" | "bad" {
  return status === "compatible" ? "good" : status === "unverified" ? "warn" : "bad";
}

/** The picker's routes in the order design §8 shows them when each is available (D-446). */
export const ROUTE_ORDER: readonly string[] = Object.freeze(["in-browser", "chrome-builtin", "ollama", "openai", "anthropic"]);
const HOSTED_BY: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic" };

/** A route card's line and subline (D-446, design §8), in the words the design fixes. */
export function routeWords(model: Pick<ModelCompatibility, "provider_id" | "display_name" | "model_id">): { line: string; subline: string } {
  const name = model.model_id.slice(model.model_id.indexOf("/") + 1);
  switch (model.provider_id) {
    case "in-browser":
      return { line: `In this browser · ${model.display_name} · free`, subline: "Runs inside this extension on your GPU. No network: nothing leaves this browser." };
    case "chrome-builtin":
      return { line: "Chrome's built-in model (Gemini Nano) · free", subline: "Run by Chrome on this device; a small model, Chrome's own." };
    case "ollama":
      return { line: `Ollama on this computer · ${name} · free`, subline: "A separate application: it runs outside the browser's protection, and this browser cannot bound what it does with your data." };
    default:
      return { line: `Hosted by ${HOSTED_BY[model.provider_id] ?? model.provider_id} · ${name} · metered`, subline: "Your key; the request leaves this device to the provider." };
  }
}

/** The models in route order (design §8), each route's own order kept. */
export function inRouteOrder<T extends { provider_id: string }>(models: readonly T[]): T[] {
  const rank = (provider: string) => (ROUTE_ORDER.includes(provider) ? ROUTE_ORDER.indexOf(provider) : ROUTE_ORDER.length);
  return models.map((model, index) => ({ model, index })).sort((a, b) => rank(a.model.provider_id) - rank(b.model.provider_id) || a.index - b.index).map((item) => item.model);
}

/**
 * The picker's suggestion (D-446): in-browser when a recommended entry is cached (one click picks
 * it), else that entry's download card in Settings → Models. Nothing downloads from here.
 */
function inBrowserSuggestion(models: ModelsView, state: AuthorizeState, actions: AuthorizeActions): HTMLElement | null {
  const suggestion = models.in_browser?.suggestion ?? null;
  if (suggestion === null) return null;
  const words = routeWords({ provider_id: "in-browser", display_name: suggestion.display_name, model_id: suggestion.host_model_id });
  if (suggestion.cached && suggestion.available) {
    return el(
      "div",
      { className: "ab-banner ab-banner-good ab-suggestion", attrs: { role: "status", "data-suggestion": suggestion.host_model_id } },
      el("strong", { text: `Suggested: ${words.line}` }),
      el("p", { text: words.subline }),
      state.selectedModel === suggestion.host_model_id
        ? null
        : button("Use it", () => {
            state.selectedModel = suggestion.host_model_id;
            actions.rerender();
          }, { variant: "primary" }),
    );
  }
  return el(
    "div",
    { className: "ab-banner ab-banner-neutral ab-suggestion", attrs: { role: "status", "data-suggestion": suggestion.host_model_id } },
    el("strong", { text: `Run this agent in this browser: ${suggestion.display_name} (${(suggestion.bytes_total / 1e9).toFixed(1)} GB, ${suggestion.license.name})` }),
    el("p", { text: `${words.subline} ${suggestion.reasons[0] ?? ""}`.trim() }),
    linkButton("Open its download card in Settings → Models", () => actions.onOpenSettings("models")),
  );
}

function modelRow(model: ModelCompatibility, state: AuthorizeState, actions: AuthorizeActions, localOnly: boolean, policy: ModelsView["model_policy"] = null): HTMLElement {
  const notLocal = localOnly && model.properties.local !== true;
  // A cost cap admits only models whose cost this browser can bound: free (local) ones (D-102).
  const unpriced = policy !== null && policy.max_cost_usd_per_run !== null && model.properties.local !== true && model.properties.cost_class !== "free";
  const selectable = model.selectable_for_run_plan && !notLocal && !unpriced;
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
  facts.push(...model.properties.tags);
  const route = routeWords(model);
  return el(
    "div",
    { className: `ab-model-row${state.selectedModel === model.model_id ? " ab-model-selected" : ""}`, attrs: { "data-model": model.model_id, "data-route": model.provider_id } },
    el("p", { className: "ab-route" }, el("strong", { text: route.line }), el("span", { className: "ab-hint", text: ` ${route.subline}` })),
    el(
      "label",
      { className: "ab-model-label" },
      input,
      el("span", { className: "ab-model-head" }, el("strong", { text: model.display_name }), el("code", { className: "ab-model-id", text: model.model_id }), model.available ? chip(model.status, compatibilityTone(model.status)) : chip("Not available", "bad"), model.properties.local === true ? chip("Local, free", "good") : chip("Hosted, metered", "warn"), notLocal ? chip(policy?.local_only ? `excluded by your policy (${policy.label}): local models only` : "excluded by the privacy-first preset", "warn") : null, unpriced ? chip(`excluded by your policy's cost cap ($${policy!.max_cost_usd_per_run} per run; no price known)`, "warn") : null),
    ),
    el("p", { className: "ab-hint", text: facts.join(" · ") }),
    // An unavailable model is reported as such, with its provider's answer: what it might lack is beside the point until it answers (D-077).
    !model.available ? el("p", { className: "ab-hint ab-model-unavailable", text: `Not available: ${model.availability_reason ?? "its provider does not offer it now."} Test the connection in Settings → Models.` }) : null,
    model.available && model.status === "unverified" ? el("p", { className: "ab-hint", text: `Not enough is known to confirm: ${model.unknown.join(", ")}. State the model's limits in Settings → Models to make it usable.` }) : null,
    model.available && model.status === "incompatible" ? el("p", { className: "ab-hint", text: `Requirement not satisfied: ${model.violated.join(", ")}.` }) : null,
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
          inBrowserSuggestion(models, state, actions),
          // Route order (D-446); the in-browser entries not downloaded live in Settings → Models, not here.
          ...inRouteOrder(models.evaluation.models.filter((model) => model.provider_id !== "in-browser" || model.available)).map((model) => modelRow(model, state, actions, models.local_models_only, models.model_policy ?? null)),
          (() => {
            const hidden = models.evaluation.models.filter((model) => model.provider_id === "in-browser" && !model.available).length;
            return hidden > 0 ? el("p", { className: "ab-hint" }, `${hidden} more in-browser model${hidden === 1 ? "" : "s"} can be downloaded in `, linkButton("Settings → Models → In this browser", () => actions.onOpenSettings("models")), ".") : null;
          })(),
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
        () => withOrigins(actions, originsFor(view, draft.approvals, state.selectedModel), () => actions.onAuthorize(draft.decisions, draft.approvals, pickState(state, personal), provenanceFrom(draft, view.preset, pickState(state, personal)), state.selectedModel, Object.keys(pickState(state, personal)).filter((id) => state.autoPicked[id]))),
        { variant: "primary", disabled: input.busy !== null || !trusted, title: trusted ? "Record these decisions and prepare a run plan with the selected model" : "Trust the publisher first" },
      ),
      state.selectedModel && view.receipt
        ? button("Prepare run plan with the selected model", () => withOrigins(actions, originsFor(view, view.receipt!.tool_approvals, state.selectedModel), () => actions.onPrepare(state.selectedModel!)), { disabled: input.busy !== null })
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
  // T16: a plan that grants a record cannot be checked while the store is locked (its registries are in the vault); say so, not "stale".
  const lockedPlan = plan !== null && view.secrets !== "unlocked" && plan.run_plan.resource_grants.length > 0;
  const headline = plan ? (lockedPlan ? "Unlock to check this run plan" : ready ? "Ready to run" : plan.preflight.stale ? "The run plan is stale" : "The run plan is not ready") : receipt.runnable ? "Authorized, no run plan yet" : "Cannot run with these decisions";
  const tone = ready ? "good" : lockedPlan ? "neutral" : plan || !receipt.runnable ? "warn" : "neutral";
  const problems = lockedPlan ? [] : plan ? [...plan.preflight.stale_reasons, ...plan.preflight.blocking_reasons] : receipt.blocking_reasons;
  return card(
    "Run plan",
    el("div", { className: `ab-banner ab-banner-${tone}`, attrs: { role: "status" } }, el("strong", { text: headline }), el("p", { text: lockedPlan ? "This plan grants one of your records. Its bindings are checked against your records, which are locked; unlock to check it and run." : ready ? "Everything this run needs is bound and current. Running arrives with the execution host (T5); nothing has run." : plan ? "This plan cannot be used as it stands; the reasons are below." : receipt.runnable ? "Choose a model under Customize your settings, or a default model in Settings → Models, to prepare a run plan." : "Adjust the decisions, or resolve the reasons below, then authorize again." })),
    lockedPlan && actions.onUnlock ? el("div", { className: "ab-actions" }, button("Unlock", actions.onUnlock, { variant: "primary" })) : null,
    reasons(problems, "Why not"),
    // A plan keeps the model it was prepared with (D-113): a later change of the default is said, not applied.
    plan?.run_plan.model_binding && view.default_model && plan.run_plan.model_binding.host_model_id !== view.default_model
      ? el("p", { className: "ab-hint ab-plan-model-note", text: `This plan runs on ${plan.run_plan.model_binding.host_model_id}. Your default model is now ${view.default_model}: press “Use this agent” to prepare a plan on it.` })
      : null,
    plan
      ? definition([
          ["Agent", `${plan.run_plan.package.name} ${plan.run_plan.package.version}`],
          ["Publisher", `${plan.run_plan.publisher.trust_status === "trusted" ? "trusted" : plan.run_plan.publisher.trust_status} · ${plan.run_plan.publisher.claimed_name}`],
          ["Model", plan.run_plan.model_binding ? `${plan.run_plan.model_binding.display_name} (${plan.run_plan.model_binding.host_model_id})` : "none"],
          ["Tools it may call", plan.run_plan.execution.required_tool_ids.join(", ") || "none"],
          ["Tools it may not call", plan.run_plan.execution.denied_tool_ids.join(", ") || "none"],
          ["Memory", plan.run_plan.resource_grants.map((grant) => grant.permission_id).join(", ") || "none"],
          // network.v0 (R-24, D-291): the envelope this plan froze, which the runner re-derives before the run.
          ...(plan.run_plan.execution.network ? [["Delegation", envelopeText(plan.run_plan.execution.network.worst_case as unknown as Parameters<typeof envelopeText>[0])] as [string, string]] : []),
          ["Decided by", receipt.provenance ? `${receipt.provenance.profile_title ? `profile “${receipt.provenance.profile_title}”` : "your own settings"}, ${PRESET_TITLES[receipt.provenance.preset] ?? receipt.provenance.preset} preset${receipt.provenance.policy ? `, policy ${receipt.provenance.policy.policy_id}@${receipt.provenance.policy.version}` : ""}${receipt.provenance.decisions && Object.values(receipt.provenance.decisions).includes("user") ? "; some items by you" : ""}` : "the receipt states no provenance"],
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
              // The origins this plan may reach (T16, D-193): Chrome's grants, listed with what needs each.
              ["Origins it may reach", plan.origins.length === 0 ? "none beyond this machine" : list(plan.origins.map((item) => el("span", { attrs: { "data-origin": item.origin } }, el("code", { text: item.origin }), ` (${item.subjects.join(", ")}) `, chip(item.granted ? "granted" : "not granted", item.granted ? "good" : "bad"))))],
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
  if (state.notice) {
    const allow = state.allowOrigins;
    children.push(
      el(
        "div",
        { className: `ab-banner ab-banner-${state.notice.tone}`, attrs: { role: "status" } },
        el("span", { text: state.notice.text }),
        allow && allow.length > 0 && actions.requestOrigins
          ? button(`Allow ${allow.join(", ")}`, () => {
              // The click is the gesture: ask Chrome, then prepare the plan again (or authorize again) with the receipt's decisions.
              void actions.requestOrigins!(allow).then(() => {
                state.allowOrigins = null;
                const receipt = input.view.receipt;
                const model = state.selectedModel ?? input.view.default_model;
                if (receipt && model) actions.onPrepare(model);
                else actions.rerender();
              });
            }, { variant: "primary" })
          : null,
      ),
    );
  }
  children.push(trustPrompt(input, actions));
  if (profiles && profiles.length > 0) {
    children.push(
      card(
        "Ways to use it",
        el("p", { className: "ab-hint", text: "The publisher's ways to use this agent. Pick one." }),
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
