/**
 * Settings → Files, Services and Run limits, and a picked PDF through a run (T6, D-081…D-084):
 * a pick is copied, hashed and bounded as the reference's selection is; a run is given exactly the
 * files its task names, refused when it names one this browser does not hold or when reading is
 * denied; the execution host reads the stored copy through the paper reader (pdf.js, in process
 * here), and the record, the audit and the artifacts name the file by opaque id and hash only.
 * The Crossref contact is part of the scholarly-search binding (a plan stales when it changes)
 * and the run limits come from Settings.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import { verifyAuditChain } from "../../src/core/execution/report.js";
import { DEFAULT_HOST_LIMITS } from "../../src/core/execution/limits.js";
import type { AuthorizationView, AuthorizeResult, FilesView, RunReadiness, RunView, SessionView, SettingsView } from "../../src/extension/messages.js";
import { parseRequest } from "../../src/extension/messages.js";
import { LONG_RUN_LIMITS } from "../../src/extension/ui/settings-page.js";
import { literatureReview } from "../helpers/fixtures.js";
import { readerPackage, readerSource, READER_URL, sha } from "../helpers/reader-package.js";
import { ROOT, SHIPPED } from "../helpers/paths.js";
import { LITERATURE_URL, makeHarness, PACKAGE_MEDIA_TYPE, PAGE, type Harness } from "../helpers/shell.js";

const PROBE = new Uint8Array(readFileSync(join(ROOT, "examples", "probe-files", "paper-reader-probe.pdf")));
const QWEN = "ollama/qwen3:30b";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function refused(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CoreError) return error;
    throw error;
  }
  throw new Error("expected a CoreError");
}

async function useQwen(h: Harness): Promise<void> {
  const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
  settings.models.default_model = QWEN;
  await h.controller.handle({ type: "settings.set", settings }, PAGE);
}

/** A trusted reader session with a ready plan: files.pdfs as decided, the reader approved. */
async function readerWorld(decision: "session" | "deny" = "session"): Promise<{ h: Harness; session: SessionView; result: AuthorizeResult }> {
  const pkg = await readerPackage();
  const h = makeHarness();
  h.routes[READER_URL] = { headers: { "content-type": PACKAGE_MEDIA_TYPE, "content-length": String(pkg.bytes.length) }, body: pkg.bytes };
  const view = (await h.controller.handle({ type: "package.open", url: READER_URL, advertisedOn: null, viewId: "test" }, PAGE)) as SessionView;
  await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: pkg.fingerprint, scope: "publisher" }, PAGE);
  await useQwen(h);
  const result = (await h.controller.handle(
    { type: "authorization.authorize", sessionId: view.session.id, packageDigest: pkg.digest, decisions: { "files.pdfs": decision, "model.reasoning": "session", "memory.session": "session" }, toolApprovals: { "paper-reader": true }, resourceSelections: {}, provenance: null, prepare: true },
    PAGE,
  )) as AuthorizeResult;
  expect(result.run_plan?.preflight.ready, JSON.stringify(result.plan_refused)).toBe(true);
  return { h, session: view, result };
}

async function start(h: Harness, session: SessionView, result: AuthorizeResult, input: unknown): Promise<RunView> {
  const plan = result.run_plan!.run_plan;
  return (await h.controller.handle({ type: "run.start", sessionId: session.session.id, runPlanId: plan.run_plan_id, runPlanSha256: plan.run_plan_sha256, input }, PAGE)) as RunView;
}

describe("the reader test package", () => {
  it("carries Literature Review 0.2.5's reader schemas byte for byte", async () => {
    const lr = await literatureReview();
    const source = readerSource();
    for (const name of ["schemas/reader-input.schema.json", "schemas/reader-output.schema.json"]) expect(new TextDecoder().decode(source.get(name)!)).toBe(new TextDecoder().decode(lr.files.get(name)!));
  });
});

describe("Settings → Files: a pick is copied, hashed and bounded (D-083)", () => {
  it("copies a PDF with its hash and size, lists it without its bytes, and removes it", async () => {
    const h = makeHarness();
    const added = (await h.controller.handle(parseRequest({ type: "files.add", name: "/Users/someone/Papers/probe.pdf", base64: b64(PROBE) }), PAGE)) as FilesView;
    expect(added.files).toHaveLength(1);
    const file = added.files[0]!;
    expect(file).toEqual({ file_id: expect.stringMatching(/^file_[0-9a-f]{32}$/u), display_name: "probe.pdf", sha256: sha(PROBE), bytes: PROBE.length, media_type: "application/pdf", selected_at: h.clock.now.toISOString() });
    expect(JSON.stringify(added)).not.toContain("Users");
    expect((await h.files.get(file.file_id))!.data).toEqual(PROBE);
    expect(h.events.some((event) => event.type === "event.files")).toBe(true);
    expect(((await h.controller.handle({ type: "files.list" }, PAGE)) as FilesView).files.map((item) => item.file_id)).toEqual([file.file_id]);
    expect(((await h.controller.handle({ type: "files.remove", fileId: file.file_id }, PAGE)) as FilesView).files).toEqual([]);
    expect((await refused(h.controller.handle({ type: "files.remove", fileId: file.file_id }, PAGE))).code).toBe("file_unknown");
  });

  it("refuses what the reference refuses, before a byte is kept", async () => {
    const h = makeHarness();
    const add = (name: string, bytes: Uint8Array) => h.controller.handle({ type: "files.add", name, base64: b64(bytes) }, PAGE);
    expect((await refused(add("notes.txt", PROBE))).code).toBe("file_invalid");
    expect((await refused(add("fake.pdf", new TextEncoder().encode("GIF89a")))).code).toBe("file_invalid");
    expect((await refused(add("empty.pdf", new Uint8Array(0)))).code).toBe("file_limit");
    expect((await refused(add("big.pdf", new Uint8Array(20 * 1024 * 1024 + 1).fill(0x25)))).code).toBe("file_limit");
    for (let index = 0; index < 16; index += 1) await add(`p${index}.pdf`, PROBE);
    expect((await refused(add("seventeenth.pdf", PROBE))).code).toBe("file_limit");
    expect(h.files.files.size).toBe(16);
    expect(() => parseRequest({ type: "files.add", name: "x.pdf", base64: "not base64!" })).toThrow(/base64/u);
    expect(() => parseRequest({ type: "files.add", name: "x.pdf", base64: "", extra: 1 })).toThrow(/unknown field/u);
  });
});

describe("a run is given exactly the picked files its task names (D-082, D-083)", () => {
  it("reads the picked PDF through the paper reader; the record, the audit and the files name it by opaque id and hash only", async () => {
    const { h, session, result } = await readerWorld();
    const file = ((await h.controller.handle({ type: "files.add", name: "My Private Folder/probe-paper.pdf", base64: b64(PROBE) }, PAGE)) as FilesView).files[0]!;
    const started = await start(h, session, result, { file_id: file.file_id });
    expect(started.task.attachments).toEqual([{ fileId: file.file_id, sha256: sha(PROBE), bytes: PROBE.length, mediaType: "application/pdf" }]);
    await h.host.drain();
    const done = (await h.controller.handle({ type: "run.get", runId: started.runId }, PAGE)) as RunView;
    expect(done.status, JSON.stringify(done.failure)).toBe("completed");
    const stored = (await h.runs.getRun(started.runId))!;
    expect(stored.invocation.attachments).toEqual([{ file_id: file.file_id, sha256: sha(PROBE), bytes: PROBE.length, media_type: "application/pdf" }]);
    const settled = stored.audit.filter((event) => event.action === "tool.settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ tool: "paper-reader", status: "ok", file_id: file.file_id, file_sha256: sha(PROBE) });
    expect(verifyAuditChain(stored.audit as never).valid).toBe(true);
    const result_ = new TextDecoder().decode((await h.runs.getArtifact(started.runId, "result.json"))!.bytes);
    expect(result_).toContain("SYNTHETIC PROBE DOCUMENT");
    // The invocation hash binds the attachment; nowhere does the file's name or folder appear.
    const everything = JSON.stringify([stored.record, stored.audit, stored.invocation, [...h.runs.artifacts.values()].map((artifact) => new TextDecoder().decode(artifact.bytes))]);
    expect(everything).not.toMatch(/probe-paper|My Private Folder/u);
  });

  it("refuses a task that names a file this browser does not hold, before any lease", async () => {
    const { h, session, result } = await readerWorld();
    const error = await refused(start(h, session, result, { file_id: `file_${"0".repeat(32)}` }));
    expect(error.code).toBe("file_unknown");
    expect(h.host.started).toHaveLength(0);
  });

  it("refuses a task naming a picked file when reading files is denied (metadata only)", async () => {
    const { h, session, result } = await readerWorld("deny");
    const file = ((await h.controller.handle({ type: "files.add", name: "probe.pdf", base64: b64(PROBE) }, PAGE)) as FilesView).files[0]!;
    const error = await refused(start(h, session, result, { file_id: file.file_id }));
    expect(error.code).toBe("execution_refused");
    expect(error.message).toMatch(/files\.pdfs/u);
    expect(h.host.started).toHaveLength(0);
  });

  it("a file removed after the run started is not read: the call fails as no longer held", async () => {
    const { h, session, result } = await readerWorld();
    const file = ((await h.controller.handle({ type: "files.add", name: "probe.pdf", base64: b64(PROBE) }, PAGE)) as FilesView).files[0]!;
    // The person removes it between the start and the host's read (the host first re-verifies the
    // package bytes and writes its record, so the read comes later).
    const run = await start(h, session, result, { file_id: file.file_id });
    await h.controller.handle({ type: "files.remove", fileId: file.file_id }, PAGE);
    await h.host.drain();
    const done = (await h.controller.handle({ type: "run.get", runId: run.runId }, PAGE)) as RunView;
    expect(done.status).toBe("failed");
    expect(done.errorCode).toBe("tool_error");
    expect(done.failure).toMatchObject({ nodeId: "read", call: { kind: "tool", action: "tool.failed", tool: "paper-reader", reason: "tool_unavailable" } });
  });
});

describe("Settings → Services: the Crossref contact is part of the search binding (D-081)", () => {
  it("is refused when it is not one address, and setting it makes a prepared Literature Review plan stale", async () => {
    const h = makeHarness();
    const view = (await h.controller.handle({ type: "package.open", url: LITERATURE_URL, advertisedOn: null }, PAGE)) as SessionView;
    await h.controller.handle({ type: "trust.pin", sessionId: view.session.id, signerFingerprint: SHIPPED.literatureReview.fingerprint, scope: "publisher" }, PAGE);
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    settings.models.default_model = QWEN;
    settings.models.connections = settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, overrides: { "qwen3:30b": { context_tokens: 65536, max_output_tokens: 16384 } } } : connection));
    await h.controller.handle({ type: "settings.set", settings }, PAGE);
    const decisions = { "network.scholarly": "session", "network.citations": "session", "files.pdfs": "session", "model.reasoning": "session", "memory.session": "session" } as const;
    const prepared = (await h.controller.handle({ type: "authorization.authorize", sessionId: view.session.id, packageDigest: SHIPPED.literatureReview.digest, decisions, toolApprovals: { "scholarly-search": true, "citation-resolver": true, "paper-reader": true }, resourceSelections: {}, provenance: null, prepare: true }, PAGE)) as AuthorizeResult;
    expect(prepared.run_plan?.preflight.ready).toBe(true);
    const search = prepared.run_plan!.run_plan.tool_bindings.find((binding) => binding.tool_id === "scholarly-search")!;
    expect(search.credentials_configured).toBe(false);
    const current = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    expect((await refused(h.controller.handle({ type: "settings.set", settings: { ...current, services: { crossref_contact: "not an address" } } }, PAGE))).code).toBe("settings_invalid");
    await h.controller.handle({ type: "settings.set", settings: { ...current, services: { crossref_contact: "reviewer@example.org" } } }, PAGE);
    const after = (await h.controller.handle({ type: "authorization.get", sessionId: view.session.id }, PAGE)) as AuthorizationView;
    expect(after.run_plan?.preflight.stale).toBe(true);
    expect(JSON.stringify(after)).not.toContain("reviewer@example.org");
  });
});

describe("Settings → Run limits (B-118, D-084)", () => {
  it("bound readiness and the run's record; values outside limits.ts are refused by name", async () => {
    const { h, session, result } = await readerWorld();
    const before = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(before.receipt?.required_seconds).toBe(DEFAULT_HOST_LIMITS.run_timeout_seconds + 60);
    const current = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    expect((await refused(h.controller.handle({ type: "settings.set", settings: { ...current, limits: { ...current.limits, run_timeout_seconds: 0 } } }, PAGE))).code).toBe("settings_invalid");
    expect((await refused(h.controller.handle({ type: "settings.set", settings: { ...current, limits: { ...current.limits, total_tokens: 20_000_000 } } }, PAGE))).code).toBe("settings_invalid");
    await h.controller.handle({ type: "settings.set", settings: { ...current, limits: { ...LONG_RUN_LIMITS } } }, PAGE);
    const after = (await h.controller.handle({ type: "run.readiness", sessionId: session.session.id }, PAGE)) as RunReadiness;
    expect(after.receipt?.required_seconds).toBe(LONG_RUN_LIMITS.run_timeout_seconds + 60);
    expect(after.ready).toBe(true); // 7,200 s sessions outlast 4,560 s
    const file = ((await h.controller.handle({ type: "files.add", name: "probe.pdf", base64: b64(PROBE) }, PAGE)) as FilesView).files[0]!;
    const run = await start(h, session, result, { file_id: file.file_id });
    expect(run.limits.host).toMatchObject({ totalTokens: 180_000, maxRemoteCalls: 45, runTimeoutSeconds: 4_500, modelCallTimeoutSeconds: 1_200 });
    await h.host.drain();
  });
});

describe("Settings → Models → Let local models think (T6)", () => {
  it("is off by default; when on, the run's Ollama requests carry think: true and the router's description says so", async () => {
    const { h, session, result } = await readerWorld();
    const settings = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    expect(settings.models.connections.find((connection) => connection.provider === "ollama")?.think).toBeUndefined();
    await h.controller.handle({ type: "settings.set", settings: { ...settings, models: { ...settings.models, connections: settings.models.connections.map((connection) => (connection.provider === "ollama" ? { ...connection, think: true } : connection)) } } }, PAGE);
    const stored = ((await h.controller.handle({ type: "settings.get" }, PAGE)) as SettingsView).settings;
    expect(stored.models.connections.find((connection) => connection.provider === "ollama")?.think).toBe(true);
    // Another provider cannot carry the switch.
    expect(stored.models.connections.find((connection) => connection.provider === "openai")?.think).toBeUndefined();
    const file = ((await h.controller.handle({ type: "files.add", name: "probe.pdf", base64: b64(PROBE) }, PAGE)) as FilesView).files[0]!;
    const run = await start(h, session, result, { file_id: file.file_id });
    expect(h.host.started.at(-1)!.settings.think).toBe(true);
    await h.host.drain();
    // The execution result (the host's record of the run) describes the router it was given.
    const executed = (await h.runs.getRun(run.runId))!.result as { router: { thinking?: boolean } };
    expect(executed.router.thinking).toBe(true);
  });
});
