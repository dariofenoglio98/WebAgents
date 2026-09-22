/**
 * Agent Browser page behaviour, rendered in a DOM with a fake feature client.
 *
 * The page is asserted on what an operator can actually see: separate
 * validation layers, signature and trust rendered apart, deny-by-default
 * permissions, and no run action anywhere.
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountAgentBrowser } from "../src/ui/page.js";
import { packageView, permissionsView, receiptView, serviceStatus } from "./fixtures.js";

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
    expect(page.text()).toContain("Nothing runs in this milestone");
    expect(page.text()).toContain("Hard token limit");
    expect(page.text()).toContain("Delegation depth");
    page.dispose();
  });

  it("states that no model has been selected", async () => {
    const page = await opened();
    expect(page.text()).toContain("Model requirements");
    expect(page.text()).toContain("Model selection happens at run time");
    expect(page.text()).toContain("No model has been selected or invoked");
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
    expect(page.text()).toContain("No agent code has executed");
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

describe("milestone boundary", () => {
  it("has no run action anywhere in the page", async () => {
    const page = mount({ "packages.open-url": () => ({ ok: true, value: packageView() }) });
    await settle();
    const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
    input.value = "https://packages.example/x.agent.pkg";
    page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
    await settle();
    const labels = [...page.container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((label) => /^(run|start|execute)\b/iu.test(label))).toBe(false);
    expect(page.text()).toContain("This build has no run action");
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
