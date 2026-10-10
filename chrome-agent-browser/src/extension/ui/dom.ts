/**
 * Minimal DOM helpers.
 *
 * Copied from `openclaw-agent-browser/src/ui/dom.ts` (the frozen reference plugin, D-029)
 * with the focus-preserving `clear`/`replace` kept and the class prefix unchanged, so the
 * two shells share one vocabulary. Never imported across the two projects.
 *
 * Every string that originates in a package — names, descriptions, domains, warning
 * messages — reaches the document through `textContent` only. There is no `innerHTML`
 * anywhere in this extension's browser code, so package-provided text can never become
 * markup.
 */

export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    title?: string;
    attrs?: Record<string, string>;
  } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  append(node, children);
  return node;
}

export function append(parent: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

type Mark = { tag: string; signature: string; index: number };
type Place = { focused: Mark | null; caret: [number, number] | null; open: Mark[] };

/** Where the caret is in a text field, or null (a checkbox, a button, a field with no selection). */
function caretOf(node: Element): [number, number] | null {
  if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) return null;
  try {
    return node.selectionStart === null || node.selectionEnd === null ? null : [node.selectionStart, node.selectionEnd];
  } catch {
    return null;
  }
}

function signature(node: Element): string {
  const label =
    node instanceof HTMLDetailsElement
      ? ([...node.children].find((child) => child.tagName === "SUMMARY")?.textContent ?? "")
      : (node.textContent ?? "");
  return [
    node.getAttribute("type"),
    node.getAttribute("name"),
    node.getAttribute("value"),
    node.getAttribute("role"),
    node.getAttribute("aria-label"),
    label.trim(),
  ].join("\u0000");
}

function mark(region: HTMLElement, node: Element): Mark {
  const tag = node.tagName.toLowerCase();
  const own = signature(node);
  let index = 0;
  for (const candidate of region.querySelectorAll(tag)) {
    if (candidate === node) break;
    if (signature(candidate) === own) index += 1;
  }
  return { tag, signature: own, index };
}

function find(region: HTMLElement, target: Mark): HTMLElement | null {
  let index = 0;
  for (const candidate of region.querySelectorAll<HTMLElement>(target.tag)) {
    if (signature(candidate) !== target.signature) continue;
    if (index === target.index) return candidate;
    index += 1;
  }
  return null;
}

function leave(region: HTMLElement): Place | null {
  const open = [...region.querySelectorAll("details[open]")].map((node) => mark(region, node));
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement && active !== region && region.contains(active) ? mark(region, active) : null;
  const caret = focused ? caretOf(active as HTMLElement) : null;
  if (focused) (active as HTMLElement).blur();
  return focused || open.length > 0 ? { focused, caret, open } : null;
}

function restore(region: HTMLElement, place: Place): void {
  if (!region.isConnected) return;
  for (const target of place.open) {
    const node = find(region, target);
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  if (!place.focused) return;
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) return;
  const node = find(region, place.focused);
  if (!node || (node as HTMLButtonElement).disabled) return;
  node.focus({ preventScroll: true });
  // The caret stays where it was in a field being typed into (T14 review 1, finding 2).
  if (place.caret && caretOf(node)) (node as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(...place.caret);
}

/** Empty a region that is about to be rebuilt, keeping the person's place. */
export function clear(node: HTMLElement): void {
  const place = leave(node);
  node.replaceChildren();
  if (place) queueMicrotask(() => restore(node, place));
}

/** Replace a region's content as one unit. */
export function replace(node: HTMLElement, children: Child[]): void {
  clear(node);
  append(node, children);
}

export function row(label: string, ...value: Child[]): HTMLElement {
  return el(
    "div",
    { className: "ab-row" },
    el("span", { className: "ab-row-label", text: label }),
    el("span", { className: "ab-row-value" }, ...value),
  );
}

export function chip(text: string, tone: "neutral" | "good" | "warn" | "bad" = "neutral"): HTMLElement {
  return el("span", { className: `ab-chip ab-chip-${tone}`, text });
}

export function card(title: string, ...children: Child[]): HTMLElement {
  return el("section", { className: "ab-card" }, el("h2", { className: "ab-card-title", text: title }), ...children);
}

export function list(items: readonly Child[], className = "ab-list"): HTMLElement {
  const node = el("ul", { className });
  for (const item of items) {
    if (item === null || item === undefined || item === false) continue;
    node.append(el("li", {}, item));
  }
  return node;
}

export function definition(pairs: ReadonlyArray<[string, Child]>): HTMLElement {
  const node = el("dl", { className: "ab-defs" });
  for (const [term, value] of pairs) {
    node.append(el("dt", { text: term }), el("dd", {}, value));
  }
  return node;
}

export function button(
  text: string,
  onClick: () => void,
  options: { variant?: "primary" | "ghost" | "danger"; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const node = el("button", {
    className: `ab-button ab-button-${options.variant ?? "ghost"}`,
    text,
    title: options.title,
  });
  node.type = "button";
  node.disabled = options.disabled ?? false;
  node.addEventListener("click", onClick);
  return node;
}

/** A disclosure with a plain-text summary. */
export function details(summary: string, open: boolean, ...children: Child[]): HTMLDetailsElement {
  const node = el("details", { className: "ab-details" }, el("summary", { text: summary }), ...children);
  node.open = open;
  return node;
}

export function shortHash(value: string, keep = 12): string {
  if (!value) return "";
  return value.length <= keep * 2 ? value : `${value.slice(0, keep)}…${value.slice(-4)}`;
}

export function bytes(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "";
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MiB`;
}

export function whenText(iso: string): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}
