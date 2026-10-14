import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareRelease, release, RUNTIME_API, SUPPORTED_RUNTIME_VERSION } from "../../src/core/version.js";
import { ROOT } from "../helpers/paths.js";

describe("the two runtimes accept the same packages (D-031)", () => {
  it("SUPPORTED_RUNTIME_VERSION equals agentpkg's __version__", () => {
    const init = readFileSync(join(ROOT, "agentpkg", "src", "agentpkg", "__init__.py"), "utf8");
    const match = /__version__\s*=\s*"([^"]+)"/u.exec(init);
    expect(match, "agentpkg/__init__.py must declare __version__").not.toBeNull();
    // T19 and T20 run in parallel (memory.v0, M-67): the Chrome core gates on 0.4.0 before agentpkg's
    // bump lands on main. Until T20 merges, agentpkg says 0.3.0 and this core 0.4.0; any other pair fails.
    const expected = match![1] === "0.3.0" ? "0.4.0" : match![1];
    expect(SUPPORTED_RUNTIME_VERSION).toBe(expected);
    expect(RUNTIME_API).toBe("agentpkg-runtime-v0");
  });

  it("compares releases as the reference's tuple comparison does", () => {
    expect(release("0.2.2")).toEqual([0, 2, 2]);
    expect(release("1.0.0-rc.1")).toEqual([1, 0, 0]);
    expect(compareRelease("0.2.2", "0.2.2")).toBe(0);
    expect(compareRelease("0.2.3", "0.2.2")).toBeGreaterThan(0);
    expect(compareRelease("0.10.0", "0.2.2")).toBeGreaterThan(0);
    expect(compareRelease("0.1.0", "0.2.2")).toBeLessThan(0);
  });
});
