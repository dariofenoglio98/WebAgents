/**
 * Your data: the records this browser holds for you, per resource type (D-051). Create and
 * edit them with a form built from the type's JSON Schema; a clearly labelled fictional demo
 * set can be added with one click and is never pre-filled silently. Values are yours and are
 * shown to you here; a package only ever sees the one record you grant it, through a tool.
 */
import type { JsonObject, JsonValue } from "../../core/json.js";
import type { VaultRecordView, VaultTypeView } from "../../core/vault.js";
import type { VaultView } from "../messages.js";
import { button, card, chip, definition, el, list, shortHash, whenText } from "./dom.js";

export interface VaultPageState {
  editing: { type: string; id: string | null; draft: Record<string, JsonValue>; label: string } | null;
  notice: { text: string; tone: "good" | "warn" | "bad" } | null;
}

export function newVaultPageState(): VaultPageState {
  return { editing: null, notice: null };
}

export interface VaultPageActions {
  onPut: (record: { id: string; type: string; label: string; value: JsonObject; demo: boolean }) => void;
  onDelete: (recordId: string) => void;
  onInstallDemo: () => void;
  rerender: () => void;
}

interface PropertySchema {
  type?: string;
  enum?: JsonValue[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  description?: string;
}

function properties(type: VaultTypeView): Array<[name: string, schema: PropertySchema, required: boolean]> {
  const props = (type.schema.properties ?? {}) as Record<string, PropertySchema>;
  const required = ((type.schema.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, schema]) => [name, schema, required.includes(name)]);
}

function recordId(): string {
  return `rec_${crypto.randomUUID().replace(/-/gu, "").slice(0, 16)}`;
}

function field(name: string, schema: PropertySchema, required: boolean, sealed: boolean, draft: Record<string, JsonValue>): HTMLElement {
  let control: HTMLElement;
  const current = draft[name];
  if (Array.isArray(schema.enum)) {
    const select = el("select", { className: "ab-select", attrs: { name: `field-${name}` } });
    select.append(el("option", { text: "choose…", attrs: { value: "" } }));
    for (const option of schema.enum) select.append(el("option", { text: String(option), attrs: { value: String(option) } }));
    select.value = current === undefined ? "" : String(current);
    select.addEventListener("change", () => {
      draft[name] = select.value;
    });
    control = select;
  } else if (schema.type === "boolean") {
    const box = el("input", { attrs: { type: "checkbox", name: `field-${name}` } });
    box.checked = current === true;
    box.addEventListener("change", () => {
      draft[name] = box.checked;
    });
    control = box;
  } else if (schema.type === "number" || schema.type === "integer") {
    const input = el("input", { className: "ab-input", attrs: { type: "number", name: `field-${name}` } });
    input.value = typeof current === "number" ? String(current) : "";
    input.addEventListener("input", () => {
      draft[name] = input.value === "" ? "" : Number(input.value);
    });
    control = input;
  } else {
    const input = el("input", { className: "ab-input", attrs: { type: "text", name: `field-${name}`, autocomplete: "off", ...(schema.pattern ? { pattern: schema.pattern } : {}), ...(schema.maxLength ? { maxlength: String(schema.maxLength) } : {}) } });
    input.value = typeof current === "string" ? current : "";
    input.addEventListener("input", () => {
      draft[name] = input.value;
    });
    control = input;
  }
  return el(
    "label",
    { className: "ab-field ab-vault-field" },
    el("span", { className: "ab-row-label" }, el("span", { text: name }), required ? chip("required") : null, sealed ? chip("sealed", "warn") : null),
    control,
    schema.pattern || schema.description ? el("span", { className: "ab-hint", text: schema.description ?? `format: ${schema.pattern}` }) : null,
    sealed ? el("span", { className: "ab-hint", text: "A sealed value identifies you or an instrument: it reaches only the tools that link the permission you grant it under, and never a model." }) : null,
  );
}

function editor(view: VaultView, state: VaultPageState, actions: VaultPageActions): HTMLElement | null {
  const editing = state.editing;
  if (!editing) return null;
  const type = view.types.find((item) => item.id === editing.type);
  if (!type) return null;
  const label = el("input", { className: "ab-input", attrs: { type: "text", name: "record-label", placeholder: "A label for you (shown when choosing; must not contain a sealed value)", autocomplete: "off" } });
  label.value = editing.label;
  label.addEventListener("input", () => {
    editing.label = label.value;
  });
  return card(
    `${editing.id ? "Edit" : "New"} ${type.display_name.toLowerCase()}`,
    el("p", { className: "ab-hint", text: type.description ?? "" }),
    el("label", { className: "ab-field" }, el("span", { className: "ab-row-label", text: "Label" }), label),
    ...properties(type).map(([name, schema, required]) => field(name, schema, required, type.sealed_fields.includes(`/${name}`), editing.draft)),
    el(
      "div",
      { className: "ab-inline" },
      button(
        "Save",
        () => {
          const value: JsonObject = {};
          for (const [name, schema] of properties(type)) {
            const raw = editing.draft[name];
            if (raw === undefined || raw === "") continue;
            value[name] = schema.type === "boolean" ? raw === true : raw;
          }
          actions.onPut({ id: editing.id ?? recordId(), type: type.id, label: editing.label.trim(), value, demo: false });
        },
        { variant: "primary" },
      ),
      button("Cancel", () => {
        state.editing = null;
        actions.rerender();
      }),
    ),
  );
}

function recordCard(view: VaultView, record: VaultRecordView, state: VaultPageState, actions: VaultPageActions): HTMLElement {
  const type = view.types.find((item) => item.id === record.type);
  let armed = false;
  const remove = button("Delete", () => {
    if (!armed) {
      armed = true;
      remove.textContent = "Press again to delete";
      remove.className = "ab-button ab-button-danger";
      return;
    }
    actions.onDelete(record.id);
  });
  return el(
    "div",
    { className: "ab-vault-record", attrs: { "data-record": record.id } },
    el("div", { className: "ab-access-head" }, el("strong", { text: record.label }), chip(type?.display_name ?? record.type), record.demo ? chip("fictional demo data", "warn") : null),
    definition(Object.entries(record.value).map(([name, value]) => [name, type?.sealed_fields.includes(`/${name}`) ? `${String(value)} (sealed)` : String(value)])),
    el("p", { className: "ab-hint", text: `Reference ${shortHash(record.digest)} · updated ${whenText(record.updated_at)}. A plan that named this record goes stale when it changes.` }),
    el(
      "div",
      { className: "ab-inline" },
      button("Edit", () => {
        state.editing = { type: record.type, id: record.id, draft: { ...record.value }, label: record.label };
        actions.rerender();
      }),
      remove,
    ),
  );
}

export function renderVaultPage(view: VaultView, state: VaultPageState, actions: VaultPageActions): HTMLElement {
  const byType = new Map<string, VaultRecordView[]>();
  for (const record of view.records) byType.set(record.type, [...(byType.get(record.type) ?? []), record]);
  return el(
    "div",
    { className: "ab-vault" },
    state.notice ? el("div", { className: `ab-banner ab-banner-${state.notice.tone}`, attrs: { role: "status" } }, el("span", { text: state.notice.text })) : null,
    card(
      "Your data",
      el("p", { className: "ab-hint", text: "Records an agent can ask for by type, never by name. They stay in this browser; when you grant a permission you choose which one record to share, and only the tools that link that permission receive it. Each record's reference changes when its value does, so a prepared run goes stale rather than reading a newer value." }),
      el(
        "div",
        { className: "ab-inline" },
        view.demo_available ? button("Add fictional demo data", actions.onInstallDemo, { title: "Six clearly labelled fictional records for the WebAir demo: a traveler, an explorer, two passengers, two demo payment methods. Nothing real." }) : null,
      ),
      view.records.length === 0 ? el("p", { className: "ab-empty", text: "No record yet. Add one below, or add the fictional demo set." }) : null,
    ),
    editor(view, state, actions),
    ...view.types.map((type) =>
      card(
        type.display_name,
        el("p", { className: "ab-hint", text: type.description ?? "" }),
        type.sealed_fields.length > 0 ? el("p", { className: "ab-hint", text: `Sealed fields: ${type.sealed_fields.map((pointer) => pointer.slice(1)).join(", ")}` }) : null,
        (byType.get(type.id) ?? []).length > 0 ? list((byType.get(type.id) ?? []).map((record) => recordCard(view, record, state, actions)), "ab-vault-list") : el("p", { className: "ab-empty", text: `No ${type.display_name.toLowerCase()} yet.` }),
        button(`Add a ${type.display_name.toLowerCase()}`, () => {
          state.editing = { type: type.id, id: null, draft: {}, label: "" };
          actions.rerender();
        }),
      ),
    ),
  );
}
