/**
 * Agent Browser page behaviour, rendered in a DOM with a fake feature client.
 *
 * The page is asserted on what an operator can actually see: separate
 * validation layers, signature and trust rendered apart, deny-by-default
 * permissions, and no run action anywhere.
 */
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountAgentBrowser } from "../src/ui/page.js";
import {
  modelCatalogView,
  packageView,
  permissionsView,
  receiptView,
  runPlanStateView,
  serviceStatus,
} from "./fixtures.js";

type Handlers = Record<string, (input: unknown) => unknown>;

function mount(handlers: Handlers = {}, options: { canWrite?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const calls: Array<{ operation: string; input: unknown }> = [];
  const controller = new AbortController();
  const defaults: Handlers = {
    "service.status": () => serviceStatus(),
    "packages.list": () => ({ ok: true, value: { sessions: [], max: 8 } }),
    "packages.get": () => ({ ok: true, value: packageView() }),
    "packages.permissions": () => ({ ok: true, value: permissionsView() }),
    "packages.authorization": () => ({ ok: true, value: null }),
    "packages.close": () => ({ ok: true, value: { sessionId: "x", closed: true } }),
  };
  const merged = { ...defaults, ...handlers };
  const dispose = mountAgentBrowser(container, {
    invoke: async (operation: string, input: unknown) => {
      calls.push({ operation, input });
      const handler = merged[operation];
      if (!handler) throw new Error(`unexpected operation ${operation}`);
      return handler(input);
    },
    signal: controller.signal,
    canWrite: options.canWrite ?? true,
  });
  return { container, calls, dispose, controller, text: () => container.textContent ?? "" };
}

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("initial view", () => {
  it("shows an address bar and no open package", async () => {
    const page = mount();
    await settle();
    expect(page.text()).toContain("Agent Browser");
    expect(page.text()).toContain("No package open");
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']");
    expect(input).not.toBeNull();
    expect(input?.placeholder).toContain("https://");
    expect(page.text()).toContain("Control plane running");
    // Whether a run can start is the plugin's runner, not the control plane,
    // which never executes a package itself.
    const detail = page.container.querySelector(".ab-service-detail")!;
    expect(detail.textContent).toContain("runs unavailable");
    expect(detail.getAttribute("title")).toContain("its own execution: disabled");
    page.dispose();
  });

  it("says runs are available when the runner is", async () => {
    const page = mount({ "service.status": () => serviceStatus({ executionSupported: true }) });
    await settle();
    expect(page.container.querySelector(".ab-service-detail")?.textContent).toContain("runs available");
    expect(page.text()).not.toContain("execution disabled");
    page.dispose();
  });

  it("offers a Retry action and no address entry when the service is down", async () => {
    const page = mount({
      "service.status": () =>
        serviceStatus({
          state: "failed",
          detail: "The control plane exited (code 1).",
          controlPlane: null,
          capabilities: { openUrl: false, openLocal: false, localRoots: [], trustPinning: false },
        }),
    });
    await settle();
    expect(page.text()).toContain("Control plane unavailable");
    expect(page.text()).toContain("The control plane exited");
    const buttons = [...page.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Retry");
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']");
    expect(input?.disabled).toBe(true);
    page.dispose();
  });

  it("hides local opening unless the host configured a root", async () => {
    const page = mount({
      "service.status": () =>
        serviceStatus({
          capabilities: { openUrl: true, openLocal: false, localRoots: [], trustPinning: true },
        }),
    });
    await settle();
    expect(page.container.querySelector("input[name='package-path']")).toBeNull();
    page.dispose();
  });
});

describe("opening a package", () => {
  async function open(page: ReturnType<typeof mount>, url = "https://packages.example/x.agent.pkg") {
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = url;
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
  }

  it("shows one bounded progress message and then the package header", async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const page = mount({
      "packages.open-url": async () => {
        await gate;
        return { ok: true, value: packageView() };
      },
    });
    await settle();
    await open(page);
    expect(page.text()).toContain("Opening and verifying package");
    // No invented phase progress.
    expect(page.text()).not.toMatch(/Downloading|Validating|Inspecting/u);
    release({});
    await settle();
    expect(page.text()).toContain("Literature Review Agent");
    expect(page.text()).toContain("org.webagents.literature-review");
    expect(page.text()).toContain("Execution profile workflow.v0");
    page.dispose();
  });

  it("renders each validation layer separately from signature and trust", async () => {
    const page = mount({ "packages.open-url": () => ({ ok: true, value: packageView() }) });
    await settle();
    await open(page);
    const text = page.text();
    for (const label of ["Container", "Integrity", "Schema", "Runtime"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Cryptographically valid");
    expect(text).toContain("Unknown publisher");
    expect(text).toContain("Nobody on this host has pinned this signing key");
    // A valid signature must not read as a trusted publisher.
    expect(text).not.toContain("Trusted by this OpenClaw host");
    page.dispose();
  });

  it("marks a publisher/key mismatch prominently", async () => {
    const mismatch = packageView();
    mismatch.publisher = {
      ...mismatch.publisher,
      trustStatus: "mismatch",
      trustReason: "claimed_publisher_pinned_to_other_key",
      pinnedFingerprintsForClaimedPublisher: [`sha256:${"9".repeat(64)}`],
    };
    mismatch.warnings = [
      { code: "publisher_mismatch", severity: "critical", message: "Impersonation risk." },
    ];
    const page = mount({ "packages.open-url": () => ({ ok: true, value: mismatch }) });
    await settle();
    await open(page);
    expect(page.text()).toContain("Publisher / key mismatch");
    expect(page.text()).toContain("impersonation risk");
    expect(page.container.querySelector(".ab-trust-mismatch")).not.toBeNull();
    // No pinning offer for a mismatched key.
    expect(page.text()).not.toContain("Review publisher key");
    page.dispose();
  });

  it("offers a deliberate two-step pin for an unknown publisher", async () => {
    const pinned = vi.fn(() => ({
      ok: true,
      value: { publisher: packageView().publisher, pinned: {} },
    }));
    const page = mount({
      "packages.open-url": () => ({ ok: true, value: packageView() }),
      "trust.pin-session-publisher": pinned,
    });
    await settle();
    await open(page);
    expect(page.text()).toContain("Review publisher key");
    expect(page.text()).toContain("persists until removed");
    const confirm = [...page.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Trust this publisher key",
    )!;
    confirm.click();
    await settle();
    // One click arms, it does not pin.
    expect(pinned).not.toHaveBeenCalled();
    expect(confirm.textContent).toContain("Confirm");
    confirm.click();
    await settle();
    expect(pinned).toHaveBeenCalledTimes(1);
    expect((pinned.mock.calls[0] as unknown[])[0]).toMatchObject({ scope: "package" });
    page.dispose();
  });

  it("renders a rejected package with its layered validation and no session", async () => {
    const page = mount({
      "packages.open-url": () => ({
        ok: false,
        error: {
          code: "package_rejected",
          title: "Package rejected",
          detail: "The package failed structural validation and was not opened",
          retryable: false,
          validation: { container_status: "valid", integrity_status: "invalid" },
        },
      }),
    });
    await settle();
    await open(page);
    expect(page.text()).toContain("Package rejected");
    expect(page.text()).toContain("package_rejected");
    expect(page.text()).toContain("Invalid");
    expect(page.text()).toContain("No package open");
    page.dispose();
  });

  it("shows a retry action for a retryable failure only", async () => {
    const page = mount({
      "packages.open-url": () => ({
        ok: false,
        error: {
          code: "url_rejected",
          title: "This URL cannot be opened",
          detail: "Only https:// package URLs are accepted",
          retryable: false,
        },
      }),
    });
    await settle();
    await open(page, "http://packages.example/x.agent.pkg");
    expect(page.text()).toContain("This URL cannot be opened");
    const retry = [...page.container.querySelectorAll(".ab-banner-error button")];
    expect(retry).toHaveLength(0);
    page.dispose();
  });
});

describe("package contents", () => {
  async function opened(handlers: Handlers = {}) {
    const page = mount({
      "packages.open-url": () => ({ ok: true, value: packageView() }),
      ...handlers,
    });
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = "https://packages.example/x.agent.pkg";
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
    return page;
  }

  it("renders tools, workers and the workflow generically", async () => {
    const page = await opened();
    const tab = (label: string) =>
      [...page.container.querySelectorAll("button")].find((b) => b.textContent === label)!;

    tab("Tools").click();
    expect(page.text()).toContain("scholarly-search");
    expect(page.text()).toContain("Remote");
    expect(page.text()).toContain("read side effects");
    expect(page.text()).toContain("api.crossref.org");

    tab("Workers").click();
    expect(page.text()).toContain("LiteratureReviewCoordinator");
    expect(page.text()).toContain("Coordinator");
    expect(page.text()).toContain("30000 tokens");

    tab("Workflow").click();
    expect(page.text()).toContain("workflow.v0");
    expect(page.text()).toContain("planning");
    expect(page.text()).toContain("Max declared parallelism");

    tab("Evals & attestations").click();
    expect(page.text()).toContain("This host has not run or verified them");

    tab("Technical details").click();
    expect(page.text()).toContain("Archive SHA-256");
    page.dispose();
  });

  it("labels declared limits as runtime-enforced, not browser-enforced", async () => {
    const page = await opened();
    expect(page.text()).toContain("Declared limits");
    expect(page.text()).toContain("the agentpkg runtime enforces them during a run");
    expect(page.text()).toContain("Hard token limit");
    expect(page.text()).toContain("Delegation depth");
    page.dispose();
  });

  it("defers model selection until the package is authorized", async () => {
    const page = await opened();
    const text = page.text();
    expect(text).toContain("This agent requires");
    // The declared requirements are readable before any catalog is fetched.
    expect(text).toContain("structured output");
    expect(text).toContain("context ≥ 16,000");
    expect(text).toContain("Authorize this package first");
    expect(text).toContain("The package names no provider and no model");
    page.dispose();
  });

  it("renders warnings by code and severity", async () => {
    const page = await opened();
    expect(page.text()).toContain("publisher_unknown");
    expect(page.text()).toContain("warning");
    page.dispose();
  });

  it("escapes package-provided strings instead of rendering markup", async () => {
    const hostile = packageView();
    hostile.identity.name = "<img src=x onerror=alert(1)>";
    hostile.identity.description = "</p><script>window.pwned=1</script>";
    hostile.capabilities = ["<b>bold</b>"];
    const page = mount({ "packages.open-url": () => ({ ok: true, value: hostile }) });
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = "https://packages.example/x.agent.pkg";
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
    expect(page.container.querySelector("img")).toBeNull();
    expect(page.container.querySelector("script")).toBeNull();
    expect(page.container.innerHTML).not.toContain("<script>");
    expect(page.text()).toContain("<img src=x onerror=alert(1)>");
    page.dispose();
  });
});

describe("permissions and authorization", () => {
  async function opened(handlers: Handlers = {}, options: { canWrite?: boolean } = {}) {
    const page = mount(
      { "packages.open-url": () => ({ ok: true, value: packageView() }), ...handlers },
      options,
    );
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = "https://packages.example/x.agent.pkg";
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
    return page;
  }

  it("defaults every permission to deny and offers only supported decisions", async () => {
    const page = await opened();
    const selects = [
      ...page.container.querySelectorAll<HTMLSelectElement>(".ab-permission select"),
    ];
    expect(selects.length).toBe(2);
    for (const select of selects) {
      expect(select.value).toBe("deny");
      const options = [...select.options].map((option) => option.value);
      expect(options).toEqual(["deny", "once", "session"]);
      expect(options).not.toContain("always");
    }
    expect(page.text()).toContain("Required");
    expect(page.text()).toContain("Optional");
    expect(page.text()).toContain('"always" is not offered');
    page.dispose();
  });

  it("sends the chosen decisions with the displayed digest", async () => {
    const authorize = vi.fn(() => ({ ok: true, value: receiptView() }));
    const page = await opened({ "packages.authorize": authorize });
    const select = page.container.querySelector<HTMLSelectElement>(".ab-permission select")!;
    select.value = "session";
    select.dispatchEvent(new Event("change"));
    [...page.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Authorize")!
      .click();
    await settle();
    expect(authorize).toHaveBeenCalledTimes(1);
    const input = (authorize.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(input.packageDigest).toBe(packageView().identity.digest);
    expect(input.decisions).toEqual([
      { permissionId: "network.scholarly", decision: "session" },
      { permissionId: "files.pdfs", decision: "deny" },
    ]);
    page.dispose();
  });

  it("shows an authorized receipt that insists nothing ran", async () => {
    const page = await opened({ "packages.authorize": () => ({ ok: true, value: receiptView() }) });
    [...page.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Authorize")!
      .click();
    await settle();
    expect(page.text()).toContain("Authorized for this session");
    expect(page.text()).toContain("The package has NOT executed");
    expect(page.text()).toContain("Authorization receipt (technical details)");
    expect(page.text()).toContain("Receipt hash");
    expect(page.text()).toContain("Authorizing runs nothing");
    page.dispose();
  });

  it("explains a blocked authorization with stable codes and subjects", async () => {
    const blocked = receiptView({
      runnable: false,
      blockingReasons: [
        {
          code: "required_permission_denied",
          message: "Required permission 'network.citations' is denied.",
          subject: "network.citations",
        },
      ],
    });
    const page = await opened({ "packages.authorize": () => ({ ok: true, value: blocked }) });
    [...page.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Authorize")!
      .click();
    await settle();
    expect(page.text()).toContain("Cannot run with these decisions");
    expect(page.text()).toContain("required_permission_denied");
    expect(page.text()).toContain("network.citations");
    page.dispose();
  });

  it("reports an expired session instead of a stale authorization", async () => {
    const page = await opened({
      "packages.authorize": () => ({
        ok: false,
        error: {
          code: "session_expired",
          title: "Package session ended",
          detail: "No open package session; it may have expired",
          retryable: false,
        },
      }),
    });
    [...page.container.querySelectorAll("button")]
      .find((button) => button.textContent === "Authorize")!
      .click();
    await settle();
    expect(page.text()).toContain("Package session ended");
    expect(page.text()).toContain("No package open");
    page.dispose();
  });

  it("offers no authorization control without operator write access", async () => {
    // A read-only operator cannot open or authorize, but may inspect a session
    // another operator opened.
    const page = mount(
      {
        "packages.list": () => ({
          ok: true,
          value: {
            sessions: [
              {
                sessionId: packageView().sessionId,
                packageId: "org.webagents.literature-review",
                name: "Literature Review Agent",
                version: "0.2.0",
                digest: "b".repeat(64),
                expiresAt: "2026-09-21T10:15:00.000Z",
                source: { kind: "url", display: "https://packages.example/x.agent.pkg" },
                signatureStatus: "valid",
                trustStatus: "unknown",
                authorizationState: "pending",
                runnable: false,
              },
            ],
            max: 8,
          },
        }),
      },
      { canWrite: false },
    );
    await settle();
    const open = [...page.container.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("org.webagents.literature-review"),
    )!;
    open.click();
    await settle();
    expect(page.text()).toContain("Literature Review Agent");
    const labels = [...page.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Authorize");
    expect(page.text()).toContain("Operator write access is required");
    const selects = [...page.container.querySelectorAll<HTMLSelectElement>(".ab-permission select")];
    expect(selects.every((select) => select.disabled)).toBe(true);
    page.dispose();
  });
});

describe("run boundary", () => {
  it("offers Run only as a disabled action until everything is in place", async () => {
    const page = mount({ "packages.open-url": () => ({ ok: true, value: packageView() }) });
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = "https://packages.example/x.agent.pkg";
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
    const run = page.container.querySelector<HTMLButtonElement>("button[data-run='start']");
    expect(run).not.toBeNull();
    expect(run!.disabled).toBe(true);
    // Nothing is started by opening, and the reason is precise.
    expect(page.calls.map((call) => call.operation)).not.toContain("execution.start");
    expect(page.text()).toContain("This host cannot run packages");
    page.dispose();
  });

  it("stops rendering after the host aborts the view", async () => {
    const page = mount();
    await settle();
    page.controller.abort();
    await settle();
    expect(document.body.contains(page.container.firstChild as Node)).toBe(false);
  });
});

// -- model selection and run plan -------------------------------------------
describe("model selection", () => {
  /** An authorized package with a host catalog already available. */
  async function authorized(overrides: Handlers = {}) {
    const page = mount({
      "packages.open-url": () => ({ ok: true, value: packageView() }),
      "packages.authorization": () => ({ ok: true, value: receiptView() }),
      "models.evaluate": () => ({ ok: true, value: modelCatalogView() }),
      "run-plan.get": () => ({
        ok: true,
        value: { plan: null, preflight: null, executionSupported: false },
      }),
      ...overrides,
    });
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = "https://packages.example/x.agent.pkg";
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
    return page;
  }

  const radios = (page: ReturnType<typeof mount>) => [
    ...page.container.querySelectorAll<HTMLInputElement>("input[name='agent-browser-model']"),
  ];

  const labelled = (page: ReturnType<typeof mount>, label: string) =>
    [...page.container.querySelectorAll("button")].find(
      (button) => (button.textContent ?? "") === label,
    );

  it("lists what this host reports, with a status for each model", async () => {
    const page = await authorized();
    const text = page.text();
    expect(text).toContain("Big Model");
    expect(text).toContain("Silent Model");
    expect(text).toContain("Small Model");
    expect(text).toContain("Compatible");
    expect(text).toContain("Unverified");
    expect(text).toContain("Incompatible");
    expect(text).toContain("Available on this OpenClaw host: 3 of 3 models");
    page.dispose();
  });

  it("labels an unverified model as unconfirmed rather than unsupported", async () => {
    const page = await authorized();
    expect(page.text()).toContain("does not report enough to confirm every requirement");
    expect(page.text()).toContain("capability:reasoning");
    expect(page.text()).toContain("It is not refuted either");
    page.dispose();
  });

  it("explains an incompatible model and refuses to let it be chosen", async () => {
    const page = await authorized();
    expect(page.text()).toContain("Requirement not satisfied: context_tokens:minimum");
    const options = Object.fromEntries(radios(page).map((input) => [input.value, input]));
    expect(options["acme/big"].disabled).toBe(false);
    expect(options["acme/silent"].disabled).toBe(false);
    expect(options["acme/small"].disabled).toBe(true);
    page.dispose();
  });

  it("shows per-requirement detail with the host's own answer and its basis", async () => {
    const page = await authorized();
    const text = page.text();
    expect(text).toContain("Compatibility details");
    expect(text).toContain("required 16000 · host 200,000");
    expect(text).toContain("host declares this for this model");
    expect(text).toContain("derived from another host capability");
    page.dispose();
  });

  it("selects nothing by default and requires an explicit choice", async () => {
    const page = await authorized();
    expect(radios(page).some((input) => input.checked)).toBe(false);
    expect(labelled(page, "Prepare run")?.disabled).toBe(true);

    const chosen = radios(page).find((input) => input.value === "acme/big")!;
    chosen.checked = true;
    chosen.dispatchEvent(new Event("change"));
    await settle();
    expect(labelled(page, "Prepare run")?.disabled).toBe(false);
    page.dispose();
  });

  it("does not offer model selection before the package is authorized", async () => {
    const page = mount({ "packages.open-url": () => ({ ok: true, value: packageView() }) });
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = "https://packages.example/x.agent.pkg";
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
    expect(page.text()).toContain("Authorize this package first");
    expect(radios(page)).toHaveLength(0);
    page.dispose();
  });

  it("sends a denied model permission back to Permissions instead of granting it", async () => {
    const page = await authorized({
      "models.evaluate": () => ({
        ok: true,
        value: modelCatalogView({ executionModePermissionsGranted: false }),
      }),
    });
    const text = page.text();
    expect(text).toContain("This run mode needs a model permission");
    expect(text).toContain("model.reasoning");
    expect(text).toContain("Allow for session");
    // Inspection still works; only preparation is blocked.
    expect(radios(page).length).toBe(3);
    const chosen = radios(page).find((input) => input.value === "acme/big")!;
    chosen.checked = true;
    chosen.dispatchEvent(new Event("change"));
    await settle();
    expect(labelled(page, "Prepare run")?.disabled).toBe(true);
    page.dispose();
  });

  it("reports an empty host catalog without inventing a model", async () => {
    const page = await authorized({
      "models.evaluate": () => ({
        ok: true,
        value: modelCatalogView({
          models: [],
          counts: { total: 0, available: 0, selectable: 0, compatible: 0, unverified: 0, incompatible: 0 },
          notes: [{ code: "no_models_available", detail: "Configure a model provider." }],
        }),
      }),
    });
    expect(page.text()).toContain("reports no models");
    expect(page.text()).toContain("no_models_available");
    expect(radios(page)).toHaveLength(0);
    page.dispose();
  });

  it("prepares a run plan and renders it as ready without starting a run", async () => {
    const prepared: Array<Record<string, unknown>> = [];
    const page = await authorized({
      "run-plan.prepare": (input) => {
        prepared.push(input as Record<string, unknown>);
        return { ok: true, value: runPlanStateView() };
      },
    });
    const chosen = radios(page).find((input) => input.value === "acme/big")!;
    chosen.checked = true;
    chosen.dispatchEvent(new Event("change"));
    await settle();
    labelled(page, "Prepare run")!.click();
    await settle();

    expect(prepared[0]).toMatchObject({
      modelId: "acme/big",
      executionMode: "model",
      packageDigest: packageView().identity.digest,
      receiptId: receiptView().receiptId,
    });
    const text = page.text();
    expect(text).toContain("Ready to run");
    expect(text).toContain("rp_0123456789abcdef0123456789abcdef");
    expect(text).toContain("sha256:9999");
    expect(text).toContain("single_model binding");
    // No execution runtime on this (fixture) host: the plan says so plainly,
    // and the Run action stays disabled. Preparing a plan started nothing.
    expect(text).toContain("This host cannot run packages right now.");
    expect(page.container.querySelector<HTMLButtonElement>("button[data-run='start']")?.disabled).toBe(true);
    expect(page.calls.map((call) => call.operation)).not.toContain("execution.start");
    page.dispose();
  });

  it("says a plan is stale, and why, instead of leaving it looking ready", async () => {
    const stale = runPlanStateView({
      preflight: {
        checkedAt: "2026-09-21T10:20:00.000Z",
        state: "stale",
        ready: false,
        stale: true,
        staleReasons: [
          {
            code: "publisher_trust_changed",
            message: "Publisher trust status changed after preparation.",
            subject: null,
          },
        ],
        blockingReasons: [],
        trustStoreChanged: true,
        modelStillAvailable: false,
      },
    });
    const page = await authorized({ "run-plan.get": () => ({ ok: true, value: stale }) });
    const text = page.text();
    expect(text).toContain("Run plan is stale");
    expect(text).toContain("publisher_trust_changed");
    expect(text).toContain("Why this plan is not usable");
    expect(text).not.toContain("Ready to run");
    page.dispose();
  });

  it("refuses a failed preparation with the control plane's own reason", async () => {
    const page = await authorized({
      "run-plan.prepare": () => ({
        ok: false,
        error: {
          code: "run_plan_refused",
          title: "Run plan refused",
          detail: "A model-backed run requires permission 'model.reasoning'.",
          retryable: false,
        },
      }),
      "models.evaluate": () => ({ ok: true, value: modelCatalogView() }),
    });
    const chosen = radios(page).find((input) => input.value === "acme/big")!;
    chosen.checked = true;
    chosen.dispatchEvent(new Event("change"));
    await settle();
    labelled(page, "Prepare run")!.click();
    await settle();
    expect(page.text()).toContain("Run plan refused");
    expect(page.text()).toContain("model.reasoning");
    page.dispose();
  });

  it("shows a read-only operator the models but no way to choose one", async () => {
    // A read-only operator cannot open a package; they reach one already open.
    const page = mount(
      {
        "packages.authorization": () => ({ ok: true, value: receiptView() }),
        "models.evaluate": () => ({ ok: true, value: modelCatalogView() }),
        "run-plan.get": () => ({
          ok: true,
          value: { plan: null, preflight: null, executionSupported: false },
        }),
        "packages.list": () => ({
          ok: true,
          value: {
            sessions: [
              {
                sessionId: packageView().sessionId,
                packageId: "org.webagents.literature-review",
                name: "Literature Review Agent",
                version: "0.2.0",
                digest: "b".repeat(64),
                expiresAt: "2026-09-21T10:15:00.000Z",
                source: { kind: "url", display: "https://packages.example/x.agent.pkg" },
                signatureStatus: "valid",
                trustStatus: "trusted",
                authorizationState: "issued",
                runnable: true,
              },
            ],
            max: 8,
          },
        }),
      },
      { canWrite: false },
    );
    await settle();
    [...page.container.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").includes("org.webagents.literature-review"))!
      .click();
    await settle();
    expect(page.text()).toContain("Big Model");
    expect(radios(page).every((option) => option.disabled)).toBe(true);
    expect(labelled(page, "Prepare run")).toBeUndefined();
    expect(page.text()).toContain("Operator write access is required to choose a model");
    page.dispose();
  });

  it("never asks the backend to complete, invoke or run anything", async () => {
    const page = await authorized({
      "run-plan.prepare": () => ({ ok: true, value: runPlanStateView() }),
    });
    const chosen = radios(page).find((input) => input.value === "acme/big")!;
    chosen.checked = true;
    chosen.dispatchEvent(new Event("change"));
    await settle();
    labelled(page, "Prepare run")!.click();
    await settle();
    for (const call of page.calls) {
      expect(call.operation).not.toMatch(/execute|invoke|complete|dispatch/u);
    }
    expect(page.calls.map((call) => call.operation)).toContain("run-plan.prepare");
    page.dispose();
  });
});

describe("what the page will not do", () => {
  it("never calls a probe, and starts runs only from the Run panel", () => {
    // A static scan of the browser half's own source, so a future edit cannot
    // quietly add a probe call or a second way to start a run.
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (...parts: string[]) => readFileSync(join(here, "..", "src", ...parts), "utf8");
    const page = read("ui", "page.ts");
    const run = read("ui", "run.ts");
    for (const source of [page, run, read("ui", "form.ts"), read("ui", "markdown.ts")]) {
      expect(source).not.toContain("execution.tool-probe");
      expect(source).not.toContain("router.probe");
      // No markup-injection API anywhere in the browser half.
      expect(source).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/u);
    }
    expect(page).not.toContain("execution.start");
    expect(run).toContain("execution.start");
    expect(page).toContain("tools.evaluate");
  });
});
