// @vitest-environment happy-dom
/**
 * An input switch that needs a memory read grants it in place (D-273, B-219): Literature Review
 * 0.2.9's "Use my research profile" ticked without a granted profile shows the recall card under
 * the switch; choosing the record re-authorizes with the grant and a new plan, and Run is offered.
 */
import { describe, expect, it } from "vitest";

import type { AuthorizationView, AuthorizeResult, Request, SessionView, SettingsView } from "../../src/extension/messages.js";
import { RunPanel } from "../../src/extension/ui/run.js";
import { until } from "../helpers/page.js";
import { readBytes, SHIPPED } from "../helpers/paths.js";
import { makeHarness, PACKAGE_MEDIA_TYPE, PAGE, webairRoutes, type Harness } from "../helpers/shell.js";

const REVIEW_URL = "https://research.example/literature-review-0.2.9.agent.pkg";
const QWEN = "ollama/qwen3:30b";
const TOOLS = { "scholarly-search": true, "paper-reader": true, "citation-resolver": true, "research.profile": true, "agent-notes.read": true, "agent-notes.write": true };

async function world(): Promise<{ h: Harness; session: SessionView }> {
  const bytes = readBytes(SHIPPED.literatureReview029.archive);
  const routes = { ...webairRoutes(), [REVIEW_URL]: { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(bytes.length) }, body: bytes } };
  const h = makeHarness({ routes });
  const view = (await h.controller.handle({ type: "package.open", url: REVIEW_URL, advertisedOn: "https://research.example/", viewId: "ui" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.literatureReview029.fingerprint, scope: "publisher" }, PAGE);
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = QWEN;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
  // One research profile in the memory, for the card to offer.
  await h.controller.handle({ type: "memory.create", draft: { type: "research.profile", title: "PhD research", fields: { interests: ["agent-native web", "capability mediation"] }, body: "Interests: agent-native web." } }, PAGE);
  const session = (await h.controller.handle({ type: "package.get", sessionId: view.session.id }, PAGE)) as SessionView;
  return { h, session };
}

describe("an input switch that needs a memory read (D-273)", () => {
  it("shows the recall card under the ticked switch, grants the read in place with a new plan, and offers Run", async () => {
    const { h, session } = await world();
    let authorization: AuthorizationView | null = null;
    let changed = 0;
    const panel = new RunPanel({
      send: <T>(request: Request) => h.controller.handle(request, PAGE) as Promise<T>,
      loaded: () => ({ session, authorization }),
      changed: () => {
        changed += 1;
      },
    });
    document.body.append(panel.root);
    const sync = async () => {
      authorization = (await h.controller.handle({ type: "authorization.get", sessionId: session.session.id }, PAGE)) as AuthorizationView;
      panel.sync();
    };
    await panel.attachSession(session.session.id);
    // Authorized with the profile read denied (the search alone), every other permission for the session.
    const decisions = { "network.scholarly": "session", "network.citations": "session", "files.pdfs": "session", "model.reasoning": "session", "memory.session": "session", "memory.research_profile": "deny", "memory.remember": "deny", "memory.agent": "session", "compute.bookkeeping": "session" };
    const result = (await h.controller.handle({ type: "authorization.authorize", sessionId: session.session.id, packageDigest: SHIPPED.literatureReview029.digest, decisions, toolApprovals: TOOLS, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
    expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
    await sync();
    expect(authorization!.input_gated_reads).toEqual([expect.objectContaining({ input_key: "use_profile", tool_id: "research.profile", permission_ids: ["memory.research_profile"] })]);
    // Nothing under the switch while it is off.
    expect(panel.root.querySelector("[data-gated-read]")).toBeNull();
    const question = panel.root.querySelector<HTMLTextAreaElement>("#ab-field-question")!;
    question.value = "What is an agent-native web?";
    question.dispatchEvent(new Event("input"));
    const toggle = panel.root.querySelector<HTMLInputElement>("#ab-field-use_profile")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    toggle.dispatchEvent(new Event("input"));
    const card = await until(() => panel.root.querySelector<HTMLElement>("[data-gated-read=use_profile]"), "the recall card under the switch");
    expect(card.textContent).toContain("“Use my research profile” needs your research profile.");
    expect(card.querySelector("[data-record]")?.textContent).toContain("PhD research");
    // The checklist holds Run while the read is not granted.
    await until(() => panel.root.querySelector("[data-check=gated_reads]"), "the checklist item");
    expect(panel.root.querySelector("[data-check=gated_reads]")?.classList.contains("ab-check-no")).toBe(true);
    expect(panel.canRun().enabled).toBe(false);
    // Grant and use: a new receipt and plan with the read granted and the record chosen.
    const before = authorization!.run_plan!.run_plan.run_plan_id;
    card.querySelector<HTMLButtonElement>("[data-gated-grant]")!.click();
    await until(() => changed > 0, "the page told to re-read");
    await sync();
    expect(authorization!.receipt?.decisions["memory.research_profile"]).toBe("session");
    expect(authorization!.run_plan!.run_plan.run_plan_id).not.toBe(before);
    expect(authorization!.run_plan!.run_plan.resource_grants.map((grant) => grant.permission_id)).toEqual(["memory.research_profile"]);
    await until(() => panel.root.querySelector("[data-gated-read]") === null, "the card gone");
    await until(() => panel.root.querySelector("[data-check=gated_reads]")?.classList.contains("ab-check-ok") === true, "the checklist item satisfied");
    await until(() => panel.canRun().enabled, "Run offered", 15_000);
    panel.dispose();
  });
});
