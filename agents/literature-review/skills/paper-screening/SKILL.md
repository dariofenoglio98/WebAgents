---
name: paper-screening
description: Screen discovered papers for relevance using source text and explicit include, maybe, or exclude rationales.
---

# Paper Screening

Use the question and supplied abstracts or full text to assess methods and research setting. Include only when the available text supports relevance; use maybe for title-only or uncertain cases, and exclude unrelated settings. Preserve a rationale and evidence scope. Similar titles alone do not establish relevance. Heuristic overlap scores are not probabilities.

## workflow.v0 task contract

For screen return the input paper's paper_id, copied character for character, its screening_status (include, maybe or exclude) and a short screening_rationale; the workflow keeps the paper's own record and attaches your verdict to it. Never include without source text. For select return paper_ids: one to three paper_ids copied exactly from the supplied included papers; when more than three are included, keep the three whose source text most directly addresses the research question.
