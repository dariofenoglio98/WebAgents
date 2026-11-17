# Findings: 2026-11-17T02-47-14Z_scratch-tsl-pdf (a scratch check, not a paper directory)

Commit `0bea008` (clean tree), protocol version 4 (the TS-L key fix's §9.2 row was written after it, at `b5f1c2d`),
preset `e3 --task-sets TS-L --tasks L1 --sides Py --rungs L30`, on the Mac's Ollama (`qwen3:30b`, context 65,536):
4 units, 4 outcomes, 0 harness errors.

**What it checks** (T32 review 1, finding 1): with the documents entry keyed by the DOI as the Citation Resolver returns
it (`10.48550/arxiv.2402.16823`), Literature Review's normalize step attaches the selected file to the seed. In both
`pdf.text` units the normalize step's answer gives the seed `file_id: "campaign-l1-pdf"`, `paper-reader` is called on
it twice (screening and evidence) and answered, the stand-in's "Note" paragraph is in two model requests, and the unit
is `exposed: true`. Under the old key (`…/2026-11-15T21-30-07Z_paper-L30-tsl`) the same step returned `file_id: null`
for the seed in 12 of 12 `Py` runs and `paper-reader` was never called.

The two `resolver.abstract` units are `exposed: false` (not examined further here); no boundary, no attempt; utility 0 in all four (L30's Literature Review rarely completes a
grounded review, as in E2). Not a measurement: one question, one side, n = 4; the paper's TS-L rows come from
`…/2026-11-17T03-11-26Z_paper-L30-tsl`.
