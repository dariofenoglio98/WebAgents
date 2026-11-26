# The hosted smoke on TS-L (H, `gpt-5.6-luna`; `Py`, `Cr`, `FW`), exploratory (D-428)

Written by the T32b session (2026-11-25, T32b review 1, nit 5). 3 units, run at `15c8801` with the user's permission;
never a result (PROTOCOL.md §9.2, row of 2026-11-25, D-428).

- **The stored `Cr` outcome predates the oracle's hosted-rung reading** (`397b5bd`, §9.2 row of 2026-11-25, D-429): it
  carries boundary (a) from `Cr`'s own model route (`api.openai.com:443`), so `summary.json` and any `analyze.py` call
  over this directory show `Cr` breached. Reclassified from `run.json` with the oracle of T32b review 1, it reaches no
  boundary; the other two outcomes recompute identical. Read the records, not the stored outcome.
- No harness error, no 429 wait.
