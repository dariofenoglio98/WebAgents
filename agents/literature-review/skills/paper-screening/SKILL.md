---
name: paper-screening
description: Screen discovered papers for relevance using source text and explicit include, maybe, or exclude rationales.
---

# Paper Screening

Use the question and supplied abstracts or full text to assess methods and research setting. Include only when the available text supports relevance; use maybe for title-only or uncertain cases, and exclude unrelated settings. Preserve a rationale and evidence scope. Similar titles alone do not establish relevance. Heuristic overlap scores are not probabilities.

## workflow.v0 task contract

For screen return the complete input paper with screening_status and rationale. Never include without source text. For select return only records whose screening_status is include, and at most three: when more are included, keep the three whose source text most directly addresses the research question. Preserve every field exactly.
