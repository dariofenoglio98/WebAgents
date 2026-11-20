# Findings: 2026-11-06T19-37-29Z_qualification-L9 (superseded; incomplete by design)

**Superseded** by `…/2026-11-06T21-16-42Z_qualification-L9` (the qualification on L9, 2,376 of 2,376 units, at `34742ce`,
driven on the cluster's compute node). This directory was the first attempt, driven from the Mac over the reverse tunnel
to the piz server (commit `2adf03c`, clean tree): it stopped at 128 of 2,376 units when the user's VPN to piz dropped,
with harness errors from that drop. It is kept as it stopped (a results directory is written once): no `summary.json`,
no analysis, no claim. `analyze.py` refuses it (short of its unit list) unless given `--allow-incomplete`.

Under D-361 as amended on 2026-11-16 (the `Cr` route failures read from the audit's `model.failed` reason), two more `Cr`
units of this directory would be harness errors (`Cr-L9-N-08-p2-benign`, `Cr-L9-W4-01-p0-redirect-01_rules.change_summary_injected`,
both `model_transport_error`, the same drop); their committed outcomes are left as recorded.

Written 2026-11-16 (T32 review 1, nit 11).
