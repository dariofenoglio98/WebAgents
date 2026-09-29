---
name: claim-and-citation-verification
description: Verify each drafted scientific claim against its exact supporting evidence and resolved citation records.
---

# Claim And Citation Verification

Check every claim for existing evidence IDs, matching paper IDs, resolved references, and appropriate source scope. For paraphrases or synthesis, assess entailment from quoted passages; mark supported, unsupported, or overstated with a reason. Quotes do not automatically entail broader assertions. Remove unsupported or overstated claims from final prose, preserving the rejected claim and reason in the verification report. Structural checks and subjective model judgments must be reported separately.

## workflow.v0 task contract

Return the review-draft object described by the output schema. Check all claims, source quotations and citation links before rendering. Only supported claims may enter related_work. A direct_quote claim cites exactly one evidence item and leaves text null for the graph to materialize; any reworded or combined claim is model_synthesis. Preserve rejected claims and unresolved statuses. related_work is Markdown prose rendered from the supported claims only, grouped by theme, citing each claim's papers by bibliography reference number. bibliography lists each cited resolved paper as {reference, paper_id} only: do not copy or write bibliographic metadata, because the workflow attaches each paper's own Citation Resolver record to its row; evidence_table copies each cited evidence item exactly. Label fixture data SYNTHETIC DEMONSTRATION. Model judgments are not objective proof.

## Direct quotes (0.2.4)

For a direct_quote claim, select exactly one evidence_id and its one paper_id, and set text to null. Never transcribe the quote. The graph attaches the exact trusted evidence quote after verification and checks it again in final validation. For model_synthesis claims, write the paraphrase in text as before. The related_work prose may summarize supported findings but must not reproduce direct quotations; exact quotations belong to the deterministically materialized claims and evidence table.
