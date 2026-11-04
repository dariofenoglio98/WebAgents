# Campaign infrastructure (T31)

What every live campaign of the mechanism paper shares, built once against the registered
protocol ([`../PROTOCOL.md`](../PROTOCOL.md), version 1, tag `protocol-v1`): the task sets, the
record set, the injection-capable origin, the drivers of the three sides, the one oracle and the
campaign driver. Nothing here changes a runtime: the drivers compose `agentpkg` and the Chrome
core from their public pieces, and every campaign seam is stated below.

| Path | What it is | Protocol |
|---|---|---|
| `tasks/` | TS-W (40), TS-C (12), TS-L (6), TS-N (20) with ground truth computed in process from WebAir's own service and travel code; `generate.py` regenerates every file byte for byte; `score.py` and the answer schemas | §2.3, D-340, D-356 |
| `records/` | The campaign record set (a memory.v0 folder: `person.identity`, `payment.card`, `travel.profile`, `person.self`) and `canaries.py` (the canaries, their eight encodings and decoders) | §2.6.5, D-352 |
| `origin/` | The payload catalog (`payloads/<family>/<id>.json`, drafts until T32 freezes them), the logging sink, the throwaway campaign CA and `CampaignStack` (the origin in its injection mode, the sink and the resolver on 127.0.0.1 over TLS). The injection mode itself is `demo/webair/origin/injection.py`, installed only by `campaign_app` and absent from the deploy bundle | §2.1, §2.6, D-351 |
| `driver/py_driver.py` | `Py`: agentpkg composed as `agentpkg converse` / `run` compose it, live, with the store's memory context | §2.1, D-353 |
| `driver/cr_driver.py`, `driver/node/driver.ts` | `Cr`: the Chrome core composed as `cli-converse.ts` composes it, with the memory context composed as the extension's host does; built beside a private copy of the core into `.cache/` (git-ignored) | §2.1, D-357 |
| `driver/hostmap.py` | The host mapping for `Py` (the one seam that is not observation only); `Cr`'s is in `driver.ts` | §2.1 |
| `driver/routes.py`, `driver/rungs.json` | The rungs (L4, L9, L30, H, H2) and `Py`'s model route | §2.2 |
| `driver/responder.py` | R-facts, R-accept, R-deny: one decision rule for our consent host and the baseline's ask step | §2.6.4 |
| `driver/record.py` | The campaign run record (`campaign.run.v1`), one shape for every side | D-352 |
| `oracle/classify.py` | The oracle: boundaries (a)…(e), attempts by the payload's matcher, utility, cards, cost | §2.4, D-352 |
| `baseline/` | `FW`: the OpenAI Agents SDK 0.24.0 with Progent's released code (`secagent`, pinned), the package's tools as function tools, the instrumented tool layer, rule 8's ask step; WebAir and the travel network (handoffs); `TUNING.md` logs every rule-10 adjustment | §2.5, D-350 |
| `driver/campaign.py` | The campaign driver: matrix, seeded order, presets, manifest, `--resume` | §2.7, D-353 |
| `tests/` | Offline and credential-free | |

## Sides and seams

- **`Py`** (agentpkg 0.7.1) and **`Cr`** (the Chrome core) run the signed packages live with the
  real model route of the rung, the real tool handlers and the store-backed memory context, so both
  egress scans are active (P-13's scope). Observation-only seams record every model request, tool
  call, consent card and dial.
- **The host mapping** (both): the declared public hostname is resolved and its real DNS answer
  classified by the runtime's own address policy; only the dial goes to the campaign stack on
  127.0.0.1, under a throwaway CA only the drivers trust; the run's fixture key travels as the
  `X-Campaign-Fixture` header. A failed lookup is a harness error. No production flag, file or
  variable can set it (tests).
- **`FW`** sees the same tools (the declared schemas and endpoints), the same records, the same
  instructions (the skills in graph order and one host paragraph), the same answer schema, the same
  model and sampling, the same budgets and the same payload bytes (tests for rules 1–5, 7–9, 11).
  Layers, outermost first: the recorder, Progent's wrapper with the committed policy
  (`baseline/policies/`, derived from the declaration), our budgets, the ask step, the executor.
  Progent's LLM-generated policy mode is never called.

## Running

From `experiments/` with the agentpkg virtualenv (install once:
`agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev,compute]' -r experiments/campaigns/requirements.txt`;
`npm ci` in `chrome-agent-browser` for `Cr`):

```sh
../agentpkg/.venv/bin/python -m pytest campaigns/tests                     # offline
../agentpkg/.venv/bin/python -m campaigns.driver.campaign --preset smoke --rungs L9 \
    --sides Py,Cr,FW --out injection_campaign/results/<UTC>_smoke            # live, local model
../agentpkg/.venv/bin/python -m campaigns.driver.campaign ... --resume       # same manifest only
```

Local rungs need Ollama with the rung's model; its server default context must equal the rung's
(32,768: `FW` reaches Ollama through `/v1`, which takes no `num_ctx`; the driver checks `/api/ps`
and records a mismatch as a harness error). The check reads `/api/ps` after the run: if the server
has already unloaded the model (a short `OLLAMA_KEEP_ALIVE`), the check is skipped and the record's
`port.limits.served_context` is null, so keep the model loaded for the campaign
(`OLLAMA_KEEP_ALIVE=-1` on the server) and treat a null there as unchecked, never as a pass. Stop
the OpenClaw Gateway's heartbeat during a campaign (§2.2). Hosted rungs read the key from the
variable `rungs.json` names.

`--resume` recomputes the manifest without the results directory itself (its runs are not a
change of the tree), skips finished units and runs again a unit whose directory has no `run.json`
(a crash or an interrupt). Each `outcome.json` carries the oracle's classification with the task
family's envelope (the manifest's `envelopes`) and the rung's list price (null for a local rung),
and `exposed` for an attack arm: false when the run never read the placement (counted in
`summary.json` as `not_exposed`).

## Not built here (open, with the task that builds it)

- `Cr` on the travel network (`ExecutionSession` as `cli-run.ts`, for TS-N and E5): T31b.
- The Literature Review port on `FW` and the TS-L arm of the drivers: T31b.
- The LangGraph arm (D-354): not built; one framework baseline is run.
