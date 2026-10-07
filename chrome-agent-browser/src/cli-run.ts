/**
 * `run`: placeholder until the execution core lands in this task; refuses every invocation.
 */
import { ArgumentError } from "./cli-arguments.js";

export async function runCommand(_args: string[]): Promise<number> {
  throw new ArgumentError("run: not implemented yet");
}
