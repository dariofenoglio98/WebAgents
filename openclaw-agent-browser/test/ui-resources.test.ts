/**
 * Choosing which host-owned resource a permission shares, in the page.
 *
 * The page shows, for a permission that requests a host resource, the host's
 * display-safe labels and nothing else; sends a pick only with a permission
 * that is allowed; keeps the pick across re-renders; and shows which
 * resource a receipt and a plan name. Choosing does not re-render anything, so
 * it cannot move the page (see `ui-stability.test.ts` for why that matters).
 */
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionsViewType } from "../src/contract.js";
import { mountAgentBrowser } from "../src/ui/page.js";
import {
  modelCatalogView,
  packageView,
  permissionsView,
  receiptView,
  runPlanStateView,
  serviceStatus,
} from "./fixtures.js";

type Handlers = Record<string, (input: any) => unknown>;

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const IDENTITY = {
  resourceType: "personal.passenger_identity",
  typeDisplayName: "Passenger identity",
  typeDescription: null,
  status: "offered",
  options: [
    { resourceId: "passenger_demo_alex", label: "Alex Traveler — a***@example.com" },
    { resourceId: "passenger_demo_sam", label: "Sam Traveler — s***@example.com" },
  ],
  selectedResourceId: null,
};
const WALLET = {
  resourceType: "wallet.payment_method",
  typeDisplayName: "Payment method",
  typeDescription: null,
  status: "offered",
  options: [
    { resourceId: "payment_demo_visa", label: "Demo Visa •••• 4242" },
    { resourceId: "payment_demo_travel", label: "Demo Travel Card •••• 1234" },
  ],
  selectedResourceId: null,
};

function resourcePermissions(overrides: Partial<PermissionsViewType> = {}): PermissionsViewType {
  const base = permissionsView();
  const permission = (id: string, kind: string, hostResource: unknown) => ({
    id,
    kind,
    description: `${id} description`,
    required: false,
    resources: [],
    decision: "deny" as const,
    linkedTools: [],
    linkedDomains: [],
    hostResource: hostResource as never,
  });
  return {
    ...base,
    blockingReasons: [],
    permissions: [
      permission("identity.passenger", "personal.read", IDENTITY),
      permission("wallet.payment", "personal.read", WALLET),
      permission("booking.simulate_purchase", "payment", null),
      permission("profile.travel", "personal.read", {
        resourceType: "personal.travel_profile",
        typeDisplayName: "Travel profile",
        typeDescription: null,
        status: "empty",
        options: [],
        selectedResourceId: null,
      }),
    ],
    ...overrides,
  };
}

function mount(handlers: Handlers = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const defaults: Handlers = {
    "service.status": () => serviceStatus(),
    "packages.list": () => ({ ok: true, value: { sessions: [], max: 8 } }),
    "packages.open-url": () => ({ ok: true, value: packageView() }),
    "packages.get": () => ({ ok: true, value: packageView() }),
    "packages.permissions": () => ({ ok: true, value: resourcePermissions() }),
    "packages.authorization": () => ({ ok: true, value: null }),
    "models.evaluate": () => ({ ok: true, value: modelCatalogView() }),
    "tools.evaluate": () => ({ ok: false, error: { code: "tool_registry_unavailable", title: "x", detail: "x", retryable: false } }),
    "run-plan.get": () => ({ ok: true, value: { plan: null, preflight: null, executionSupported: false } }),
    "execution.list": () => ({ ok: true, value: { runs: [] } }),
    "execution.readiness": () => ({ ok: true, value: null }),
  };
  const merged = { ...defaults, ...handlers };
  const controller = new AbortController();
  const dispose = mountAgentBrowser(container, {
    invoke: async (operation: string, input: unknown) => {
      const handler = merged[operation];
      if (!handler) return { ok: false, error: { code: "invalid_request", title: "x", detail: operation, retryable: false } };
      return handler(input);
    },
    signal: controller.signal,
    canWrite: true,
  });
  return { container, dispose, text: () => container.textContent ?? "" };
}

async function opened(handlers: Handlers = {}) {
  const page = mount(handlers);
  await settle();
  const input = page.container.querySelector<HTMLInputElement>("input[name='package-url']")!;
  input.value = "https://packages.example/x.agent.pkg";
  page.container.querySelector("form")!.dispatchEvent(new Event("submit"));
  await settle();
  return page;
}

const chooser = (page: { container: HTMLElement }, label: string) =>
  page.container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const decision = (page: { container: HTMLElement }, id: string) =>
  page.container.querySelector<HTMLSelectElement>(`select[aria-label="Decision for ${id}"]`)!;
function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change"));
}
const authorizeButton = (page: { container: HTMLElement }) =>
  [...page.container.querySelectorAll("button")].find((button) => button.textContent === "Authorize")!;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("choosing a host resource", () => {
  it("offers the host's labels, chooses nothing by default, and explains what cannot be granted", async () => {
    const page = await opened();
    const identity = chooser(page, "Passenger identity for identity.passenger");
    expect(identity.value).toBe("");
    expect([...identity.options].map((option) => option.textContent)).toEqual([
      "Choose a passenger identity…",
      "Alex Traveler — a***@example.com",
      "Sam Traveler — s***@example.com",
    ]);
    expect(decision(page, "identity.passenger").value).toBe("deny");
    expect(page.text()).toContain("Held by this host, not by the package");
    expect(page.text()).toContain("This host holds no travel profile");
    // An action authority is a plain permission, with no chooser.
    expect(page.container.querySelector('select[aria-label$="for booking.simulate_purchase"]:not([aria-label^="Decision"])')).toBeNull();
    page.dispose();
  });

  it("sends a pick only with a permission that is allowed", async () => {
    const authorize = vi.fn(() => ({ ok: true, value: receiptView() }));
    const page = await opened({ "packages.authorize": authorize });
    choose(chooser(page, "Passenger identity for identity.passenger"), "passenger_demo_alex");
    choose(decision(page, "identity.passenger"), "session");
    // Picked, but the permission stays denied: the pick must not travel.
    choose(chooser(page, "Payment method for wallet.payment"), "payment_demo_visa");
    authorizeButton(page).click();
    await settle();
    const input = (authorize.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(input.resourceSelections).toEqual([
      { permissionId: "identity.passenger", resourceId: "passenger_demo_alex" },
    ]);
    expect(input.decisions).toContainEqual({ permissionId: "wallet.payment", decision: "deny" });
    page.dispose();
  });

  it("changes nothing on the page while choosing, and keeps the pick across a re-render", async () => {
    const receipt = receiptView({
      resourceGrants: [
        {
          permissionId: "identity.passenger",
          resourceType: "personal.passenger_identity",
          resourceId: "passenger_demo_sam",
          resourceDigest: "d".repeat(64),
        },
      ],
    });
    const page = await opened({ "packages.authorize": () => ({ ok: true, value: receipt }) });
    const card = page.container.querySelector(".ab-permissions")!;
    const before = card.innerHTML;
    choose(chooser(page, "Passenger identity for identity.passenger"), "passenger_demo_sam");
    choose(decision(page, "identity.passenger"), "session");
    // No re-render: the same nodes, so nothing can move.
    expect(page.container.querySelector(".ab-permissions")).toBe(card);
    expect(card.innerHTML).toBe(before);
    authorizeButton(page).click();
    await settle();
    // Authorize re-renders the page; the pick and the decision are still the person's.
    expect(chooser(page, "Passenger identity for identity.passenger").value).toBe("passenger_demo_sam");
    expect(decision(page, "identity.passenger").value).toBe("session");
    expect(chooser(page, "Payment method for wallet.payment").value).toBe("");
    // The receipt names the resource by the label the person saw, never a value.
    expect(page.text()).toContain("identity.passenger → Sam Traveler — s***@example.com");
    page.dispose();
  });

  it("restores a pick the current receipt holds when the session is reopened", async () => {
    const permissions = resourcePermissions();
    permissions.permissions[1] = {
      ...permissions.permissions[1]!,
      decision: "session",
      hostResource: { ...WALLET, selectedResourceId: "payment_demo_travel" },
    };
    const page = await opened({ "packages.permissions": () => ({ ok: true, value: permissions }) });
    expect(chooser(page, "Payment method for wallet.payment").value).toBe("payment_demo_travel");
    page.dispose();
  });

  it("shows which resource a prepared plan would run with", async () => {
    const plan = runPlanStateView();
    plan.plan!.resourceGrants = [
      {
        permissionId: "wallet.payment",
        resourceType: "wallet.payment_method",
        resourceId: "payment_demo_visa",
        resourceDigest: "e".repeat(64),
      },
    ];
    const page = await opened({
      "packages.authorization": () => ({ ok: true, value: receiptView() }),
      "run-plan.get": () => ({ ok: true, value: plan }),
    });
    await settle();
    expect(page.text()).toContain("Host resources");
    expect(page.text()).toContain("wallet.payment → Demo Visa •••• 4242");
    page.dispose();
  });
});
