/**
 * Which `agentpkg-runtime-v0` version this core implements.
 *
 * A manifest's `runtime.minimum_version` may not exceed it (`validation.py`), so this
 * constant is the gate the Python reference applies with its own `__version__`.
 * `test/core/version.test.ts` asserts it equals `agentpkg/src/agentpkg/__init__.py`'s value,
 * so the two runtimes accept the same packages (D-031).
 */
export const SUPPORTED_RUNTIME_VERSION = "0.6.0";
export const RUNTIME_API = "agentpkg-runtime-v0";
export const SUPPORTED_EXECUTION_PROFILES: readonly string[] = Object.freeze(["workflow.v0"]);
export const CORE_VERSION = "0.4.0";

/** `(major, minor, patch)` of a semantic version, prerelease dropped. */
export function release(version: string): number[] {
  return version
    .split("-")[0]!
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

export function compareRelease(a: string, b: string): number {
  const left = release(a);
  const right = release(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
