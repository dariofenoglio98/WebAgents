---
name: citation-resolution
description: Verify bibliographic metadata through the existing remote Citation Resolver API and preserve ambiguous or failed lookups.
---

# Citation Resolution

Call citation-resolver before using a reference. Prefer supplied DOI or arXiv ID and request format bibtex. Only status resolved permits best_match to enter the verified set. ambiguous remains unresolved even when match_score is 1: preserve candidates and seek an exact identifier in a later user-directed run. not_found means no credible index match; provider_error means failed coverage. Preserve warnings, sources, null fields, and returned BibTeX. Never reconstruct missing bibliographic facts from memory or merge disagreeing records. Scores are lexical heuristics, not probabilities.
