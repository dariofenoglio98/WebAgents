---
name: claim-and-citation-verification
description: Verify each drafted scientific claim against its exact supporting evidence and resolved citation records.
---

# Claim And Citation Verification

Check every claim for existing evidence IDs, matching paper IDs, resolved references, and appropriate source scope. For paraphrases or synthesis, assess entailment from quoted passages; mark supported, unsupported, or overstated with a reason. Quotes do not automatically entail broader assertions. Remove unsupported or overstated claims from final prose, preserving the rejected claim and reason in the verification report. Structural checks and subjective model judgments must be reported separately.

## workflow.v0 task contract

Return the final review-output object. Check all claims, source quotations and citation links before rendering. Only supported claims may enter related_work. A direct_quote claim cites exactly one evidence item and its text is that item's quote, verbatim; any reworded or combined claim is model_synthesis. Preserve rejected claims and unresolved statuses. related_work is Markdown prose rendered from the supported claims only, grouped by theme, citing each claim's papers by bibliography reference number. bibliography lists each cited resolved paper as {reference, paper_id, metadata} with metadata copied exactly from its citation record; evidence_table copies each cited evidence item exactly. Label fixture data SYNTHETIC DEMONSTRATION. Model judgments are not objective proof.
