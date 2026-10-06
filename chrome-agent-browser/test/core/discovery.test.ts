import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyCandidate,
  classifyLinks,
  discoverFromPage,
  PACKAGE_MEDIA_TYPE,
  REJECTION_REASONS,
  scanHead,
  type FetchedPage,
} from "../../src/core/discovery.js";
import { CoreError } from "../../src/core/errors.js";
import { ROOT } from "../helpers/paths.js";

const encoder = new TextEncoder();

/** A small, ordinary HTML document (test_browser_discovery.py::page). */
function page(head = "", body = "<p>Hello.</p>"): string {
  return `<!doctype html>\n<html lang=en>\n<head>\n<meta charset=utf-8>\n<title>Example</title>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

function link(href = "/agent.pkg", options: { rel?: string; type?: string | null } = {}): string {
  const kind = options.type !== undefined && options.type !== null ? ` type="${options.type}"` : "";
  return `<link rel="${options.rel ?? "agent-package"}"${kind} href="${href}">`;
}

function scan(html: string | Uint8Array, options: { charset?: string | null; complete?: boolean } = {}) {
  const body = typeof html === "string" ? encoder.encode(html) : html;
  return scanHead(body, { httpCharset: options.charset === undefined ? "utf-8" : options.charset, complete: options.complete ?? true, maxLinks: 16 });
}

function hrefs(html: string | Uint8Array, options: { charset?: string | null; complete?: boolean } = {}): Array<string | null> {
  return scan(html, options).links.map((item) => item.href);
}

describe("1. which links count: the document head, by the HTML parsing rules", () => {
  for (const markup of [
    '<link rel="agent-package" href="/agent.pkg">',
    "<link href='/agent.pkg' rel='agent-package'>",
    "<link rel=agent-package href=/agent.pkg>",
    '<LINK REL="Agent-Package" HREF="/agent.pkg">',
    '<link\n\trel="agent-package"\n   href="/agent.pkg"\n/>',
    '<link rel="stylesheet agent-package" href="/agent.pkg">',
    '<link rel=" \tAGENT-PACKAGE\n  alternate " href="/agent.pkg">',
    '<link rel="agent&#45;package" href="/agent.pkg">',
    `<link href="/agent.pkg" type="${PACKAGE_MEDIA_TYPE}" rel="agent-package">`,
  ]) {
    it(`recognizes ${JSON.stringify(markup)}`, () => {
      expect(hrefs(page(markup))).toEqual(["/agent.pkg"]);
    });
  }

  for (const markup of [
    '<link rel="agent-packages" href="/x.pkg">',
    '<link rel="agentpackage" href="/x.pkg">',
    '<link rel="agent-package stylesheet" href="/x.pkg">',
    '<link rel="agent-pacKge" href="/x.pkg">',
    '<link rel href="/x.pkg">',
    '<link href="/x.pkg">',
    '<meta name="agent-package" content="/x.pkg">',
  ]) {
    it(`does not mistake ${JSON.stringify(markup)} for an advertisement`, () => {
      expect(hrefs(page(markup))).toEqual([]);
    });
  }

  it("the first of duplicated attributes wins, as in HTML", () => {
    expect(hrefs(page('<link rel="agent-package" href="/first.pkg" href="https://evil.example/x">'))).toEqual(["/first.pkg"]);
    expect(hrefs(page('<link rel="stylesheet" rel="agent-package" href="/x.pkg">'))).toEqual([]);
  });

  for (const markup of [
    "<script>document.write('<link rel=agent-package href=/s.pkg>')</script>",
    '<script type="text/template"><link rel="agent-package" href="/s.pkg"></script>',
    "<script/><link rel=agent-package href=/s.pkg></script>",
    "<style>/* <link rel=agent-package href=/s.pkg> */</style>",
    "<title>Deals <link rel=agent-package href=/s.pkg></title>",
    "<!-- <link rel=agent-package href=/s.pkg> -->",
    "<template><link rel=agent-package href=/s.pkg></template>",
    "<template><template></template><link rel=agent-package href=/s.pkg></template>",
    "<template><title></template><link rel=agent-package href=/s.pkg></title></template>",
    "<template><textarea></template><link rel=agent-package href=/s></textarea></template>",
    "<noframes><link rel=agent-package href=/s.pkg></noframes>",
  ]) {
    it(`text, comments and templates hold no advertisement: ${JSON.stringify(markup.slice(0, 50))}`, () => {
      expect(hrefs(page(markup + link("/real.pkg")))).toEqual(["/real.pkg"]);
    });
  }

  it("plaintext inside a template never ends", () => {
    expect(hrefs(`<html><head><template><plaintext></plaintext></template>${link("/after.pkg")}`)).toEqual([]);
  });

  it("a declared charset is echoed only as escaped text", () => {
    const body = new Uint8Array([...encoder.encode('<head><meta charset="'), 0xe2, 0x80, 0xae, ...encoder.encode(`utf-8">${link()}`)]);
    const result = scan(body, { charset: null });
    expect(result.declared_charset).toBe("\\u00e2\\u0080\\u00aeutf-8");
    expect(result.links.map((item) => item.href)).toEqual(["/agent.pkg"]);
  });

  it("only the document head is searched", () => {
    const result = scan(page(link("/head.pkg"), `${link("/body.pkg")}<p>text</p>${link("/later.pkg")}`));
    expect(result.links.map((item) => item.href)).toEqual(["/head.pkg"]);
    expect(result.head_ended).toBe(true);
  });

  for (const opener of ["<body>", "<div>", "<img src=/pixel.png>", "<svg>", "<frameset>", "<textarea>", "Plain text", "&nbsp;", "\u0000", "</body>", "</html>", "</br>"]) {
    it(`the head ends where the tree builder ends it: ${JSON.stringify(opener)}`, () => {
      const result = scan(`<!doctype html><html><head>${link("/before.pkg")}${opener}${link("/after.pkg")}`);
      expect(result.links.map((item) => item.href)).toEqual(["/before.pkg"]);
      expect(result.head_ended).toBe(true);
    });
  }

  it("a link between head and body is still placed in the head", () => {
    expect(hrefs(`<html><head><title>x</title></head>\n${link("/between.pkg")}\n<body>${link("/b.pkg")}`)).toEqual(["/between.pkg"]);
  });

  it("head content and whitespace keep the head open", () => {
    const html =
      "\n<!doctype html>\n<!-- comment --><?xml-stylesheet x?>\n<html lang=en>\n <head>\n" +
      "  <meta charset=utf-8><base target=_self><meta name=viewport content=x>\n" +
      "  <noscript><style>p {}</style></noscript>\n  <script src=/app.js></script>\n" +
      "  <link rel=stylesheet href=/site.css><link rel=icon href=/favicon.ico>\n" +
      `  <title>Shop</title>\n  </div>\n${link("/x.pkg")}`;
    const result = scan(html);
    expect(result.links.map((item) => item.href)).toEqual(["/x.pkg"]);
    expect(result.head_ended).toBe(false); // The document ended inside its head.
  });

  it("a noscript after the head opens the body", () => {
    expect(hrefs(`<head></head><noscript></noscript>${link("/x.pkg")}`)).toEqual([]);
  });

  it("a base element is noticed and never used", () => {
    const result = scan(page(`<base href="https://evil.example/">${link("agent.pkg")}`));
    expect(result.base_href).toBe(true);
    expect(result.links.map((item) => item.href)).toEqual(["agent.pkg"]);
  });

  for (const [html, expected] of [
    ['<head><link rel="agent-package href=/x.pkg>\n<body>', []],
    ["<head><link rel=agent-package href=/x.pkg", []],
    [`<head><<<>>>${link("/x.pkg")}`, []],
    [`<head></div></span></p>${link("/x.pkg")}`, ["/x.pkg"]],
    [`<head><title>never closed${link("/x.pkg")}`, []],
    [`<head><template>${link("/x.pkg")}`, []],
    [`<head><!-- never closed ${link("/x.pkg")}`, []],
    [`<head><script>${link("/x.pkg")}`, []],
    ["<head><link rel='agent-package' href='/x.pkg'\"\">", ["/x.pkg"]],
  ] as Array<[string, string[]]>) {
    it(`malformed html neither raises nor invents a link: ${JSON.stringify(html.slice(0, 40))}`, () => {
      expect(hrefs(html)).toEqual(expected);
    });
  }

  it("arbitrary bytes never escape the parser", () => {
    let seed = 20261002;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pieces = ["<", ">", "</", "<!--", "-->", '"', "'", "=", "&", "#", ";", "head", "link", "rel", "href", "agent-package", "/", " ", "\n", "template", "script", "\u0000", "é", "<![CDATA[", "<?", "!"];
    for (let round = 0; round < 300; round += 1) {
      let html = "";
      const count = 1 + Math.floor(random() * 40);
      for (let index = 0; index < count; index += 1) html += pieces[Math.floor(random() * pieces.length)];
      expect(() => scan(html)).not.toThrow();
      expect(() => scan(encoder.encode(html).subarray(0, Math.floor(random() * html.length)), { complete: false })).not.toThrow();
    }
  });

  it("the link count is bounded", () => {
    const many = Array.from({ length: 20 }, (_, index) => link(`/p${index}.pkg`)).join("");
    const result = scan(page(many));
    expect(result.links).toHaveLength(16);
    expect(result.overflow).toBe(4);
  });
});

describe("2. character encodings", () => {
  it("a UTF-8 byte-order mark is consumed", () => {
    const result = scan(new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(page(link()))]), { charset: null });
    expect(result.codec).toBe("utf-8");
    expect(result.encoding_source).toBe("bom");
    expect(result.links.map((item) => item.href)).toEqual(["/agent.pkg"]);
  });

  for (const codec of ["utf-16le", "utf-16be"] as const) {
    it(`${codec} pages with a byte-order mark are decoded`, () => {
      const text = page(link());
      const bytes = new Uint8Array(2 + text.length * 2);
      bytes.set(codec === "utf-16le" ? [0xff, 0xfe] : [0xfe, 0xff], 0);
      for (let index = 0; index < text.length; index += 1) {
        const unit = text.charCodeAt(index);
        const position = 2 + index * 2;
        if (codec === "utf-16le") {
          bytes[position] = unit & 0xff;
          bytes[position + 1] = unit >> 8;
        } else {
          bytes[position] = unit >> 8;
          bytes[position + 1] = unit & 0xff;
        }
      }
      const result = scan(bytes, { charset: null });
      expect(result.codec).toBe(codec);
      expect(result.links.map((item) => item.href)).toEqual(["/agent.pkg"]);
    });
  }

  it("UTF-16 declared by HTTP is decoded as UTF-16, but a meta declaration cannot switch to it", () => {
    const text = page(link());
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index * 2] = text.charCodeAt(index) & 0xff;
      bytes[index * 2 + 1] = text.charCodeAt(index) >> 8;
    }
    const result = scan(bytes, { charset: "UTF-16LE" });
    expect(result.codec).toBe("utf-16le");
    expect(result.encoding_source).toBe("http");
    expect(result.links.map((item) => item.href)).toEqual(["/agent.pkg"]);
    const meta = scan(`<head><meta charset="utf-16">${link()}`, { charset: null });
    expect(meta.codec).toBe("utf-8");
    expect(meta.declared_charset).toBe("utf-16");
    expect(meta.encoding_source).toBe("meta");
  });

  it("a meta declaration is found by the prescan", () => {
    const first = scan(`<head><meta charset="ISO-8859-1">${link()}`, { charset: null });
    expect(first.declared_charset).toBe("iso-8859-1");
    expect(first.encoding_source).toBe("meta");
    const second = scan(`<head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252">${link()}`, { charset: null });
    expect(second.declared_charset).toBe("windows-1252");
    expect(second.codec).toBe("utf-8");
    expect(second.links.map((item) => item.href)).toEqual(["/agent.pkg"]);
  });

  for (const label of ["iso-2022-jp", "csISO2022JP", "hz-gb-2312", "replacement", "iso-2022-kr"]) {
    it(`refuses the ${label} encoding`, () => {
      const error = (() => {
        try {
          scan(page(link()), { charset: label });
        } catch (caught) {
          return caught as CoreError;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(CoreError);
      expect(error?.code).toBe("discovery_encoding_unsupported");
    });
  }

  for (const label of ["windows-1252", "shift_jis", "euc-kr", "gbk", "x-user-defined", "koi8-r"]) {
    it(`ASCII markup reads the same under ${label}`, () => {
      expect(hrefs(page(link()), { charset: label })).toEqual(["/agent.pkg"]);
    });
  }

  it("invalid bytes are replaced, not fatal", () => {
    const body = new Uint8Array([...encoder.encode("<head><title>"), 0xff, 0xfe, 0xc3, ...encoder.encode(`</title>${link()}`)]);
    expect(hrefs(body)).toEqual(["/agent.pkg"]);
  });

  it("a truncated page is trusted only where its head ended", () => {
    const cut = scan(encoder.encode('<head><title>t</title><link rel="agent-package" href="/agent.pk'), { complete: false });
    expect(cut.links).toEqual([]);
    expect(cut.head_ended).toBe(false);
    const half = scan(encoder.encode("<head><title>é").subarray(0, encoder.encode("<head><title>é").length - 1), { complete: false });
    expect(half.head_ended).toBe(false);
    const ended = scan(encoder.encode(`<head>${link("/a.pkg")}<body><p>cut off`), { complete: false });
    expect(ended.links.map((item) => item.href)).toEqual(["/a.pkg"]);
    expect(ended.head_ended).toBe(true);
  });
});

describe("3. candidates: resolution and the same-origin profile", () => {
  const PAGE = "https://airline.example/travel/";

  for (const [href, expected] of [
    ["/agent.pkg", "https://airline.example/agent.pkg"],
    ["agents/current.agent.pkg", "https://airline.example/travel/agents/current.agent.pkg"],
    ["../agent.pkg", "https://airline.example/agent.pkg"],
    ["https://airline.example/agent.pkg", "https://airline.example/agent.pkg"],
    ["https://airline.example:443/agent.pkg", "https://airline.example/agent.pkg"],
    ["HTTPS://AIRLINE.EXAMPLE/agent.pkg", "https://airline.example/agent.pkg"],
    ["//airline.example/agent.pkg", "https://airline.example/agent.pkg"],
    ["https:agent.pkg", "https://airline.example/travel/agent.pkg"],
    ["  /agent.pkg\n", "https://airline.example/agent.pkg"],
    ["/agent.pkg?version=0.1.0", "https://airline.example/agent.pkg?version=0.1.0"],
  ]) {
    it(`resolves ${JSON.stringify(href)} like a browser`, () => {
      const candidate = classifyCandidate(0, { href, type: null }, PAGE);
      expect(candidate.accepted, JSON.stringify(candidate)).toBe(true);
      expect(candidate.same_origin).toBe(true);
      expect(candidate.resolved_url).toBe(expected);
    });
  }

  for (const [href, reason] of [
    [null, "href_missing"],
    ["", "href_empty"],
    [" \t\n", "href_empty"],
    ["#agent", "fragment_only"],
    ["#", "fragment_only"],
    ["/agent.pkg#v1", "fragment_not_allowed"],
    ["javascript:alert(1)", "unsupported_scheme"],
    ["data:application/zip;base64,UEsDBA==", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["ftp://airline.example/agent.pkg", "unsupported_scheme"],
    ["mailto:ops@airline.example", "unsupported_scheme"],
    ["blob:https://airline.example/0b8f", "unsupported_scheme"],
    ["https://user:secret@airline.example/agent.pkg", "credentials_not_allowed"],
    ["https://user@airline.example/agent.pkg", "credentials_not_allowed"],
    ["https://evil.example/agent.pkg", "cross_origin"],
    ["//evil.example/agent.pkg", "cross_origin"],
    ["https://sub.airline.example/agent.pkg", "cross_origin"],
    ["https://airline.example./agent.pkg", "cross_origin"],
    ["http://airline.example/agent.pkg", "cross_origin"],
    ["https://airline.example:8443/agent.pkg", "cross_origin"],
    ["https://airline.example:0/agent.pkg", "cross_origin"],
    ["/agent pkg", "href_malformed"],
    ["/\\evil.example/agent.pkg", "href_malformed"],
    ["/agent.pkg\u0000", "href_malformed"],
    ["/café.pkg", "href_malformed"],
    [`/${"a".repeat(2100)}`, "href_malformed"],
    ["https://[::1/agent.pkg", "href_malformed"],
    ["https://airline.example:99999/agent.pkg", "href_malformed"],
    ["https://airline.example:port/agent.pkg", "href_malformed"],
    [".", "points_to_page"],
    ["/travel/", "points_to_page"],
  ] as Array<[string | null, string]>) {
    it(`rejects ${JSON.stringify(href?.slice(0, 40))} as ${reason}`, () => {
      const candidate = classifyCandidate(0, { href, type: null }, PAGE);
      expect(candidate.accepted).toBe(false);
      expect(candidate.rejection_reason).toBe(reason);
      expect(REJECTION_REASONS).toContain(reason);
      expect(candidate.rejection_message).toBeTruthy();
    });
  }

  for (const [href, component] of [
    ["https://evil.example/agent.pkg", "host"],
    ["http://airline.example/agent.pkg", "scheme"],
    ["https://airline.example:8443/agent.pkg", "port"],
  ]) {
    it(`a cross-origin rejection names what differs: ${component}`, () => {
      const candidate = classifyCandidate(0, { href: href!, type: null }, PAGE);
      expect(candidate.same_origin).toBe(false);
      expect(candidate.rejection_message).toContain(`different ${component}`);
      expect(candidate.rejection_message).toContain("https://airline.example");
    });
  }

  it("a resolved URL beyond the package URL limit is rejected", () => {
    const longPage = `https://airline.example/${"p/".repeat(990)}`;
    const candidate = classifyCandidate(0, { href: "a".repeat(60), type: null }, longPage);
    expect(candidate.rejection_reason).toBe("url_rejected");
  });

  for (const [type, ok] of [
    [null, true],
    ["", true],
    [PACKAGE_MEDIA_TYPE, true],
    ["Application/VND.WebAgents.Agent-Package", true],
    [`${PACKAGE_MEDIA_TYPE}; version=0.1`, true],
    ["text/html", false],
    ["application/zip", false],
    ["application/octet-stream", false],
  ] as Array<[string | null, boolean]>) {
    it(`the type hint is a hint: ${JSON.stringify(type)}`, () => {
      const candidate = classifyCandidate(0, { href: "/agent.pkg", type }, PAGE);
      expect(candidate.accepted).toBe(ok);
      if (!ok) expect(candidate.rejection_reason).toBe("unsupported_type");
    });
  }

  it("untrusted href text is shown escaped", () => {
    const candidate = classifyCandidate(0, { href: "/agent‮gkp.exe", type: null }, PAGE);
    expect(candidate.rejection_reason).toBe("href_malformed");
    expect(candidate.href).toBe("/agent\\u202egkp.exe");
  });

  it("the same URL advertised twice is listed once", () => {
    const result = classifyLinks([{ href: "/agent.pkg", type: null }, { href: "./agent.pkg", type: null }, { href: "/other.pkg", type: null }], "https://airline.example/");
    expect(result.candidates.map((candidate) => candidate.rejection_reason)).toEqual([null, "duplicate", null]);
    expect(result.status).toBe("multiple_candidates");
  });
});

describe("4. WebAir's own pages (examples/webair-site.json)", () => {
  type Site = { origin: string; agent_package: { path: string; media_type: string }; pages: Array<{ path: string; content_type: string; html: string }> };
  const site = JSON.parse(readFileSync(join(ROOT, "examples", "webair-site.json"), "utf8")) as Site;

  function fetched(path: string): FetchedPage {
    const entry = site.pages.find((item) => item.path === path)!;
    const [, parameters] = entry.content_type.split(";");
    return {
      requested_url: `${site.origin}${path}`,
      final_url: `${site.origin}${path}`,
      redirects: [],
      content_type: entry.content_type,
      charset: parameters?.trim().replace(/^charset=/u, "") ?? null,
      content_coding: "identity",
      body: encoder.encode(entry.html),
      truncated: false,
    };
  }

  it("the home page advertises its package", async () => {
    const result = await discoverFromPage(fetched("/"));
    expect(result.schema).toBe("agentpkg-website-discovery-v0");
    expect(result.discovery_status).toBe("candidate");
    expect(result.page_origin).toBe("https://webair.example");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      index: 0,
      href: "/agent.pkg",
      type_hint: PACKAGE_MEDIA_TYPE,
      resolved_url: `${site.origin}${site.agent_package.path}`,
      same_origin: true,
      accepted: true,
      rejection_reason: null,
    });
    expect(result.trust).toEqual({
      conveys: "location_only",
      package_verified: false,
      publisher_trusted: false,
      permissions_granted: false,
      note: expect.stringContaining("untrusted candidate"),
    });
    expect(result.execution.performed).toBe(false);
    expect(result.execution.package_fetched).toBe(false);
    expect(result.page.html_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.page.decoded_as).toBe("utf-8");
    expect(result.page.head_ended).toBe(true);
    expect(result.page.base_element_ignored).toBe(false);
  });

  it("every captured page resolves to the same package or advertises nothing", async () => {
    for (const entry of site.pages) {
      const result = await discoverFromPage(fetched(entry.path));
      const accepted = result.candidates.filter((candidate) => candidate.accepted).map((candidate) => candidate.resolved_url);
      expect(accepted.length <= 1, entry.path).toBe(true);
      if (accepted.length === 1) expect(accepted[0]).toBe(`${site.origin}${site.agent_package.path}`);
    }
  });

  it("an ordinary website advertises nothing, and a non-HTML answer is refused", async () => {
    const plain = { ...fetched("/"), body: encoder.encode(page()), final_url: "https://news.example/", requested_url: "https://news.example/" };
    const result = await discoverFromPage(plain);
    expect(result.discovery_status).toBe("no_candidate");
    expect(result.candidates).toEqual([]);
    const binary = { ...plain, content_type: "application/octet-stream" };
    const error = await discoverFromPage(binary).catch((caught: unknown) => caught as CoreError);
    expect((error as CoreError).code).toBe("discovery_not_html");
    expect((error as CoreError).details.content_type).toBe("application/octet-stream");
  });

  it("a cross-origin advertisement is reported and never accepted", async () => {
    const html = page(link("https://cdn.example/agent.pkg"));
    const result = await discoverFromPage({ ...fetched("/"), body: encoder.encode(html) });
    expect(result.discovery_status).toBe("candidates_rejected");
    expect(result.candidates[0]?.rejection_reason).toBe("cross_origin");
    expect(result.accepted_count).toBe(0);
    expect(result.rejected_count).toBe(1);
  });

  it("a page whose head does not end within the cap is refused", async () => {
    const huge = { ...fetched("/"), body: encoder.encode(`<head><title>${"x".repeat(100)}`), truncated: true };
    const error = await discoverFromPage(huge).catch((caught: unknown) => caught as CoreError);
    expect((error as CoreError).code).toBe("discovery_too_large");
    expect((error as CoreError).status).toBe(413);
  });
});
