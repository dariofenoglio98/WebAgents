/**
 * Argument parsing for the CLI, with `argparse`'s refusals (T1 review 2, nit 12).
 *
 * agentpkg's CLI is built on `argparse`, which exits with status 2 and one of a few fixed
 * messages when the command line does not fit: `unrecognized arguments: …` for an unknown
 * flag or a surplus positional, `argument --x: expected one argument` for a flag without its
 * value, and `the following arguments are required: …` for a missing required one. This
 * module reproduces those three refusals so that a mistyped flag is a refusal in both CLIs
 * rather than a silently ignored word in one of them. Values that start with `--` are not
 * taken as values, as argparse does not take them.
 */

export type OptionKind = "value" | "flag" | "list";

export interface OptionSpec {
  kind: OptionKind;
  required?: boolean;
  /** An allowed set, refused with argparse's `invalid choice` wording otherwise. */
  choices?: readonly string[];
  default?: string;
}

export interface ArgumentSpec {
  /** Positional names in order; every one is required. */
  positional: readonly string[];
  options: Readonly<Record<string, OptionSpec>>;
}

export class ArgumentError extends Error {
  override readonly name = "ArgumentError";
}

export class ParsedArguments {
  constructor(
    readonly positional: Readonly<Record<string, string>>,
    private readonly options: ReadonlyMap<string, string | string[] | true>,
  ) {}

  value(name: string): string | null {
    const found = this.options.get(name);
    return typeof found === "string" ? found : null;
  }

  list(name: string): string[] {
    const found = this.options.get(name);
    return Array.isArray(found) ? [...found] : [];
  }

  flag(name: string): boolean {
    return this.options.get(name) === true;
  }
}

/** Parse `args` for `command` against `spec`, or throw an `ArgumentError` with argparse's wording. */
export function parseArguments(command: string, args: readonly string[], spec: ArgumentSpec): ParsedArguments {
  const positional: string[] = [];
  const options = new Map<string, string | string[] | true>();
  const unrecognized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token.startsWith("--") && token.length > 2) {
      const [name, inline] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
      const option = spec.options[name];
      if (option === undefined) {
        unrecognized.push(token);
        continue;
      }
      if (option.kind === "flag") {
        if (inline !== undefined) throw new ArgumentError(`argument ${name}: ignored explicit argument '${inline}'`);
        options.set(name, true);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = args[index + 1];
        if (next === undefined || (next.startsWith("--") && next.length > 2)) {
          throw new ArgumentError(`argument ${name}: expected one argument`);
        }
        value = next;
        index += 1;
      }
      if (option.choices && !option.choices.includes(value)) {
        throw new ArgumentError(
          `argument ${name}: invalid choice: '${value}' (choose from ${option.choices.map((choice) => `'${choice}'`).join(", ")})`,
        );
      }
      if (option.kind === "list") {
        const existing = options.get(name);
        options.set(name, Array.isArray(existing) ? [...existing, value] : [value]);
      } else {
        options.set(name, value);
      }
      continue;
    }
    if (positional.length < spec.positional.length) positional.push(token);
    else unrecognized.push(token);
  }
  if (unrecognized.length > 0) throw new ArgumentError(`unrecognized arguments: ${unrecognized.join(" ")}`);
  const missing: string[] = [];
  for (let index = positional.length; index < spec.positional.length; index += 1) missing.push(spec.positional[index]!);
  for (const [name, option] of Object.entries(spec.options)) {
    if (option.required && !options.has(name)) missing.push(name);
    if (!options.has(name) && option.default !== undefined) options.set(name, option.default);
  }
  if (missing.length > 0) throw new ArgumentError(`${command}: the following arguments are required: ${missing.join(", ")}`);
  const named: Record<string, string> = {};
  spec.positional.forEach((name, index) => {
    named[name] = positional[index]!;
  });
  return new ParsedArguments(named, options);
}
