/**
 * The content script (D-026) reads only `link` elements of the document head whose `rel`
 * tokens include `agent-package`, reports at most 16, and touches nothing else. The
 * documents are parsed by an explicit happy-dom window with resource loading disabled, so
 * the captured page's stylesheet link never becomes a network request.
 */
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { collectLinks } from "../../src/extension/content/content-script.js";
import { PACKAGE_MEDIA_TYPE, webairSite } from "../helpers/shell.js";

const window = new Window({
  url: "https://webair.example/",
  settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableComputedStyleRendering: true },
});

function parse(html: string): Document {
  return new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
}

describe("the content script's link collection", () => {
  it("reports WebAir's advertised package from the captured page", () => {
    const page = webairSite().pages[0]!;
    expect(collectLinks(parse(page.html))).toEqual([{ href: "/agent.pkg", type: PACKAGE_MEDIA_TYPE, title: null }]);
  });

  it("matches rel tokens case-insensitively among others, and ignores links outside the head", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/style.css">
      <link rel="prefetch Agent-Package" href="/one.pkg" title="One">
      <link rel="agent-packages" href="/not.pkg">
      <link rel="agent-package" type="${PACKAGE_MEDIA_TYPE}" href="/two.pkg">
      <link rel="agent-package">
    </head><body>
      <link rel="agent-package" href="/body.pkg">
      <a rel="agent-package" href="/anchor.pkg">x</a>
    </body></html>`;
    expect(collectLinks(parse(html))).toEqual([
      { href: "/one.pkg", type: null, title: "One" },
      { href: "/two.pkg", type: PACKAGE_MEDIA_TYPE, title: null },
      { href: null, type: null, title: null },
    ]);
  });

  it("stops at sixteen links and reports nothing for a page without a head", () => {
    const many = Array.from({ length: 20 }, (_, index) => `<link rel="agent-package" href="/p${index}.pkg">`).join("");
    expect(collectLinks(parse(`<html><head>${many}</head><body></body></html>`))).toHaveLength(16);
    const headless = window.document.implementation.createDocument(null, null);
    expect(collectLinks(headless as unknown as Document)).toEqual([]);
  });
});
