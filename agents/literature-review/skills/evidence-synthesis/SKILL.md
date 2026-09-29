---
name: evidence-synthesis
description: Organize verified evidence by methods and cautiously compare themes while retaining claim-to-evidence links.
---

# Evidence Synthesis

Group papers by meaningful methodological relationships and report differences supported by evidence IDs. Distinguish source quotations from model synthesis: a direct_quote claim cites exactly one evidence item and leaves text null for the graph to materialize; any reworded or combined claim is model_synthesis. Gaps concern the reviewed evidence, not all literature; absent reporting is not proof of absence. Every scientific claim must reference evidence and paper IDs, copied character for character from the supplied evidence items. When the supplied evidence supports no claim about the question, return no themes and no claims rather than writing unsupported ones. Do not turn qualitative support categories into calibrated probabilities.

## Direct quotes (0.2.4)

For a direct_quote claim, select exactly one evidence_id and its one paper_id, and set text to null. Never transcribe the quote. The graph attaches the exact trusted evidence quote after verification and checks it again in final validation. For model_synthesis claims, write the paraphrase in text as before. The related_work prose may summarize supported findings but must not reproduce direct quotations; exact quotations belong to the deterministically materialized claims and evidence table.
