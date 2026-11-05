# Conformance report and divergence log (E8)

E8 of the pre-registered protocol ([`../PROTOCOL.md`](../PROTOCOL.md) §3 E8, Tab. 10; T38, D-306) answers
three questions: how many cases the two runtimes agree on at the final commit, which differences
are documented, and which divergences the suite and the reviews found and fixed over the history.
It has three inputs, each kept where it lives and cited by path:

- **The conformance run**: `node conformance/run.mjs` at the commit the report names, kept under
  [`conformance/results/<UTC>/`](../../conformance/results/) (its `report.json` records the commit
  and whether the tree was clean).
- **The divergence log**: [`docs/conformance-divergences.md`](../../docs/conformance-divergences.md). It lists every
  cross-runtime difference found in T1…T26 by a conformance case, a test, a review or a live run
  and then fixed or kept as a documented difference. Each row is classified behaviour, wording,
  timing or platform (D-306) and cites its task, its source and the resolving commit.
- **P-19's reviewable path**: [`scripts/check_extension_privileges.py`](../../scripts/check_extension_privileges.py)
  (the manifest's permissions, host permissions, CSP tokens, no static reach into pages, the offscreen
  Worker placement) and `npm run check-pack` in `chrome-agent-browser/` (the packed zip's members
  and permission list), both at the same commit.

```sh
node conformance/run.mjs
agentpkg/.venv/bin/python scripts/check_extension_privileges.py > /tmp/privileges.json
(cd chrome-agent-browser && npm run pack && npm run check-pack) | tail -1 > /tmp/check-pack.json
agentpkg/.venv/bin/python experiments/conformance_report/report.py \
    --conformance conformance/results/<UTC> --privileges /tmp/privileges.json --check-pack /tmp/check-pack.json
```

`report.py` writes a new directory `results/<UTC>/` holding `summary.json`, `report.md` and copies of the two JSON inputs. It computes
every number from the inputs: the cases per family, the agreed ones and the documented differences;
the log's counts by class, resolution, how each item was found, the runtime that differed and the
task; and the two checks. The families are listed by case head in `report.py` (the four extensions,
the control plane, package format and trust, authorization and execution, and the shipped packages
as `<name>-<x.y.z>`); a head no family lists is an error, so a new case family is named before it
is counted (D-307). It passes only when the suite passed on a clean tree, every case that is not a
documented difference agreed, the privileges check passed, the conformance run and the privileges
JSON each name a commit and the same one, check-pack's extension version is the run's Chrome core
(its line names no commit), and the log's summary tables equal what its rows give. A case that
disagrees at the final commit and is not a documented difference is E8's defect.

To recompute a kept report directory, pass its own copies: `--privileges <dir>/privileges.json
--check-pack <dir>/check-pack.json` (`--check-pack` reads a whole JSON file, or the last line of
npm's output) with a new `--out`.

The paper's report directory is listed in [`../README.md`](../README.md).
