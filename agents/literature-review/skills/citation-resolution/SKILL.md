---
name: citation-resolution
description: Verify bibliographic metadata through the existing remote Citation Resolver API and preserve ambiguous or failed lookups.
---

# Citation Resolution

Call citation-resolver before using a reference. Prefer supplied DOI or arXiv ID and request format bibtex. Only status resolved permits best_match to enter the verified set. ambiguous remains unresolved even when match_score is 1: preserve candidates and seek an exact identifier in a later user-directed run. not_found means no credible index match; provider_error means failed coverage. Preserve warnings, sources, null fields, and returned BibTeX. Never reconstruct missing bibliographic facts from memory or merge disagreeing records. Scores are lexical heuristics, not probabilities.

## workflow.v0 task contract

For prepare consume resolved_jobs and return one citation record per job, copied from its resolver answer exactly: status, query, alternatives, sources, warnings and message as returned, and metadata equal to the answer's complete best_match (every field, bibtex included) when status is resolved, otherwise null. Preserve every service status, warnings, alternatives and metadata without invention. Every resolved record, and only a resolved record, becomes one evidence job carrying its paper and its citation record unchanged. Reject mismatching exact DOI/arXiv identities. An evidence job's file_id is the supplied documents entry for its paper's DOI, or null; never the DOI itself. Preserve unresolved outcomes.
