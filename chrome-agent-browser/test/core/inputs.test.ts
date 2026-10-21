/** Input switches that need a host read (D-273, B-219), derived from the graph alone. */
import { describe, expect, it } from "vitest";

import { inputGatedReads } from "../../src/core/inputs.js";
import { loadPackageBytes } from "../../src/core/package.js";
import { readBytes, SHIPPED } from "../helpers/paths.js";

describe("inputGatedReads", () => {
  it("links Literature Review 0.2.9's use_profile switch to the research profile read, its permission and type", async () => {
    const pkg = await loadPackageBytes(readBytes(SHIPPED.literatureReview029.archive));
    expect(inputGatedReads(pkg)).toEqual([{ input_key: "use_profile", state_key: "use_profile", tool_id: "research.profile", node_id: "profile", permission_ids: ["memory.research_profile"], resource_types: ["research.profile"] }]);
  });

  it("finds no switch in WebAir 0.7.0 (its profile read is decided by the model, not by an input switch) nor in Meeting Agenda", async () => {
    for (const shipped of [SHIPPED.webair070, SHIPPED.meetingAgenda]) {
      const pkg = await loadPackageBytes(readBytes(shipped.archive));
      expect(inputGatedReads(pkg)).toEqual([]);
    }
  });
});
