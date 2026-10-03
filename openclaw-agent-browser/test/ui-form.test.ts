/**
 * The task form's object fields: a required object whose fields declare defaults starts from
 * them, and a required field cleared to "" keeps "" (the package's schema decides whether that
 * is valid), exactly as an object list's rows do. Nothing here is a particular package's: the
 * schema is a made-up "reprint an order" task.
 */
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { TaskForm, buildFormModel, initialValue, type FormContext } from "../src/ui/form.js";

const SCHEMA = {
  type: "object",
  properties: {
    note: { type: "string" },
    order: {
      type: "object",
      properties: {
        order_id: { type: "string", pattern: "^(ORD-[0-9]{4})?$", default: "" },
        copies: { type: "integer", minimum: 1 },
        label: { type: "string" },
      },
      required: ["order_id", "label"],
      additionalProperties: false,
    },
    extra: {
      type: "object",
      properties: { color: { type: "string" } },
      additionalProperties: false,
    },
  },
  required: ["note", "order"],
  additionalProperties: false,
};

const context: FormContext = {
  files: () => [],
  fileSelection: () => false,
  fileRoots: () => [],
  canWrite: true,
};

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("object fields in the task form", () => {
  it("start a required object from the defaults its fields declare, and nothing else", () => {
    const model = buildFormModel(SCHEMA);
    // Only declared defaults: no invented value for `label` or `copies`, no optional object.
    expect(initialValue(model)).toEqual({ note: "", order: { order_id: "" } });
  });

  it("keep a cleared required field as an empty string and drop a cleared optional one", () => {
    const changes: unknown[] = [];
    const form = new TaskForm(buildFormModel(SCHEMA), null, context, (value) => changes.push(value));
    document.body.append(form.root);
    const input = (label: string) => form.root.querySelector<HTMLInputElement>(`input[aria-label="Order ${label}"]`)!;
    type(input("Order id"), "ORD-0042");
    type(input("Label"), "Front desk");
    type(input("Copies"), "2");
    expect(form.current()).toMatchObject({ order: { order_id: "ORD-0042", label: "Front desk", copies: 2 } });
    type(input("Order id"), "");
    type(input("Label"), "");
    type(input("Copies"), "");
    expect((form.current() as Record<string, unknown>).order).toEqual({ order_id: "", label: "" });
    form.root.remove();
  });
});
