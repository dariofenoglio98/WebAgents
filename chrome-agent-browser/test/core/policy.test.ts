import { describe, expect, it } from "vitest";

import { CoreError } from "../../src/core/errors.js";
import { canonicalUrl, documentUrl, looksLikePackageUrl, origin, originText, validatePackageUrl } from "../../src/core/policy.js";
import { urlsplit, UrlSplitError } from "../../src/core/urls.js";

describe("urlsplit mirrors urllib.parse.urlsplit", () => {
  it("splits ordinary URLs", () => {
    const parts = urlsplit("HTTPS://User:Pw@Example.COM:443/a/b?q=1#frag");
    expect(parts.scheme).toBe("https");
    expect(parts.netloc).toBe("User:Pw@Example.COM:443");
    expect(parts.username).toBe("User");
    expect(parts.password).toBe("Pw");
    expect(parts.hostname).toBe("example.com");
    expect(parts.port).toBe(443);
    expect(parts.path).toBe("/a/b");
    expect(parts.query).toBe("q=1");
    expect(parts.fragment).toBe("frag");
  });

  it("keeps backslashes in the netloc and reports invalid ports instead of guessing", () => {
    expect(urlsplit("https://host\\evil.example/x").hostname).toBe("host\\evil.example");
    expect(urlsplit("https://example.com:port/").portError).toBe(true);
    expect(urlsplit("https://example.com:99999/").portError).toBe(true);
    expect(urlsplit("https://example.com:0/").port).toBe(0);
    expect(urlsplit("https://example.com:/").port).toBeNull();
    expect(() => urlsplit("https://[::1/agent.pkg")).toThrow(UrlSplitError);
    expect(urlsplit("https://[::1]:8443/x").hostname).toBe("::1");
    expect(urlsplit("https://[::1]:8443/x").port).toBe(8443);
    expect(urlsplit("relative/path.json").scheme).toBe("");
    expect(urlsplit("#/defs").fragment).toBe("/defs");
    expect(urlsplit("c:ommon.json").scheme).toBe("c");
    expect(urlsplit("1:x").scheme).toBe("");
    expect(urlsplit("\t https://a.b/\n").scheme).toBe("https");
    expect(urlsplit("https:///a.agent.pkg").hostname).toBeNull();
  });
});

describe("the package URL policy (test_browser_fetch.py::test_unsafe_url_syntax_is_refused and D-026)", () => {
  for (const url of [
    "http://example.com/a.agent.pkg",
    "file:///etc/passwd",
    "ftp://example.com/a.agent.pkg",
    "gopher://example.com/a",
    "/etc/passwd",
    "https://user:secret@example.com/a.agent.pkg",
    "https://example.com:8443/a.agent.pkg",
    "https://example.com/a.agent.pkg#fragment",
    "https://example.com/a\n.agent.pkg",
    "https:///a.agent.pkg",
    `https://${"a".repeat(300)}.com/a.agent.pkg`,
    "https://example.com:bad/a.agent.pkg",
    "https://example.com/a b.agent.pkg",
    "",
    `https://example.com/${"a".repeat(2100)}`,
    // Chrome line additions: no IP literals and no local names at the syntax stage.
    "https://127.0.0.1/a.agent.pkg",
    "https://93.184.216.34/a.agent.pkg",
    "https://[::1]/a.agent.pkg",
    "https://[2001:db8::1]/a.agent.pkg",
    "https://localhost/a.agent.pkg",
    "https://dev.localhost/a.agent.pkg",
    "https://printer.local/a.agent.pkg",
    // Review 1, finding 2: forms the WHATWG parser (and so Chrome) folds into an IP literal
    // or a local name, which `urlsplit` alone reads as ordinary DNS names.
    "https://2130706433/a.agent.pkg",
    "https://127.1/a.agent.pkg",
    "https://0x7f.1/a.agent.pkg",
    "https://0177.0.0.1/a.agent.pkg",
    "https://0x0a000001/a.agent.pkg",
    "https://1.2.3/a.agent.pkg",
    "https://%31%32%37.0.0.1/a.agent.pkg",
    "https://\uff11\uff12\uff17.\uff10.\uff10.\uff11/a.agent.pkg",
    "https://\uff4c\uff4f\uff43\uff41\uff4c\uff48\uff4f\uff53\uff54/a.agent.pkg",
    "https://169.254.169.254./a.agent.pkg",
    "https://127.0.0.1./a.agent.pkg",
    "https://[::ffff:127.0.0.1]/a.agent.pkg",
    "https://localhost./a.agent.pkg",
    "https://printer.local./a.agent.pkg",
    "https://ip6-localhost/a.agent.pkg",
    "https://127.0.0.1\\a.pkg/b.pkg",
    "https://webair.example\\@127.0.0.1/a.pkg",
    "https://999.1.1.1/a.agent.pkg",
    "https://foo.123/a.agent.pkg",
    // Review 2, nit 11: every trailing dot is stripped before the local-name test, and an
    // empty label anywhere else is not a DNS name.
    "https://localhost../a.agent.pkg",
    "https://printer.local.../a.agent.pkg",
    "https://a..example/a.agent.pkg",
    "https://.example.com/a.agent.pkg",
  ]) {
    it(`refuses ${JSON.stringify(url.slice(0, 60))}`, () => {
      const error = (() => {
        try {
          validatePackageUrl(url);
        } catch (caught) {
          return caught as CoreError;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(CoreError);
      expect(error?.code).toBe("url_rejected");
    });
  }

  it("accepts HTTPS on 443 and keeps the query string (test_accepted_url_syntax_keeps_the_query_string)", () => {
    expect(validatePackageUrl("https://example.com/pkg/a.agent.pkg?version=0.1.0")).toEqual({
      hostname: "example.com",
      target: "/pkg/a.agent.pkg?version=0.1.0",
    });
    expect(validatePackageUrl("https://Example.COM:443")).toEqual({ hostname: "example.com", target: "/" });
    expect(validatePackageUrl("https://webagents-webair-production.up.railway.app/", "Website").hostname).toBe(
      "webagents-webair-production.up.railway.app",
    );
  });

  it("names the subject in its messages, quoting as the reference does", () => {
    expect(() => validatePackageUrl("http://x.example/", "Website")).toThrow(/Only https:\/\/ website URLs are accepted; refused scheme 'http'/u);
    expect(() => validatePackageUrl("x.example/a.pkg")).toThrow(/refused scheme 'none'/u);
    expect(() => validatePackageUrl(42)).toThrow(/Package URL must be a string/u);
  });

  it("judges the host Chrome will connect to, not only the urlsplit host (D-039)", () => {
    expect(() => validatePackageUrl("https://127.1/a.agent.pkg")).toThrow(/IP literal/u);
    expect(() => validatePackageUrl("https://2130706433/a.agent.pkg")).toThrow(/IP literal/u);
    expect(() => validatePackageUrl("https://localhost./a.agent.pkg")).toThrow(/local host/u);
    expect(() => validatePackageUrl("https://127.0.0.1\\a.pkg/b.pkg")).toThrow(/backslash/u);
    expect(() => validatePackageUrl("https://%31%32%37.0.0.1/a.agent.pkg")).toThrow(/IP literal/u);
    expect(() => validatePackageUrl("https://a%2eb.example/a.agent.pkg")).toThrow(/browser would connect to 'a.b.example'/u);
    // DNS names Chrome and the reference read alike are accepted: trailing dot, mixed case, IDN.
    expect(validatePackageUrl("https://webair.example./a.agent.pkg").hostname).toBe("webair.example.");
    expect(validatePackageUrl("https://b\u00fccher.example/a.agent.pkg").hostname).toBe("b\u00fccher.example");
    expect(validatePackageUrl("https://127.0.0.1.example/a.agent.pkg").hostname).toBe("127.0.0.1.example");
    expect(validatePackageUrl("https://localhost.example/a.agent.pkg").hostname).toBe("localhost.example");
    expect(() => validatePackageUrl("https://localhost../a.agent.pkg")).toThrow(/local host/u);
    expect(() => validatePackageUrl("https://a..example/a.agent.pkg")).toThrow(/empty label/u);
    // One trailing dot is a fully qualified name and stays accepted.
    expect(validatePackageUrl("https://example.com./a.agent.pkg").hostname).toBe("example.com.");
  });
});

describe("origins and canonical forms (discovery.py)", () => {
  it("computes origins with effective ports", () => {
    expect(origin("https://Airline.Example/travel/")).toEqual(["https", "airline.example", 443]);
    expect(origin("http://airline.example/")).toEqual(["http", "airline.example", 80]);
    expect(origin("https://airline.example:8443/")).toEqual(["https", "airline.example", 8443]);
    expect(origin("ftp://airline.example/")).toBeNull();
    expect(origin("https://airline.example:port/")).toBeNull();
    expect(origin("mailto:ops@airline.example")).toBeNull();
    expect(originText(["https", "airline.example", 443])).toBe("https://airline.example");
    expect(originText(["https", "airline.example", 8443])).toBe("https://airline.example:8443");
    expect(originText(["https", "::1", 443])).toBe("https://[::1]");
  });

  it("canonicalizes URLs: lowercase host, default port dropped, fragment removed", () => {
    expect(canonicalUrl("HTTPS://Airline.Example:443/agent.pkg?v=1#x")).toBe("https://airline.example/agent.pkg?v=1");
    expect(canonicalUrl("https://airline.example")).toBe("https://airline.example/");
    expect(canonicalUrl("not a url")).toBe("not a url");
  });

  it("documentUrl drops a fragment but applies the package policy otherwise", () => {
    expect(documentUrl("https://Airline.Example/travel/#top")).toBe("https://airline.example/travel/");
    expect(() => documentUrl("http://airline.example/")).toThrow(CoreError);
    expect(() => documentUrl("https://airline.example/#bad\nfragment")).toThrow(/whitespace or control bytes/u);
    expect(() => documentUrl("https://airline.example/x y")).toThrow(CoreError);
  });

  it("decides between a package address and a website address by the last path segment", () => {
    expect(looksLikePackageUrl("https://airline.example/agent.pkg")).toBe(true);
    expect(looksLikePackageUrl("https://airline.example/dist/webair-0.3.0.agent.PKG?x=1")).toBe(true);
    expect(looksLikePackageUrl("https://airline.example/")).toBe(false);
    expect(looksLikePackageUrl("https://airline.example/agent.pkg/")).toBe(false);
    expect(looksLikePackageUrl("https://airline.example/flights")).toBe(false);
  });
});
