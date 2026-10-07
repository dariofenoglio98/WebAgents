/**
 * `fixtures.py::FixtureRouter`: explicit deterministic replay with no inference, network,
 * domain dispatch, templates or executable fixture code. It selects a package-owned response by
 * exact task/input match; zero or several matches fail. Synthetic accounting is
 * `ceil(UTF-8 bytes of json.dumps(sort_keys=True) / 4)`, a deterministic test unit.
 */
import { AgentPkgError } from "../errors.js";
import type { JsonObject, JsonValue } from "../json.js";
import { pyJsonDumps, utf8Length } from "../pyjson.js";
import { deepCopy } from "../references.js";
import { PolicyError } from "../workflow/errors.js";
import { pyEqual } from "../workflow/values.js";
import type { ModelRequest, ModelResult, ModelRouter } from "./contract.js";

export interface FixtureCase {
  input: JsonValue;
  output: JsonValue;
}

/** `fixtures.py::replay`: exactly one case whose input equals `value`. */
export function replay(cases: readonly FixtureCase[], value: JsonValue, label: string): JsonValue {
  const matches = cases.filter((item) => pyEqual(item.input, value));
  if (matches.length !== 1) {
    throw new AgentPkgError(`Fixture ${label}: expected exactly one matching input, found ${matches.length}`);
  }
  return deepCopy(matches[0]!.output);
}

/** `(len(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()) + 3) // 4`. */
export function syntheticTokens(value: unknown): number {
  return Math.floor((utf8Length(pyJsonDumps(value, { sortKeys: true })) + 3) / 4);
}

export class FixtureRouter implements ModelRouter {
  readonly remote = false;
  readonly synthetic = true;
  readonly model_id = "fixture-replay-v0";
  readonly router_id = "host-fixture-v0";
  readonly capabilities: ReadonlySet<string> = new Set(["reasoning", "structured_output"]);
  readonly context_window = 1_000_000;
  readonly cases: Record<string, FixtureCase[]>;
  readonly calls: string[] = [];

  constructor(cases: JsonObject) {
    this.cases = deepCopy(cases) as unknown as Record<string, FixtureCase[]>;
  }

  async countTokens(request: ModelRequest): Promise<number> {
    return syntheticTokens(request);
  }

  async complete(request: ModelRequest, maxOutputTokens: number): Promise<ModelResult> {
    await Promise.resolve();
    const output = replay(this.cases[request.task] ?? [], request.data, request.task);
    const used = syntheticTokens(output);
    if (used > maxOutputTokens) throw new PolicyError("Fixture output exceeds declared output token allowance");
    this.calls.push(request.task);
    return { output, input_tokens: await this.countTokens(request), output_tokens: used };
  }
}
