/**
 * A small Markdown renderer for text a package produced.
 *
 * The input is untrusted: it is what a model wrote inside a downloaded
 * package's run. So this builds DOM nodes directly and every character of the
 * source reaches the document through `textContent`. There is no `innerHTML`,
 * no HTML pass-through (a `<script>` in the source is shown as the text
 * `<script>`), no images, and a link is live only for an `http(s)` URL, opened
 * in a new context with no referrer and no opener.
 *
 * Supported: ATX headings, paragraphs, emphasis, strong, inline code, fenced
 * code, block quotes, ordered and unordered lists, horizontal rules and links.
 * Anything else is text.
 */

const MAX_SOURCE = 512 * 1024;
const MAX_BLOCKS = 4000;
const MAX_DEPTH = 8;

function text(value: string): Text {
  return document.createTextNode(value);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function safeHref(raw: string): string | null {
  const candidate = raw.trim();
  if (!/^https?:\/\//iu.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Inline spans: code, strong, emphasis and links. Everything else is text. */
export function renderInline(source: string, depth = 0): DocumentFragment {
  const out = document.createDocumentFragment();
  if (depth > MAX_DEPTH) {
    out.append(text(source));
    return out;
  }
  let buffer = "";
  const flush = () => {
    if (buffer) out.append(text(buffer));
    buffer = "";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const rest = source.slice(index);
    if (char === "\\" && index + 1 < source.length && /[\\`*_[\]()#>+\-.!|~]/u.test(source[index + 1]!)) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const end = source.indexOf("`", index + 1);
      if (end > index) {
        flush();
        const code = element("code");
        code.textContent = source.slice(index + 1, end);
        out.append(code);
        index = end + 1;
        continue;
      }
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/u.exec(rest);
    if (strong) {
      flush();
      const node = element("strong");
      node.append(renderInline(strong[2]!, depth + 1));
      out.append(node);
      index += strong[0].length;
      continue;
    }
    const emphasis = /^(\*|_)(?=\S)([\s\S]+?)(?<=\S)\1(?![*_])/u.exec(rest);
    if (emphasis && (char === "*" || !/\w/u.test(source[index - 1] ?? ""))) {
      flush();
      const node = element("em");
      node.append(renderInline(emphasis[2]!, depth + 1));
      out.append(node);
      index += emphasis[0].length;
      continue;
    }
    const link = /^\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)/u.exec(rest);
    if (link) {
      flush();
      const href = safeHref(link[2]!);
      if (href) {
        const anchor = element("a", "ab-md-link");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer nofollow";
        anchor.referrerPolicy = "no-referrer";
        anchor.append(renderInline(link[1]!, depth + 1));
        out.append(anchor);
      } else {
        // Not a web link: keep the words, drop the target.
        out.append(renderInline(link[1]!, depth + 1));
      }
      index += link[0].length;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "rule" };

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const FENCE = /^(```|~~~)/u;
const QUOTE = /^>[ \t]?(.*)$/u;
const BULLET = /^[ \t]{0,3}[-*+][ \t]+(.*)$/u;
const ORDERED = /^[ \t]{0,3}(\d{1,9})[.)][ \t]+(.*)$/u;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line.trim());
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        body.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const items: string[] = [];
      const start = ordered ? Number(ordered[1]) : 1;
      while (index < lines.length) {
        const current = lines[index]!;
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        if (match) {
          items.push(isOrdered ? match[2]! : match[1]!);
          index += 1;
        } else if (current.trim() && /^[ \t]{2,}\S/u.test(current) && items.length > 0) {
          // A continuation line of the previous item.
          items[items.length - 1] += ` ${current.trim()}`;
          index += 1;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !HEADING.test(lines[index]!) &&
      !FENCE.test(lines[index]!.trim()) &&
      !QUOTE.test(lines[index]!) &&
      !BULLET.test(lines[index]!) &&
      !ORDERED.test(lines[index]!) &&
      !RULE.test(lines[index]!)
    ) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

/** Render untrusted Markdown into a detached element built without markup. */
export function renderMarkdown(source: string, depth = 0): HTMLElement {
  const root = element("div", "ab-markdown");
  const input = typeof source === "string" ? source.slice(0, MAX_SOURCE) : "";
  for (const block of parse(input)) {
    switch (block.kind) {
      case "heading": {
        // Nested under the page's own headings: # becomes h3, and so on.
        const level = Math.min(6, block.level + 2) as 3 | 4 | 5 | 6;
        const node = element(`h${level}`);
        node.append(renderInline(block.text));
        root.append(node);
        break;
      }
      case "paragraph": {
        const node = element("p");
        node.append(renderInline(block.text));
        root.append(node);
        break;
      }
      case "code": {
        const pre = element("pre", "ab-md-code");
        const code = element("code");
        code.textContent = block.text;
        pre.append(code);
        root.append(pre);
        break;
      }
      case "quote": {
        const quote = element("blockquote");
        quote.append(
          depth < MAX_DEPTH ? renderMarkdown(block.lines.join("\n"), depth + 1) : text(block.lines.join(" ")),
        );
        root.append(quote);
        break;
      }
      case "list": {
        const list = block.ordered ? element("ol") : element("ul");
        if (block.ordered && block.start !== 1) (list as HTMLOListElement).start = block.start;
        for (const item of block.items) {
          const li = element("li");
          li.append(renderInline(item));
          list.append(li);
        }
        root.append(list);
        break;
      }
      case "rule":
        root.append(element("hr"));
        break;
    }
  }
  if (input.length < (typeof source === "string" ? source.length : 0)) {
    const note = element("p", "ab-hint");
    note.textContent = "This document was shortened for display. Download it for the full text.";
    root.append(note);
  }
  return root;
}
