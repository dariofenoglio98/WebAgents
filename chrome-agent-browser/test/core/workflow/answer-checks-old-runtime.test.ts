/**
 * An older runtime refuses a package with answer checks at load (D-150): such a package declares
 * runtime minimum 0.3.0, and a 0.2.2 runtime refuses that minimum before reading its graph. This
 * file replaces the supported version with 0.2.2, as `test_answer_checks.py` monkeypatches
 * agentpkg's `__version__`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/version.js", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), SUPPORTED_RUNTIME_VERSION: "0.2.2" }));

import { agendaFiles } from "../../helpers/agenda-checks.js";
import { loadSource } from "../../helpers/source-tree.js";

describe("a 0.2.2 runtime", () => {
  it("refuses a package with answer checks at load, by its declared minimum", async () => {
    await expect(loadSource(agendaFiles())).rejects.toThrow(/manifest runtime\.minimum_version exceeds reference runtime 0\.2\.2/u);
    // The same package without checks, declaring 0.2.2, still loads.
    await expect(loadSource(agendaFiles({ checks: false, minimum: "0.2.2" }))).resolves.toBeDefined();
  });
});
