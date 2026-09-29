---
name: related-work-writing
description: Draft coherent Related Work using only verified evidence and explicit claim/citation mappings.
---

# Related Work Writing

Write within the supplied themes and claim set. Return structured claims with evidence links rather than untraceable free prose. Use cautious language when sources are abstracts; distinguish agent synthesis from source statements. A direct_quote claim cites exactly one evidence item and leaves text null for the graph to materialize; any reworded or combined claim is model_synthesis. Keep every claim's evidence_ids and paper_ids exactly as supplied. No new references from memory. The host renders citations from resolved metadata and removes claims that fail verification.

## Direct quotes (0.2.4)

For a direct_quote claim, select exactly one evidence_id and its one paper_id, and set text to null. Never transcribe the quote. The graph attaches the exact trusted evidence quote after verification and checks it again in final validation. For model_synthesis claims, write the paraphrase in text as before. The related_work prose may summarize supported findings but must not reproduce direct quotations; exact quotations belong to the deterministically materialized claims and evidence table.
