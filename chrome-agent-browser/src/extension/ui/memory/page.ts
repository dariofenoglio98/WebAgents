/**
 * The Memory page (T19; design `memory-ui.md` §3, §6; D-218, D-222, D-225): Graph | List, the
 * record card beside the canvas, filters and layers, search, New record, Import, Export, Tidy
 * up, the migration report, and Settings → Memory. A thin view over the service worker: every
 * write is one message the person's click sends; the page never holds a sealed value until
 * Reveal, and what it holds then is one field's value for the life of the card. Positions and
 * the chosen view are UI state (`chrome.storage.local`), never the memory's.
 */
import type { JsonObject, JsonValue } from "../../../core/json.js";
import { MAX_AGENT_BODY_CHARS, RELATIONS, SEALED_PLACEHOLDER, SELF_ID, type Relation } from "../../../core/memory/model.js";
import { dayWords, provenanceWords, RELATION_MEANING, relationWords } from "../../../core/memory/words.js";
import type { ExportFile, ImportFile, ImportPlanView, MemoryView, MigrationReport, RecordDraft, Request } from "../../messages.js";
import type { MemoryRecordListing } from "../../background/memory-controller.js";
import type { MemoryTypeView } from "../../../core/memory/types.js";
import { button, bytes as bytesText, card, chip, el, list, whenText } from "../dom.js";
import { renderMarkdown } from "../markdown.js";
import { readZip, writeZip } from "../zip.js";
import { fill, MASK, STRINGS } from "./strings.js";

export type MemoryMode = "graph" | "list";
export type TidyGroupKey = "superseded" | "expired" | "unreadable" | "dangling" | "unused" | "demo" | "agents";

export interface MemoryFilters {
  types: string[];
  tags: string[];
  packageId: string | null;
  showSuperseded: boolean;
  showExpired: boolean;
  typeHubs: boolean;
  packages: boolean;
  size: "links" | "recent";
}

export interface CardState {
  /** `view` for an existing record; `create` for a new one of `type`. */
  mode: "view" | "create";
  id: string | null;
  type: string;
  draft: { title: string; fields: Record<string, JsonValue>; body: string; tags: string[]; links: Array<{ to: string; rel: Relation }>; valid_until: string | null; identity: "replace" | "keep_both" };
  /** Sealed pointers revealed in this card, with their values (for the life of the card). */
  revealed: Record<string, string>;
  /** Sealed pointers the person is editing (a one-field editor). */
  editingSealed: string[];
  dirty: boolean;
  preview: boolean;
  deleteArmed: boolean;
}

export type Sheet =
  | { kind: "types" }
  | { kind: "export"; includeSealed: boolean; includeAgents: boolean; recordIds: string[] | null; busy: boolean }
  | { kind: "import"; name: string | null; files: ImportFile[]; plan: ImportPlanView | null; completions: Record<string, Record<string, string>>; busy: boolean; error: string | null }
  | { kind: "linkPicker"; from: string; query: string }
  | { kind: "relation"; from: string; to: string; rel: Relation | null; error: string | null }
  | { kind: "deleteMany"; ids: string[]; label: string }
  | { kind: "migration" }
  | { kind: "agentNote"; id: string; note: { title: string; body: string; updated: string; provenance: string } | null; loading: boolean };

export interface MemoryPageState {
  mode: MemoryMode;
  query: string;
  filters: MemoryFilters;
  selected: string | null;
  card: CardState | null;
  sheet: Sheet | null;
  notice: { text: string; tone: "good" | "warn" | "bad" } | null;
  tidy: boolean;
  tidyGroup: TidyGroupKey | null;
  checked: string[];
  sort: { column: "title" | "type" | "updated"; descending: boolean };
  /** The search's results in score order, when a query is set. */
  matches: Array<{ id: string; score: number }> | null;
  /** The local graph's root and depth, when the graph shows a neighbourhood. */
  local: { root: string; depth: 1 | 2 } | null;
  /** The narrow layout's [Filters] disclosure (design §3.7). */
  filtersOpen: boolean;
}

export function newMemoryPageState(): MemoryPageState {
  return {
    mode: "graph",
    query: "",
    filters: { types: [], tags: [], packageId: null, showSuperseded: false, showExpired: true, typeHubs: false, packages: false, size: "links" },
    selected: null,
    card: null,
    sheet: null,
    notice: null,
    tidy: false,
    tidyGroup: null,
    checked: [],
    sort: { column: "title", descending: false },
    matches: null,
    local: null,
    filtersOpen: false,
  };
}

export interface MemoryPageActions {
  send<T>(request: Request): Promise<T>;
  rerender(): void;
  /** Reload the view from the worker after a write (the worker also broadcasts `event.memory`). */
  reload(): void;
  /** The store is locked and a write was asked for: open the Unlock sheet, then run `then`. */
  unlock(action: string, then: () => void): void;
  openRun(runId: string): void;
  saveBlob(name: string, blob: Blob): Promise<string | null>;
  /** The graph canvas for the main column, when the page is in graph mode (`ui/memory/graph.ts`). */
  graph?: (view: MemoryView, state: MemoryPageState, actions: MemoryPageActions) => HTMLElement;
  /** Open Settings → Memory (the demo set, agent notes, Forget memory). */
  openSettingsMemory?: () => void;
}

// -- helpers -----------------------------------------------------------------------------------
export function typeOf(view: MemoryView, id: string): MemoryTypeView | undefined {
  return view.types.find((type) => type.id === id);
}

export function recordOf(view: MemoryView, id: string | null): MemoryRecordListing | undefined {
  return id === null ? undefined : view.records.find((record) => record.id === id);
}

interface PropertySchema {
  type?: string | string[];
  enum?: JsonValue[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  description?: string;
  format?: string;
}

export function properties(type: MemoryTypeView): Array<[name: string, schema: PropertySchema, required: boolean]> {
  const props = (type.schema.properties ?? {}) as Record<string, PropertySchema>;
  const required = (type.schema.required as string[] | undefined) ?? [];
  const summary = type.display.summary.map((pointer) => pointer.slice(1));
  // The `display.summary` fields first, then schema order (design §3.4).
  const names = [...summary.filter((name) => name in props), ...Object.keys(props).filter((name) => !summary.includes(name))];
  return names.map((name) => [name, props[name]!, required.includes(name)]);
}

/** Which records the filters and the search keep (design §3.2: filters reduce what is drawn). */
export function visibleRecords(view: MemoryView, state: MemoryPageState): MemoryRecordListing[] {
  const filters = state.filters;
  const matches = state.matches === null ? null : new Map(state.matches.map((match) => [match.id, match.score]));
  let records = view.records.filter((record) => {
    if (!filters.showSuperseded && record.superseded_by !== null) return false;
    if (!filters.showExpired && record.expired) return false;
    if (filters.types.length > 0 && !filters.types.includes(record.type)) return false;
    if (filters.tags.length > 0 && !(record.tags ?? []).some((tag) => filters.tags.includes(tag))) return false;
    if (filters.packageId !== null && !record.usage.some((usage) => usage.package_id === filters.packageId)) return false;
    if (state.tidyGroup !== null && !view.tidy[state.tidyGroup].includes(record.id)) return false;
    return true;
  });
  if (matches !== null) records = records.filter((record) => matches.has(record.id)).sort((a, b) => (matches.get(b.id) ?? 0) - (matches.get(a.id) ?? 0));
  return records;
}

function sortRecords(records: MemoryRecordListing[], view: MemoryView, sort: MemoryPageState["sort"]): MemoryRecordListing[] {
  const key = (record: MemoryRecordListing): string => (sort.column === "title" ? record.title.toLowerCase() : sort.column === "type" ? (typeOf(view, record.type)?.display_name ?? record.type).toLowerCase() : record.updated);
  const sorted = [...records].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return sort.descending ? sorted.reverse() : sorted;
}

export function statusWords(view: MemoryView): string {
  const minutes = view.lock.idle_minutes;
  let lock: string;
  if (view.locked) lock = STRINGS["memory.status.locked"];
  else if (minutes === null || view.lock.last_used_at === null) lock = STRINGS["memory.status.unlocked.never"];
  else {
    const left = Math.max(0, Math.round(minutes - (Date.now() - new Date(view.lock.last_used_at).getTime()) / 60_000));
    lock = fill("memory.status.unlocked", { min: left });
  }
  return fill("memory.status", { records: view.counts.records, types: view.counts.types, superseded: view.counts.superseded, lock });
}

function usageLine(record: MemoryRecordListing): string {
  if (record.usage.length === 0) return "—";
  const top = record.usage[0]!;
  return `${top.package_id} · ${top.runs} run${top.runs === 1 ? "" : "s"}`;
}

const TYPE_GROUPS: Array<[prefix: string, label: string]> = [
  ["person.", "About you"],
  ["travel.", "Travel"],
  ["research.", "Research"],
  ["contact.", "Contacts and cards"],
  ["payment.", "Contacts and cards"],
  ["document.", "Notes"],
];

// -- the card --------------------------------------------------------------------------------------
export function openCard(view: MemoryView, state: MemoryPageState, id: string): void {
  const record = recordOf(view, id);
  if (!record) return;
  state.selected = id;
  state.card = {
    mode: "view",
    id,
    type: record.type,
    draft: { title: record.title, fields: JSON.parse(JSON.stringify(record.fields)) as Record<string, JsonValue>, body: record.body, tags: [...(record.tags ?? [])], links: [...(record.links ?? [])], valid_until: record.valid_until ?? null, identity: "replace" },
    revealed: {},
    editingSealed: [],
    dirty: false,
    preview: false,
    deleteArmed: false,
  };
  state.local = null;
}

export function openCreate(view: MemoryView, state: MemoryPageState, typeId: string): void {
  const type = typeOf(view, typeId);
  if (!type) return;
  state.selected = null;
  state.card = {
    mode: "create",
    id: null,
    type: typeId,
    draft: { title: "", fields: {}, body: "", tags: [], links: type.default_links.map((link) => ({ ...link })), valid_until: null, identity: "replace" },
    revealed: {},
    editingSealed: [],
    dirty: false,
    preview: false,
    deleteArmed: false,
  };
  state.sheet = null;
}

function writeGuard(view: MemoryView, actions: MemoryPageActions, action: string, work: () => void): void {
  if (view.locked) actions.unlock(action, work);
  else work();
}

function fieldControl(name: string, schema: PropertySchema, draft: Record<string, JsonValue>, onChange: () => void): HTMLElement {
  const current = draft[name];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (Array.isArray(schema.enum)) {
    const select = el("select", { className: "ab-select", attrs: { name: `field-${name}` } });
    select.append(el("option", { text: "choose…", attrs: { value: "" } }));
    for (const option of schema.enum) select.append(el("option", { text: String(option), attrs: { value: String(option) } }));
    select.value = current === undefined ? "" : String(current);
    select.addEventListener("change", () => {
      if (select.value === "") delete draft[name];
      else draft[name] = select.value;
      onChange();
    });
    return select;
  }
  if (types.includes("boolean")) {
    const box = el("input", { attrs: { type: "checkbox", name: `field-${name}` } });
    box.checked = current === true;
    box.addEventListener("change", () => {
      draft[name] = box.checked;
      onChange();
    });
    return box;
  }
  if (types.includes("number") || types.includes("integer")) {
    const input = el("input", { className: "ab-input", attrs: { type: "number", name: `field-${name}` } });
    input.value = typeof current === "number" ? String(current) : "";
    input.addEventListener("input", () => {
      if (input.value === "") delete draft[name];
      else draft[name] = Number(input.value);
      onChange();
    });
    return input;
  }
  if (types.includes("array") || types.includes("object")) {
    const area = el("textarea", { className: "ab-textarea", attrs: { name: `field-${name}`, rows: "3", placeholder: "JSON" } });
    area.value = current === undefined ? "" : JSON.stringify(current, null, 1);
    area.addEventListener("input", () => {
      try {
        if (area.value.trim() === "") delete draft[name];
        else draft[name] = JSON.parse(area.value) as JsonValue;
        area.setCustomValidity("");
      } catch {
        area.setCustomValidity("not valid JSON");
      }
      onChange();
    });
    return area;
  }
  const input = el("input", { className: "ab-input", attrs: { type: schema.format === "date" ? "date" : "text", name: `field-${name}`, autocomplete: "off", ...(schema.maxLength ? { maxlength: String(schema.maxLength) } : {}) } });
  input.value = typeof current === "string" ? current : current === undefined ? "" : String(current);
  input.addEventListener("input", () => {
    if (input.value === "") delete draft[name];
    else draft[name] = input.value;
    onChange();
  });
  return input;
}

function sealedField(name: string, pointer: string, view: MemoryView, state: MemoryPageState, card: CardState, actions: MemoryPageActions): HTMLElement {
  const editing = card.editingSealed.includes(pointer);
  const revealed = card.revealed[pointer];
  const placeholder = card.draft.fields[name] === SEALED_PLACEHOLDER || card.draft.fields[name] === undefined;
  if (editing) {
    const input = el("input", { className: "ab-input", attrs: { type: "text", name: `field-${name}`, autocomplete: "off", "aria-label": `${name} (sealed)` } });
    input.value = typeof card.draft.fields[name] === "string" && card.draft.fields[name] !== SEALED_PLACEHOLDER ? String(card.draft.fields[name]) : (revealed ?? "");
    input.addEventListener("input", () => {
      card.draft.fields[name] = input.value;
      card.dirty = true;
      const save = input.closest(".ab-memory-card")?.querySelector<HTMLButtonElement>(".ab-memory-card-footer .ab-button-primary");
      if (save) save.disabled = false;
    });
    return input;
  }
  const shown = revealed !== undefined ? revealed : placeholder ? MASK : String(card.draft.fields[name]);
  const reveal = button(revealed !== undefined ? "Hide" : "Reveal", () => {
    if (revealed !== undefined) {
      delete card.revealed[pointer];
      actions.rerender();
      return;
    }
    if (card.id === null) return;
    writeGuard(view, actions, "reveal", () => {
      void actions.send<{ value: string }>({ type: "memory.reveal", recordId: card.id!, pointer }).then(
        (result) => {
          card.revealed[pointer] = result.value;
          actions.rerender();
        },
        (error: unknown) => {
          state.notice = { text: error instanceof Error ? error.message : STRINGS["memory.locked"], tone: "bad" };
          actions.rerender();
        },
      );
    });
  });
  reveal.setAttribute("aria-pressed", revealed !== undefined ? "true" : "false");
  const edit = button("Edit", () =>
    writeGuard(view, actions, "edit", () => {
      card.editingSealed = [...card.editingSealed, pointer];
      card.dirty = true;
      actions.rerender();
    }),
  );
  return el("span", { className: "ab-sealed-value" }, el("span", { className: "ab-id", text: shown, attrs: { "aria-label": revealed !== undefined ? name : "sealed, hidden" } }), card.id === null ? null : reveal, edit);
}

function cardLinks(view: MemoryView, state: MemoryPageState, card: CardState, actions: MemoryPageActions): HTMLElement {
  const rows = card.draft.links.map((link) => {
    const target = recordOf(view, link.to);
    const title = target?.title ?? (link.to === SELF_ID ? "Me" : "missing record"); // the Me record's own title, never a fixed name (review 1, finding 6)
    const open = target ? button(title, () => {
      openCard(view, state, target.id);
      actions.rerender();
    }, { variant: "ghost" }) : el("span", { className: "ab-muted", text: `${title} (missing)` });
    return el(
      "li",
      { className: "ab-memory-link" },
      el("span", { text: `${relationWords(link.rel).forward} → ` }),
      open,
      button("remove", () => {
        card.draft.links = card.draft.links.filter((item) => !(item.to === link.to && item.rel === link.rel));
        card.dirty = true;
        actions.rerender();
      }),
    );
  });
  return el(
    "div",
    { className: "ab-memory-links" },
    el("h4", { text: "Links" }),
    rows.length > 0 ? el("ul", { className: "ab-list" }, ...rows) : el("p", { className: "ab-hint", text: "No links yet." }),
    button("+ Link…", () =>
      writeGuard(view, actions, "add a link", () => {
        if (card.id === null) {
          state.notice = { text: "Save the record first, then link it.", tone: "warn" };
          actions.rerender();
          return;
        }
        state.sheet = { kind: "linkPicker", from: card.id, query: "" };
        actions.rerender();
      }),
    ),
  );
}

function cardTags(card: CardState, actions: MemoryPageActions): HTMLElement {
  const input = el("input", { className: "ab-input ab-input-short", attrs: { type: "text", name: "tag-new", placeholder: "add a tag", autocomplete: "off" } });
  const add = () => {
    const tag = input.value.trim().toLowerCase();
    if (!tag || card.draft.tags.includes(tag)) return;
    card.draft.tags.push(tag);
    card.dirty = true;
    actions.rerender();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  });
  return el(
    "div",
    { className: "ab-memory-tags" },
    el("span", { className: "ab-row-label", text: "Tags" }),
    ...card.draft.tags.map((tag) =>
      el(
        "span",
        { className: "ab-chip ab-chip-neutral" },
        el("span", { text: tag }),
        button("×", () => {
          card.draft.tags = card.draft.tags.filter((item) => item !== tag);
          card.dirty = true;
          actions.rerender();
        }, { title: `remove ${tag}` }),
      ),
    ),
    input,
    button("Add", add),
  );
}

export function draftOf(view: MemoryView, card: CardState): RecordDraft {
  const type = typeOf(view, card.type)!;
  const fields: JsonObject = {};
  for (const [name, schema, required] of properties(type)) {
    const raw = card.draft.fields[name];
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.includes("boolean")) {
      if (required || raw !== undefined) fields[name] = raw === true;
      continue;
    }
    if (raw === undefined || raw === "") continue;
    fields[name] = raw;
  }
  return { type: card.type, title: card.draft.title, fields, body: card.draft.body, tags: card.draft.tags, links: card.draft.links, sealed: type.sealed_fields.length > 0 ? [...type.sealed_fields] : [], ...(card.draft.valid_until ? { valid_until: card.draft.valid_until } : {}), identity: card.draft.identity };
}

function saveCard(view: MemoryView, state: MemoryPageState, card: CardState, actions: MemoryPageActions): void {
  writeGuard(view, actions, card.mode === "create" ? "add" : "edit", () => {
    const draft = draftOf(view, card);
    const request: Request = card.mode === "create" ? { type: "memory.create", draft: draft as unknown as JsonObject } : { type: "memory.edit", recordId: card.id!, changes: { title: draft.title, fields: draft.fields, body: draft.body, tags: draft.tags, links: draft.links, valid_until: card.draft.valid_until } as unknown as JsonObject };
    void actions.send<{ id: string; replaced?: string | null }>(request).then(
      (result) => {
        state.notice = { text: card.mode === "create" ? (result.replaced ? "Saved; the older record is kept as replaced." : "Saved.") : "Saved. A prepared run plan that named this record is now stale.", tone: "good" };
        state.selected = result.id;
        state.card = null;
        actions.reload();
      },
      (error: unknown) => {
        state.notice = { text: error instanceof Error ? error.message : "Could not save.", tone: "bad" };
        actions.rerender();
      },
    );
  });
}

export function renderCard(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const card = state.card;
  if (card === null) return el("div", { className: "ab-memory-card ab-memory-card-empty" }, el("p", { className: "ab-empty", text: STRINGS["memory.empty"] }));
  const type = typeOf(view, card.type);
  if (!type) return el("div", { className: "ab-memory-card" }, el("p", { className: "ab-hint", text: `Unknown type ${card.type}` }));
  const record = recordOf(view, card.id);
  // The title on its own line, the chips wrapping under it: no four-line title beside three tall chips at 1280 px (review 1, nit 12).
  const head = el(
    "div",
    { className: "ab-memory-card-head" },
    el("div", { className: "ab-memory-card-title" }, el("strong", { text: card.mode === "create" ? `New ${type.display_name.toLowerCase()}` : record?.title ?? "" }), el("div", { className: "ab-row ab-memory-card-chips" }, chip(type.display_name), record?.demo ? chip("demo", "warn") : null, type.sealed_fields.length > 0 ? chip("🔒 sealed fields", "neutral") : null)),
    button("×", () => {
      state.card = null;
      actions.rerender();
    }, { title: "Close" }),
  );
  const flags: HTMLElement[] = [];
  if (record?.superseded_by) {
    const head = recordOf(view, record.superseded_by);
    flags.push(el("div", { className: "ab-banner ab-banner-warn" }, el("span", { text: fill("memory.card.replaced", { title: head?.title ?? record.superseded_by, date: dayWords(head?.updated ?? record.updated) }) }), head ? button("open", () => {
      openCard(view, state, head.id);
      actions.rerender();
    }) : null));
  }
  if (record?.expired && record.valid_until) flags.push(el("div", { className: "ab-banner ab-banner-warn" }, el("span", { text: fill("memory.card.expired", { date: dayWords(record.valid_until) }) })));
  if (record?.unreadable) flags.push(el("div", { className: "ab-banner ab-banner-bad" }, el("span", { text: STRINGS["memory.card.unreadable"] }), button("Tidy up", () => {
    state.tidy = true;
    actions.rerender();
  })));
  const provenance = record ? el("p", { className: "ab-hint ab-memory-provenance", text: `${provenanceWords(record.source)}${record.usage.length > 0 ? ` · last used ${whenText(record.usage[0]!.last)}` : ""}` }) : null;
  // What this type is for (the taxonomy's description), so the form's fields read in context.
  const about = type.description ? el("p", { className: "ab-hint ab-memory-type-about", text: type.description }) : null;
  // Save enables on the first change without a re-render (a re-render would replace the input being typed in).
  const save = button("Save", () => saveCard(view, state, card, actions), { variant: "primary", disabled: card.mode === "view" && !card.dirty });
  const markDirty = () => {
    card.dirty = true;
    save.disabled = false;
  };
  const title = el("input", { className: "ab-input", attrs: { type: "text", name: "record-title", placeholder: "Title", autocomplete: "off", maxlength: "200" } });
  title.value = card.draft.title;
  title.addEventListener("input", () => {
    card.draft.title = title.value;
    markDirty();
  });
  const fields = properties(type).map(([name, schema, required]) => {
    const pointer = `/${name}`;
    const sealed = type.sealed_fields.includes(pointer);
    const control = sealed ? sealedField(name, pointer, view, state, card, actions) : fieldControl(name, schema, card.draft.fields, markDirty);
    return el("label", { className: "ab-field ab-memory-field" }, el("span", { className: "ab-row-label" }, el("span", { text: name.replace(/_/gu, " ") }), required ? chip("required") : null, sealed ? chip("sealed", "warn") : null), control, schema.description ? el("span", { className: "ab-hint", text: schema.description }) : null);
  });
  const body = el("textarea", { className: "ab-textarea", attrs: { name: "record-body", rows: "6", maxlength: "16384", placeholder: "Markdown; [[Title]] links to another record" } });
  body.value = card.draft.body;
  body.addEventListener("input", () => {
    card.draft.body = body.value;
    markDirty();
  });
  const bodySection = el(
    "div",
    { className: "ab-memory-card-body" },
    el("div", { className: "ab-row" }, el("h4", { text: "Body" }), button(card.preview ? "Edit" : "Preview", () => {
      card.preview = !card.preview;
      actions.rerender();
    })),
    card.preview ? renderMarkdown(card.draft.body) : body,
  );
  const whereUsed = record && record.usage.length > 0 ? el("div", { className: "ab-memory-usage" }, el("h4", { text: "Where used" }), list(record.usage.map((usage) => el("span", { text: fill("memory.card.where_used", { package: usage.package_id, n: usage.runs, date: dayWords(usage.last) }) })))) : null;
  const identityBar = card.mode === "create" && type.identity.length > 0 ? el("p", { className: "ab-hint", text: `If a ${type.display_name.toLowerCase()} with the same ${type.identity.map((pointer) => pointer.slice(1).replace(/_/gu, " ")).join(", ")} exists, it is replaced (kept as replaced); choose "Keep both" below to keep it.` }) : null;
  const identityChoice = card.mode === "create" && type.identity.length > 0 ? el("div", { className: "ab-row" }, ...(["replace", "keep_both"] as const).map((choice) => {
    const input = el("input", { attrs: { type: "radio", name: "identity", value: choice } });
    input.checked = card.draft.identity === choice;
    input.addEventListener("change", () => {
      card.draft.identity = choice;
    });
    return el("label", { className: "ab-inline" }, input, el("span", { text: choice === "replace" ? STRINGS["memory.replace.yes"] : STRINGS["memory.replace.no"] }));
  })) : null;
  const remove = record ? button(card.deleteArmed ? "Press again to delete" : "Delete", () =>
    writeGuard(view, actions, "delete", () => {
      if (!card.deleteArmed) {
        card.deleteArmed = true;
        state.notice = { text: fill("memory.delete.ask", { title: record.title }), tone: "warn" };
        actions.rerender();
        return;
      }
      void actions.send({ type: "memory.delete", recordIds: [record.id] }).then(
        () => {
          state.card = null;
          state.selected = null;
          state.notice = { text: "Deleted.", tone: "good" };
          actions.reload();
        },
        (error: unknown) => {
          state.notice = { text: error instanceof Error ? error.message : "Could not delete.", tone: "bad" };
          actions.rerender();
        },
      );
    }), { variant: card.deleteArmed ? "danger" : "ghost" }) : null;
  const exportThis = record ? button("Export this", () => {
    state.sheet = { kind: "export", includeSealed: false, includeAgents: false, recordIds: [record.id], busy: false };
    actions.rerender();
  }) : null;
  const footer = el(
    "div",
    { className: "ab-inline ab-memory-card-footer" },
    save,
    card.mode === "create" ? button("Cancel", () => {
      state.card = null;
      actions.rerender();
    }) : null,
    remove,
    exportThis,
  );
  return el("div", { className: "ab-memory-card", attrs: { "data-record": card.id ?? "new" } }, head, ...flags, provenance, about, el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: "Title" }), title), ...fields, bodySection, cardLinks(view, state, card, actions), whereUsed, cardTags(card, actions), identityBar, identityChoice, footer);
}

// -- the list ---------------------------------------------------------------------------------------
export function renderList(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const records = sortRecords(visibleRecords(view, state), view, state.sort);
  const header = (column: MemoryPageState["sort"]["column"], label: string): HTMLElement => {
    const active = state.sort.column === column;
    const th = el("th", { attrs: { scope: "col", "aria-sort": active ? (state.sort.descending ? "descending" : "ascending") : "none" } });
    th.append(button(`${label}${active ? (state.sort.descending ? " ▾" : " ▴") : ""}`, () => {
      state.sort = { column, descending: active ? !state.sort.descending : false };
      actions.rerender();
    }));
    return th;
  };
  const rows = records.map((record) => {
    const type = typeOf(view, record.type);
    const box = el("input", { attrs: { type: "checkbox", "aria-label": `select ${record.title}` } });
    box.checked = state.checked.includes(record.id);
    box.addEventListener("change", () => {
      state.checked = box.checked ? [...state.checked, record.id] : state.checked.filter((id) => id !== record.id);
      actions.rerender();
    });
    const flags: string[] = [];
    if (record.demo) flags.push("(demo)");
    if (record.superseded_by) flags.push(`(replaced ${dayWords(recordOf(view, record.superseded_by)?.updated ?? record.updated)})`);
    if (record.expired && record.valid_until) flags.push(`(expired ${dayWords(record.valid_until)})`);
    const row = el(
      "tr",
      { className: state.selected === record.id ? "ab-memory-row ab-memory-row-selected" : "ab-memory-row", attrs: { "data-record": record.id, tabindex: "0" } },
      el("td", {}, box),
      el("td", {}, el("span", { text: record.title }), flags.length > 0 ? el("span", { className: "ab-muted", text: ` ${flags.join(" ")}` }) : null),
      el("td", {}, el("span", { text: type?.display_name ?? record.type }), (type?.sealed_fields.length ?? 0) > 0 ? el("span", { text: " 🔒", attrs: { title: "has sealed fields" } }) : null),
      el("td", { text: (record.tags ?? []).join(", ") }),
      el("td", { text: dayWords(record.updated) }),
      el("td", { text: usageLine(record) }),
    );
    const open = () => {
      openCard(view, state, record.id);
      actions.rerender();
    };
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      open();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") open();
    });
    return row;
  });
  const table = el(
    "table",
    { className: "ab-memory-table" },
    el("thead", {}, el("tr", {}, el("th", { attrs: { scope: "col" } }, el("span", { className: "ab-visually-hidden", text: "select" })), header("title", "Title"), header("type", "Type"), el("th", { attrs: { scope: "col" }, text: "Tags" }), header("updated", "Updated"), el("th", { attrs: { scope: "col" }, text: "Used by" }))),
    el("tbody", {}, ...rows),
  );
  const selection = state.checked.length > 0 ? el(
    "div",
    { className: "ab-inline" },
    el("span", { text: `${state.checked.length} selected:` }),
    button("Delete…", () => writeGuard(view, actions, "delete", () => {
      state.sheet = { kind: "deleteMany", ids: [...state.checked], label: `${state.checked.length} record${state.checked.length === 1 ? "" : "s"}` };
      actions.rerender();
    })),
    button("Export selected", () => {
      state.sheet = { kind: "export", includeSealed: false, includeAgents: false, recordIds: [...state.checked], busy: false };
      actions.rerender();
    }),
  ) : null;
  return el("div", { className: "ab-memory-list" }, records.length === 0 ? el("p", { className: "ab-empty", text: view.records.length <= 1 ? "No record yet. Press + New record, or add the demo set under Settings → Memory." : "No record matches." }) : table, selection);
}

// -- tidy up ---------------------------------------------------------------------------------------
export function renderTidy(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const groups: Array<[TidyGroupKey, string, string, boolean]> = [
    ["superseded", "Replaced records", "Older versions kept behind a newer one.", true],
    ["expired", "Expired", "valid_until has passed.", true],
    ["unreadable", "Unreadable sealed value", "A sealed value the store key cannot read.", false],
    ["dangling", "Missing links", "Records that link to a record that no longer exists.", false],
    ["unused", "Not used for 180 days", "No package read them since.", false],
    ["demo", "Demo set", "Fictional records labelled demo.", true],
    ["agents", "Agent notes", "Packages' private notes (Settings → Memory).", false],
  ];
  const rows = groups.map(([key, title, explanation, deletable]) => {
    const count = view.tidy[key].length;
    return el(
      "tr",
      {},
      el("td", { text: title }),
      el("td", { className: "ab-id", text: String(count) }),
      el("td", { className: "ab-hint", text: explanation }),
      el("td", {}, count > 0 && key !== "agents" ? button("Review", () => {
        state.tidy = false;
        state.tidyGroup = key;
        state.mode = "list";
        state.filters.showSuperseded = true;
        actions.rerender();
      }) : null, count > 0 && deletable ? button(`Delete all ${count}…`, () => writeGuard(view, actions, "delete", () => {
        state.sheet = { kind: "deleteMany", ids: [...view.tidy[key]], label: `${count} ${title.toLowerCase()}` };
        actions.rerender();
      }), { variant: "danger" }) : null),
    );
  });
  return el(
    "div",
    { className: "ab-memory-tidy" },
    el("div", { className: "ab-row" }, el("h3", { text: "Tidy up" }), button("← Back to memory", () => {
      state.tidy = false;
      actions.rerender();
    })),
    el("p", { className: "ab-hint", text: "Nothing here runs on its own. Missing links are removed per record from its card; a record is never deleted for a missing link." }),
    el("table", { className: "ab-memory-table" }, el("tbody", {}, ...rows)),
  );
}

// -- sheets -----------------------------------------------------------------------------------------
function sheetFrame(title: string, onClose: () => void, ...children: Array<HTMLElement | null>): HTMLElement {
  const backdrop = el("div", { className: "ab-sheet-backdrop" });
  backdrop.addEventListener("click", onClose);
  const cardNode = el("div", { className: "ab-sheet-card ab-memory-sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-label": title } }, el("h3", { text: title }), ...children);
  const sheet = el("div", { className: "ab-sheet" }, backdrop, cardNode);
  sheet.addEventListener("keydown", (event) => {
    if (event.key === "Escape") onClose();
  });
  queueMicrotask(() => {
    const first = cardNode.querySelector<HTMLElement>("input, select, textarea, button");
    first?.focus();
  });
  return sheet;
}

function typesSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const groups = new Map<string, MemoryTypeView[]>();
  for (const type of view.types) {
    if (type.id === "person.self" || type.id === "agent.memory") continue;
    let label = "Other";
    if (type.declared_by.kind === "person") label = "Your types";
    else if (type.declared_by.kind === "package") label = `Approved package types (${type.declared_by.package_id ?? ""})`;
    else label = TYPE_GROUPS.find(([prefix]) => type.id.startsWith(prefix))?.[1] ?? "Other";
    groups.set(label, [...(groups.get(label) ?? []), type]);
  }
  const sections = [...groups.entries()].map(([label, types]) =>
    el(
      "div",
      { className: "ab-memory-type-group" },
      el("h4", { text: label }),
      ...types.map((type) => button(`${type.display_name}${type.sealed_fields.length > 0 ? " 🔒" : ""}`, () => {
        openCreate(view, state, type.id);
        actions.rerender();
      }, { title: type.description ?? "" })),
    ),
  );
  return sheetFrame("New record", close, el("p", { className: "ab-hint", text: "Choose what to remember. Sealed types (🔒) keep their identifying values away from every model." }), ...sections, button("Cancel", close));
}

function exportSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions, sheet: Extract<Sheet, { kind: "export" }>): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const count = sheet.recordIds ? sheet.recordIds.length : view.counts.records - view.counts.agents;
  const sealedTypes = new Set<string>();
  let sealedValues = 0;
  for (const record of view.records) {
    if (sheet.recordIds && !sheet.recordIds.includes(record.id)) continue;
    if (record.sealed_pointers.length > 0) {
      sealedTypes.add(typeOf(view, record.type)?.display_name ?? record.type);
      sealedValues += record.sealed_pointers.length;
    }
  }
  const sealedBox = el("input", { attrs: { type: "checkbox", name: "include-sealed" } });
  sealedBox.checked = sheet.includeSealed;
  sealedBox.addEventListener("change", () => {
    sheet.includeSealed = sealedBox.checked;
    actions.rerender();
  });
  const agentsBox = el("input", { attrs: { type: "checkbox", name: "include-agents" } });
  agentsBox.checked = sheet.includeAgents;
  agentsBox.addEventListener("change", () => {
    sheet.includeAgents = agentsBox.checked;
  });
  const run = () => {
    sheet.busy = true;
    actions.rerender();
    void actions.send<{ files: ExportFile[]; sealed_included: boolean }>({ type: "memory.export", includeSealed: sheet.includeSealed, includeAgents: sheet.includeAgents, recordIds: sheet.recordIds }).then(
      async (result) => {
        const encoder = new TextEncoder();
        const zip = writeZip(result.files.map((file) => ({ name: file.path, bytes: encoder.encode(file.text) })));
        const name = `memory-${new Date().toISOString().slice(0, 10)}.zip`;
        await actions.saveBlob(name, new Blob([zip as BlobPart], { type: "application/zip" }));
        state.sheet = null;
        state.notice = { text: `Saved ${name} (${result.files.length} files${result.sealed_included ? ", sealed values in clear" : ", sealed values omitted"}).`, tone: "good" };
        actions.rerender();
      },
      (error: unknown) => {
        sheet.busy = false;
        state.notice = { text: error instanceof Error ? error.message : "Could not export.", tone: "bad" };
        actions.rerender();
      },
    );
  };
  return sheetFrame(
    "Export",
    close,
    el("p", { text: `Export ${count} record${count === 1 ? "" : "s"} as a folder of Markdown files (a zip).` }),
    !view.locked && sealedValues > 0 ? el("label", { className: "ab-inline" }, sealedBox, el("span", { text: fill("memory.export.sealed", { n: sealedValues, types: [...sealedTypes].join(", ") }) })) : null,
    sheet.includeSealed ? el("p", { className: "ab-banner ab-banner-warn", text: STRINGS["memory.export.sealed.warn"] }) : null,
    view.counts.agents > 0 ? el("label", { className: "ab-inline" }, agentsBox, el("span", { text: "Include agent notes" })) : null,
    el("div", { className: "ab-inline" }, button("Export", run, { variant: "primary", disabled: sheet.busy }), button("Cancel", close)),
  );
}

async function filesOf(input: HTMLInputElement): Promise<{ name: string | null; files: ImportFile[] }> {
  const picked = [...(input.files ?? [])];
  if (picked.length === 0) return { name: null, files: [] };
  const first = picked[0]!;
  if (picked.length === 1 && first.name.toLowerCase().endsWith(".zip")) {
    const members = await readZip(new Uint8Array(await first.arrayBuffer()));
    const decoder = new TextDecoder();
    return { name: first.name, files: members.map((member) => ({ path: member.name, text: decoder.decode(member.bytes) })) };
  }
  const files: ImportFile[] = [];
  for (const file of picked) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const relative = path.includes("/") ? path.split("/").slice(1).join("/") : path;
    files.push({ path: relative, text: await file.text() });
  }
  return { name: (first as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] ?? "folder", files };
}

function importSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions, sheet: Extract<Sheet, { kind: "import" }>): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const picker = el("input", { attrs: { type: "file", name: "import-files", multiple: "", accept: ".zip,.md,.json" } });
  picker.addEventListener("change", () => {
    sheet.busy = true;
    sheet.error = null;
    actions.rerender();
    void filesOf(picker).then(
      async ({ name, files }) => {
        sheet.name = name;
        sheet.files = files;
        sheet.plan = files.length === 0 ? null : await actions.send<ImportPlanView>({ type: "memory.importPlan", files });
        sheet.busy = false;
        actions.rerender();
      },
      (error: unknown) => {
        sheet.busy = false;
        sheet.error = error instanceof Error ? error.message : "Could not read the files.";
        actions.rerender();
      },
    );
  });
  const plan = sheet.plan;
  const lines: HTMLElement[] = [];
  if (plan) {
    lines.push(el("p", { text: fill("memory.import.report", { added: plan.counts.added, updated: plan.counts.updated, same: plan.counts.same }) }));
    if (plan.counts.hub > 0) lines.push(el("p", { text: STRINGS["memory.import.self"] }));
    const incomplete = plan.items.filter((item) => item.kind === "incomplete");
    for (const item of incomplete) {
      for (const missing of item.missing) {
        const input = el("input", { className: "ab-input", attrs: { type: "text", name: `complete-${item.path}-${missing.pointer}`, placeholder: `${item.type ?? ""}: ${missing.field}`, autocomplete: "off" } });
        input.value = sheet.completions[item.path]?.[missing.pointer] ?? "";
        input.addEventListener("input", () => {
          sheet.completions[item.path] = { ...(sheet.completions[item.path] ?? {}), [missing.pointer]: input.value };
        });
        lines.push(el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: fill("memory.import.incomplete", { n: 1, type: item.type ?? "", field: missing.field }) }), input));
      }
    }
    if (plan.counts.sealed_restored > 0) lines.push(el("p", { text: fill("memory.import.restored", { n: plan.counts.sealed_restored, types: [...new Set(plan.items.filter((item) => item.restored > 0).map((item) => item.type ?? ""))].join(", ") }) }));
    const refused = plan.items.filter((item) => item.kind === "refused");
    if (refused.length > 0) lines.push(el("details", {}, el("summary", { text: `${refused.length} file${refused.length === 1 ? " was" : "s were"} refused` }), list(refused.map((item) => el("span", { text: `${item.path}: ${item.reason ?? ""}` })))));
    const mirrors = plan.items.filter((item) => item.mirror_not_imported.length > 0);
    if (mirrors.length > 0) lines.push(el("details", {}, el("summary", { text: `${mirrors.length} file${mirrors.length === 1 ? "" : "s"} carried a ## Links mirror that is not imported (edit the property instead)` }), list(mirrors.map((item) => el("span", { text: `${item.path}: ${item.mirror_not_imported.join(", ")}` })))));
    if (plan.counts.links_as_text > 0 || plan.counts.links_resolved > 0) lines.push(el("p", { className: "ab-hint", text: `${plan.counts.links_as_text} link${plan.counts.links_as_text === 1 ? "" : "s"} could not be resolved and stay as text · ${fill("memory.import.resolved", { n: plan.counts.links_resolved, s: plan.counts.links_resolved === 1 ? "" : "s", s2: plan.counts.links_resolved === 1 ? "s" : "" })}` }));
    if (plan.counts.became_notes > 0) lines.push(el("p", { className: "ab-hint", text: `${plan.counts.became_notes} file${plan.counts.became_notes === 1 ? "" : "s"} of unknown type become Notes` }));
  }
  const writes = plan ? plan.counts.added + plan.counts.updated + plan.counts.hub + plan.counts.incomplete : 0;
  const apply = () =>
    writeGuard(view, actions, "import", () => {
      sheet.busy = true;
      actions.rerender();
      void actions.send<{ written: number; skipped: string[] }>({ type: "memory.importApply", files: sheet.files, completions: sheet.completions }).then(
        (result) => {
          state.sheet = null;
          state.notice = { text: `Imported ${result.written} record${result.written === 1 ? "" : "s"}${result.skipped.length > 0 ? `; ${result.skipped.length} skipped` : ""}.`, tone: "good" };
          actions.reload();
        },
        (error: unknown) => {
          sheet.busy = false;
          sheet.error = error instanceof Error ? error.message : "Could not import.";
          actions.rerender();
        },
      );
    });
  return sheetFrame(
    sheet.name ? `Import from ${sheet.name}` : "Import",
    close,
    el("p", { className: "ab-hint", text: "Pick a memory folder's files or its zip. Nothing is written until you press Import." }),
    picker,
    sheet.busy ? el("p", { className: "ab-busy", text: "Reading…" }) : null,
    sheet.error ? el("p", { className: "ab-banner ab-banner-bad", text: sheet.error }) : null,
    ...lines,
    el("div", { className: "ab-inline" }, button(plan ? `Import ${writes} record${writes === 1 ? "" : "s"}` : "Import", apply, { variant: "primary", disabled: !plan || writes === 0 || sheet.busy }), button("Cancel", close)),
  );
}

function linkPickerSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions, sheet: Extract<Sheet, { kind: "linkPicker" }>): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const from = recordOf(view, sheet.from);
  const query = el("input", { className: "ab-input", attrs: { type: "search", name: "link-query", placeholder: STRINGS["memory.search.placeholder"], autocomplete: "off" } });
  query.value = sheet.query;
  query.addEventListener("input", () => {
    sheet.query = query.value;
    actions.rerender();
    queueMicrotask(() => document.querySelector<HTMLInputElement>('input[name="link-query"]')?.focus());
  });
  const needle = sheet.query.trim().toLowerCase();
  const candidates = view.records.filter((record) => record.id !== sheet.from && record.superseded_by === null && (needle === "" || record.title.toLowerCase().includes(needle))).slice(0, 50);
  return sheetFrame(
    `Link ${from?.title ?? ""} to…`,
    close,
    query,
    list(candidates.map((record) => button(`${record.title} · ${typeOf(view, record.type)?.display_name ?? record.type}`, () => {
      state.sheet = { kind: "relation", from: sheet.from, to: record.id, rel: null, error: null };
      actions.rerender();
    }))),
    button("Cancel", close),
  );
}

export function relationSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions, sheet: Extract<Sheet, { kind: "relation" }>): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const from = recordOf(view, sheet.from);
  const to = recordOf(view, sheet.to);
  const existing = new Set((from?.links ?? []).map((link) => `${link.to}|${link.rel}`));
  const already = sheet.rel !== null && existing.has(`${sheet.to}|${sheet.rel}`);
  const radios = RELATIONS.map((rel) => {
    const input = el("input", { attrs: { type: "radio", name: "relation", value: rel } });
    input.checked = sheet.rel === rel;
    input.addEventListener("change", () => {
      sheet.rel = rel;
      sheet.error = null;
      actions.rerender();
    });
    const words = relationWords(rel);
    return el("label", { className: "ab-memory-relation" }, input, el("span", {}, el("strong", { text: words.forward }), el("span", { className: "ab-muted", text: ` · ${to?.title ?? ""} ${words.inverse} ${from?.title ?? ""}` }), el("span", { className: "ab-hint", text: RELATION_MEANING[rel] })));
  });
  const link = () => {
    if (sheet.rel === null) return;
    writeGuard(view, actions, "add a link", () => {
      void actions.send<{ id: string; existed: boolean }>({ type: "memory.link", from: sheet.from, to: sheet.to, rel: sheet.rel! }).then(
        () => {
          state.sheet = null;
          if (state.card && state.card.id === sheet.from) openCard(view, state, sheet.from);
          actions.reload();
        },
        (error: unknown) => {
          sheet.error = error instanceof Error ? error.message : "Could not link.";
          actions.rerender();
        },
      );
    });
  };
  return sheetFrame(
    fill("memory.link.chooser.title", { source: from?.title ?? "", target: to?.title ?? "" }),
    close,
    ...radios,
    sheet.error ? el("p", { className: "ab-banner ab-banner-bad", text: sheet.error }) : null,
    el("div", { className: "ab-inline" }, button(already ? STRINGS["memory.link.exists"] : "Link", link, { variant: "primary", disabled: sheet.rel === null || already }), button("Cancel", close)),
  );
}

function deleteManySheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions, sheet: Extract<Sheet, { kind: "deleteMany" }>): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const titles = sheet.ids.map((id) => recordOf(view, id)?.title ?? id);
  return sheetFrame(
    `Delete ${sheet.label}?`,
    close,
    el("p", { text: "This cannot be undone. Links to these records in other records stay and are shown as missing." }),
    list(titles.slice(0, 50).map((title) => el("span", { text: title }))),
    el("div", { className: "ab-inline" }, button("Cancel", close), button(`Delete ${sheet.ids.length}`, () => {
      void actions.send<{ deleted: string[] }>({ type: "memory.delete", recordIds: sheet.ids }).then(
        (result) => {
          state.sheet = null;
          state.checked = [];
          if (state.card && result.deleted.includes(state.card.id ?? "")) state.card = null;
          state.notice = { text: `Deleted ${result.deleted.length} record${result.deleted.length === 1 ? "" : "s"}.`, tone: "good" };
          actions.reload();
        },
        (error: unknown) => {
          state.notice = { text: error instanceof Error ? error.message : "Could not delete.", tone: "bad" };
          state.sheet = null;
          actions.rerender();
        },
      );
    }, { variant: "danger" })),
  );
}

function migrationSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const report = view.migration;
  if (!report) return sheetFrame("Migration", close, button("Close", close));
  return sheetFrame(
    STRINGS["migration.title"],
    close,
    el("p", { text: migrationSummary(report) }),
    list(report.items.map((item) => el("span", { text: item.outcome.kind === "migrated" ? `${item.label} → ${item.outcome.title} (${item.outcome.type})` : `${item.label}: not migrated: ${item.outcome.reason}` }))),
    el("p", { className: "ab-hint", text: "Nothing was deleted. The old Your data document stays in the protected store until you press Done." }),
    el("div", { className: "ab-inline" }, button("Done", () => writeGuard(view, actions, "finish the migration", () => {
      void actions.send({ type: "memory.migrationDone" }).then(() => {
        state.sheet = null;
        actions.reload();
      });
    }), { variant: "primary" }), button("Later", close)),
  );
}

export function migrationSummary(report: MigrationReport): string {
  const parts = Object.entries(report.counts).map(([type, count]) => `${count} ${type}`);
  return `${report.total - report.failed} of ${report.total} record${report.total === 1 ? "" : "s"} moved (${parts.join(", ") || "none"}); the old types map to ${report.mappings.map((mapping) => `${mapping.from_type} → ${mapping.to_type}`).join(", ") || "nothing"}; packages that ask for the old names still get them.${report.failed > 0 ? ` ${report.failed} could not be migrated.` : ""}`;
}

function agentNoteSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions, sheet: Extract<Sheet, { kind: "agentNote" }>): HTMLElement {
  const close = () => {
    state.sheet = null;
    actions.rerender();
  };
  const note = view.agents.find((item) => item.id === sheet.id);
  if (note && sheet.note === null && !sheet.loading) {
    sheet.loading = true;
    void actions.send<{ title: string; body: string; updated: string; provenance: string } | null>({ type: "memory.agentNote", packageId: note.package_id }).then(
      (loaded) => {
        sheet.note = loaded;
        sheet.loading = false;
        actions.rerender();
      },
      () => {
        sheet.loading = false;
        actions.rerender();
      },
    );
  }
  return sheetFrame(
    note?.title ?? "Agent notes",
    close,
    note ? el("p", { className: "ab-hint", text: `${note.package_id} ${note.package_version ?? ""} · written ${whenText(note.updated)} · ${bytesText(note.bytes)} of ${MAX_AGENT_BODY_CHARS.toLocaleString("en-US")} characters at most${sheet.note ? ` · ${sheet.note.provenance}` : ""}` }) : null,
    el("div", { className: "ab-memory-note" }, el("p", { className: "ab-hint", text: "Read-only: the package's own notes, shown as it wrote them (data to its next run, never an instruction to this browser)." }), sheet.note ? renderMarkdown(sheet.note.body) : el("p", { className: "ab-busy", text: sheet.loading ? "Loading…" : "No notes." })),
    button("Close", close),
  );
}

export function renderSheet(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement | null {
  const sheet = state.sheet;
  if (sheet === null) return null;
  switch (sheet.kind) {
    case "types":
      return typesSheet(view, state, actions);
    case "export":
      return exportSheet(view, state, actions, sheet);
    case "import":
      return importSheet(view, state, actions, sheet);
    case "linkPicker":
      return linkPickerSheet(view, state, actions, sheet);
    case "relation":
      return relationSheet(view, state, actions, sheet);
    case "deleteMany":
      return deleteManySheet(view, state, actions, sheet);
    case "migration":
      return migrationSheet(view, state, actions);
    case "agentNote":
      return agentNoteSheet(view, state, actions, sheet);
    default:
      return null;
  }
}

// -- the page ------------------------------------------------------------------------------------
function filtersBar(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const filters = state.filters;
  const typeSelect = el("select", { className: "ab-select", attrs: { name: "filter-type", "aria-label": "Type" } });
  typeSelect.append(el("option", { text: "Type: all", attrs: { value: "" } }));
  for (const type of view.types.filter((item) => item.id !== "agent.memory")) typeSelect.append(el("option", { text: type.display_name, attrs: { value: type.id } }));
  typeSelect.value = filters.types[0] ?? "";
  typeSelect.addEventListener("change", () => {
    filters.types = typeSelect.value ? [typeSelect.value] : [];
    actions.rerender();
  });
  const tags = [...new Set(view.records.flatMap((record) => record.tags ?? []))].sort();
  const tagSelect = el("select", { className: "ab-select", attrs: { name: "filter-tag", "aria-label": "Tag" } });
  tagSelect.append(el("option", { text: "Tag: all", attrs: { value: "" } }));
  for (const tag of tags) tagSelect.append(el("option", { text: tag, attrs: { value: tag } }));
  tagSelect.value = filters.tags[0] ?? "";
  tagSelect.addEventListener("change", () => {
    filters.tags = tagSelect.value ? [tagSelect.value] : [];
    actions.rerender();
  });
  const packages = view.layers.packages;
  const packageSelect = el("select", { className: "ab-select", attrs: { name: "filter-package", "aria-label": "Package" } });
  packageSelect.append(el("option", { text: "Package: all", attrs: { value: "" } }));
  for (const node of packages) packageSelect.append(el("option", { text: node.label, attrs: { value: node.id.replace(/^package:/u, "") } }));
  packageSelect.value = filters.packageId ?? "";
  packageSelect.addEventListener("change", () => {
    filters.packageId = packageSelect.value || null;
    actions.rerender();
  });
  const toggle = (label: string, key: "showSuperseded" | "showExpired" | "typeHubs" | "packages"): HTMLElement => {
    const box = el("input", { attrs: { type: "checkbox", name: `filter-${key}` } });
    box.checked = filters[key];
    box.addEventListener("change", () => {
      filters[key] = box.checked;
      actions.rerender();
    });
    return el("label", { className: "ab-inline" }, box, el("span", { text: label }));
  };
  const sizeSelect = el("select", { className: "ab-select", attrs: { name: "graph-size", "aria-label": "Size" } });
  for (const [value, label] of [["links", "Size: Links"], ["recent", "Size: Recent"]] as const) sizeSelect.append(el("option", { text: label, attrs: { value } }));
  sizeSelect.value = filters.size;
  sizeSelect.addEventListener("change", () => {
    filters.size = sizeSelect.value as MemoryFilters["size"];
    actions.rerender();
  });
  return el(
    "div",
    { className: "ab-memory-filters" },
    typeSelect,
    tagSelect,
    packageSelect,
    toggle("Show superseded", "showSuperseded"),
    toggle("Show expired", "showExpired"),
    state.mode === "graph" ? toggle("Type hubs", "typeHubs") : null,
    state.mode === "graph" ? toggle("Packages", "packages") : null,
    state.mode === "graph" ? sizeSelect : null,
    state.tidyGroup ? button("Clear tidy filter", () => {
      state.tidyGroup = null;
      actions.rerender();
    }) : null,
    el("span", { className: "ab-memory-filters-spacer" }),
    button("Tidy up", () => {
      state.tidy = true;
      actions.rerender();
    }),
    button("Import", () => writeGuard(view, actions, "import", () => {
      state.sheet = { kind: "import", name: null, files: [], plan: null, completions: {}, busy: false, error: null };
      actions.rerender();
    })),
    button("Export", () => {
      state.sheet = { kind: "export", includeSealed: false, includeAgents: false, recordIds: null, busy: false };
      actions.rerender();
    }),
  );
}

function header(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const search = el("input", { className: "ab-input ab-memory-search", attrs: { type: "search", name: "memory-search", placeholder: STRINGS["memory.search.placeholder"], autocomplete: "off", "aria-label": "Search records" } });
  search.value = state.query;
  let timer: ReturnType<typeof setTimeout> | null = null;
  search.addEventListener("input", () => {
    state.query = search.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const query = state.query.trim();
      if (query === "") {
        state.matches = null;
        actions.rerender();
        return;
      }
      void actions.send<Array<{ id: string; score: number }>>({ type: "memory.search", query }).then((matches) => {
        state.matches = matches;
        actions.rerender();
        queueMicrotask(() => {
          const node = document.querySelector<HTMLInputElement>('input[name="memory-search"]');
          if (node && document.activeElement !== node) {
            node.focus();
            node.setSelectionRange(node.value.length, node.value.length);
          }
        });
      });
    }, 150);
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && state.matches && state.matches.length > 0) {
      openCard(view, state, state.matches[0]!.id);
      actions.rerender();
    }
    if (event.key === "Escape") {
      state.query = "";
      state.matches = null;
      actions.rerender();
    }
  });
  const toggle = (mode: MemoryMode, label: string): HTMLElement => {
    const node = button(label, () => {
      state.mode = mode;
      actions.rerender();
    }, { variant: state.mode === mode ? "primary" : "ghost" });
    node.setAttribute("aria-pressed", state.mode === mode ? "true" : "false");
    return node;
  };
  return el(
    "div",
    { className: "ab-memory-header" },
    el("h2", { text: STRINGS["memory.title"] }),
    el("div", { className: "ab-memory-toggle", attrs: { role: "group", "aria-label": "View" } }, toggle("graph", STRINGS["memory.toggle.graph"]), toggle("list", STRINGS["memory.toggle.list"])),
    search,
    button(STRINGS["memory.new"], () => writeGuard(view, actions, "add", () => {
      state.sheet = { kind: "types" };
      actions.rerender();
    }), { variant: "primary" }),
    (() => {
      // Narrow layout only (CSS shows it below 700 px): the filters collapse behind one button (design §3.7).
      const toggle = button("Filters", () => {
        state.filtersOpen = !state.filtersOpen;
        actions.rerender();
      }, { variant: state.filtersOpen ? "primary" : "ghost" });
      toggle.classList.add("ab-memory-filters-toggle");
      toggle.setAttribute("aria-expanded", state.filtersOpen ? "true" : "false");
      return toggle;
    })(),
  );
}

export function renderMemoryPage(view: MemoryView, state: MemoryPageState, actions: MemoryPageActions): HTMLElement {
  const notice = state.notice ? el("div", { className: `ab-banner ab-banner-${state.notice.tone}`, attrs: { role: "status" } }, el("span", { text: state.notice.text })) : null;
  const migration = view.migration ? el("div", { className: "ab-banner ab-banner-good ab-memory-migration", attrs: { role: "status" } }, el("strong", { text: `${STRINGS["migration.title"]} ` }), el("span", { text: migrationSummary(view.migration) }), button("Show details", () => {
    state.sheet = { kind: "migration" };
    actions.rerender();
  })) : null;
  const lockedLine = view.locked ? el("div", { className: "ab-banner ab-banner-warn", attrs: { role: "status" } }, el("span", { text: `${STRINGS["memory.status.locked"]}. ${STRINGS["memory.locked"]}` }), button("Unlock", () => actions.unlock("edit", () => actions.reload()), { variant: "primary" })) : null;
  // An empty memory (the Me record alone): say where the demo set is, so the first visit is not a blank graph.
  const emptyLine = view.records.length <= 1 && !state.tidy ? el("div", { className: "ab-banner ab-banner-neutral", attrs: { role: "status" } }, el("span", { text: "Only you so far. Add a record with + New record, or add the fictional demo set under Settings → Memory." }), actions.openSettingsMemory ? button("Settings → Memory", actions.openSettingsMemory) : null) : null;
  const main = state.tidy ? renderTidy(view, state, actions) : state.mode === "graph" && actions.graph ? actions.graph(view, state, actions) : renderList(view, state, actions);
  const status = el("p", { className: "ab-memory-status", attrs: { role: "status" }, text: statusWords(view) });
  const sheet = renderSheet(view, state, actions);
  const page = el(
    "div",
    { className: `ab-memory ab-memory-mode-${state.mode}` },
    notice,
    migration,
    lockedLine,
    emptyLine,
    header(view, state, actions),
    state.tidy ? null : (() => {
      const bar = filtersBar(view, state, actions);
      if (state.filtersOpen) bar.classList.add("ab-memory-filters-open");
      return bar;
    })(),
    el("div", { className: "ab-memory-body" }, el("div", { className: "ab-memory-main" }, main), el("aside", { className: "ab-memory-side", attrs: { "aria-label": "Record" } }, renderCard(view, state, actions))),
    status,
    sheet,
  );
  page.addEventListener("keydown", (event) => {
    if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault();
      page.querySelector<HTMLInputElement>('input[name="memory-search"]')?.focus();
    }
  });
  return page;
}

// -- Settings → Memory (design §6) -----------------------------------------------------------------
export function renderMemorySettings(view: MemoryView | null, state: MemoryPageState, actions: MemoryPageActions & { openMemory: () => void; preset: string; forgetTyped: string; setForgetTyped: (value: string) => void }): HTMLElement[] {
  if (view === null) return [card("Memory", el("p", { className: "ab-busy", text: "Loading…" }))];
  const forget = el("input", { className: "ab-input", attrs: { type: "text", name: "forget-memory", placeholder: "forget", autocomplete: "off" } });
  forget.value = actions.forgetTyped;
  forget.addEventListener("input", () => actions.setForgetTyped(forget.value));
  return [
    card(
      "Memory",
      el("p", { text: `${view.counts.records} record${view.counts.records === 1 ? "" : "s"} · ${view.counts.types} types · ${bytesText(view.counts.bytes)} · ${view.locked ? STRINGS["memory.status.locked"] : "store unlocked"}` }),
      el("div", { className: "ab-inline" }, button("Open Memory", actions.openMemory, { variant: "primary" }), button("Export…", () => {
        actions.openMemory();
        state.sheet = { kind: "export", includeSealed: false, includeAgents: false, recordIds: null, busy: false };
      }), button("Import…", () => {
        actions.openMemory();
        state.sheet = { kind: "import", name: null, files: [], plan: null, completions: {}, busy: false, error: null };
      }), button("Tidy up…", () => {
        actions.openMemory();
        state.tidy = true;
      })),
    ),
    card(
      "Agent notes",
      el("p", { className: "ab-hint", text: "Packages' private notes between runs (at most 32,768 characters each), read at the start of a run and written once at its end. You can read and clear them here." }),
      view.agents.length === 0 ? el("p", { className: "ab-empty", text: "No package has written notes yet." }) : list(view.agents.map((note) => el("div", { className: "ab-row" }, el("strong", { text: note.title }), el("span", { className: "ab-hint", text: ` ${bytesText(note.bytes)} · written ${whenText(note.updated)}` }), button("Open", () => {
        actions.openMemory();
        state.selected = note.id;
        state.sheet = { kind: "agentNote", id: note.id, note: null, loading: false };
      }), button("Clear…", () => writeGuard(view, actions, "clear these notes", () => {
        void actions.send({ type: "memory.clearAgent", packageId: note.package_id }).then(() => actions.reload());
      }), { variant: "danger" })))),
      actions.preset === "privacy-first" ? el("p", { className: "ab-hint", text: STRINGS["memory.agent.none_privacy"] }) : null,
    ),
    card(
      "Demo set",
      el("p", { className: "ab-hint", text: `${view.counts.demo} fictional record${view.counts.demo === 1 ? "" : "s"} labelled demo: two travel profiles, two identities, two payment cards for the WebAir demo. Nothing real.` }),
      el("div", { className: "ab-inline" }, button("Add demo set", () => writeGuard(view, actions, "add the demo set", () => {
        void actions.send({ type: "memory.installDemo" }).then(() => actions.reload());
      })), view.counts.demo > 0 ? button("Remove demo set…", () => writeGuard(view, actions, "remove the demo set", () => {
        void actions.send({ type: "memory.removeDemo" }).then(() => actions.reload());
      }), { variant: "danger" }) : null),
    ),
    card(
      "Forget memory",
      el("p", { className: "ab-hint", text: "Deletes every record, note and position. Export first if you want a copy." }),
      el("p", { text: STRINGS["memory.forget.ask"] }),
      el("div", { className: "ab-inline" }, forget, button("Forget memory…", () => writeGuard(view, actions, "forget your memory", () => {
        void actions.send({ type: "memory.forget", confirmation: actions.forgetTyped }).then(
          () => {
            actions.setForgetTyped("");
            void chrome.storage?.local?.remove?.("memoryUiState");
            actions.reload();
          },
          (error: unknown) => {
            state.notice = { text: error instanceof Error ? error.message : "Not forgotten.", tone: "bad" };
            actions.rerender();
          },
        );
      }), { variant: "danger", disabled: actions.forgetTyped !== "forget" })),
    ),
  ];
}
