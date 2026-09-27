/**
 * The Markdown renderer for package-produced text.
 *
 * Its input is what a model wrote during a downloaded package's run, so the
 * properties that matter are negative ones: no element the source did not
 * earn, no live link that is not a web link, and every character as text.
 */
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderInline, renderMarkdown } from "../src/ui/markdown.js";

const tags = (node: Element) => [...node.querySelectorAll("*")].map((item) => item.tagName.toLowerCase());

describe("safe Markdown", () => {
  it("renders the structure a review uses", () => {
    const node = renderMarkdown(
      [
        "# Related Work",
        "",
        "## Network-layer detection",
        "The *guardrail* system uses **regex** and `ONNX` classifiers [1].",
        "",
        "- first",
        "- second",
        "",
        "1. one",
        "2. two",
        "",
        "> quoted *source*",
        "",
        "---",
        "```",
        "<b>code</b>",
        "```",
      ].join("\n"),
    );
    expect(node.querySelector("h3")?.textContent).toBe("Related Work");
    expect(node.querySelector("h4")?.textContent).toBe("Network-layer detection");
    expect(node.querySelector("em")?.textContent).toBe("guardrail");
    expect(node.querySelector("strong")?.textContent).toBe("regex");
    expect(node.querySelector("p code")?.textContent).toBe("ONNX");
    expect([...node.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["first", "second"]);
    expect([...node.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(node.querySelector("blockquote em")?.textContent).toBe("source");
    expect(node.querySelector("hr")).not.toBeNull();
    expect(node.querySelector("pre code")?.textContent).toBe("<b>code</b>");
    expect(node.textContent).toContain("[1]");
  });

  it("never turns source text into markup", () => {
    const node = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> <iframe src="https://x"></iframe>\n\n' +
        "<a href=\"javascript:alert(1)\">x</a> **<b>bold</b>**",
    );
    expect(tags(node).filter((tag) => ["script", "img", "iframe", "a", "b"].includes(tag))).toEqual([]);
    expect(node.textContent).toContain("<script>alert(1)</script>");
    expect(node.textContent).toContain("<b>bold</b>");
    for (const element of node.querySelectorAll("*")) {
      expect([...element.attributes].map((attr) => attr.name).filter((name) => name.startsWith("on"))).toEqual([]);
    }
  });

  it("makes only http(s) links live, with no opener and no referrer", () => {
    const node = renderMarkdown(
      "[web](https://example.org/a) [plain](http://example.org/b) [js](javascript:alert(1)) " +
        "[data](data:text/html,x) [file](file:///etc/passwd) [rel](/relative)",
    );
    const anchors = [...node.querySelectorAll("a")];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://example.org/a", "http://example.org/b"]);
    for (const anchor of anchors) {
      expect(anchor.target).toBe("_blank");
      expect(anchor.rel).toBe("noopener noreferrer nofollow");
    }
    // The words of a refused link stay; its target does not.
    expect(node.textContent).toContain("js");
    expect(node.textContent).not.toContain("javascript:");
    expect(node.textContent).not.toContain("file:///etc/passwd");
  });

  it("keeps intraword underscores and escapes literal", () => {
    const fragment = renderInline("snake_case_name and \\*not emphasis\\*");
    const holder = document.createElement("div");
    holder.append(fragment);
    expect(holder.querySelector("em")).toBeNull();
    expect(holder.textContent).toBe("snake_case_name and *not emphasis*");
  });

  it("bounds what it renders", () => {
    const huge = `${"word ".repeat(200_000)}`;
    const node = renderMarkdown(huge);
    expect(node.textContent!.length).toBeLessThanOrEqual(600 * 1024);
    expect(node.textContent).toContain("shortened for display");
  });

  it("is built from DOM calls only", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "src", "ui", "markdown.ts"), "utf8");
    expect(source).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write|DOMParser/u);
  });
});
