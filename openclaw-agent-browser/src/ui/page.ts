/**
 * The Agent Browser page.
 *
 * It is deliberately a pure function of feature-operation results: it renders
 * what the control plane reported and sends back explicit decisions. It never
 * decides whether a package is valid, whether a publisher is trusted, or
 * whether something is runnable.
 *
 * Its one way to execute anything is the Run panel (`run.ts`), which starts a
 * run only when the backend's own preflight and the package's own input schema
 * both accept exactly the plan and the task on screen — and the backend checks
 * everything again when it starts. The page never calls a probe.
 */
import type {
  FeatureErrorView,
  HostModelViewType,
  ModelCatalogViewType,
  PackageViewType,
  PermissionsViewType,
  ReceiptViewType,
  RunPlanStateViewType,
  ServiceStatusView,
  ToolRegistryViewType,
  RunRecordViewType,
  RunSummaryViewType,
  WebsiteCandidateViewType,
  WebsiteDiscoveryViewType,
} from "../contract.js";
import { RunPanel, renderRunList } from "./run.js";
import {
  append,
  button,
  bytes,
  card,
  chip,
  clear,
  definition,
  el,
  list,
  replace,
  row,
  shortHash,
  whenText,
} from "./dom.js";

type Decision = "deny" | "once" | "session";

export type PageInvoke = (operation: string, input: unknown) => Promise<unknown>;

export type PageDeps = {
  invoke: PageInvoke;
  signal: AbortSignal;
  canWrite: boolean;
};

type SessionRow = {
  sessionId: string;
  packageId: string;
  version: string;
  trustStatus: string;
  authorizationState: string;
  runnable: boolean;
};

type Loaded = {
  pkg: PackageViewType;
  permissions: PermissionsViewType;
  receipt: ReceiptViewType | null;
  /** Null until the host catalog has been read for this session. */
  models: ModelCatalogViewType | null;
  /** Null until this host's tool implementations have been read. */
  tools: ToolRegistryViewType | null;
  runPlan: RunPlanStateViewType | null;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: FeatureErrorView };

const DECISION_LABELS: Record<Decision, string> = {
  deny: "Deny",
  once: "Allow once",
  session: "Allow for session",
};

const VALIDATION_ROWS: ReadonlyArray<[keyof PackageViewType["validation"], string]> = [
  ["container", "Container"],
  ["integrity", "Integrity"],
  ["schema", "Schema"],
  ["runtime", "Runtime"],
];

const CONTENT_TABS = [
  ["overview", "Overview"],
  ["tools", "Tools"],
  ["workers", "Workers"],
  ["workflow", "Workflow"],
  ["evidence", "Evals & attestations"],
  ["technical", "Technical details"],
] as const;

type TabId = (typeof CONTENT_TABS)[number][0];

function statusTone(value: string): "good" | "warn" | "bad" | "neutral" {
  if (value === "valid" || value === "compatible" || value === "trusted") return "good";
  if (value === "invalid" || value === "mismatch") return "bad";
  if (value === "absent" || value === "unknown" || value === "incompatible") return "warn";
  return "neutral";
}

function statusText(value: string): string {
  switch (value) {
    case "valid":
      return "Valid";
    case "invalid":
      return "Invalid";
    case "compatible":
      return "Compatible";
    case "incompatible":
      return "Not supported by this host";
    case "not_evaluated":
      return "Not evaluated";
    case "absent":
      return "Absent";
    case "trusted":
      return "Trusted by this OpenClaw host";
    case "unknown":
      return "Unknown publisher";
    case "mismatch":
      return "Publisher / key mismatch";
    default:
      return value;
  }
}

/** Mount the page. Returns a disposer for the host view contract. */
export function mountAgentBrowser(container: HTMLElement, deps: PageDeps): () => void {
  let service: ServiceStatusView | null = null;
  let sessions: SessionRow[] = [];
  let loaded: Loaded | null = null;
  /**
   * The last web page read for advertised packages. Shown while no package is
   * open; a candidate is only an address until the person inspects it.
   */
  let discovery: WebsiteDiscoveryViewType | null = null;
  /** Sessions opened from a page's advertisement: session id -> that page. */
  const advertisedOn = new Map<string, string>();
  let busy: string | null = null;
  let failure: {
    error: FeatureErrorView;
    retry?: () => void;
    action?: { label: string; run: () => void };
  } | null = null;
  let notice: { text: string; tone: "good" | "warn" } | null = null;
  let tab: TabId = "overview";
  let decisions = new Map<string, Decision>();
  let approvals = new Map<string, boolean>();
  // Which host resource the person picked for a permission that requests one.
  // Only ids from that permission's own options ever enter this map.
  let resourceSelections = new Map<string, string>();
  /** The model the operator explicitly chose. Never defaulted, never inferred. */
  let selectedModel: string | null = null;
  let disposed = false;
  /** Runs this backend holds, across sessions, for reconnecting after a reload. */
  let recentRuns: RunSummaryViewType[] = [];

  const root = el("section", { className: "agent-browser" });
  const header = el("header", { className: "ab-topbar" });
  const serviceArea = el("div", { className: "ab-service", attrs: { role: "status" } });
  const addressArea = el("div", { className: "ab-address-area" });
  const statusArea = el("div", { className: "ab-status", attrs: { "aria-live": "polite" } });
  const sessionArea = el("nav", { className: "ab-sessions", attrs: { "aria-label": "Open packages" } });
  const mainArea = el("main", { className: "ab-main" });
  // Three stable regions: the package header, the Run panel, and the setup
  // cards. Re-rendering the others never rebuilds the panel, so a person's
  // cursor in the task form stays where it was while progress updates.
  const topArea = el("div", { className: "ab-top" });
  const runHost = el("div", { className: "ab-run-host" });
  const setupArea = el("div", { className: "ab-setup" });
  mainArea.append(topArea, runHost, setupArea);

  header.append(
    el(
      "div",
      { className: "ab-brand" },
      el("h1", { className: "ab-title", text: "Agent Browser" }),
      el("p", {
        className: "ab-subtitle",
        text:
          "Open, verify and authorize a signed agent package, then run it on a model you choose. " +
          "Nothing runs until you press Run.",
      }),
    ),
    serviceArea,
  );
  root.append(header, addressArea, statusArea, sessionArea, mainArea);
  container.append(root);

  const alive = () => !disposed && !deps.signal.aborted;

  async function call<T>(operation: string, input: unknown): Promise<T> {
    return (await deps.invoke(operation, input)) as T;
  }

  const runPanel = new RunPanel({
    call,
    alive,
    canWrite: deps.canWrite,
    service: () => service,
    loaded: () => loaded,
    reveal: (section) => {
      const target = root.querySelector<HTMLElement>(`[data-section="${section}"]`);
      target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      target?.classList.add("ab-card-flash");
      setTimeout(() => target?.classList.remove("ab-card-flash"), 1600);
    },
    changed: () => {
      void refreshSessions();
      void refreshRuns();
    },
  });

  /** Every run this backend holds, newest first. Used to reconnect after a reload. */
  async function refreshRuns(options: { reconnect?: boolean } = {}): Promise<void> {
    const result = await call<Result<{ runs: RunSummaryViewType[]; active: RunRecordViewType | null }>>(
      "execution.status",
      {},
    ).catch(() => null);
    if (!alive() || !result || !result.ok) return;
    recentRuns = [...result.value.runs].reverse();
    if (options.reconnect && !loaded && result.value.active) {
      const active = result.value.active;
      if (sessions.some((session) => session.sessionId === active.sessionId)) {
        await showSession(active.sessionId);
      } else {
        await openRun(active.runId);
      }
      return;
    }
    if (!loaded) renderMain();
  }

  async function openRun(runId: string): Promise<void> {
    const record = recentRuns.find((item) => item.runId === runId);
    if (record && sessions.some((session) => session.sessionId === record.sessionId)) {
      if (loaded?.pkg.sessionId !== record.sessionId) await showSession(record.sessionId);
      await runPanel.openRun(runId);
      return;
    }
    // The run's package session is gone: show the run on its own.
    loaded = null;
    renderSessions();
    await runPanel.openRun(runId);
    renderMain();
  }

  function setBusy(label: string | null) {
    busy = label;
    if (label) {
      failure = null;
      notice = null;
    }
    renderStatus();
    renderAddress();
  }

  function fail(
    error: FeatureErrorView,
    retry?: () => void,
    action?: { label: string; run: () => void },
  ) {
    failure = { error, retry, action };
    busy = null;
    renderStatus();
    renderAddress();
  }

  // -- service ---------------------------------------------------------------
  function renderService() {
    clear(serviceArea);
    if (!service) {
      serviceArea.append(chip("Checking service…", "neutral"));
      return;
    }
    const tone =
      service.state === "running" ? "good" : service.state === "starting" ? "warn" : "bad";
    const label =
      service.state === "running"
        ? "Control plane running"
        : service.state === "starting"
          ? "Control plane starting…"
          : service.state === "unconfigured"
            ? "Control plane not configured"
            : "Control plane unavailable";
    serviceArea.append(chip(label, tone));
    if (service.controlPlane) {
      // The control plane's own `execution` field says that it never runs a
      // package itself; runs happen in a separate leased runner, so what the
      // operator needs here is whether that runner is available.
      serviceArea.append(
        el("span", {
          className: "ab-service-detail",
          text: `agentpkg ${service.controlPlane.agentpkgVersion} · ${service.controlPlane.packageFormat} · ${service.executionSupported ? "runs available" : "runs unavailable"}`,
          attrs: {
            title: `The control plane verifies and authorizes (its own execution: ${service.controlPlane.execution}); a run executes in a separate runner started for that run only.`,
          },
        }),
      );
    }
    if (service.state !== "running") {
      serviceArea.append(el("p", { className: "ab-service-detail", text: service.detail }));
      if (deps.canWrite) {
        serviceArea.append(
          button("Retry", () => void restartService(), { variant: "primary" }),
        );
      }
    }
  }

  async function refreshService(): Promise<void> {
    try {
      service = await call<ServiceStatusView>("service.status", {});
    } catch {
      service = null;
    }
    if (!alive()) return;
    renderService();
    renderAddress();
  }

  async function restartService(): Promise<void> {
    setBusy("Restarting the Agent Browser service…");
    try {
      service = await call<ServiceStatusView>("service.restart", {});
    } catch {
      service = null;
    }
    if (!alive()) return;
    setBusy(null);
    renderService();
    renderAddress();
    void refreshSessions();
  }

  // -- address bar -----------------------------------------------------------
  function renderAddress() {
    clear(addressArea);
    const canOpen = deps.canWrite && service?.state === "running" && !busy;

    const form = el("form", { className: "ab-address" });
    const input = el("input", {
      className: "ab-url",
      attrs: {
        type: "text",
        name: "package-url",
        placeholder: "https://example.org/ or https://example.org/travel.agent.pkg",
        "aria-label": "Website or agent package URL",
        spellcheck: "false",
        autocomplete: "off",
      },
    });
    input.disabled = !canOpen;
    const submit = button("Open", () => openAddress(input.value.trim()), {
      variant: "primary",
      disabled: !canOpen,
    });
    submit.type = "submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (canOpen) openAddress(input.value.trim());
    });
    form.append(input, submit);
    addressArea.append(form);
    addressArea.append(
      el("p", {
        className: "ab-hint",
        text:
          "HTTPS only. A website is read for an advertised agent package; an address ending in " +
          ".pkg opens that package directly. The control plane fetches and verifies; this page never does.",
      }),
    );

    if (service?.capabilities.openLocal) {
      const details = el("details", { className: "ab-local" });
      details.append(el("summary", { text: "Open a local package (operator directories)" }));
      const localForm = el("form", { className: "ab-address" });
      const localInput = el("input", {
        className: "ab-url",
        attrs: {
          type: "text",
          name: "package-path",
          placeholder: "/path/to/package.agent.pkg",
          "aria-label": "Local agent package path",
          spellcheck: "false",
          autocomplete: "off",
        },
      });
      localInput.disabled = !canOpen;
      const localSubmit = button("Open file", () => void openLocal(localInput.value.trim()), {
        disabled: !canOpen,
      });
      localSubmit.type = "submit";
      localForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (canOpen) void openLocal(localInput.value.trim());
      });
      localForm.append(localInput, localSubmit);
      details.append(
        localForm,
        el("p", {
          className: "ab-hint",
          text: `Allowed directories: ${service.capabilities.localRoots.join(", ")}`,
        }),
      );
      addressArea.append(details);
    }
  }

  // -- status / errors -------------------------------------------------------
  function renderStatus() {
    clear(statusArea);
    if (busy) {
      statusArea.append(
        el("div", { className: "ab-banner ab-banner-busy" }, el("span", { text: busy })),
      );
      return;
    }
    if (notice) {
      statusArea.append(
        el(
          "div",
          { className: `ab-banner ab-banner-${notice.tone}` },
          el("span", { text: notice.text }),
        ),
      );
      return;
    }
    if (!failure) return;
    const banner = el("div", { className: "ab-banner ab-banner-error", attrs: { role: "alert" } });
    banner.append(
      el("strong", { text: failure.error.title }),
      el("span", { className: "ab-error-code", text: failure.error.code }),
      el("p", { text: failure.error.detail }),
    );
    const validation = failure.error.validation as Record<string, unknown> | null | undefined;
    if (validation && typeof validation === "object") {
      const layers = VALIDATION_ROWS.map(([key, label]) => {
        const raw = validation[`${key}_status`];
        const value = typeof raw === "string" ? raw : "not_evaluated";
        return row(label, chip(statusText(value), statusTone(value)));
      });
      banner.append(el("div", { className: "ab-validation" }, ...layers));
    }
    if (failure.action && deps.canWrite) {
      banner.append(button(failure.action.label, failure.action.run, { variant: "primary" }));
    }
    if (failure.retry && deps.canWrite) {
      banner.append(button("Retry", failure.retry, { variant: failure.action ? "ghost" : "primary" }));
    }
    statusArea.append(banner);
  }

  // -- sessions --------------------------------------------------------------
  async function refreshSessions(): Promise<void> {
    try {
      const result = await call<
        { ok: true; value: { sessions: SessionRow[] } } | { ok: false; error: FeatureErrorView }
      >("packages.list", {});
      sessions = result.ok ? result.value.sessions : [];
    } catch {
      sessions = [];
    }
    if (!alive()) return;
    renderSessions();
  }

  function renderSessions() {
    clear(sessionArea);
    if (sessions.length === 0) return;
    sessionArea.append(el("span", { className: "ab-sessions-label", text: "Open packages" }));
    for (const session of sessions) {
      const active = loaded?.pkg.sessionId === session.sessionId;
      const tab = el("div", { className: `ab-session${active ? " ab-session-active" : ""}` });
      tab.append(
        button(`${session.packageId} ${session.version}`, () => void showSession(session.sessionId)),
        chip(statusText(session.trustStatus), statusTone(session.trustStatus)),
      );
      if (deps.canWrite) {
        tab.append(
          button("×", () => void closeSession(session.sessionId), {
            title: `Close ${session.packageId}`,
          }),
        );
      }
      sessionArea.append(tab);
    }
  }

  // -- open / load -----------------------------------------------------------
  type OpenResult = { ok: true; value: PackageViewType } | { ok: false; error: FeatureErrorView };

  /**
   * One address bar for both kinds of address. This only chooses which
   * control-plane operation to ask; each applies its own full URL policy, and
   * a website that turns out not to be a web page says so.
   */
  function openAddress(value: string): void {
    if (!value) return;
    if (namesPackage(value)) void openUrl(value);
    else void discoverWebsite(value);
  }

  function namesPackage(value: string): boolean {
    try {
      return new URL(value).pathname.toLowerCase().endsWith(".pkg");
    } catch {
      return false;
    }
  }

  /**
   * Inspecting a package is the same operation whether a person typed its
   * address or a website advertised it; `advertisedBy` only labels the result.
   */
  async function openUrl(url: string, advertisedBy: string | null = null): Promise<void> {
    if (!url) return;
    setBusy("Opening and verifying package…");
    const result = await call<OpenResult>("packages.open-url", { url }).catch(
      () => null as OpenResult | null,
    );
    if (!alive()) return;
    if (result?.ok) {
      if (advertisedBy) advertisedOn.set(result.value.sessionId, advertisedBy);
      // A package opened by its own address replaces the website view.
      else discovery = null;
    }
    await afterOpen(result, () => void openUrl(url, advertisedBy));
  }

  async function openLocal(path: string): Promise<void> {
    if (!path) return;
    setBusy("Opening and verifying package…");
    const result = await call<OpenResult>("packages.open-local", { path }).catch(
      () => null as OpenResult | null,
    );
    if (!alive()) return;
    if (result?.ok) discovery = null;
    await afterOpen(result, () => void openLocal(path));
  }

  /** Read a web page for advertised packages. Nothing is opened or verified. */
  async function discoverWebsite(url: string): Promise<void> {
    setBusy("Reading the website for an advertised agent package…");
    const result = await call<Result<WebsiteDiscoveryViewType>>("websites.discover", { url }).catch(
      () => null,
    );
    if (!alive()) return;
    const retry = () => void discoverWebsite(url);
    if (!result || !result.ok) {
      const error = result ? result.error : unexpectedError();
      // The address answered, but not with a page. If it is a package, that
      // is the person's call to make, by the same operation as any package.
      const asPackage =
        error.code === "discovery_not_html"
          ? { label: "Open as agent package", run: () => void openUrl(url) }
          : undefined;
      fail(error, error.retryable ? retry : undefined, asPackage);
      return;
    }
    setBusy(null);
    discovery = result.value;
    if (loaded) {
      // A new address replaces the package view; its session stays open.
      loaded = null;
      runPanel.detach();
      renderSessions();
    }
    renderMain();
  }

  async function afterOpen(result: OpenResult | null, retry: () => void): Promise<void> {
    if (!result) {
      fail(unexpectedError(), retry);
      return;
    }
    if (!result.ok) {
      fail(result.error, result.error.retryable ? retry : undefined);
      void refreshService();
      return;
    }
    setBusy(null);
    await loadSession(result.value);
    void refreshSessions();
  }

  async function showSession(sessionId: string): Promise<void> {
    setBusy("Loading package…");
    const result = await call<OpenResult>("packages.get", { sessionId }).catch(
      () => null as OpenResult | null,
    );
    if (!alive()) return;
    if (!result || !result.ok) {
      loaded = null;
      renderMain();
      fail(result ? result.error : unexpectedError());
      void refreshSessions();
      return;
    }
    setBusy(null);
    await loadSession(result.value);
  }

  async function loadSession(pkg: PackageViewType): Promise<void> {
    const permissionsResult = await call<
      { ok: true; value: PermissionsViewType } | { ok: false; error: FeatureErrorView }
    >("packages.permissions", { sessionId: pkg.sessionId }).catch(() => null);
    if (!alive()) return;
    if (!permissionsResult || !permissionsResult.ok) {
      fail(permissionsResult ? permissionsResult.error : unexpectedError());
      return;
    }
    const receiptResult = await call<
      { ok: true; value: ReceiptViewType | null } | { ok: false; error: FeatureErrorView }
    >("packages.authorization", { sessionId: pkg.sessionId }).catch(() => null);
    if (!alive()) return;

    loaded = {
      pkg,
      permissions: permissionsResult.value,
      receipt: receiptResult && receiptResult.ok ? receiptResult.value : null,
      models: null,
      tools: null,
      runPlan: null,
    };
    decisions = new Map(
      permissionsResult.value.permissions.map((item) => [item.id, item.decision as Decision]),
    );
    approvals = new Map(
      permissionsResult.value.toolApprovals.map((item) => [item.toolId, item.decision]),
    );
    resourceSelections = new Map(
      permissionsResult.value.permissions.flatMap((item) =>
        item.hostResource?.selectedResourceId
          ? [[item.id, item.hostResource.selectedResourceId] as [string, string]]
          : [],
      ),
    );
    selectedModel = null;
    tab = "overview";
    renderSessions();
    renderMain();
    void runPanel.attachSession(pkg.sessionId);
    // Model discovery follows authorization: before a receipt exists there is
    // nothing a model could be bound to.
    if (loaded.receipt) void loadModels(pkg.sessionId);
  }

  // -- models ----------------------------------------------------------------
  async function loadModels(sessionId: string, options: { announce?: boolean } = {}) {
    if (options.announce) setBusy("Reading this host's model catalog…");
    const [catalog, tools, plan] = await Promise.all([
      call<Result<ModelCatalogViewType>>("models.evaluate", { sessionId }).catch(() => null),
      call<Result<ToolRegistryViewType>>("tools.evaluate", { sessionId }).catch(() => null),
      call<Result<RunPlanStateViewType>>("run-plan.get", { sessionId }).catch(() => null),
    ]);
    if (!alive() || loaded?.pkg.sessionId !== sessionId) return;
    if (options.announce) setBusy(null);
    if (catalog && !catalog.ok) {
      loaded = { ...loaded, models: null, tools: null };
      fail(catalog.error, () => void loadModels(sessionId, { announce: true }));
      return;
    }
    const models = catalog && catalog.ok ? catalog.value : null;
    const runPlan = plan && plan.ok ? plan.value : null;
    if (
      selectedModel &&
      models &&
      !models.models.some((model) => model.modelId === selectedModel)
    ) {
      // The chosen model disappeared from the host catalog between reads.
      selectedModel = null;
    }
    if (!selectedModel && runPlan?.plan?.modelBinding) {
      selectedModel = runPlan.plan.modelBinding.hostModelId;
    }
    loaded = {
      ...loaded,
      models,
      tools: tools && tools.ok ? tools.value : null,
      runPlan,
    };
    renderMain();
  }

  async function prepareRun(): Promise<void> {
    const current = loaded;
    if (!current || !current.receipt || !selectedModel) return;
    setBusy("Preparing the run plan…");
    const result = await call<Result<RunPlanStateViewType>>("run-plan.prepare", {
      sessionId: current.pkg.sessionId,
      packageDigest: current.pkg.identity.digest,
      receiptId: current.receipt.receiptId,
      modelId: selectedModel,
      executionMode: "model",
    }).catch(() => null);
    if (!alive()) return;
    if (!result || !result.ok) {
      fail(result ? result.error : unexpectedError());
      void loadModels(current.pkg.sessionId);
      return;
    }
    setBusy(null);
    loaded = { ...current, runPlan: result.value };
    notice = {
      text: result.value.preflight?.ready
        ? "Run plan prepared. Nothing has executed."
        : "Run plan prepared, but it is not ready to run.",
      tone: result.value.preflight?.ready ? "good" : "warn",
    };
    renderStatus();
    renderMain();
    void refreshSessions();
  }

  async function clearRunPlan(): Promise<void> {
    const current = loaded;
    if (!current) return;
    setBusy("Discarding the run plan…");
    await call("run-plan.clear", { sessionId: current.pkg.sessionId }).catch(() => undefined);
    if (!alive()) return;
    setBusy(null);
    loaded = {
      ...current,
      runPlan: { plan: null, preflight: null, executionSupported: Boolean(service?.executionSupported) },
    };
    renderMain();
    void refreshSessions();
  }

  async function closeSession(sessionId: string): Promise<void> {
    await call("packages.close", { sessionId }).catch(() => undefined);
    if (!alive()) return;
    advertisedOn.delete(sessionId);
    if (loaded?.pkg.sessionId === sessionId) {
      loaded = null;
      runPanel.detach();
      renderMain();
    }
    void refreshSessions();
    void refreshRuns();
  }

  function unexpectedError(): FeatureErrorView {
    return {
      code: "control_plane_error",
      title: "Request failed",
      detail: "The Agent Browser backend did not answer this request.",
      retryable: true,
    };
  }

  // -- package rendering -----------------------------------------------------
  function renderRecentRuns(): HTMLElement | null {
    if (recentRuns.length === 0) return null;
    return card(
      "Recent runs",
      el("p", {
        className: "ab-hint",
        text:
          "Runs this Agent Browser holds. A finished run's result, artifacts and audit stay " +
          "inspectable even after its package session has closed.",
      }),
      renderRunList(recentRuns.slice(0, 16), (runId) => void openRun(runId)),
    );
  }

  function renderMain() {
    // Region by region, each replaced as a unit. Emptying two regions up front
    // let the pressed control's removal lay out a page missing the first one,
    // which clamped the host's scroll position (see `clear` in dom.ts).
    if (!loaded) {
      if (runPanel.currentRun() && !runPanel.hasSession()) {
        replace(topArea, []);
        if (!runHost.contains(runPanel.root)) runHost.append(runPanel.root);
        runPanel.render();
        replace(setupArea, [renderRecentRuns()]);
        return;
      }
      replace(topArea, [
        discovery
          ? renderWebsiteCard(discovery)
          : el(
              "div",
              { className: "ab-empty" },
              el("h2", { text: "No package open" }),
              el("p", {
                text: "Enter a website, or the HTTPS address of an agent package, above. A website is read for an advertised package. A package is downloaded and its container, integrity, schema and signature verified, and what it requests is reported, before anything is authorized.",
              }),
            ),
      ]);
      replace(runHost, []);
      replace(setupArea, [renderRecentRuns()]);
      return;
    }
    const { pkg } = loaded;
    replace(topArea, [renderHeaderCard(pkg)]);
    if (!runHost.contains(runPanel.root)) replace(runHost, [runPanel.root]);
    runPanel.sync();
    replace(setupArea, [
      renderSecurityCard(pkg),
      renderWarnings(pkg),
      renderContentCard(pkg),
      renderPermissionsCard(),
      renderConstraintsCard(pkg),
      renderAuthorizationCard(),
      renderModelCard(pkg),
      renderRunPlanCard(),
    ]);
  }

  // -- website discovery -----------------------------------------------------
  const WEBSITE_STATUS: Record<
    WebsiteDiscoveryViewType["status"],
    { label: string; tone: "neutral" | "warn" | "bad"; text: string }
  > = {
    candidate: {
      label: "Agent package advertised",
      tone: "warn",
      text:
        "This website says an agent package is available at the address below. That is only a " +
        "location: who published it, whether it is intact and signed, and what it would be " +
        "allowed to do are unknown until you inspect it.",
    },
    multiple_candidates: {
      label: "Several agent packages advertised",
      tone: "warn",
      text:
        "This website advertises more than one agent package, and the Agent Browser does not " +
        "choose between them. Each is only a location until you inspect it.",
    },
    no_candidate: {
      label: "No agent package advertised",
      tone: "neutral",
      text:
        'This page does not advertise an agent package: its head has no <link rel="agent-package">. ' +
        "If you know a package's own address, open that directly.",
    },
    candidates_rejected: {
      label: "Advertised package not usable",
      tone: "bad",
      text:
        "This page advertises an agent package this browser will not fetch, for the reasons " +
        "below. Nothing was downloaded.",
    },
  };

  function renderWebsiteCard(view: WebsiteDiscoveryViewType): HTMLElement {
    const status = WEBSITE_STATUS[view.status];
    const node = el("div", { className: "ab-website" });
    append(node, [
      el("p", { className: "ab-website-url" }, el("code", { text: view.finalUrl })),
      view.redirects.length > 0
        ? el("p", {
            className: "ab-hint",
            text: `Reached from ${view.requestedUrl} through ${view.redirects.length} redirect${
              view.redirects.length === 1 ? "" : "s"
            } within ${view.pageOrigin}.`,
          })
        : null,
      el("div", { className: "ab-chips" }, chip(status.label, status.tone)),
      el("p", { text: status.text }),
    ]);
    if (view.candidates.length > 0) {
      const items = el("div", { className: "ab-items" });
      for (const candidate of view.candidates) items.append(renderCandidate(view, candidate));
      node.append(items);
    }
    if (view.linksNotListed > 0) {
      node.append(
        el("p", {
          className: "ab-hint",
          text: `${view.linksNotListed} further advertisement(s) on this page were not listed.`,
        }),
      );
    }
    node.append(
      el("p", {
        className: "ab-hint",
        text:
          'rel="agent-package" is experimental WebAgents metadata, not a web standard. The ' +
          "control plane read this one page without running its scripts or loading anything it " +
          "references, and accepts only a package served by the page's own origin. Inspecting " +
          "a package downloads and verifies it exactly as if you had typed its address.",
      }),
      renderWebsiteDetails(view),
    );
    return sectioned("website", card("Website", node));
  }

  function renderCandidate(
    view: WebsiteDiscoveryViewType,
    candidate: WebsiteCandidateViewType,
  ): HTMLElement {
    const address = candidate.resolvedUrl ?? candidate.href ?? "(no href)";
    const node = el("div", {
      className: `ab-item ab-candidate${candidate.accepted ? "" : " ab-candidate-rejected"}`,
    });
    node.append(
      el(
        "div",
        { className: "ab-item-head" },
        el("code", { text: address }),
        candidate.accepted ? chip("Unverified candidate", "warn") : chip("Not fetched", "bad"),
        candidate.typeHint ? chip(`advertised type ${candidate.typeHint}`) : null,
      ),
    );
    if (candidate.href !== null && candidate.href !== address) {
      node.append(el("p", { className: "ab-muted", text: `Written on the page as ${candidate.href}` }));
    }
    if (!candidate.accepted) {
      node.append(
        el(
          "p",
          {},
          el("code", { text: candidate.rejectionReason ?? "rejected" }),
          el("span", { text: ` ${candidate.rejectionMessage ?? ""}` }),
        ),
      );
    } else if (deps.canWrite && candidate.resolvedUrl) {
      const url = candidate.resolvedUrl;
      node.append(
        button("Inspect agent package", () => void openUrl(url, view.finalUrl), {
          variant: "primary",
          disabled: busy !== null,
          title: "Download and verify it through the control plane. Nothing is authorized or run.",
        }),
      );
    }
    return node;
  }

  function renderWebsiteDetails(view: WebsiteDiscoveryViewType): HTMLElement {
    const details = el("details", { className: "ab-receipt" });
    details.append(el("summary", { text: "Discovery details (technical)" }));
    const page = view.page;
    details.append(
      definition([
        ["Requested", view.requestedUrl],
        ["Page", view.finalUrl],
        ["Origin", view.pageOrigin],
        [
          "Redirects",
          view.redirects.map((hop) => `${hop.status} ${hop.fromUrl} → ${hop.toUrl}`).join(" · ") ||
            "none",
        ],
        [
          "Content",
          `${page.contentType} · read as ${page.decodedAs} (${page.encodingSource}) · ${page.contentCoding}`,
        ],
        [
          "Read",
          `${bytes(page.bytesRead)}${page.truncated ? " (the beginning only; the head ended inside it)" : ""}`,
        ],
        ["Page SHA-256", el("code", { text: page.htmlSha256 })],
        ["<base> element", page.baseElementIgnored ? "present, not used" : "none"],
        [
          "Profile",
          `${view.profile.name} · rel ${view.profile.rel} · ${
            view.profile.sameOriginRequired ? "same origin only" : "any origin"
          } · at most ${view.profile.maxRedirects} redirects`,
        ],
        ["Advertisements", `${view.acceptedCount} accepted, ${view.rejectedCount} rejected`],
        ["Discovered", whenText(view.discoveredAt)],
        ["Package fetched", "no"],
        ["Verified or trusted", "no"],
        ["Executed", "no"],
      ]),
    );
    return details;
  }

  function renderHeaderCard(pkg: PackageViewType): HTMLElement {
    const node = el("section", { className: "ab-card ab-package-header" });
    const advertised = advertisedOn.get(pkg.sessionId);
    node.append(
      el("h2", { className: "ab-package-name", text: pkg.identity.name }),
      el("p", { className: "ab-package-id", text: `${pkg.identity.packageId} · version ${pkg.identity.version}` }),
      el("p", { className: "ab-package-description", text: pkg.identity.description }),
      el(
        "div",
        { className: "ab-chips" },
        chip(`Execution profile ${pkg.identity.executionProfile}`),
        chip(`${pkg.payload.fileCount} files · ${bytes(pkg.payload.totalBytes)}`),
        chip(`Session expires ${whenText(pkg.expiresAt)}`, "warn"),
      ),
      el("p", {
        className: "ab-source",
        text: `${pkg.source.kind === "url" ? "Downloaded from" : "Opened from"} ${pkg.source.display}`,
      }),
    );
    if (advertised) {
      node.append(
        el("p", {
          className: "ab-hint ab-advertised",
          text: `Advertised on ${advertised}. An advertisement only said where to look; everything below comes from the package itself.`,
        }),
      );
    }
    if (deps.canWrite) {
      node.append(button("Close package", () => void closeSession(pkg.sessionId)));
    }
    return node;
  }

  function renderSecurityCard(pkg: PackageViewType): HTMLElement {
    const validation = el("div", { className: "ab-validation" });
    for (const [key, label] of VALIDATION_ROWS) {
      const value = pkg.validation[key] as string;
      validation.append(row(label, chip(statusText(value), statusTone(value))));
    }
    for (const error of pkg.validation.errors) {
      validation.append(el("p", { className: "ab-validation-error", text: error.message }));
    }

    const publisher = pkg.publisher;
    const signature = el(
      "div",
      { className: "ab-signature" },
      row(
        "Signature",
        chip(
          publisher.signatureStatus === "valid"
            ? "Cryptographically valid"
            : publisher.signatureStatus === "invalid"
              ? "Invalid"
              : "Not signed",
          statusTone(publisher.signatureStatus),
        ),
      ),
      row("Signer key", el("code", { text: publisher.signerFingerprint ?? "—" })),
    );

    const trustBlock = el("div", {
      className: `ab-trust ab-trust-${publisher.trustStatus}`,
    });
    trustBlock.append(
      row("Claimed publisher", el("span", { text: `${publisher.claimedName} (${publisher.claimedId})` })),
      row("Publisher trust", chip(statusText(publisher.trustStatus), statusTone(publisher.trustStatus))),
      el("p", { className: "ab-trust-reason", text: trustExplanation(publisher) }),
    );
    if (publisher.trustEntry) {
      trustBlock.append(
        el("p", {
          className: "ab-hint",
          text: `Pinned as "${publisher.trustEntry.displayName}"${
            publisher.trustEntry.packageIdPrefix
              ? ` for packages starting with ${publisher.trustEntry.packageIdPrefix}`
              : ""
          }, added ${whenText(publisher.trustEntry.addedAt)}.`,
        }),
      );
    }
    if (
      publisher.signatureStatus === "valid" &&
      publisher.trustStatus === "unknown" &&
      deps.canWrite
    ) {
      trustBlock.append(renderTrustReview(pkg));
    }

    return sectioned("trust", card(
      "Verification and trust",
      el("p", {
        className: "ab-hint",
        text: "A valid signature proves the package is internally consistent. It does not say who published it: that requires a key this host has pinned.",
      }),
      validation,
      signature,
      trustBlock,
    ));
  }

  function sectioned(section: string, node: HTMLElement): HTMLElement {
    node.dataset.section = section;
    return node;
  }

  function trustExplanation(publisher: PackageViewType["publisher"]): string {
    switch (publisher.trustStatus) {
      case "trusted":
        return "An operator pinned this exact signing key on this host.";
      case "mismatch":
        return publisher.pinnedFingerprintsForClaimedPublisher.length > 0
          ? "This host has pinned different keys for the claimed publisher. Treat this package as an impersonation risk."
          : "The pinned key does not cover this package identity.";
      default:
        return publisher.signatureStatus === "valid"
          ? "Nobody on this host has pinned this signing key, so the publisher is unverified."
          : "Without a valid signature there is no key to trust.";
    }
  }

  function renderTrustReview(pkg: PackageViewType): HTMLElement {
    const details = el("details", { className: "ab-trust-review" });
    details.append(el("summary", { text: "Review publisher key" }));
    const scope = el("select", { className: "ab-select", attrs: { "aria-label": "Trust scope" } });
    const narrow = el("option", { text: `Only ${pkg.identity.packageId}` });
    narrow.value = "package";
    const broad = el("option", { text: `Any package from ${pkg.publisher.claimedId}` });
    broad.value = "publisher";
    scope.append(narrow, broad);

    let armed = false;
    const confirm = button("Trust this publisher key", () => {
      if (!armed) {
        armed = true;
        confirm.textContent = "Confirm: pin this key permanently";
        confirm.className = "ab-button ab-button-danger";
        return;
      }
      void pinPublisher(pkg, scope.value);
    });

    details.append(
      definition([
        ["Claimed publisher", `${pkg.publisher.claimedName} (${pkg.publisher.claimedId})`],
        ["Signer fingerprint", el("code", { text: pkg.publisher.signerFingerprint ?? "" })],
        ["Package", pkg.identity.packageId],
      ]),
      el("p", {
        className: "ab-hint",
        text: "Pinning records an operator trust decision on this host. It persists until removed, unlike package permissions, which end with this session. Only pin a key you obtained from the publisher through a channel you trust.",
      }),
      el("div", { className: "ab-inline" }, scope, confirm),
    );
    return details;
  }

  async function pinPublisher(pkg: PackageViewType, scope: string): Promise<void> {
    setBusy("Recording the publisher trust decision…");
    const result = await call<
      { ok: true; value: unknown } | { ok: false; error: FeatureErrorView }
    >("trust.pin-session-publisher", {
      sessionId: pkg.sessionId,
      signerFingerprint: pkg.publisher.signerFingerprint,
      scope,
    }).catch(() => null);
    if (!alive()) return;
    if (!result || !result.ok) {
      fail(result ? result.error : unexpectedError());
      return;
    }
    setBusy(null);
    notice = { text: "Publisher key pinned on this host.", tone: "good" };
    renderStatus();
    await showSession(pkg.sessionId);
  }

  function renderWarnings(pkg: PackageViewType): HTMLElement | null {
    if (pkg.warnings.length === 0) return null;
    const node = el("div", { className: "ab-warnings" });
    for (const warning of pkg.warnings) {
      const tone = warning.severity === "critical" ? "bad" : warning.severity === "warning" ? "warn" : "neutral";
      node.append(
        el(
          "div",
          { className: `ab-warning ab-warning-${warning.severity}` },
          chip(warning.severity, tone),
          el("code", { className: "ab-warning-code", text: warning.code }),
          el("span", { text: warning.message }),
        ),
      );
    }
    return card("Warnings", node);
  }

  function renderContentCard(pkg: PackageViewType): HTMLElement {
    const strip = el("div", { className: "ab-tabs", attrs: { role: "tablist" } });
    const body = el("div", { className: "ab-tab-body" });
    for (const [id, label] of CONTENT_TABS) {
      const tabButton = button(label, () => {
        tab = id;
        renderMain();
      });
      tabButton.setAttribute("role", "tab");
      tabButton.setAttribute("aria-selected", String(tab === id));
      if (tab === id) tabButton.classList.add("ab-tab-active");
      strip.append(tabButton);
    }
    append(body, [renderTab(pkg)]);
    return card("Package contents", strip, body);
  }

  function renderTab(pkg: PackageViewType): HTMLElement {
    switch (tab) {
      case "tools":
        return renderTools(pkg, loaded?.tools ?? null);
      case "workers":
        return renderWorkers(pkg);
      case "workflow":
        return renderWorkflow(pkg);
      case "evidence":
        return renderEvidence(pkg);
      case "technical":
        return renderTechnical(pkg);
      default:
        return renderOverview(pkg);
    }
  }

  function renderOverview(pkg: PackageViewType): HTMLElement {
    const node = el("div", { className: "ab-grid" });
    node.append(
      el(
        "div",
        {},
        el("h3", { text: `Capabilities (${pkg.capabilities.length})` }),
        pkg.capabilities.length > 0
          ? list(pkg.capabilities.map((item) => el("code", { text: item })))
          : el("p", { className: "ab-hint", text: "No capabilities declared." }),
      ),
      el(
        "div",
        {},
        el("h3", { text: `Skills (${pkg.skills.length})` }),
        list(
          pkg.skills.map((skill) =>
            el(
              "div",
              {},
              el("code", { text: skill.id }),
              el("span", { className: "ab-muted", text: ` ${skill.version} · ${skill.path} · ${bytes(skill.bytes)}` }),
            ),
          ),
        ),
      ),
    );
    return node;
  }

  /**
   * Three facts per tool, deliberately not merged.
   *
   * The package's *declaration* is what it asks for. This host's *binding* is
   * what would actually run, if anything does. The *approval* is the person's.
   * A row can be declared and unbound, bound and unapproved, or approved with
   * a denied permission — and each of those is a different thing to fix.
   */
  const TOOL_STATUS_LABELS: Record<string, { label: string; tone: "good" | "warn" | "bad" }> = {
    bound: { label: "Host implementation", tone: "good" },
    unverified: { label: "Contract unconfirmed", tone: "warn" },
    unavailable: { label: "Implementation unusable", tone: "warn" },
    ambiguous: { label: "More than one implementation", tone: "bad" },
    incompatible: { label: "Contract mismatch", tone: "bad" },
    unbound: { label: "No host implementation", tone: "bad" },
  };

  function renderToolBinding(
    tools: ToolRegistryViewType | null,
    toolId: string,
  ): HTMLElement | null {
    if (!tools) {
      return el("p", {
        className: "ab-muted",
        text: "Authorize this package to see what this host implements for it.",
      });
    }
    const row = tools.tools.find((item: ToolRegistryViewType["tools"][number]) => item.toolId === toolId);
    if (!row) return null;
    const status = TOOL_STATUS_LABELS[row.status] ?? TOOL_STATUS_LABELS.unbound!;
    const head = el(
      "div",
      { className: "ab-item-head" },
      chip(status.label, status.tone),
      chip(row.approved ? "Approved" : "Not approved", row.approved ? "good" : "warn"),
      row.permissionsGranted ? null : chip("Permission denied", "warn"),
    );
    const rows: Array<[string, HTMLElement | string]> = [];
    if (row.binding) {
      rows.push(["Implementation", el("code", { text: row.binding.bindingId })]);
      rows.push(["Version", row.binding.implementationVersion]);
      rows.push([
        "Runs",
        row.remote
          ? `remotely, ${row.binding.method ?? ""} ${row.binding.endpointOrigin ?? ""}${
              row.binding.endpointPath ?? ""
            }`.trim()
          : "locally, in this host",
      ]);
      rows.push([
        "Credential",
        row.binding.credentialsRequired
          ? row.binding.credentialsConfigured
            ? "configured on this host"
            : "required and not configured"
          : "none",
      ]);
      rows.push(["Binding digest", el("code", { text: row.binding.bindingSha256 })]);
      rows.push([
        "Contract",
        row.binding.checks.every((check: { status: string }) => check.status === "satisfied")
          ? "verified against this package's own schemas"
          : row.binding.checks
              .filter((check: { status: string }) => check.status !== "satisfied")
              .map((check: { subject: string; status: string }) => `${check.subject}: ${check.status}`)
              .join(", "),
      ]);
    }
    if (row.deniedPermissionIds.length > 0) {
      rows.push(["Denied permissions", row.deniedPermissionIds.join(", ")]);
    }
    const detail = el("div", { className: "ab-subitem" }, head);
    if (row.reason) detail.append(el("p", { className: "ab-muted", text: row.reason }));
    if (rows.length > 0) detail.append(definition(rows));
    return detail;
  }

  function renderTools(pkg: PackageViewType, tools: ToolRegistryViewType | null): HTMLElement {
    if (pkg.tools.length === 0) {
      return el("p", { className: "ab-hint", text: "This package declares no tools." });
    }
    const node = el("div", { className: "ab-items" });
    node.append(
      el("p", {
        className: "ab-hint",
        text:
          "A package declares what it needs. This host decides what, if anything, implements " +
          "it, and you decide whether that implementation may be used. All three are required.",
      }),
    );
    for (const tool of pkg.tools) {
      node.append(
        el(
          "div",
          { className: "ab-item" },
          el(
            "div",
            { className: "ab-item-head" },
            el("code", { text: tool.id }),
            chip(tool.execution === "remote" ? "Remote" : "Local", tool.execution === "remote" ? "warn" : "neutral"),
            chip(`${tool.sideEffects} side effects`, tool.sideEffects === "read" ? "neutral" : "warn"),
            tool.approvalRequired ? chip("Approval required", "warn") : null,
          ),
          el("p", { text: tool.description }),
          definition([
            ["Requested capability", el("code", { text: tool.binding })],
            ["Expects", tool.endpointOrigin ? `${tool.method ?? ""} ${tool.endpointOrigin}`.trim() : "—"],
            ["Network domains", tool.domains.length > 0 ? tool.domains.join(", ") : "—"],
            ["Required permissions", tool.permissions.length > 0 ? tool.permissions.join(", ") : "—"],
            ["Timeout", `${tool.timeoutSeconds}s`],
          ]),
          renderToolBinding(tools, tool.id),
        ),
      );
    }
    return node;
  }

  function renderWorkers(pkg: PackageViewType): HTMLElement {
    const node = el("div", { className: "ab-items" });
    for (const worker of pkg.workers) {
      node.append(
        el(
          "div",
          { className: "ab-item" },
          el(
            "div",
            { className: "ab-item-head" },
            el("code", { text: worker.id }),
            worker.isCoordinator ? chip("Coordinator") : null,
            chip(`max ${worker.maxInstances}`),
          ),
          definition([
            ["Skills", worker.skills.length > 0 ? worker.skills.join(", ") : "—"],
            ["Tools", worker.tools.length > 0 ? worker.tools.join(", ") : "—"],
            ["Reads state", worker.stateRead.length > 0 ? worker.stateRead.join(", ") : "—"],
            ["Writes state", worker.stateWrite.length > 0 ? worker.stateWrite.join(", ") : "—"],
            ["Budget", `${worker.budgetTokens} tokens · ${worker.budgetRemoteCalls} remote calls`],
          ]),
        ),
      );
    }
    return node;
  }

  function renderWorkflow(pkg: PackageViewType): HTMLElement {
    const flow = pkg.workflow;
    const node = el("div", {});
    node.append(
      definition([
        ["Profile", el("code", { text: flow.profile })],
        ["Coordinator", el("code", { text: flow.coordinator })],
        ["Nodes", String(flow.nodeCount)],
        ["Node types", flow.nodeTypes.map((item) => `${item.type} ${item.count}`).join(" · ") || "—"],
        ["Entry nodes", flow.entryNodes.join(", ") || "—"],
        ["Output nodes", flow.outputNodes.join(", ") || "—"],
        ["Max declared parallelism", String(flow.maxDeclaredParallel)],
        ["Whole-run deadline", flow.deadlineSeconds === null ? "—" : `${flow.deadlineSeconds}s`],
        ["Exports", flow.exports.map((item) => `${item.path} (${item.format})`).join(", ") || "—"],
      ]),
    );
    if (flow.nodes.length > 0) {
      const steps = el("ol", { className: "ab-flow" });
      for (const workflowNode of flow.nodes) {
        steps.append(
          el(
            "li",
            { className: "ab-flow-node" },
            el("code", { text: workflowNode.id }),
            chip(workflowNode.type),
            el("span", { className: "ab-muted", text: ` worker ${workflowNode.worker}` }),
            workflowNode.dependsOn.length > 0
              ? el("span", { className: "ab-muted", text: ` ← ${workflowNode.dependsOn.join(", ")}` })
              : null,
            workflowNode.steps.length > 0
              ? el("span", { className: "ab-muted", text: ` · ${workflowNode.steps.length} steps` })
              : null,
          ),
        );
      }
      node.append(steps);
    }
    if (flow.truncated) {
      node.append(el("p", { className: "ab-hint", text: "This graph was truncated for display." }));
    }
    return node;
  }

  function renderEvidence(pkg: PackageViewType): HTMLElement {
    const node = el("div", { className: "ab-grid" });
    node.append(
      el(
        "div",
        {},
        el("h3", { text: `Evals (${pkg.evals.length})` }),
        pkg.evals.length > 0
          ? list(
              pkg.evals.map((item) =>
                el(
                  "div",
                  {},
                  el("code", { text: item.id }),
                  el("span", { className: "ab-muted", text: ` ${item.kind} · ${item.caseCount} cases` }),
                ),
              ),
            )
          : el("p", { className: "ab-hint", text: "No evaluations declared." }),
        el("p", {
          className: "ab-hint",
          text: "Declared only. This host has not run or verified them.",
        }),
      ),
      el(
        "div",
        {},
        el("h3", { text: `Attestations (${pkg.attestations.length})` }),
        pkg.attestations.length > 0
          ? list(pkg.attestations.map((item) => el("code", { text: item.path })))
          : el("p", { className: "ab-hint", text: "No attestations declared." }),
        el("p", {
          className: "ab-hint",
          text: "Self-authored metadata. No third-party attestation is verified.",
        }),
      ),
    );
    return node;
  }

  function renderTechnical(pkg: PackageViewType): HTMLElement {
    return definition([
      ["Package digest", el("code", { text: pkg.identity.digest })],
      ["Archive SHA-256", el("code", { text: pkg.snapshot.archiveSha256 })],
      ["Archive size", bytes(pkg.snapshot.archiveBytes)],
      ["Specification", pkg.identity.specVersion],
      ["Entry point", pkg.identity.entrypoint],
      ["Runtime API", `${pkg.identity.runtimeApi} ≥ ${pkg.identity.minimumRuntimeVersion}`],
      ["Built", whenText(pkg.identity.createdAt)],
      ["Source", pkg.source.display],
      ["Session", el("code", { text: pkg.sessionId })],
      ["Supported profiles", pkg.validation.supportedProfiles.join(", ") || "—"],
      ["Memory scope", `${pkg.memory.scope} · retention ${pkg.memory.retention}`],
    ]);
  }

  // -- permissions -----------------------------------------------------------
  function renderPermissionsCard(): HTMLElement {
    const permissions = loaded?.permissions;
    if (!permissions) return card("Permissions");
    const required = permissions.permissions.filter((item) => item.required);
    const optional = permissions.permissions.filter((item) => !item.required);
    const node = el("div", { className: "ab-permissions" });

    const section = (title: string, items: typeof required) => {
      if (items.length === 0) return null;
      const block = el("div", { className: "ab-permission-group" });
      block.append(el("h3", { text: title }));
      for (const permission of items) {
        block.append(renderPermission(permission));
      }
      return block;
    };
    append(node, [section("Required", required), section("Optional", optional)]);

    if (permissions.toolApprovals.length > 0) {
      const block = el("div", { className: "ab-permission-group" });
      block.append(el("h3", { text: "Tool approvals" }));
      for (const approval of permissions.toolApprovals) {
        const checkbox = el("input", { attrs: { type: "checkbox" } });
        checkbox.checked = approvals.get(approval.toolId) ?? false;
        checkbox.disabled = !deps.canWrite;
        checkbox.addEventListener("change", () => approvals.set(approval.toolId, checkbox.checked));
        const label = el("label", { className: "ab-approval" });
        label.append(
          checkbox,
          el("code", { text: approval.toolId }),
          el("span", { className: "ab-muted", text: ` ${approval.sideEffects} side effects` }),
        );
        block.append(label);
      }
      node.append(block);
    }

    return sectioned("permissions", card(
      "Permissions",
      el("p", {
        className: "ab-hint",
        text: "Every permission starts denied. Publisher trust and user permission are separate decisions: a trusted publisher is still granted nothing until you choose it here.",
      }),
      node,
      permissions.unsupportedDecisions.length > 0
        ? el(
            "p",
            { className: "ab-hint" },
            ...permissions.unsupportedDecisions.map((item) =>
              // The control plane's reason may itself open with "Not offered".
              el("span", { text: `"${item.value}" is not offered: ${item.reason.replace(/^not offered:\s*/iu, "")} ` }),
            ),
          )
        : null,
    ));
  }

  function renderPermission(permission: PermissionsViewType["permissions"][number]): HTMLElement {
    const select = el("select", {
      className: "ab-select",
      attrs: { "aria-label": `Decision for ${permission.id}` },
    });
    const options = loaded?.permissions.decisionOptions ?? ["deny"];
    for (const option of options) {
      const optionNode = el("option", { text: DECISION_LABELS[option as Decision] ?? option });
      optionNode.value = option;
      select.append(optionNode);
    }
    // Set once every option is attached, so a re-render restores the decision exactly.
    const chosen = decisions.get(permission.id) ?? "deny";
    select.value = options.includes(chosen) ? chosen : (options[0] ?? "deny");
    select.disabled = !deps.canWrite;
    select.addEventListener("change", () => {
      decisions.set(permission.id, select.value as Decision);
    });

    return el(
      "div",
      { className: "ab-permission" },
      select,
      el(
        "div",
        { className: "ab-permission-body" },
        el(
          "div",
          { className: "ab-item-head" },
          el("code", { text: permission.id }),
          chip(permission.kind),
          permission.required ? chip("Required", "warn") : chip("Optional"),
        ),
        el("p", { text: permission.description }),
        permission.hostResource ? renderResourceChoice(permission) : null,
        permission.resources.length > 0
          ? el("p", { className: "ab-muted", text: `Scope: ${permission.resources.join(", ")}` })
          : null,
        permission.linkedDomains.length > 0
          ? el("p", { className: "ab-muted", text: `Network: ${permission.linkedDomains.join(", ")}` })
          : null,
        permission.linkedTools.length > 0
          ? el("p", { className: "ab-muted", text: `Used by: ${permission.linkedTools.join(", ")}` })
          : null,
      ),
    );
  }

  /**
   * The host resource a permission would share, chosen by the person from what
   * this host holds. Labels are the host's display-safe text; the value itself
   * never reaches the page.
   */
  function renderResourceChoice(permission: PermissionsViewType["permissions"][number]): HTMLElement {
    const request = permission.hostResource!;
    const kind = request.typeDisplayName ?? "host resource";
    if (request.status !== "offered") {
      const why =
        request.status === "empty"
          ? `This host holds no ${kind.toLowerCase()}, so this permission cannot be granted here.`
          : request.status === "kind_mismatch"
            ? `The package requests a ${kind.toLowerCase()} under a different permission kind than this host reads it with, so it cannot be granted.`
            : "The package's request names more than one kind of host resource, so it cannot be granted.";
      return el("p", { className: "ab-muted ab-resource-choice", text: why });
    }
    const select = el("select", {
      className: "ab-select",
      attrs: { "aria-label": `${kind} for ${permission.id}` },
    });
    const placeholder = el("option", { text: `Choose a ${kind.toLowerCase()}…` });
    placeholder.value = "";
    select.append(placeholder);
    const current = resourceSelections.get(permission.id) ?? "";
    for (const option of request.options) {
      const node = el("option", { text: option.label });
      node.value = option.resourceId;
      select.append(node);
    }
    // Set once every option is attached: the pick survives a re-render exactly.
    select.value = request.options.some((option) => option.resourceId === current) ? current : "";
    select.disabled = !deps.canWrite;
    select.addEventListener("change", () => {
      if (select.value) resourceSelections.set(permission.id, select.value);
      else resourceSelections.delete(permission.id);
    });
    return el(
      "div",
      { className: "ab-resource-choice" },
      el("label", {}, el("span", { className: "ab-muted", text: `${kind}: ` }), select),
      el("p", {
        className: "ab-muted",
        text:
          "Held by this host, not by the package. Only the one you choose is shared, and only " +
          "with the tools listed under “Used by”; denying the permission shares none.",
      }),
    );
  }

  /** A grant as a person reads it: the permission and the label they chose. */
  function resourceGrantText(grant: { permissionId: string; resourceId: string; resourceDigest: string }): string {
    const permission = loaded?.permissions.permissions.find((item) => item.id === grant.permissionId);
    const label = permission?.hostResource?.options.find(
      (option) => option.resourceId === grant.resourceId,
    )?.label;
    return `${grant.permissionId} → ${label ?? grant.resourceId} (${shortHash(grant.resourceDigest)})`;
  }

  function renderConstraintsCard(pkg: PackageViewType): HTMLElement {
    return card(
      "Declared limits",
      el("p", {
        className: "ab-hint",
        text: "These are limits the package declares; the agentpkg runtime enforces them during a run, and this host can only lower them.",
      }),
      definition([
        ["Estimated tokens", String(pkg.budget.estimatedTokens)],
        ["Hard token limit", String(pkg.budget.hardTokens)],
        ["Max remote calls", String(pkg.budget.maxRemoteCalls)],
        ["Max parallel workers", String(pkg.budget.maxParallelWorkers)],
        [
          "Approval threshold",
          pkg.budget.approvalThresholdTokens === null
            ? "—"
            : String(pkg.budget.approvalThresholdTokens),
        ],
        [
          "Per-tool call caps",
          pkg.budget.maxCallsPerTool.map((item) => `${item.toolId} ${item.calls}`).join(" · ") || "—",
        ],
        ["Delegation depth", String(pkg.delegation.maxDepth)],
        ["Remote delegation", pkg.delegation.allowRemote ? "Requested" : "Not requested"],
        ["Approved worker roles", pkg.delegation.approvedRoles.join(", ") || "—"],
        ["Allowed network domains", pkg.network.allowedDomains.join(", ") || "none"],
      ]),
    );
  }

  // -- model selection -------------------------------------------------------
  function requirementLabel(requirement: { kind: string; subject: string; required: unknown }): string {
    if (requirement.kind === "context_tokens") {
      return `context ≥ ${Number(requirement.required ?? 0).toLocaleString()}`;
    }
    if (requirement.kind === "property") return `${requirement.subject} model`;
    return requirement.subject.replace(/_/gu, " ");
  }

  function compatibilityTone(status: string): "good" | "warn" | "bad" {
    if (status === "compatible") return "good";
    if (status === "incompatible") return "bad";
    return "warn";
  }

  function compatibilityText(status: string): string {
    switch (status) {
      case "compatible":
        return "Compatible";
      case "incompatible":
        return "Incompatible";
      default:
        return "Unverified";
    }
  }

  const BASIS_LABELS: Record<string, string> = {
    declared: "host declares this for this model",
    host_default: "host default policy for models that do not say",
    derived: "derived from another host capability",
    absent: "the host does not report this",
  };

  function renderModelCard(pkg: PackageViewType): HTMLElement {
    const current = loaded;
    const requirements = pkg.modelRequirements;
    // The control plane's normalized requirement set once it is known; before
    // that, the same facts read straight off the package's declared tasks, so
    // the section is never empty.
    const hard =
      current?.models?.requirements.hardRequirements ??
      [
        ...[...new Set(requirements.tasks.flatMap((task) => task.capabilities))]
          .sort()
          .map((capability) => ({
            kind: "capability",
            subject: capability,
            required: true as boolean | number | null,
            tasks: requirements.tasks
              .filter((task) => task.capabilities.includes(capability))
              .map((task) => task.id),
          })),
        ...(requirements.tasks.length > 0
          ? [
              {
                kind: "context_tokens",
                subject: "context_tokens",
                required: Math.max(...requirements.tasks.map((task) => task.contextWindow)) as
                  | boolean
                  | number
                  | null,
                tasks: requirements.tasks.map((task) => task.id),
              },
            ]
          : []),
      ];
    const declared = el("div", { className: "ab-model-requirements" });
    declared.append(
      el("h3", { text: "This agent requires" }),
      list(
        hard.map((requirement) =>
          el(
            "span",
            {},
            el("code", { text: requirementLabel(requirement) }),
            el("span", {
              className: "ab-muted",
              text: ` · declared by ${requirement.tasks.length} task(s)`,
            }),
          ),
        ),
      ),
      el("p", {
        className: "ab-hint",
        text:
          `Routing ${requirements.routing} · fallback ${requirements.fallbackPolicy}` +
          `${requirements.privacy ? ` · privacy ${requirements.privacy}` : ""}. ` +
          "The package names no provider and no model.",
      }),
    );

    if (!current?.receipt) {
      return sectioned("model", card(
        "Model",
        declared,
        el("p", {
          className: "ab-hint",
          text: "Authorize this package first. A model is chosen for an authorized run, not for an inspection.",
        }),
      ));
    }

    const body = el("div", { className: "ab-model" });
    const catalog = current.models;
    if (!catalog) {
      body.append(
        el("p", { className: "ab-hint", text: "Reading this OpenClaw host's model catalog…" }),
      );
      if (deps.canWrite) {
        body.append(
          button("Refresh models", () => void loadModels(pkg.sessionId, { announce: true })),
        );
      }
      return sectioned("model", card("Model", declared, body));
    }

    body.append(
      el("p", {
        className: "ab-hint",
        text:
          `Available on this OpenClaw host: ${catalog.counts.available} of ${catalog.counts.total} ` +
          `models · ${catalog.counts.compatible} compatible, ${catalog.counts.unverified} unverified, ` +
          `${catalog.counts.incompatible} incompatible.`,
      }),
    );
    for (const note of catalog.notes) {
      body.append(
        el(
          "p",
          { className: "ab-model-note" },
          el("code", { text: note.code }),
          el("span", { text: ` ${note.detail ?? ""}` }),
        ),
      );
    }

    if (!catalog.executionModePermissionsGranted) {
      const ids = catalog.executionModePermissionIds;
      body.append(
        el(
          "div",
          { className: "ab-banner ab-banner-warn", attrs: { role: "status" } },
          el("strong", { text: "This run mode needs a model permission" }),
          el("p", {
            text:
              ids.length === 0
                ? "This package declares no model permission, so it cannot request a model-backed run."
                : `A model-backed run requires ${ids.join(", ")}. Set it to Allow once or Allow for ` +
                  "session in Permissions above, then authorize again. Models are listed below for " +
                  "inspection, but no run plan can be prepared until then.",
          }),
        ),
      );
    }

    if (catalog.models.length === 0) {
      body.append(
        el("p", {
          className: "ab-hint",
          text: "This OpenClaw host reports no models. Configure a model provider and refresh.",
        }),
      );
    } else {
      body.append(renderModelList(catalog));
    }

    const canPrepare =
      deps.canWrite &&
      selectedModel !== null &&
      catalog.executionModePermissionsGranted &&
      catalog.models.some(
        (model) => model.modelId === selectedModel && model.selectableForRunPlan,
      );
    const actions = el("div", { className: "ab-inline" });
    if (deps.canWrite) {
      actions.append(
        button("Prepare run", () => void prepareRun(), {
          variant: "primary",
          disabled: !canPrepare || busy !== null,
          title: canPrepare
            ? "Bind this package, its authorization and this model into a run plan"
            : "Choose a selectable model and grant the model permission first",
        }),
        button("Refresh models", () => void loadModels(pkg.sessionId, { announce: true })),
      );
    } else {
      actions.append(
        el("p", { className: "ab-hint", text: "Operator write access is required to choose a model." }),
      );
    }
    body.append(actions);
    body.append(
      el("p", {
        className: "ab-hint",
        text:
          "The package declares requirements, OpenClaw supplies the candidates, and you choose. " +
          "Nothing is selected for you, and preparing a run plan does not run anything.",
      }),
    );
    return sectioned("model", card("Model", declared, body));
  }

  function renderModelList(catalog: ModelCatalogViewType): HTMLElement {
    const node = el("div", { className: "ab-models", attrs: { role: "radiogroup" } });
    for (const model of catalog.models) {
      node.append(renderModelRow(model));
    }
    return node;
  }

  function renderModelRow(model: HostModelViewType): HTMLElement {
    const selectable = model.selectableForRunPlan && deps.canWrite;
    const row_ = el("div", {
      className: `ab-model-row ab-model-${model.status}${
        selectedModel === model.modelId ? " ab-model-selected" : ""
      }`,
    });
    const input = el("input", {
      attrs: { type: "radio", name: "agent-browser-model", value: model.modelId },
    });
    input.checked = selectedModel === model.modelId;
    input.disabled = !selectable;
    input.addEventListener("change", () => {
      selectedModel = model.modelId;
      renderMain();
    });
    const label = el("label", { className: "ab-model-label" });
    label.append(
      input,
      el(
        "span",
        { className: "ab-model-head" },
        el("strong", { text: model.displayName }),
        el("code", { className: "ab-model-id", text: model.modelId }),
        chip(compatibilityText(model.status), compatibilityTone(model.status)),
        model.available ? null : chip("Not available", "bad"),
        model.local === true ? chip("Local") : null,
      ),
    );
    row_.append(label);

    const facts: string[] = [];
    facts.push(`Provider ${model.providerId}`);
    if (model.contextTokens !== null) {
      facts.push(`context ${model.contextTokens.toLocaleString()} tokens`);
    } else if (model.nativeContextWindow !== null) {
      facts.push(`context window ${model.nativeContextWindow.toLocaleString()}`);
    } else {
      facts.push("context not reported");
    }
    if (!model.available && model.availabilityReason) {
      facts.push(`unavailable: ${model.availabilityReason}`);
    }
    for (const tag of model.tags) facts.push(tag);
    row_.append(el("p", { className: "ab-muted", text: facts.join(" · ") }));

    if (model.status === "unverified") {
      row_.append(
        el("p", {
          className: "ab-model-warning",
          text:
            "This host does not report enough to confirm every requirement: " +
            `${model.unknown.join(", ")}. It is not refuted either.`,
        }),
      );
    }
    if (model.status === "incompatible") {
      row_.append(
        el("p", {
          className: "ab-model-warning",
          text: `Requirement not satisfied: ${model.violated.join(", ")}.`,
        }),
      );
    }
    row_.append(renderCompatibilityDetails(model));
    return row_;
  }

  function renderCompatibilityDetails(model: HostModelViewType): HTMLElement {
    const details = el("details", { className: "ab-model-details" });
    details.append(el("summary", { text: "Compatibility details" }));
    const table = el("div", { className: "ab-checks" });
    for (const check of model.checks) {
      const tone =
        check.status === "satisfied" ? "good" : check.status === "violated" ? "bad" : "warn";
      const hostValue =
        check.hostValue === null
          ? "not reported"
          : typeof check.hostValue === "boolean"
            ? String(check.hostValue)
            : check.hostValue.toLocaleString();
      table.append(
        el(
          "div",
          { className: "ab-check" },
          el("code", { text: check.id }),
          chip(check.status, tone),
          el("span", {
            className: "ab-muted",
            text: ` required ${String(check.required)} · host ${hostValue} · ${
              BASIS_LABELS[check.basis] ?? check.basis
            }`,
          }),
          check.detail ? el("p", { className: "ab-muted", text: check.detail }) : null,
        ),
      );
    }
    details.append(table);
    if (model.capabilities.length > 0) {
      details.append(
        el("h4", { text: "What this host reports" }),
        list(
          model.capabilities.map((capability) =>
            el(
              "span",
              {},
              el("code", { text: capability.name }),
              el("span", {
                className: "ab-muted",
                text: ` ${capability.value === null ? "unknown" : String(capability.value)} · ${
                  BASIS_LABELS[capability.basis] ?? capability.basis
                }`,
              }),
            ),
          ),
        ),
      );
    }
    return details;
  }

  // -- run plan --------------------------------------------------------------
  function renderRunPlanCard(): HTMLElement | null {
    const state = loaded?.runPlan;
    const plan = state?.plan;
    if (!plan || !state) return null;
    const preflight = state.preflight;
    const ready = preflight?.ready === true;
    const node = el("div", { className: "ab-runplan" });
    node.append(
      el(
        "div",
        { className: `ab-receipt-banner ab-receipt-${ready ? "ok" : "blocked"}` },
        el("strong", {
          text: ready
            ? "Ready to run"
            : preflight?.stale
              ? "Run plan is stale"
              : "Run plan is not ready",
        }),
        el("p", {
          text: ready
            ? "Everything this run needs is bound and current."
            : "This plan cannot be used as it stands; the reasons are listed below.",
        }),
      ),
      definition([
        ["Package", `${plan.package.name} ${plan.package.version}`],
        [
          "Publisher",
          `${plan.publisher.trustStatus === "trusted" ? "✓ Trusted" : plan.publisher.trustStatus} · ${plan.publisher.claimedName}`,
        ],
        [
          "Authorization",
          `${preflight?.stale ? "Superseded or changed" : "✓ Current"} · ${plan.authorization.receiptId}`,
        ],
        ...(plan.resourceGrants.length > 0
          ? [
              [
                "Host resources",
                plan.resourceGrants.map(resourceGrantText).join(" · "),
              ] as [string, string],
            ]
          : []),
        [
          "Model",
          plan.modelBinding
            ? `${plan.modelBinding.displayName} (${plan.modelBinding.hostModelId}) · ${compatibilityText(
                plan.modelBinding.compatibilityStatus,
              )}`
            : "none — this plan binds one tool call, not a run",
        ],
        [
          "Execution",
          `${plan.execution.profile} · mode ${plan.execution.mode} · ${plan.execution.bindingStrategy} binding`,
        ],
        ["Run plan", el("code", { text: plan.runPlanId })],
        ["Run plan hash", el("code", { text: `sha256:${plan.runPlanSha256}` })],
      ]),
    );

    const problems = [...(preflight?.staleReasons ?? []), ...(preflight?.blockingReasons ?? [])];
    if (problems.length > 0) {
      const reasons = el("ul", { className: "ab-blocking" });
      for (const reason of problems) {
        reasons.append(
          el("li", {}, el("code", { text: reason.code }), el("span", { text: ` ${reason.message}` })),
        );
      }
      node.append(el("h3", { text: "Why this plan is not usable" }), reasons);
    }

    node.append(
      el(
        "div",
        { className: "ab-banner ab-banner-good", attrs: { role: "status" } },
        el("strong", {
          text: state.executionSupported
            ? "Run this plan from the Run panel above."
            : "This host cannot run packages right now.",
        }),
        el("p", {
          text:
            "A run plan never runs by itself and never changes. Each Run re-verifies the package, " +
            "its signature, publisher trust, the authorization, the tool bindings and the model " +
            "against this plan, and is recorded as a separate run that references it.",
        }),
      ),
    );
    if (deps.canWrite) {
      node.append(button("Discard run plan", () => void clearRunPlan(), { variant: "danger" }));
    }
    node.append(renderRunPlanDetails(plan, preflight));
    return sectioned("run-plan", card("Run plan", node));
  }

  function renderRunPlanDetails(
    plan: NonNullable<RunPlanStateViewType["plan"]>,
    preflight: RunPlanStateViewType["preflight"],
  ): HTMLElement {
    const details = el("details", { className: "ab-receipt" });
    details.append(el("summary", { text: "Run plan (technical details)" }));
    details.append(
      definition([
        ["Schema version", plan.runPlanVersion],
        ["Prepared", whenText(plan.createdAt)],
        ["Expires", whenText(plan.expiresAt)],
        ["Package digest", el("code", { text: plan.package.digest })],
        ["Archive SHA-256", el("code", { text: plan.package.archiveSha256 })],
        ["Signer", el("code", { text: plan.publisher.signerFingerprint ?? "—" })],
        ["Receipt hash", el("code", { text: plan.authorization.receiptSha256 })],
        ["Granted", plan.authorization.grantedPermissionIds.join(", ") || "none"],
        ["Run-mode permissions", plan.execution.requiredPermissionIds.join(", ") || "none"],
        ["Model", el("code", { text: plan.modelBinding?.hostModelId ?? "none" })],
        ["Model evidence", plan.modelBinding?.evidenceStrength ?? "—"],
        [
          "Catalog snapshot",
          plan.modelBinding
            ? `${plan.modelBinding.catalogModelCount} models · sha256:${shortHash(plan.modelBinding.catalogSha256)}`
            : "—",
        ],
        [
          "Model still offered",
          !plan.modelBinding
            ? "—"
            : preflight?.modelStillAvailable === null
              ? "unknown"
              : preflight?.modelStillAvailable
                ? "yes"
                : "no",
        ],
        ["Trust store changed since", preflight?.trustStoreChanged ? "yes" : "no"],
        ["Preflight checked", whenText(preflight?.checkedAt ?? "")],
        ["Executed", "no"],
      ]),
    );
    if (plan.toolBindings.length > 0) {
      details.append(el("h4", { text: "Tools" }));
      details.append(
        el("p", {
          className: "ab-muted",
          text:
            preflight?.toolBindingsCurrent === false
              ? "One of these implementations changed after this plan was prepared, so the " +
                "plan is stale."
              : "Exactly these implementations would run. Nothing else is reachable.",
        }),
      );
      for (const bound of plan.toolBindings) {
        details.append(
          definition([
            ["Tool", el("code", { text: bound.toolId })],
            ["Implementation", el("code", { text: bound.bindingId })],
            ["Binding digest", el("code", { text: bound.bindingSha256 })],
            [
              "Runs",
              bound.remote
                ? `remotely, ${bound.method ?? ""} ${bound.endpointOrigin ?? ""}${
                    bound.endpointPath ?? ""
                  }`.trim()
                : "locally, in this host",
            ],
            ["Permissions", bound.requiredPermissionIds.join(", ") || "none"],
            ["Approved", "yes"],
            [
              "Credential",
              bound.credentialsRequired
                ? bound.credentialsConfigured
                  ? "configured on this host"
                  : "required and not configured"
                : "none",
            ],
            ["Call cap", bound.maxCalls === null ? "—" : String(bound.maxCalls)],
          ]),
        );
      }
      if (plan.toolRegistry) {
        details.append(
          definition([
            [
              "Registry snapshot",
              `${plan.toolRegistry.bindingCount} implementations · sha256:${shortHash(
                plan.toolRegistry.registrySha256,
              )}`,
            ],
          ]),
        );
      }
    }
    return details;
  }

  // -- authorization ---------------------------------------------------------
  function renderAuthorizationCard(): HTMLElement {
    const current = loaded;
    if (!current) return card("Authorization");
    const node = el("div", { className: "ab-authorize" });

    const blocking = current.receipt?.blockingReasons ?? current.permissions.blockingReasons;
    if (current.receipt) {
      node.append(
        el(
          "div",
          { className: `ab-receipt-banner ab-receipt-${current.receipt.runnable ? "ok" : "blocked"}` },
          el("strong", {
            text: current.receipt.runnable
              ? "✓ Authorized for this session"
              : "Cannot run with these decisions",
          }),
          el("p", {
            text: current.receipt.runnable
              ? "The package has NOT executed. Authorization only records permission to proceed, and it expires with this session."
              : "Adjust the decisions below, or resolve the blocking reasons, then authorize again.",
          }),
        ),
      );
    }
    if (blocking.length > 0) {
      const reasons = el("ul", { className: "ab-blocking" });
      for (const reason of blocking) {
        reasons.append(
          el(
            "li",
            {},
            el("code", { text: reason.code }),
            el("span", { text: ` ${reason.message}` }),
          ),
        );
      }
      node.append(el("h3", { text: "Blocking reasons" }), reasons);
    }

    if (deps.canWrite) {
      node.append(
        button("Authorize", () => void authorize(), {
          variant: "primary",
          disabled: busy !== null,
        }),
      );
    } else {
      node.append(
        el("p", { className: "ab-hint", text: "Operator write access is required to authorize." }),
      );
    }
    node.append(
      el("p", {
        className: "ab-hint",
        text:
          "Authorizing runs nothing. A run starts only when you press Run, after a run plan is " +
          "prepared, and everything is re-verified at that moment.",
      }),
    );
    if (current.receipt) node.append(renderReceiptDetails(current.receipt));
    return sectioned("authorization", card("Authorization", node));
  }

  function renderReceiptDetails(receipt: ReceiptViewType): HTMLElement {
    const details = el("details", { className: "ab-receipt" });
    details.append(el("summary", { text: "Authorization receipt (technical details)" }));
    details.append(
      definition([
        ["Receipt", el("code", { text: receipt.receiptId })],
        ["Issued", whenText(receipt.issuedAt)],
        ["Expires", whenText(receipt.expiresAt)],
        ["Package", `${receipt.packageId} ${receipt.packageVersion}`],
        ["Package digest", el("code", { text: receipt.packageDigest })],
        ["Archive SHA-256", el("code", { text: receipt.archiveSha256 })],
        ["Signer", el("code", { text: receipt.publisher.signerFingerprint ?? "—" })],
        ["Signature", receipt.publisher.signatureStatus],
        ["Publisher trust", `${receipt.publisher.trustStatus} (${receipt.publisher.trustReason})`],
        [
          "Trust store",
          `${receipt.trustStore.entryCount} pinned · ${shortHash(receipt.trustStore.stateSha256)}`,
        ],
        [
          "Decisions",
          receipt.decisions.map((item) => `${item.permissionId}=${item.decision}`).join(" · ") || "—",
        ],
        [
          "Tool approvals",
          receipt.toolApprovals.map((item) => `${item.toolId}=${item.approved}`).join(" · ") || "—",
        ],
        ["Granted", receipt.grantedPermissionIds.join(", ") || "none"],
        ["Host resources", receipt.resourceGrants.map(resourceGrantText).join(" · ") || "none"],
        ["Runnable", receipt.runnable ? "yes" : "no"],
        ["Receipt hash", el("code", { text: receipt.receiptSha256 })],
        ["Executed", "no"],
      ]),
    );
    return details;
  }

  async function authorize(): Promise<void> {
    const current = loaded;
    if (!current) return;
    setBusy("Recording your decisions…");
    const result = await call<
      { ok: true; value: ReceiptViewType } | { ok: false; error: FeatureErrorView }
    >("packages.authorize", {
      sessionId: current.pkg.sessionId,
      packageDigest: current.pkg.identity.digest,
      decisions: [...decisions.entries()].map(([permissionId, decision]) => ({
        permissionId,
        decision,
      })),
      toolApprovals: [...approvals.entries()].map(([toolId, approved]) => ({ toolId, approved })),
      // A pick travels only with a permission that is allowed and requests a
      // resource this host offers; a denied permission carries none.
      resourceSelections: current.permissions.permissions
        .filter(
          (item) =>
            item.hostResource?.status === "offered" &&
            (decisions.get(item.id) ?? "deny") !== "deny" &&
            resourceSelections.has(item.id),
        )
        .map((item) => ({ permissionId: item.id, resourceId: resourceSelections.get(item.id)! })),
    }).catch(() => null);
    if (!alive()) return;
    if (!result || !result.ok) {
      fail(result ? result.error : unexpectedError());
      if (result && !result.ok && result.error.code === "session_expired") {
        loaded = null;
        renderMain();
        void refreshSessions();
      }
      return;
    }
    setBusy(null);
    // A new receipt supersedes any prepared plan, on the server and here.
    loaded = { ...current, receipt: result.value, runPlan: null };
    void loadModels(current.pkg.sessionId);
    notice = {
      text: result.value.runnable
        ? "Authorized for this session. Nothing has executed."
        : "Recorded. The package is not runnable with these decisions.",
      tone: result.value.runnable ? "good" : "warn",
    };
    renderStatus();
    renderMain();
    void refreshSessions();
  }

  // -- boot ------------------------------------------------------------------
  renderService();
  renderAddress();
  renderStatus();
  renderMain();
  void (async () => {
    await refreshService();
    if (alive()) await refreshSessions();
    // A reload must not lose a run: reconnect to one still in flight.
    if (alive()) await refreshRuns({ reconnect: true });
  })();

  const dispose = () => {
    disposed = true;
    runPanel.dispose();
    root.remove();
  };
  deps.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
