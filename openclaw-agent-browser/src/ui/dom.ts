/**
 * Minimal DOM helpers.
 *
 * Every string that originates in a package — names, descriptions, domains,
 * warning messages — reaches the document through `textContent` only. There is
 * no `innerHTML` anywhere in this plugin's browser code, so package-provided
 * text can never become markup.
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

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.firstChild.remove();
}

/** A labelled row used across the security, budget and detail panels. */
export function row(label: string, ...value: Child[]): HTMLElement {
  return el(
    "div",
    { className: "ab-row" },
    el("span", { className: "ab-row-label", text: label }),
    el("span", { className: "ab-row-value" }, ...value),
  );
}

export function chip(text: string, tone: "neutral" | "good" | "warn" | "bad" = "neutral") {
  return el("span", { className: `ab-chip ab-chip-${tone}`, text });
}

export function card(title: string, ...children: Child[]): HTMLElement {
  return el(
    "section",
    { className: "ab-card" },
    el("h2", { className: "ab-card-title", text: title }),
    ...children,
  );
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
