/**
 * A slot's look over the extension's transport (T66 review 1, nits 7 and 12): a page longer than
 * the discovery cap is read to its first MiB and its head scanned, as `browser/discovery.py` and
 * `RecordedWeb.look` read it, where the look used to refuse it `discovery_too_large`; a package's
 * download still refuses a body over its cap; a response without a body stream is counted; and a
 * run's cards are shown one at a time (nit 6).
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_LIMITS } from "../../src/core/discovery.js";
import { downloadPackage, lookAtPage } from "../../src/core/links/web.js";
import type { RunRequest } from "../../src/core/conversation/host.js";
import { oneCardAtATime } from "../../src/extension/execution/execute.js";
import { browserTransport, type FetchLike } from "../../src/extension/execution/transport.js";

const PAGE = "https://hotel.example.org/";
const HEAD = '<!doctype html><html><head><title>Hotel</title><link rel="agent-package" href="/agent.pkg"></head><body>';

function longPage(bytes: number): Uint8Array {
  const head = new TextEncoder().encode(HEAD);
  const page = new Uint8Array(bytes).fill(0x61);
  page.set(head, 0);
  return page;
}

const answering =
  (body: Uint8Array, headers: Record<string, string>): FetchLike =>
  async () =>
    new Response(body as Uint8Array<ArrayBuffer>, { status: 200, headers });

describe("a slot's look reads a long page's head (nit 7)", () => {
  it("a page over 1 MiB, with and without a declared length: the first MiB read, the candidate found", async () => {
    const page = longPage(DEFAULT_LIMITS.maxHtmlBytes + 300_000);
    for (const headers of [{ "content-type": "text/html; charset=utf-8" }, { "content-type": "text/html; charset=utf-8", "content-length": String(page.length) }] as Array<Record<string, string>>) {
      const found = await lookAtPage(PAGE, browserTransport({ allowLoopbackHttp: false, fetch: answering(page, headers) }));
      expect(found.discovery_status).toBe("candidate");
      expect(found.candidates[0]).toMatchObject({ href: "/agent.pkg" });
      expect(found.page).toMatchObject({ truncated: true, bytes_read: DEFAULT_LIMITS.maxHtmlBytes, head_ended: true });
    }
  });

  it("a package's download still refuses a body over its cap", async () => {
    const transport = browserTransport({ allowLoopbackHttp: false, fetch: answering(longPage(1024), {}) });
    await expect(transport({ url: PAGE, method: "GET", headers: {}, body: null, signal: new AbortController().signal, maxResponseBytes: 100 })).rejects.toMatchObject({ facts: { stage: "body_size" } });
    const small = new Uint8Array([1, 2, 3]);
    expect(await downloadPackage("https://hotel.example.org/agent.pkg", browserTransport({ allowLoopbackHttp: false, fetch: answering(small, {}) }))).toEqual(small);
  });
});

describe("a response without a body stream (nit 12)", () => {
  it("is counted: its bytes are returned, and a longer one is refused or truncated as asked", async () => {
    const bytes = new TextEncoder().encode("hello, world");
    const streamless: FetchLike = async () => ({ status: 200, type: "basic", headers: new Headers({ "content-type": "text/plain" }), body: null, arrayBuffer: async () => bytes.slice().buffer }) as unknown as Response;
    const transport = browserTransport({ allowLoopbackHttp: false, fetch: streamless });
    const request = { url: PAGE, method: "GET" as const, headers: {}, body: null, signal: new AbortController().signal };
    const whole = await transport({ ...request, maxResponseBytes: 1024 });
    expect(whole).toMatchObject({ status: 200, body: "hello, world" });
    expect(whole.bytes).toEqual(bytes);
    await expect(transport({ ...request, maxResponseBytes: 5 })).rejects.toMatchObject({ facts: { stage: "body_size" } });
    const cut = await transport({ ...request, maxResponseBytes: 5, truncate: true });
    expect(cut).toMatchObject({ body: "hello", truncated: true });
  });
});

describe("a run's cards one at a time (nit 6)", () => {
  const request = (node: string) => ({ kind: "link.join", run_id: "r", node_id: node, facts: {}, timeout_seconds: 10 }) as unknown as RunRequest;

  it("a second card waits for the first to end instead of replacing it; one whose wait ended in the queue is never shown", async () => {
    const shown: string[] = [];
    const answers = new Map<string, (value: unknown) => void>();
    const ask = oneCardAtATime((item) => {
      shown.push(item.node_id!);
      return new Promise((resolve) => answers.set(item.node_id!, resolve));
    });
    const first = ask(request("join"), new AbortController().signal);
    const second = ask(request("raise"), new AbortController().signal);
    const expired = new AbortController();
    const third = ask(request("late"), expired.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toEqual(["join"]);
    expired.abort(new Error("timeout"));
    answers.get("join")!({ accepted: true });
    expect(await first).toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toEqual(["join", "raise"]);
    answers.get("raise")!({ accepted: false });
    expect(await second).toEqual({ accepted: false });
    await expect(third).rejects.toThrow("timeout");
    expect(shown).toEqual(["join", "raise"]);
  });
});
