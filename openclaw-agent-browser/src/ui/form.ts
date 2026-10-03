/**
 * A form for a workflow.v0 task, rendered from the package's own input schema.
 *
 * Generic by construction: nothing here knows a package, a field name or a
 * domain. It reads a bounded JSON Schema document (already bundled by the
 * control plane) and optional presentation hints, and it builds inputs for
 * the shapes a task needs — text, multi-line text, enums, numbers, booleans,
 * lists of primitives, lists of simple objects, simple objects, string maps and
 * selected-file maps. Anything else becomes a JSON editor for that field.
 *
 * The form is not a validator. It keeps the value the person is building and
 * reports it; whether that value satisfies the package is decided by the
 * control plane (`execution.validate-input`) and again by the runner before
 * any instruction reaches a model.
 *
 * Selected files are capabilities, not paths: a file-map value can only be one
 * of the opaque ids this session's host issued, chosen from a list the host
 * returned. A person never types an id, and the package never sees a path.
 */
import type { FileCapabilityViewType, PresentationViewType } from "../contract.js";
import { bytes, clear, el } from "./dom.js";

type Json = unknown;
type Schema = Record<string, unknown>;
type Hint = PresentationViewType["input"][number];

export type FieldKind =
  | "text"
  | "multiline"
  | "enum"
  | "number"
  | "integer"
  | "boolean"
  | "list"
  | "objectList"
  | "object"
  | "map"
  | "files"
  | "json";

export type FieldModel = {
  name: string;
  kind: FieldKind;
  label: string;
  description: string | null;
  required: boolean;
  group: "primary" | "optional" | "advanced";
  schema: Schema;
  placeholder: string | null;
  rows: number;
  options: Json[];
  itemKind: FieldKind | null;
  itemSchema: Schema | null;
  columns: FieldModel[];
  keyLabel: string | null;
  keyPlaceholder: string | null;
  itemPlaceholder: string | null;
  defaultValue: Json;
};

export type FormModel = {
  /** False when the input is not an object with properties: edit as JSON. */
  structured: boolean;
  fields: FieldModel[];
  root: Schema | null;
};

export type FormContext = {
  /** This session's selected files; the only values a file map can hold. */
  files: () => readonly FileCapabilityViewType[];
  /** Whether this host lets the person select PDFs at all. */
  fileSelection: () => boolean;
  /** Ask the host to select one PDF by path; resolves to its capability, or null. */
  selectFile?: (path: string) => Promise<FileCapabilityViewType | null>;
  /** Directories the host allows files from, for display. */
  fileRoots: () => readonly string[];
  canWrite: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function humanize(name: string): string {
  const words = name.replace(/[_-]+/gu, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

function typesOf(schema: Schema): string[] {
  const type = schema.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string");
  return [];
}

/** Follow local `#/...` references inside the bundled document, bounded. */
export function resolve(schema: unknown, root: Schema | null, depth = 0): Schema {
  if (!isRecord(schema)) return {};
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/") && root && depth < 16) {
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
      target = isRecord(target) ? target[key] : undefined;
    }
    const { $ref: _ignored, ...rest } = schema;
    return { ...resolve(target, root, depth + 1), ...rest };
  }
  return schema;
}

function isPrimitive(schema: Schema): boolean {
  if (Array.isArray(schema.enum)) return schema.enum.every((item) => item === null || typeof item !== "object");
  const types = typesOf(schema);
  return types.length === 1 && ["string", "number", "integer", "boolean"].includes(types[0]!);
}

function primitiveKind(schema: Schema, hint?: Hint | null, topLevel = false): FieldKind {
  if (Array.isArray(schema.enum)) return "enum";
  const type = typesOf(schema)[0];
  if (type === "boolean") return "boolean";
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (hint?.widget === "multiline") return "multiline";
  const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : null;
  // A long or unbounded free-text field at the top of a task reads as prose.
  if (topLevel && typeof schema.pattern !== "string" && (maxLength === null || maxLength >= 200)) {
    return "multiline";
  }
  return "text";
}

function defaultFor(schema: Schema, kind: FieldKind, required: boolean, columns: FieldModel[] = []): Json {
  if ("default" in schema) return structuredClone(schema.default);
  if (!required) return undefined;
  switch (kind) {
    case "object": {
      // A required object starts from the defaults its own fields declare, if any.
      const value: Record<string, Json> = {};
      for (const column of columns) {
        if ("default" in column.schema) value[column.name] = structuredClone(column.schema.default as Json);
      }
      return Object.keys(value).length > 0 ? value : undefined;
    }
    case "list":
    case "objectList":
      return [];
    case "map":
    case "files":
      return {};
    case "boolean":
      return false;
    case "text":
    case "multiline":
      return "";
    default:
      return undefined;
  }
}

function field(
  name: string,
  raw: unknown,
  root: Schema | null,
  required: boolean,
  hint: Hint | null,
  topLevel: boolean,
): FieldModel {
  const schema = resolve(raw, root);
  const types = typesOf(schema);
  let kind: FieldKind = "json";
  let itemKind: FieldKind | null = null;
  let itemSchema: Schema | null = null;
  let columns: FieldModel[] = [];
  const combinator = ["anyOf", "oneOf", "allOf", "not", "if"].some((key) => key in schema);
  if (combinator || "const" in schema) {
    kind = "json";
  } else if (isPrimitive(schema)) {
    kind = primitiveKind(schema, hint, topLevel);
  } else if (types.length === 1 && types[0] === "array") {
    const items = resolve(schema.items, root);
    if (isPrimitive(items)) {
      kind = "list";
      itemKind = primitiveKind(items);
      itemSchema = items;
    } else if (typesOf(items)[0] === "object" && isRecord(items.properties)) {
      const props = Object.entries(items.properties).map(([key, value]) => [key, resolve(value, root)] as const);
      if (props.length > 0 && props.length <= 12 && props.every(([, value]) => isPrimitive(value))) {
        const need = new Set(Array.isArray(items.required) ? items.required.map(String) : []);
        kind = "objectList";
        itemSchema = items;
        columns = props.map(([key, value]) => field(key, value, root, need.has(key), null, false));
      }
    }
  } else if (types.length === 1 && types[0] === "object") {
    const props = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
    const extra = schema.additionalProperties;
    if (props.length === 0 && isRecord(extra) && isPrimitive(resolve(extra, root))) {
      const value = resolve(extra, root);
      kind = hint?.widget === "selected_files" && typesOf(value)[0] === "string" ? "files" : "map";
      itemSchema = value;
    } else if (props.length > 0 && props.length <= 16) {
      const resolved = props.map(([key, value]) => [key, resolve(value, root)] as const);
      if (resolved.every(([, value]) => isPrimitive(value))) {
        const need = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
        kind = "object";
        columns = resolved.map(([key, value]) => field(key, value, root, need.has(key), null, false));
      }
    }
  }
  const examples = Array.isArray(schema.examples) ? schema.examples : [];
  const title = typeof schema.title === "string" ? schema.title : null;
  return {
    name,
    kind,
    label: hint?.label ?? title ?? humanize(name),
    description: typeof schema.description === "string" ? schema.description : null,
    required,
    group: hint?.group ?? "primary",
    schema,
    placeholder:
      hint?.placeholder ?? (typeof examples[0] === "string" ? (examples[0] as string) : null),
    rows: hint?.rows ?? 4,
    options: Array.isArray(schema.enum) ? schema.enum : [],
    itemKind,
    itemSchema,
    columns,
    keyLabel: hint?.keyLabel ?? null,
    keyPlaceholder: hint?.keyPlaceholder ?? null,
    itemPlaceholder: hint?.itemPlaceholder ?? null,
    defaultValue: defaultFor(schema, kind, required, columns),
  };
}

/** Read a bundled input schema and hints into a form description. */
export function buildFormModel(document: unknown, hints: readonly Hint[] = []): FormModel {
  const root = isRecord(document) ? (document as Schema) : null;
  const schema = resolve(root, root);
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!root || typesOf(schema)[0] !== "object" || !properties) {
    return { structured: false, fields: [], root };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const byField = new Map(hints.map((hint) => [hint.field, hint]));
  const fields = Object.entries(properties)
    .slice(0, 64)
    .map(([name, value]) => field(name, value, root, required.has(name), byField.get(name) ?? null, true));
  return { structured: true, fields, root };
}

/** The value a fresh form starts from: declared defaults, then empty collections. */
export function initialValue(model: FormModel): Record<string, Json> {
  const value: Record<string, Json> = {};
  for (const item of model.fields) {
    if (item.defaultValue !== undefined) value[item.name] = structuredClone(item.defaultValue);
  }
  return value;
}

function coerce(kind: FieldKind | null, raw: string): Json {
  if (kind === "integer" || kind === "number") {
    if (raw.trim() === "") return undefined;
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }
  return raw;
}

function optionLabel(option: Json): string {
  return option === null ? "none" : String(option);
}

/**
 * A mounted form. It owns its DOM and its value; typing never re-renders the
 * page around it, so a person's cursor stays where it was.
 */
export class TaskForm {
  readonly root: HTMLElement;
  private value: Record<string, Json>;
  private jsonMode: boolean;
  private jsonText = "";
  private localErrors = new Map<string, string>();
  private fieldErrors = new Map<string, string>();
  /**
   * Fields the person has edited. The schema's verdict on a field appears
   * beside it only once it has been touched; the Run checklist states it
   * from the start, so an untouched form is not painted as a mistake.
   */
  private touched = new Set<string>();
  /**
   * Rows of map-shaped fields as the person is editing them. A row whose key
   * is still empty cannot live in the task value (an object key is required),
   * so the rows are the editing state and the value is derived from them.
   */
  private mapRows = new Map<string, Array<[string, Json]>>();

  constructor(
    readonly model: FormModel,
    initial: Record<string, Json> | null,
    private readonly context: FormContext,
    private readonly onChange: (value: Json, localErrors: ReadonlyMap<string, string>) => void,
  ) {
    this.value = structuredClone(initial ?? initialValue(model));
    this.jsonMode = !model.structured;
    if (this.jsonMode) this.jsonText = JSON.stringify(this.value, null, 2);
    this.root = el("div", { className: "ab-form" });
    this.render();
  }

  current(): Json {
    return this.jsonMode ? this.parsedJson() : this.ordered();
  }

  /** The value with its fields in the schema's order, then anything else. */
  private ordered(): Record<string, Json> {
    const out: Record<string, Json> = {};
    for (const item of this.model.fields) {
      if (Object.hasOwn(this.value, item.name)) out[item.name] = structuredClone(this.value[item.name]);
    }
    for (const [key, value] of Object.entries(this.value)) {
      if (!Object.hasOwn(out, key)) out[key] = structuredClone(value);
    }
    return out;
  }

  errors(): ReadonlyMap<string, string> {
    return this.localErrors;
  }

  /** Server-side verdicts, by JSON pointer, shown beside their fields. */
  showErrors(errors: ReadonlyArray<{ pointer: string; message: string }>): void {
    this.fieldErrors = new Map();
    for (const error of errors) {
      const top = error.pointer.split("/")[1] ?? "";
      const key = top.replace(/~1/gu, "/").replace(/~0/gu, "~");
      if (!this.fieldErrors.has(key)) this.fieldErrors.set(key, error.message);
    }
    for (const node of this.root.querySelectorAll<HTMLElement>("[data-field-error]")) {
      node.textContent = this.shownError(node.dataset.fieldError ?? "");
    }
  }

  /**
   * How a verdict names what it is about: the field's own label, with the
   * rest of the pointer when it points inside the field.
   */
  labelFor(pointer: string): string {
    const parts = pointer.split("/").slice(1).map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
    if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) return "The task";
    const item = this.model.fields.find((candidate) => candidate.name === parts[0]);
    const head = item ? item.label : parts[0]!;
    return parts.length > 1 ? `${head} (${pointer})` : head;
  }

  /** A field's own mistakes at once; the schema's verdict once it is touched. */
  private shownError(name: string): string {
    return this.localErrors.get(name) ?? (this.touched.has(name) ? this.fieldErrors.get(name) : undefined) ?? "";
  }

  /** Re-render after the selected-file list changed. */
  refreshFiles(): void {
    this.render();
  }

  private parsedJson(): Json {
    try {
      return JSON.parse(this.jsonText) as Json;
    } catch {
      return undefined;
    }
  }

  private emit(): void {
    this.onChange(this.current(), this.localErrors);
  }

  private set(name: string, next: Json): void {
    if (next === undefined) delete this.value[name];
    else this.value[name] = next;
    this.touched.add(name);
    this.emit();
  }

  private render(): void {
    clear(this.root);
    if (this.model.structured) {
      const toggle = el("button", {
        className: "ab-button ab-button-ghost ab-form-mode",
        text: this.jsonMode ? "Edit as form" : "Edit as JSON",
      });
      toggle.type = "button";
      toggle.addEventListener("click", () => this.toggleJson());
      this.root.append(el("div", { className: "ab-form-toolbar" }, toggle));
    }
    if (this.jsonMode) {
      this.root.append(this.renderJsonEditor());
      return;
    }
    const groups: Record<FieldModel["group"], FieldModel[]> = { primary: [], optional: [], advanced: [] };
    for (const item of this.model.fields) groups[item.group].push(item);
    for (const item of groups.primary) this.root.append(this.renderField(item));
    for (const [group, label] of [
      ["optional", "Optional"],
      ["advanced", "Advanced"],
    ] as const) {
      if (groups[group].length === 0) continue;
      const details = el("details", { className: `ab-form-group ab-form-${group}` });
      const filled = groups[group].some((item) => {
        const value = this.value[item.name];
        return Array.isArray(value) ? value.length > 0 : isRecord(value) ? Object.keys(value).length > 0 : false;
      });
      if (filled || groups[group].some((item) => this.shownError(item.name) !== "")) details.open = true;
      details.append(el("summary", { text: `${label} — ${groups[group].map((item) => item.label).join(", ")}` }));
      for (const item of groups[group]) details.append(this.renderField(item));
      this.root.append(details);
    }
  }

  private toggleJson(): void {
    if (this.jsonMode) {
      const parsed = this.parsedJson();
      if (!isRecord(parsed)) {
        this.localErrors.set("", "The task is not a JSON object, so it cannot be edited as a form.");
        this.emit();
        this.render();
        return;
      }
      this.value = parsed;
      this.mapRows = new Map();
      this.jsonMode = false;
      for (const item of this.model.fields) this.touched.add(item.name);
    } else {
      this.jsonText = JSON.stringify(this.ordered(), null, 2);
      this.jsonMode = true;
    }
    this.localErrors = new Map();
    this.render();
    this.emit();
  }

  private renderJsonEditor(): HTMLElement {
    const area = el("textarea", {
      className: "ab-json-editor",
      attrs: { rows: "14", spellcheck: "false", "aria-label": "Task as JSON" },
    });
    area.value = this.jsonText;
    area.disabled = !this.context.canWrite;
    const error = el("p", { className: "ab-field-error", attrs: { "data-field-error": "" } });
    area.addEventListener("input", () => {
      this.jsonText = area.value;
      if (this.parsedJson() === undefined && area.value.trim() !== "") {
        this.localErrors.set("", "The task is not valid JSON.");
      } else {
        this.localErrors.delete("");
      }
      error.textContent = this.localErrors.get("") ?? "";
      this.emit();
    });
    return el(
      "div",
      { className: "ab-field" },
      el("label", { className: "ab-field-label", text: "Task (JSON)" }),
      area,
      el("p", {
        className: "ab-hint",
        text: "Validated against the package's own input schema before Run is enabled.",
      }),
      error,
    );
  }

  private renderField(item: FieldModel): HTMLElement {
    const wrapper = el("div", { className: `ab-field ab-field-${item.kind}` });
    const id = `ab-field-${item.name.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
    const label = el("label", { className: "ab-field-label", text: item.label, attrs: { for: id } });
    if (!item.required) label.append(el("span", { className: "ab-muted", text: " (optional)" }));
    wrapper.append(label);
    if (item.description) wrapper.append(el("p", { className: "ab-hint", text: item.description }));
    wrapper.append(this.renderControl(item, id));
    wrapper.append(
      el("p", {
        className: "ab-field-error",
        text: this.shownError(item.name),
        attrs: { "data-field-error": item.name, role: "status" },
      }),
    );
    return wrapper;
  }

  private renderControl(item: FieldModel, id: string): HTMLElement {
    const disabled = !this.context.canWrite;
    const value = this.value[item.name];
    switch (item.kind) {
      case "multiline":
      case "text": {
        const input =
          item.kind === "multiline"
            ? el("textarea", { className: "ab-textarea", attrs: { id, rows: String(item.rows) } })
            : el("input", { className: "ab-input", attrs: { id, type: "text" } });
        input.value = typeof value === "string" ? value : "";
        if (item.placeholder) input.placeholder = item.placeholder;
        if (typeof item.schema.maxLength === "number") input.maxLength = item.schema.maxLength;
        input.disabled = disabled;
        input.spellcheck = true;
        input.addEventListener("input", () =>
          this.set(item.name, input.value === "" && !item.required ? undefined : input.value),
        );
        return input;
      }
      case "enum": {
        const select = el("select", { className: "ab-select", attrs: { id } });
        if (!item.required || value === undefined) {
          const none = el("option", { text: item.required ? "Choose…" : "—" });
          none.value = "";
          select.append(none);
        }
        item.options.forEach((option, index) => {
          const node = el("option", { text: optionLabel(option) });
          node.value = String(index);
          if (JSON.stringify(option) === JSON.stringify(value)) node.selected = true;
          select.append(node);
        });
        select.disabled = disabled;
        select.addEventListener("change", () =>
          this.set(item.name, select.value === "" ? undefined : structuredClone(item.options[Number(select.value)])),
        );
        return select;
      }
      case "integer":
      case "number": {
        const input = el("input", { className: "ab-input ab-input-number", attrs: { id, type: "number" } });
        if (typeof item.schema.minimum === "number") input.min = String(item.schema.minimum);
        if (typeof item.schema.maximum === "number") input.max = String(item.schema.maximum);
        input.step = item.kind === "integer" ? "1" : "any";
        input.value = typeof value === "number" ? String(value) : "";
        input.disabled = disabled;
        input.addEventListener("input", () => this.set(item.name, coerce(item.kind, input.value)));
        return input;
      }
      case "boolean": {
        const input = el("input", { attrs: { id, type: "checkbox" } });
        input.checked = value === true;
        input.disabled = disabled;
        input.addEventListener("change", () => this.set(item.name, input.checked));
        return input;
      }
      case "list":
        return this.renderList(item, disabled);
      case "objectList":
        return this.renderObjectList(item, disabled);
      case "object":
        return this.renderObject(item, disabled);
      case "map":
        return this.renderMap(item, disabled, false);
      case "files":
        return this.renderMap(item, disabled, true);
      default:
        return this.renderJsonField(item, id, disabled);
    }
  }

  private renderList(item: FieldModel, disabled: boolean): HTMLElement {
    const list = el("div", { className: "ab-list-editor" });
    const values = Array.isArray(this.value[item.name]) ? [...(this.value[item.name] as Json[])] : [];
    const commit = () => this.set(item.name, values.length === 0 && !item.required ? undefined : [...values]);
    values.forEach((entry, index) => {
      const input = el("input", {
        className: "ab-input",
        attrs: { type: item.itemKind === "integer" || item.itemKind === "number" ? "number" : "text" },
      });
      input.value = entry === undefined || entry === null ? "" : String(entry);
      input.disabled = disabled;
      if (item.itemPlaceholder) input.placeholder = item.itemPlaceholder;
      input.addEventListener("input", () => {
        values[index] = coerce(item.itemKind, input.value);
        commit();
      });
      const remove = el("button", { className: "ab-button ab-button-ghost", text: "Remove" });
      remove.type = "button";
      remove.disabled = disabled;
      remove.addEventListener("click", () => {
        values.splice(index, 1);
        commit();
        this.render();
      });
      list.append(el("div", { className: "ab-list-row" }, input, remove));
    });
    const maxItems = typeof item.schema.maxItems === "number" ? item.schema.maxItems : 64;
    const add = el("button", { className: "ab-button ab-button-ghost", text: "Add" });
    add.type = "button";
    add.disabled = disabled || values.length >= maxItems;
    add.addEventListener("click", () => {
      values.push(item.itemKind === "boolean" ? false : "");
      commit();
      this.render();
    });
    list.append(add);
    return list;
  }

  private renderObjectList(item: FieldModel, disabled: boolean): HTMLElement {
    const list = el("div", { className: "ab-list-editor" });
    const rows = Array.isArray(this.value[item.name])
      ? (this.value[item.name] as Json[]).map((row) => (isRecord(row) ? { ...row } : {}))
      : [];
    const commit = () => this.set(item.name, rows.length === 0 && !item.required ? undefined : rows.map((row) => ({ ...row })));
    rows.forEach((row, index) => {
      const line = el("div", { className: "ab-list-row" });
      for (const column of item.columns) {
        const input = el("input", {
          className: "ab-input",
          attrs: {
            type: column.kind === "integer" || column.kind === "number" ? "number" : "text",
            "aria-label": `${item.label} ${index + 1} ${column.label}`,
            placeholder: column.label,
          },
        });
        const current = row[column.name];
        input.value = current === undefined || current === null ? "" : String(current);
        input.disabled = disabled;
        input.addEventListener("input", () => {
          const next = coerce(column.kind, input.value);
          if (next === undefined || (next === "" && !column.required)) delete row[column.name];
          else row[column.name] = next;
          commit();
        });
        line.append(input);
      }
      const remove = el("button", { className: "ab-button ab-button-ghost", text: "Remove" });
      remove.type = "button";
      remove.disabled = disabled;
      remove.addEventListener("click", () => {
        rows.splice(index, 1);
        commit();
        this.render();
      });
      line.append(remove);
      list.append(line);
    });
    const maxItems = typeof item.schema.maxItems === "number" ? item.schema.maxItems : 64;
    const add = el("button", { className: "ab-button ab-button-ghost", text: `Add ${item.label.toLowerCase()}` });
    add.type = "button";
    add.disabled = disabled || rows.length >= maxItems;
    add.addEventListener("click", () => {
      const row: Record<string, Json> = {};
      for (const column of item.columns) if (column.required && column.kind !== "integer" && column.kind !== "number") row[column.name] = "";
      rows.push(row);
      commit();
      this.render();
    });
    list.append(add);
    return list;
  }

  private renderObject(item: FieldModel, disabled: boolean): HTMLElement {
    const group = el("fieldset", { className: "ab-fieldset" });
    const current = isRecord(this.value[item.name]) ? { ...(this.value[item.name] as Record<string, Json>) } : {};
    for (const column of item.columns) {
      const input = el("input", {
        className: "ab-input",
        attrs: {
          type: column.kind === "integer" || column.kind === "number" ? "number" : "text",
          "aria-label": `${item.label} ${column.label}`,
          placeholder: column.label,
        },
      });
      const value = current[column.name];
      input.value = value === undefined || value === null ? "" : String(value);
      input.disabled = disabled;
      input.addEventListener("input", () => {
        const next = coerce(column.kind, input.value);
        // As in an object list: a required field keeps "" and the schema decides.
        if (next === undefined || (next === "" && !column.required)) delete current[column.name];
        else current[column.name] = next;
        this.set(item.name, Object.keys(current).length === 0 && !item.required ? undefined : { ...current });
      });
      group.append(el("label", { className: "ab-inline" }, el("span", { text: column.label }), input));
    }
    return group;
  }

  private renderMap(item: FieldModel, disabled: boolean, files: boolean): HTMLElement {
    const box = el("div", { className: files ? "ab-files" : "ab-list-editor" });
    if (!this.mapRows.has(item.name)) {
      this.mapRows.set(
        item.name,
        isRecord(this.value[item.name]) ? Object.entries(this.value[item.name] as Record<string, Json>) : [],
      );
    }
    const entries = this.mapRows.get(item.name)!;
    const available = files ? this.context.files() : [];
    const held = new Set(available.map((file) => file.fileId));
    // Blank rows are ignored; a half-filled row, or a document the host no
    // longer holds, is a local error that keeps Run disabled.
    const check = () => {
      const empty = (value: Json) => value === "" || value === undefined || value === null;
      const incomplete = entries.some(([key, value]) => (key === "") !== empty(value));
      const stale =
        files && entries.some(([, value]) => typeof value === "string" && value !== "" && !held.has(value));
      const message = stale
        ? "A selected document is no longer held by this host; select it again."
        : incomplete
          ? files
            ? `Each document needs both a ${(item.keyLabel ?? "key").toLowerCase()} and a selected PDF.`
            : "Each entry needs both a key and a value."
          : null;
      if (message) this.localErrors.set(item.name, message);
      else this.localErrors.delete(item.name);
      for (const node of this.root.querySelectorAll<HTMLElement>("[data-field-error]")) {
        if (node.dataset.fieldError === item.name) node.textContent = this.shownError(item.name);
      }
    };
    const commit = () => {
      check();
      const next: Record<string, Json> = {};
      for (const [key, value] of entries) {
        if (key !== "" && value !== "" && value !== undefined && value !== null) next[key] = value;
      }
      this.set(item.name, Object.keys(next).length === 0 && !item.required ? undefined : next);
    };
    check();
    entries.forEach((entry, index) => {
      const key = el("input", {
        className: "ab-input",
        attrs: {
          type: "text",
          "aria-label": `${item.label} ${index + 1} ${item.keyLabel ?? "key"}`,
          placeholder: item.keyPlaceholder ?? item.keyLabel ?? "key",
        },
      });
      key.value = entry[0];
      key.disabled = disabled;
      key.addEventListener("input", () => {
        entries[index] = [key.value, entries[index]![1]];
        commit();
      });
      let valueControl: HTMLElement;
      if (files) {
        const select = el("select", {
          className: "ab-select",
          attrs: { "aria-label": `${item.label} ${index + 1} document` },
        });
        const none = el("option", { text: available.length > 0 ? "Choose a selected PDF…" : "No PDF selected yet" });
        none.value = "";
        select.append(none);
        for (const file of available) {
          const option = el("option", { text: `${file.displayName} · ${bytes(file.bytes)}` });
          option.value = file.fileId;
          if (entry[1] === file.fileId) option.selected = true;
          select.append(option);
        }
        select.disabled = disabled;
        select.addEventListener("change", () => {
          entries[index] = [entries[index]![0], select.value];
          commit();
        });
        valueControl = select;
      } else {
        const input = el("input", {
          className: "ab-input",
          attrs: { type: "text", "aria-label": `${item.label} ${index + 1} value` },
        });
        input.value = entry[1] === undefined || entry[1] === null ? "" : String(entry[1]);
        input.disabled = disabled;
        input.addEventListener("input", () => {
          entries[index] = [entries[index]![0], input.value];
          commit();
        });
        valueControl = input;
      }
      const remove = el("button", { className: "ab-button ab-button-ghost", text: "Remove" });
      remove.type = "button";
      remove.disabled = disabled;
      remove.addEventListener("click", () => {
        entries.splice(index, 1);
        commit();
        this.render();
      });
      box.append(el("div", { className: "ab-list-row" }, key, valueControl, remove));
    });
    const add = el("button", {
      className: "ab-button ab-button-ghost",
      text: files ? "Add a document" : "Add an entry",
    });
    add.type = "button";
    add.disabled = disabled || (files && !this.context.fileSelection());
    add.addEventListener("click", () => {
      entries.push(["", ""]);
      commit();
      this.render();
    });
    box.append(add);
    if (files) box.append(this.renderFilePicker(disabled));
    return box;
  }

  private renderFilePicker(disabled: boolean): HTMLElement {
    const box = el("div", { className: "ab-file-picker" });
    if (!this.context.fileSelection()) {
      box.append(
        el("p", {
          className: "ab-hint",
          text:
            "Document selection is not enabled on this host: an operator must configure " +
            "plugins.entries.agent-browser.config.localFiles.roots.",
        }),
      );
      return box;
    }
    const files = this.context.files();
    if (files.length > 0) {
      box.append(
        el(
          "ul",
          { className: "ab-list" },
          ...files.map((file) =>
            el(
              "li",
              {},
              el("span", { text: file.displayName }),
              el("span", {
                className: "ab-muted",
                text: ` · ${bytes(file.bytes)} · ${file.mediaType} · id ${file.fileId.slice(0, 13)}…`,
              }),
            ),
          ),
        ),
      );
    }
    if (!this.context.selectFile) return box;
    const form = el("form", { className: "ab-address" });
    const input = el("input", {
      className: "ab-url",
      attrs: {
        type: "text",
        name: "document-path",
        placeholder: "/absolute/path/to/paper.pdf",
        "aria-label": "Path of a PDF to select",
        spellcheck: "false",
        autocomplete: "off",
      },
    });
    input.disabled = disabled;
    const status = el("p", { className: "ab-field-error", attrs: { role: "status" } });
    const submit = el("button", { className: "ab-button ab-button-ghost", text: "Select PDF" });
    submit.type = "submit";
    submit.disabled = disabled;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const path = input.value.trim();
      if (!path || !this.context.selectFile) return;
      submit.disabled = true;
      void this.context.selectFile(path).then((selected) => {
        submit.disabled = disabled;
        if (selected) {
          input.value = "";
          status.textContent = "";
          this.render();
        } else {
          status.textContent = "That file could not be selected.";
        }
      });
    });
    form.append(input, submit);
    box.append(
      form,
      el("p", {
        className: "ab-hint",
        text:
          `PDFs only, from: ${this.context.fileRoots().join(", ") || "the configured directories"}. ` +
          "The host copies the file once and the package receives only an opaque id — never the path.",
      }),
      status,
    );
    return box;
  }

  private renderJsonField(item: FieldModel, id: string, disabled: boolean): HTMLElement {
    const area = el("textarea", {
      className: "ab-json-editor",
      attrs: { id, rows: "6", spellcheck: "false" },
    });
    const value = this.value[item.name];
    area.value = value === undefined ? "" : JSON.stringify(value, null, 2);
    area.disabled = disabled;
    area.addEventListener("input", () => {
      if (area.value.trim() === "") {
        this.localErrors.delete(item.name);
        this.set(item.name, undefined);
        return;
      }
      try {
        const parsed = JSON.parse(area.value) as Json;
        this.localErrors.delete(item.name);
        this.set(item.name, parsed);
      } catch {
        this.localErrors.set(item.name, "Not valid JSON.");
        this.emit();
      }
      for (const node of this.root.querySelectorAll<HTMLElement>("[data-field-error]")) {
        if (node.dataset.fieldError === item.name) node.textContent = this.localErrors.get(item.name) ?? "";
      }
    });
    return area;
  }
}
