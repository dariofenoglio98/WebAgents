# Citation Resolver

A small, deterministic FastAPI service that resolves DOI, arXiv, and title references
against scholarly metadata APIs. It returns normalized metadata, provenance, explicit
uncertainty, and optional BibTeX. No LLM, API keys, database, authentication, or frontend.

This is a precursor experiment in agent-discoverable web services: a generic agent
reads `SKILL.md`, recognizes a previously unknown capability, calls its HTTP API, and
uses the structured result. The agent interprets intent; the service retrieves and
matches metadata. **This project does not implement `agent.pkg` or an OpenClaw plugin.**

## Run locally

Requires Python 3.11+; Railway uses Python 3.13 via `.python-version`.

```sh
cd citation-resolver
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m app
```

The server listens on `0.0.0.0:${PORT:-8000}` with one worker. Open
`http://localhost:8000/docs` for the generated API documentation.
`GET /health` checks the application, without calling providers.

Optional environment variables (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `CONTACT_EMAIL` | Operator contact in User-Agent on all requests and Crossref `mailto` |
| `PUBLIC_BASE_URL` | Public HTTP(S) origin for the hosted skill; recommended behind proxies |
| `ALLOWED_HOSTS` | Additional explicit hostnames, comma-separated, without scheme/port |
| `PORT` | Listening port; default 8000; Railway supplies it |

Environment files are examples only and are not loaded automatically. Export variables
in your shell or configure them in Railway. Never commit personal values or credentials.

```sh
curl -sS http://localhost:8000/health
curl --max-time 40 -sS http://localhost:8000/resolve \
  -H 'Content-Type: application/json' \
  -d '{"query":"https://doi.org/10.1038/nphys1170","format":"bibtex"}'
curl --max-time 40 -sS http://localhost:8000/resolve \
  -H 'Content-Type: application/json' \
  -d '{"query":"arXiv:1706.03762","query_type":"arxiv"}'
curl --max-time 40 -sS http://localhost:8000/resolve \
  -H 'Content-Type: application/json' \
  -d '{"query":"Attention Is All You Need","query_type":"title","format":"bibtex"}'
```

## API and matching policy

`POST /resolve` accepts `query` (1–500 characters), `query_type`
(`auto`, `doi`, `arxiv`, `title`; default `auto`), and `format`
(`json`, `bibtex`; default `json`). Unknown request fields are rejected.
BibTeX mode still returns JSON, with `best_match.bibtex` and candidate BibTeX.

| HTTP | Status | Meaning |
| --- | --- | --- |
| 200 | `resolved` | Exact identifier verified or strong lexical title match |
| 200 | `ambiguous` | Credible candidates, but insufficient evidence to select one |
| 404 | `not_found` | Providers responded, with no credible match |
| 502 | `provider_error` | A required lookup failed and no credible candidate was recovered |
| 400 | `invalid_request` | Malformed JSON, schema error, or invalid explicit identifier |

Responses contain `query`, `detected_type`, `best_match`, `match_score`,
`alternatives: [{paper, match_score}]`, `sources: [{provider, status, error_code}]`,
`warnings`, and `message`. In ambiguous responses, `best_match` is **only a candidate**.
Null fields/empty author arrays are unavailable metadata, not an invitation to infer it.

Supported identifiers include bare DOIs, `doi:` prefixes, doi.org/dx.doi.org URLs,
modern arXiv IDs (including versions), legacy IDs such as `hep-th/9901001`, and
arxiv.org abs/pdf URLs, with optional `.pdf`. DOI case is normalized; suffix
punctuation is preserved because it can be meaningful. Supply identifiers without
surrounding citation punctuation. arXiv validation checks months, sequence widths,
nonzero sequences, and historical format transitions. Existence is checked upstream.
Arbitrary numbers are not treated as arXiv IDs. Unsupported URLs are rejected in auto mode.

Title scoring applies Unicode NFKC, case folding, punctuation-to-space conversion,
and whitespace collapse, then computes
`0.7 * rapidfuzz.ratio + 0.3 * rapidfuzz.token_sort_ratio`, divided by 100.
All thresholds live in `app/config.py`:

- Below **0.72**: discard as not credible.
- At least **0.93**, more than **0.05** ahead of the next credible result, and
  at least three query words: resolve.
- Otherwise, retain credible candidates as ambiguous, with up to three alternatives.

Scores are **heuristics, not calibrated probabilities**. Exact identifier lookups
score 1. A title score of 1 can still be ambiguous. Search retrieves eight records
per queried index; results do not establish global uniqueness. Short queries such
as `Deep Learning` deliberately require disambiguation even for an exact title.
Metadata verification means retrieval from the named provider, not a guarantee
that a provider's deposits are complete or error-free.

## Architecture and provider strategy

`app/main.py` handles HTTP/lifespan; `models.py` defines one normalized paper model;
`identifiers.py` parses inputs; `resolver.py` orchestrates adapters;
`matching.py` ranks titles; `bibtex.py` formats verified fields. Each adapter in
`app/providers/` normalizes its own response and uses a shared, small HTTP helper.

| Input | Strategy |
| --- | --- |
| DOI | Crossref first; OpenAlex on no record, failure, or identifier mismatch |
| arXiv ID | arXiv Atom API only; honor requested versions; no speculative enrichment |
| Title | OpenAlex first; Crossref if weak, ambiguous, incomplete, empty, or unavailable; verify strong arXiv preprint matches directly with arXiv instead |

A strong, complete primary result stops further calls. For a strong OpenAlex
preprint match linked to one arXiv work, fetch that arXiv ID and return its entire
authoritative preprint record if its title also matches strongly. Report differences
from OpenAlex in warnings; if verification fails, return ambiguity. This avoids
silently citing later deposits that an index has grouped with an older preprint.
It uses two provider calls, with no Crossref call on this path.
Exact lookup results must carry the
requested ID. On fallback, return the provider's whole record and any failure
warnings. Do not combine fields across sources. Title deduplication uses identifiers,
never title alone. Crossref wins identical/nonconflicting DOI duplicates; conflicting
title/year/venue/publisher/authors/pagination are retained separately with warnings. Differences
in name spelling or online/print dates may therefore produce conservative ambiguity.
OpenAlex publication types and location source types are used only when available;
publisher is left unset there instead of assuming a source's host is its publisher.
arXiv years refer to first submission; its journal-reference string is preserved
separately, not parsed into a fabricated venue/year. Full names are not guessed into
given/family parts. OpenAlex may truncate lists at 100 authors; responses warn at that limit.

BibTeX uses a sanitized author/year/title key plus a short identifier digest, escapes
TeX characters, protects title capitalization, and omits missing fields. Unknown
publication types use `@misc`. It preserves literal names when structured names are
unavailable. Complex publisher TeX/math markup is not interpreted or executed.

Provider connections have a 5-second connect and 12-second I/O timeout, plus a
16-second whole-operation deadline (at most two lookups). Failures, rate limits,
invalid payloads, and unexpected redirects are reported without exposing upstream
bodies. There are no automatic retries; clients should back off before retrying.
arXiv calls are serialized at least three seconds apart with a bounded 128-entry,
24-hour in-process metadata cache, following its API guidance. Use one worker and
one replica; horizontal scaling would require a shared rate limiter.

Only three fixed HTTPS provider hosts are contacted. User URLs are parsed, never
fetched, and upstream redirects are not followed. XML entities are disabled. The
service does not log request bodies. Incoming hosts are allowlisted; forwarded host
and scheme headers are not trusted by the supplied startup command.

## Tests

```sh
python -m pytest
python -m ruff check .
python -m ruff format --check .
```

Tests use `httpx.MockTransport` with synthetic provider records and exercise the
real adapters through the API. A network guard prevents accidental live requests.
Coverage includes parsing, ranking, ambiguity, fallback, invalid upstream data,
timeouts, BibTeX, SSRF boundaries, `/health`, and skill rendering. The curl examples
above are optional live smoke tests; provider availability never gates the suite.

## Deploy to Railway

No account operations or deployment are performed by this repository.

1. Create an empty GitHub repository. From this directory, run:

   ```sh
   git init -b main
   git add .
   git commit -m "Build Citation Resolver MVP"
   git remote add origin https://github.com/YOUR_ACCOUNT/citation-resolver.git
   git push -u origin main
   ```

2. In Railway, choose **New Project → Deploy from GitHub repo** and select that repo.
   If you instead push the surrounding workspace, set the service root directory to
   `/citation-resolver` and its config file path to `/citation-resolver/railway.toml`.
3. Railway reads `railway.toml`: Railpack installs `requirements.txt`, then runs
   `python -m app`, binding `0.0.0.0:$PORT`, and checks `/health`. Keep one replica.
4. In service **Settings → Networking → Public Networking**, choose **Generate Domain**.
5. In **Variables**, optionally set `CONTACT_EMAIL`, and set `PUBLIC_BASE_URL` to
   the generated HTTPS origin (no trailing path). Railway's `RAILWAY_PUBLIC_DOMAIN`
   also supplies the origin automatically when available. Redeploy after changes.
6. Verify `https://YOUR_DOMAIN/health`, `https://YOUR_DOMAIN/SKILL.md`, and POST a curl
   example above to `https://YOUR_DOMAIN/resolve`. Check that the skill contains the
   actual HTTPS URL and no `{{BASE_URL}}` placeholder.

`GET /SKILL.md` serves the repository skill as `text/markdown` with simple placeholder
replacement. Origin precedence is `PUBLIC_BASE_URL`, `RAILWAY_PUBLIC_DOMAIN` (HTTPS),
then the validated local request origin. For other proxies/custom domains configure
`PUBLIC_BASE_URL`; use `ALLOWED_HOSTS` for any additional incoming hostnames. Public
skill responses are not cached, avoiding origin-dependent cached content.

## OpenClaw discovery experiment

With OpenClaw installed and an agent permitted to make HTTP calls, download the
**rendered** skill into that agent's actual workspace (replace the example path):

```sh
mkdir -p /path/to/openclaw-workspace/skills/citation-resolver
curl --fail -sS https://YOUR_DOMAIN/SKILL.md \
  -o /path/to/openclaw-workspace/skills/citation-resolver/SKILL.md
```

Start a fresh OpenClaw session so it loads the skill. Do not copy the repository
template with its unresolved placeholder. For local testing, download from
`http://localhost:8000/SKILL.md` instead, provided the agent shares this host/network.

Ask: “Give me the correct BibTeX for Attention Is All You Need.” Inspect the agent's
tool trace for POST `/resolve`; its answer should use returned metadata/BibTeX.
The response may describe the arXiv preprint rather than the conference publication;
check `source` and `publication_type`, and do not add a conference venue from memory.
Then ask: “Find the citation for Deep Learning.” Expect candidate presentation or a
clarifying question, not a silently selected result. Live index rankings may change;
the tests include fixed ambiguous cases for reproducibility. This repository tests
the service, not the behavior of a separately installed OpenClaw agent.

## Official references checked during implementation

- [Crossref REST endpoints and schema](https://github.com/CrossRef/rest-api-doc) and
  [contact/polite access](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/).
- [OpenAlex authentication](https://help.openalex.org/api/authentication/),
  [search](https://help.openalex.org/api/searching/),
  [DOI lookup](https://help.openalex.org/api/get-single-entities/), and
  [work attributes](https://help.openalex.org/data/works/attributes/).
  Its current documentation permits anonymous basic queries with a limited budget.
  No key or paid API is configured here; budget exhaustion is a reported provider failure.
- [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html) and
  [identifier specification](https://info.arxiv.org/help/arxiv_identifier.html).
- [Railway configuration](https://docs.railway.com/config-as-code/reference),
  [Railpack Python](https://railpack.com/languages/python/), and
  [OpenClaw skills](https://docs.openclaw.ai/tools/skills).
