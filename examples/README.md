# Recorded runs and reproduction

For this milestone, use [the workflow demo commands](../docs/workflow-migration.md#commands)
and `literature-review-input.json` / `meeting-agenda-input.json` with their matching
grants. Current deterministic demo outputs are in `workflow-review/` and
`workflow-agenda/`. The live runs below are preserved historical results; reproduce
them with `python -m agentpkg.dev.legacy_cli` and
`dist/literature-review-legacy.agent.pkg`, using the original publisher key.


All recorded runs use the signed reference artifact whose package digest is `20a35b6db17127ae52809e84e23e23994d9fbad235d91882b136f36fc4c547a5`. Run outputs are evidence about this prototype, not independent certification.

| Directory | Meaning |
|---|---|
| `demo-offline` | Final synthetic fixture run; three bibliography entries, ten evidence items, no model calls |
| `eval-results` | Final 22/22 deterministic eval receipt; semantic evals not run |
| `demo-live` | Initial real discovery run; exposed numeric-seed keyword pollution |
| `demo-live-final` | Corrected topic-query run with all four seeds retained; metadata-only ACL seeds stayed `maybe` |
| `demo-live-fulltext` | Final real run with two selected public ACL PDFs; see exact summary in `verification/live-fulltext-summary.json` |
| `execution-offline` | The full artifact set of one **package execution**: the real runner, interpreter and protocol, with a scripted provider so it is deterministic and spends nothing. See [package execution](../docs/package-execution.md). |
| `verification` | Test logs/JUnit, artifact/wheel verification, staging receipt and live source hashes |
| `openclaw-workspace` | Locally staged supported skill workspace, excluded from Git |

The Milestone 3B2 live acceptance evidence, all against `meeting-agenda` 0.2.1 on a local `ollama/qwen3.5:9b`:

| File | What it records |
|---|---|
| `verification/meeting-agenda-live-run-local-v021.json` | **the passing run** — the whole lifecycle, the run record, the agenda and the run plan before and after |
| `verification/meeting-agenda-021-untrusted-open.json` | what the Agent Browser said about the rotated signer *before* any trust decision |
| `verification/meeting-agenda-021-router-probe.json` | one host-owned model call on the selected model, no workflow |
| `verification/meeting-agenda-local-step-latency.json` | the per-node latency the 0.2.1 timing policy was set from |
| `verification/meeting-agenda-structured-output-conformance.json` | four local models × three nodes, with and without constrained decoding |
| `verification/meeting-agenda-021-*-tests.*`, `-plugin-verify.json`, `-browser-verification.json` | the suites and verification scripts for that state of the tree |

The earlier `meeting-agenda-live-run.json`, `-local.json` and `-qwen35-9b.json` are the preserved 0.2.0 failures (hosted-credential refusal, then the 60 s step timeout) that motivated 0.2.1.

The live outputs use an extractive baseline. Structural success does not certify relevance: some off-topic works passed lexical screening. Two arXiv provider failures remain unresolved. Read [the implementation report](../docs/implementation-report.md) before interpreting the output as research.

## Reproduce the final live demo

Commands below run from the repository root. They fetch two public PDFs from ACL Anthology into host storage, outside the package. The source pages are [MasRouter](https://aclanthology.org/2025.acl-long.757/) and [AgentDropout](https://aclanthology.org/2025.acl-long.1170/). Downloads and scholarly services may change; the recorded run's exact hashes are in `verification/live-pdf-sources.json`.

```sh
mkdir /private/tmp/webagents-demo-inputs
curl --fail --proto '=https' --max-time 60 \
  https://aclanthology.org/2025.acl-long.757.pdf \
  -o /private/tmp/webagents-demo-inputs/masrouter.pdf
curl --fail --proto '=https' --max-time 60 \
  https://aclanthology.org/2025.acl-long.1170.pdf \
  -o /private/tmp/webagents-demo-inputs/agentdropout.pdf
python3 - <<'PY'
import json
from pathlib import Path
root = Path('/private/tmp/webagents-demo-inputs')
(root / 'selected-files.json').write_text(json.dumps({
    'masrouter': str(root / 'masrouter.pdf'),
    'agentdropout': str(root / 'agentdropout.pdf'),
}, indent=2) + '\n')
PY
agentpkg/.venv/bin/agentpkg run dist/literature-review.agent.pkg \
  --mode live --trust-key examples/keys/publisher.pub.pem \
  --question 'Dynamic agent selection and topology adaptation in multi-agent LLM systems' \
  --seed 'arXiv:2602.06039' --seed 'arXiv:2602.17100' \
  --seed '10.18653/v1/2025.acl-long.757' --seed '10.18653/v1/2025.acl-long.1170' \
  --grants examples/grants.live-pdfs.json \
  --pdf-map examples/live-pdf-map.json \
  --selected-files /private/tmp/webagents-demo-inputs/selected-files.json \
  --out examples/my-live-review
```

Use new input/output paths if these already exist. `grants.live-pdfs.json` authorizes only declared scholarly/resolver network permissions, selected-PDF reading and session memory; model use remains denied. Downloading the two files above is an explicit host preparation step, not an undeclared runtime network operation. The workflow itself does not fetch URLs found inside metadata or papers.

For the deterministic offline reproduction, use the root [README](../README.md). Its full-text fixture is synthetic page data, clearly distinguished from the real selected PDFs above. A configured, compatible model router and explicit model grant are necessary to test real semantic reasoning; `router-config.example.json` is configuration documentation, not a deployed endpoint.
