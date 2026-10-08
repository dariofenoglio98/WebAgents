/**
 * The message contract (D-033): every message is validated structurally at the receiver,
 * unknown types and fields are refused, strings are bounded, and responses carry stable
 * codes rather than prose.
 */
import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import { failure, isEvent, MAX_LINKS, MAX_URL, parseContentMessage, parseRequest, success } from "../../src/extension/messages.js";

function code(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof CoreError) return error.code;
    throw error;
  }
  return "accepted";
}

describe("requests from extension pages", () => {
  it("accepts every request type with exactly its fields", () => {
    expect(parseRequest({ type: "candidates.get", tabId: 3 })).toEqual({ type: "candidates.get", tabId: 3 });
    expect(parseRequest({ type: "website.discover", url: "https://a.example/" })).toEqual({ type: "website.discover", url: "https://a.example/" });
    expect(parseRequest({ type: "package.open", url: "https://a.example/x.pkg" })).toEqual({ type: "package.open", url: "https://a.example/x.pkg", advertisedOn: null, viewId: null, foundVia: null });
    expect(parseRequest({ type: "package.open", url: "https://a.example/x.pkg", advertisedOn: "https://a.example/", viewId: "sidepanel:1" })).toEqual({
      type: "package.open",
      url: "https://a.example/x.pkg",
      advertisedOn: "https://a.example/",
      viewId: "sidepanel:1",
      foundVia: null,
    });
    expect(parseRequest({ type: "package.get", sessionId: "s1" })).toEqual({ type: "package.get", sessionId: "s1", viewId: null });
    expect(parseRequest({ type: "package.get", sessionId: "s1", viewId: "browser:1" })).toEqual({ type: "package.get", sessionId: "s1", viewId: "browser:1" });
    expect(parseRequest({ type: "package.release", sessionId: "s1", viewId: "browser:1" })).toEqual({ type: "package.release", sessionId: "s1", viewId: "browser:1" });
    expect(parseRequest({ type: "package.close", sessionId: "s1" })).toEqual({ type: "package.close", sessionId: "s1" });
    for (const type of ["sessions.list", "trust.list", "status.get"]) expect(parseRequest({ type })).toEqual({ type });
    expect(parseRequest({ type: "trust.pin", sessionId: "s1", signerFingerprint: "sha256:ab" })).toEqual({
      type: "trust.pin",
      sessionId: "s1",
      signerFingerprint: "sha256:ab",
      scope: "package",
    });
    expect(parseRequest({ type: "trust.pin", sessionId: "s1", signerFingerprint: "sha256:ab", scope: "publisher" })).toMatchObject({ scope: "publisher" });
    expect(parseRequest({ type: "trust.pinKey", publicKeyPem: "-----BEGIN PUBLIC KEY-----", displayName: "x" })).toEqual({
      type: "trust.pinKey",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----",
      displayName: "x",
      publisherId: null,
      packageIdPrefix: null,
    });
    expect(parseRequest({ type: "trust.unpin", fingerprint: "sha256:ab" })).toEqual({ type: "trust.unpin", fingerprint: "sha256:ab" });
  });

  it("search, indexes, the policy subscription and the Library (T8): exactly their fields, bounded", () => {
    expect(parseRequest({ type: "search.query", text: "literature review" })).toEqual({ type: "search.query", text: "literature review" });
    expect(code(() => parseRequest({ type: "search.query", text: "" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "search.query", text: "x".repeat(513) }))).toBe("invalid_request");
    for (const type of ["indexes.list", "policy.get", "policy.refresh", "policy.unsubscribe", "library.get"]) {
      expect(parseRequest({ type })).toEqual({ type });
      expect(code(() => parseRequest({ type, extra: 1 }))).toBe("invalid_request");
    }
    expect(parseRequest({ type: "indexes.add", url: "https://a.example/i.json", publicKeyPem: "PEM" })).toEqual({ type: "indexes.add", url: "https://a.example/i.json", publicKeyPem: "PEM" });
    expect(parseRequest({ type: "indexes.enable", url: "https://a.example/i.json", enabled: false })).toEqual({ type: "indexes.enable", url: "https://a.example/i.json", enabled: false });
    expect(code(() => parseRequest({ type: "indexes.enable", url: "https://a.example/i.json", enabled: "no" }))).toBe("invalid_request");
    expect(parseRequest({ type: "policy.subscribe", url: "https://a.example/p.json", publicKeyPem: "PEM" })).toEqual({ type: "policy.subscribe", url: "https://a.example/p.json", publicKeyPem: "PEM", replace: false });
    expect(parseRequest({ type: "library.pin", sessionId: "s1" })).toEqual({ type: "library.pin", sessionId: "s1" });
    expect(parseRequest({ type: "library.unpin", packageUrl: "https://a.example/x.pkg" })).toEqual({ type: "library.unpin", packageUrl: "https://a.example/x.pkg" });
    expect(parseRequest({ type: "package.open", url: "https://a.example/x.pkg", foundVia: { indexId: "org.example.index" } })).toMatchObject({ foundVia: { indexId: "org.example.index" } });
    expect(code(() => parseRequest({ type: "package.open", url: "https://a.example/x.pkg", foundVia: { indexId: "i", digest: "forged" } }))).toBe("invalid_request");
  });

  it("run.active (T5a, D-076): an optional page URL, bounded, and nothing else", () => {
    expect(parseRequest({ type: "run.active" })).toEqual({ type: "run.active", pageUrl: null });
    expect(parseRequest({ type: "run.active", pageUrl: null })).toEqual({ type: "run.active", pageUrl: null });
    expect(parseRequest({ type: "run.active", pageUrl: "https://a.example/" })).toEqual({ type: "run.active", pageUrl: "https://a.example/" });
    expect(code(() => parseRequest({ type: "run.active", pageUrl: "" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "run.active", pageUrl: 7 }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "run.active", pageUrl: `https://a.example/${"h".repeat(MAX_URL)}` }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "run.active", sessionId: "s1" }))).toBe("invalid_request");
  });

  it("refuses unknown types, unknown fields, empty or oversized strings and bad ids", () => {
    expect(code(() => parseRequest({ type: "package.run", sessionId: "s1" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "status.get", extra: 1 }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "package.get", sessionId: "" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "package.release", sessionId: "s1" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "package.close", sessionId: "s1", viewId: "x" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "package.get", sessionId: "s".repeat(201) }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "website.discover", url: `https://a.example/${"h".repeat(MAX_URL)}` }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "candidates.get", tabId: -1 }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "candidates.get", tabId: 1.5 }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "candidates.get", tabId: "7" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "trust.pin", sessionId: "s", signerFingerprint: "f", scope: "always" }))).toBe("invalid_request");
    expect(code(() => parseRequest({ type: "trust.pinKey", publicKeyPem: "k".repeat(16 * 1024 + 1), displayName: "x" }))).toBe("invalid_request");
    expect(code(() => parseRequest(null))).toBe("invalid_request");
    expect(code(() => parseRequest("status.get"))).toBe("invalid_request");
    expect(code(() => parseRequest([]))).toBe("invalid_request");
    expect(code(() => parseRequest({}))).toBe("invalid_request");
  });
});

describe("the one content-script message", () => {
  it("accepts bounded link reports and nothing else", () => {
    const links = [{ href: "/agent.pkg", type: "application/vnd.webagents.agent-package", title: null }];
    expect(parseContentMessage({ type: "content.links", links })).toEqual({ type: "content.links", links });
    expect(parseContentMessage({ type: "content.links", links: [] })).toEqual({ type: "content.links", links: [] });
    const long = parseContentMessage({ type: "content.links", links: [{ href: "x".repeat(MAX_URL + 50), type: null, title: null }] });
    expect(long.links[0]!.href!.length).toBe(MAX_URL);
    expect(code(() => parseContentMessage({ type: "status.get" }))).toBe("invalid_request");
    expect(code(() => parseContentMessage({ type: "candidates.get", tabId: 1 }))).toBe("invalid_request");
    expect(code(() => parseContentMessage({ type: "content.links", links: new Array(MAX_LINKS + 1).fill({ href: null, type: null, title: null }) }))).toBe(
      "invalid_request",
    );
    expect(code(() => parseContentMessage({ type: "content.links", links: [{ href: 5, type: null, title: null }] }))).toBe("invalid_request");
    expect(code(() => parseContentMessage({ type: "content.links", links: [{ href: "/a", rel: "agent-package" }] }))).toBe("invalid_request");
    expect(code(() => parseContentMessage({ type: "content.links", links: "none" }))).toBe("invalid_request");
    expect(code(() => parseContentMessage({ type: "content.links", links, url: "https://page.example/" }))).toBe("invalid_request");
  });
});

describe("responses", () => {
  it("carry stable codes and never an unexpected error's text", () => {
    expect(success({ a: 1 })).toEqual({ ok: true, result: { a: 1 } });
    expect(failure(new CoreError("url_rejected", "Only https", { details: { reason: "scheme" } }))).toEqual({
      ok: false,
      error: { code: "url_rejected", message: "Only https", details: { reason: "scheme" } },
    });
    expect(failure(new CoreError("session_unknown", "gone"))).toEqual({ ok: false, error: { code: "session_unknown", message: "gone" } });
    const leaked = failure(new Error("secret body text from a provider"));
    expect(leaked.ok).toBe(false);
    if (!leaked.ok) {
      expect(leaked.error.code).toBe("internal_error");
      expect(leaked.error.message).not.toContain("secret");
    }
  });

  it("recognizes only the worker's own broadcasts as events", () => {
    expect(isEvent({ type: "event.trust" })).toBe(true);
    expect(isEvent({ type: "event.candidates", tabId: 1 })).toBe(true);
    expect(isEvent({ type: "trust.list" })).toBe(false);
    expect(isEvent("event.trust")).toBe(false);
    expect(isEvent(null)).toBe(false);
  });
});
