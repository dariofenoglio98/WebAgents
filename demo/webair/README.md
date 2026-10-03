# WebAir — a fictional airline origin

WebAir is a made-up airline that exists only for the WebAgents demo. It is a small, local web
origin with two interfaces over one set of business logic:

```text
                         WebAir origin
                         /           \
                       HTML        agent.pkg  (signed, served at /agent.pkg)
                        |             |
                      human      agent-native host
                                      |
                              semantic tool contracts
                                      |
                                  WebAir APIs  (POST /api/v1/<operation>)
                                      |
                                 WebAirService  (shared by both interfaces)
```

> **No real booking or payment ever occurs.** WebAir is not an airline. Every flight, schedule
> and price is invented; "purchases" are simulated, nothing is reserved, charged or issued, and
> the site collects no card details. It calls no airline, payment or other external service.

## Why it exists

It is the motivating story for WebAgents. A normal website serves pages and forms designed for
people, so a general-purpose agent has to reverse-engineer them: fill the search form, read
the results, click through fares, type passengers, pay. The same origin can also publish an
**agent package**: a signed `agent.pkg` that an agent-native host can verify, authorize and run.
The host binds that package's tools to the origin's semantic operations instead of scraping the
HTML.

**The package does not navigate the HTML website.** It never clicks, parses pages, reads a DOM
or takes screenshots. It is a machine-native interface published by the same origin: WebAir's
own workflow, domain knowledge and semantic tool contracts, as data. The package carries
behaviour and requirements, but no authority: the host still chooses the model, decides trust,
records the person's authorizations, chooses and binds every tool implementation, holds any
credential and enforces the budgets.

Both interfaces use the same `WebAirService`, so a search, a fare quote or a simulated purchase
gives the same answer whichever interface asks.

## What exists

| Piece | Where |
|---|---|
| Deterministic, fictional inventory: 6 airports, 16 flight numbers, 20 itineraries (nonstop and one-stop), 4 fare families | [`origin/inventory.py`](origin/inventory.py) |
| Shared service layer: search, flight, fare rules, booking quote, simulated purchase | [`origin/service.py`](origin/service.py) |
| Typed, bounded request/response models | [`origin/models.py`](origin/models.py) |
| Human website: home → search → results → flight → fare → passengers → payment → confirmation | [`origin/web.py`](origin/web.py), [`origin/templates/`](origin/templates/), [`origin/static/webair.css`](origin/static/webair.css) |
| Semantic JSON API | [`origin/api.py`](origin/api.py) |
| Experimental discovery hint plus a fixed `/agent.pkg` route | [`origin/agent_package.py`](origin/agent_package.py) |
| **The signed WebAir agent package** (milestone 2) | source [`agents/webair/`](../../agents/webair/README.md); artifact [`dist/webair-0.1.0.agent.pkg`](../../dist/README.md#demo) |
| Publisher tooling: tool schemas from the API contract, the recorded fixture, example tasks, the captured pages | [`publisher/`](publisher/) |
| Tests: service, API, HTML journey, discovery, safety; package contract, package runs, package serving | [`tests/`](tests/) |
| **Agent Browser discovery of this origin** (milestone 3): generic `rel="agent-package"` discovery, tested offline against these pages and this package | [below](#how-the-agent-browser-discovers-webair); evidence [`webair-010-discovery.json`](../../examples/verification/webair-010-discovery.json) |

### Not implemented yet (on purpose)

Host tool bindings for WebAir's operations in the Agent Browser (its tool registry has none, so
a browser run plan would report all four tools `unbound`). A public HTTPS deployment, and so a
live discovery of this origin: the Agent Browser refuses the local `http://127.0.0.1:8040/` by
design. Host-owned personal-data and payment capabilities, mid-run authorization, NANDA. Real
airline or payment services. **No generic WebAgents code was changed or special-cased for
WebAir:** discovery works on any origin that publishes the link, and the browser's code
mentions no site (`scripts/verify_webair.py` and the plugin's structural tests check this).

## Running it

From the repository root (the dev requirements install the local `agentpkg` for the package
tests and tooling, by a path relative to the repository root; the origin itself never imports
it):

```sh
python3 -m venv demo/webair/.venv
demo/webair/.venv/bin/python -m pip install -r demo/webair/requirements-dev.txt
cd demo/webair && .venv/bin/python -m origin --agent-package ../../dist/webair-0.1.0.agent.pkg
```

Then open **<http://127.0.0.1:8040/>**; the signed package is at
**<http://127.0.0.1:8040/agent.pkg>**. Options: `--host`, `--port`, and `--agent-package PATH`
(or `$WEBAIR_AGENT_PACKAGE`); without a package `/agent.pkg` answers 404. Python 3.11+ is
required; the runtime dependencies are FastAPI, Pydantic, Jinja2 and uvicorn
([`requirements.txt`](requirements.txt)). The pages use no JavaScript, CDN or external font.

Tests, lint and the generated-files check:

```sh
cd demo/webair
.venv/bin/python -m pytest
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/python -m publisher check
```

## Human demo flow

1. **Home** (`/`): the search form is pre-filled with Boston (BOS) → Zurich (ZRH),
   **Fri 9 Oct 2026**, 1 passenger. `/flights` has the full form: cabin, maximum price, nonstop
   only.
2. **Results** (`/results?…`): four BOS→ZRH flights that day. Two are nonstop (WA101, WA105) and
   two connect via London (WA213 + WA741) or Reykjavik (WA205 + WA731).
3. **Flight** (`/flight/WA101-20261009`): compare Economy Basic, Standard, Flex and Business.
4. **Fare** (`/fare/WA101-20261009-STANDARD`): baggage, change and refund rules, total price.
5. **Passengers** (`/passenger?fare_id=…`): one name per traveler and a contact email. Use
   made-up details.
6. **Payment** (`POST /payment`): review, then pick *Demo Visa •••• 4242* or *Demo Travel Card
   •••• 1234*. No card number is ever asked for.
7. **Confirmation** (`POST /confirmation`): a demo code such as `WA-DEMO-HT8J6` and the notice
   **"No real transaction was performed."**

The journey is stateless. Passenger details travel only in the forms of the journey's own pages.
The origin writes nothing to disk and keeps nothing in memory between requests.

## The agent package

| | |
|---|---|
| Package | `org.webagents.webair` **0.1.0**, "WebAir Travel Agent" |
| Publisher | `webair-demo`, "WebAir (fictional demo airline)": a dedicated demo key, `sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b` ([public key](../../examples/keys/webair-publisher.pub.pem)) |
| Artifact | `dist/webair-0.1.0.agent.pkg` (= `dist/webair.agent.pkg`), 164,531 bytes, 41 payload files, archive SHA-256 `73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c` |
| Package digest | `3b7c61a7bd9584e0217dda802065248c86dd135d210b8a06ab25239835cc2fb6` |
| Profile | `workflow.v0`, runtime ≥ agentpkg 0.2.1; 21 nodes, canonical operators only |

### The task

One travel request in plain language, for example *"Find me a nonstop flight from Boston to
Zurich on 9 October under $900."*, or *"… Which of those fares includes a checked bag?"*, or
*"What are the change and refund rules for the Standard fare on the nonstop flights from Boston
to Zurich on 9 October?"*. Task input:

```json
{"request": "Find me a nonstop flight from Boston to Zurich on 9 October under $900.",
 "booking": null, "purchase": null}
```

`booking` (made-up passengers and a contact email) asks for a quote of the fare the workflow
selects; `purchase` (an exact `quote_id` from an earlier run and `demo-visa-4242` or
`demo-travel-1234`) asks to simulate purchasing that quote. A model never decides to book or
buy: both are explicit in the task, and a purchase must name the exact quote.

```text
interpret ─► search_flights ─► select ─► verify the reading ─┬─► get_fare_rules × ≤6
 (model)       (tool)          (model)   against WebAir's    ├─► prepare_booking   (only with booking)
                                         own answer          └─► simulate_purchase (only with an authorized quote)
                                    answer (model) ─► assemble + validate ─► output
```

The result separates WebAir's evidence (search, fare rules, quote, confirmation, copied
verbatim) from what a model wrote (the answer text and the interpreted request). Every fare id a
model names is checked against the search, every fare-rule price against the search, a quote
against the selected fare, price and party size, and a purchase against the authorized quote;
a mismatch stops the run. The answer *text* is model-written: workflow.v0 can check the ids it
cites, not every number in its prose.

### Tools, permissions, models

| Tool | Binding | Declared endpoint (upper bound only) | Permission | Effects |
|---|---|---|---|---|
| `search-flights` | `webair.search_flights` | `POST https://webair.example/api/v1/search_flights` | `network.webair` (required) | read |
| `get-fare-rules` | `webair.get_fare_rules` | `POST https://webair.example/api/v1/get_fare_rules` | `network.webair` (required) | read |
| `prepare-booking` | `webair.prepare_booking` | `POST https://webair.example/api/v1/prepare_booking` | `network.webair.booking` (optional) | read, approval required |
| `simulate-purchase` | `webair.simulate_purchase` | `POST https://webair.example/api/v1/simulate_purchase` | `network.webair.booking` (optional) | write, approval required |

`webair.example` is a reserved, never-resolving name (RFC 2606). A declared endpoint is an upper
bound that a host binding must land inside; it is not authority, and nothing in the package
selects a URL, header, credential, path or command. Further permissions: `model.reasoning`
(host router) and `memory.session`. Model tasks `interpret`, `select` and `answer` need
structured output and reasoning with a 16,000-token context window, routed by the host with no
fallback; the package names no provider, model or credential. `get_flight` stays an
origin-only operation: every declared tool must be bound and approved before a package can run,
and the workflow never needs it.

### Keeping the package and the API aligned

The package's tool schemas (`agents/webair/schemas/api/*.json`) are **generated** from the
contract this origin publishes at `GET /api/v1/schemas`: each input schema is the published
request schema; each output schema is the published answer or the published refusal
(`{"error": …}`), because a `json_http` binding hands 4xx bodies to the package as data.
[`tests/test_package_contract.py`](tests/test_package_contract.py) fails if either side changes
alone: operation names, paths and methods; request and answer schemas, compared both with the
HTTP document and with an independent derivation from the Pydantic models; enum values, id
formats and bounds of the package's own model-facing schemas; real answers and every refusal
code validated against the package's schemas; and the recorded fixture against today's answers.
The built package contains no Python and never imports this directory.

### Build, sign, verify, run (from the repository root)

```sh
# refresh the generated files after an origin change (then review the diff)
(cd demo/webair && .venv/bin/python -m publisher sync)

agentpkg/.venv/bin/agentpkg build agents/webair -o dist/webair-0.1.0.agent.pkg
agentpkg/.venv/bin/agentpkg sign dist/webair-0.1.0.agent.pkg \
  --private-key ~/.config/agentpkg/keys/webagents-webair.private.pem
agentpkg/.venv/bin/agentpkg verify dist/webair-0.1.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem

# fixture run of the hero request: generic CLI, interpreter, model router and tool handlers
agentpkg/.venv/bin/agentpkg run dist/webair-0.1.0.agent.pkg --mode fixture \
  --grants examples/webair-grants.json \
  --approve-tool search-flights --approve-tool get-fare-rules \
  --out examples/my-webair
# a quote, then a simulated purchase of that exact quote
agentpkg/.venv/bin/agentpkg run dist/webair-0.1.0.agent.pkg --mode fixture \
  --grants examples/webair-grants.json --input examples/webair-booking-input.json \
  --approve-tool search-flights --approve-tool get-fare-rules --approve-tool prepare-booking \
  --out examples/my-webair-quote
agentpkg/.venv/bin/agentpkg run dist/webair-0.1.0.agent.pkg --mode fixture \
  --grants examples/webair-grants.json --input examples/webair-purchase-input.json \
  --approve-tool search-flights --approve-tool get-fare-rules \
  --approve-tool prepare-booking --approve-tool simulate-purchase \
  --out examples/my-webair-purchase

agentpkg/.venv/bin/python scripts/verify_webair.py     # every scenario, offline
```

The private key lives outside the repository (`0600`, in a `0700` directory), as the other
publishers' keys do; only the public key is in the tree. Building and signing again with the
same key reproduces the artifact byte for byte. The fixture replays nine scenarios
([`examples/webair-scenarios.json`](../../examples/webair-scenarios.json)): the hero search,
the checked-bag question, Standard-fare rules, JFK→GVA in business, a route WebAir does not fly
(no results), a date outside the schedule (WebAir refuses), a city WebAir does not serve (nothing
searched), a quote for two demo passengers and its simulated purchase. Its model answers are
scripted; its tool answers were recorded from this origin by `python -m publisher sync`, which
runs the package's own graph in the generic interpreter against the in-process API.

The hero result: **WA101 Economy Basic $704, WA101 Economy Standard $858, WA105 Economy Basic
$749**, all nonstop; only WA101 Standard includes a checked bag (one, 23 kg).

### Limitations

- **One task per package.** workflow.v0 has one graph and no session memory, so each request
  must be self-contained ("the Standard fare" needs the route and date in the same request);
  a host could carry conversation context into the request text later.
- **The search outcome is classified by a model and verified by the graph.** workflow.v0 can
  test only `eq`/`ne` and cannot ask whether a field exists, and WebAir's answer and refusal
  share no field; a wrong classification stops the run instead of producing an answer.
- **The declared host is a placeholder.** `webair.example` never resolves. Agent Browser
  bindings require HTTPS on 443 at a public address, so a public deployment needs a new package
  version naming its hostname, plus host bindings for the four tools.
- **No optional tools in agent.pkg 0.1.** A host must bind and approve all four tools to run
  the package at all, even for a search-only task (the booking permission itself is optional).
- **Demo personal data in the task.** Passenger names and the email reach the interpreting and
  answering models today; host-owned capabilities should supply them later without changing
  the tool contracts.
- **Prices in the answer prose are not machine-checked**; ids and all structured fields are.

## Demo data

* **Dates.** The bookable window is explicit: 1 Oct 2026 – 31 Dec 2027. Nothing depends on
  today's date. Flights follow weekly patterns; for example, WA105 flies Mon/Wed/Fri/Sun.
* **Times.** Local departure time plus block time, converted with the IANA time zones of the
  airports, so arrivals and connections stay correct across both DST changes.
* **Prices.** Whole USD per passenger, taxes included:
  `itinerary base × fare-family % × weekday %`. The weekday factor is Fri 110%, Tue/Wed 92%, and
  so on.
* **Seats.** A fixed count per fare family. A fare is unavailable when fewer seats remain than
  passengers. Simulated purchases never consume seats.

## Semantic API operations

Each operation is one fixed path, `POST /api/v1/<operation>`, with the arguments as an
`application/json` body (≤ 16 KiB) and the result as JSON. This matches the request shape of the
WebAgents host's generic `json_http` tool adapter
([docs/tool-broker.md §3a](../../docs/tool-broker.md)). Answers use 200, and refusals use 400,
404 and 422, the statuses that adapter hands to a package as data. Requests are validated
strictly: no type coercion, and unknown fields are refused, not ignored.

| Operation | Arguments | Result |
|---|---|---|
| `search_flights` | `origin`, `destination`, `date`, `passengers` (1–6), `nonstop_only`, `max_price_usd`, `cabin` | matching flights, each with its matching fares |
| `get_flight` | `flight_id` (e.g. `WA205-WA731-20261009`), `passengers` | schedule, segments, layovers, every fare with availability |
| `get_fare_rules` | `fare_id` (e.g. `WA101-20261009-STANDARD`), `passengers` | price, total, baggage, change and refund policy |
| `prepare_booking` | `fare_id`, `passengers[]` (`given_name`, `family_name`), `contact_email` | a quote; `quote_id` is a digest binding the fare, price and passengers |
| `simulate_purchase` | `booking` (the `prepare_booking` arguments), `quote_id`, `payment_method_id` (`demo-visa-4242` \| `demo-travel-1234`) | `confirmation_id` `WA-DEMO-XXXXX`, `real_transaction: false`, `amount_charged_usd: 0` |

`GET /api/v1/schemas` publishes every request, response and error schema as JSON Schema.
Request and response objects are closed (`additionalProperties: false`), and a response lists
as required every field WebAir always writes, including the constants `simulated: true`,
`real_transaction: false` and `amount_charged_usd: 0`. Errors have the shape
`{"error": {"code", "message", "details": [{"field", "message"}]}}`.
Their codes are `invalid_json`, `invalid_request`, `invalid_route`, `invalid_date`,
`date_out_of_range`, `unknown_flight`, `unknown_fare`, `insufficient_seats`, `quote_mismatch`,
`request_too_large` and `unsupported_media_type`. Rejected values are never echoed back.

Booking is stateless and deterministic. `simulate_purchase` recomputes the quote from `booking`
and refuses it if `quote_id` does not match, so the same inputs always give the same
confirmation code.

```sh
curl -s -X POST http://127.0.0.1:8040/api/v1/search_flights \
  -H 'content-type: application/json' \
  -d '{"origin":"BOS","destination":"ZRH","date":"2026-10-09","nonstop_only":true,"max_price_usd":900}'
```

## Experimental discovery link

Every WebAir page carries, in its `<head>`:

```html
<link rel="agent-package" type="application/vnd.webagents.agent-package" href="/agent.pkg">
```

**This is a WebAgents demo convention, not an HTML or web standard.** Neither
`rel="agent-package"` nor the media type is registered anywhere. The `href` is relative, so it
always resolves against the origin that served the page. Pages send
`Content-Security-Policy: base-uri 'none'` and contain no `<base>` element, so nothing can
retarget it.

`GET /agent.pkg` (and `HEAD`) serves **exactly one file**: the one passed to
`--agent-package PATH` (or `$WEBAIR_AGENT_PACKAGE`) when the origin starts. The file is checked
(regular file, 1 byte – 16 MiB), read once at startup and served from memory as
`application/vnd.webagents.agent-package`, with `X-Agent-Package-SHA256` and an ETag. No request
can name a path. There is no static directory mount and no directory listing, and a missing or
invalid configured file stops the origin from starting. Without a configured package,
`/agent.pkg` answers `404` with `{"error": {"code": "agent_package_unavailable", …}}`.

Started with `--agent-package ../../dist/webair-0.1.0.agent.pkg`, the link resolves to the exact
signed bytes: `X-Agent-Package-SHA256` and the ETag carry
`73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c`, and `agentpkg verify` on the
downloaded file succeeds against WebAir's pinned key
([`tests/test_package_serving.py`](tests/test_package_serving.py); a recorded `curl` check is in
[`examples/verification/webair-010-serving.json`](../../examples/verification/webair-010-serving.json)).

### How the Agent Browser discovers WebAir

Give the Agent Browser WebAir's address instead of the package's:

```text
 https://webair.example/                      the human page
      │  read once, under the browser's URL policy; nothing on it runs or loads
      ▼
 <link rel="agent-package" … href="/agent.pkg">   in the page's head
      │  resolved against the page, accepted because it is WebAir's own origin
      ▼
 https://webair.example/agent.pkg              an untrusted candidate: an address
      │  the person presses "Inspect agent package"
      ▼
 the ordinary package path: snapshot, validation, signature, publisher trust,
 deny-by-default permissions, authorization, model, run plan
```

The page only says *where* the package is. It does not say who published it, whether it is
intact, or what it may do: the Agent Browser verifies the signed bytes it then downloads, reports
WebAir's key as **unknown** until an operator pins it, and starts every permission at *Deny*.
Nothing about this is WebAir-specific in the browser — any origin that publishes the link is
discovered the same way, and WebAir's own pages pass only because they publish it. The design and
its limits (head only, same-origin only, no `<base>`, at most five same-origin redirects, 1 MiB) are
in [the control plane, §3a](../../docs/browser-control-plane.md#3a-website-discovery) and
[the Agent Browser, §5b](../../docs/openclaw-agent-browser.md#5b-website-discovery).

**Tested offline, not yet live.** The local origin above is plain HTTP on loopback, which the
browser refuses by design, and that policy is unchanged. The discovery tests serve WebAir's own
pages instead, captured from this origin by `python -m publisher sync` into
[`examples/webair-site.json`](../../examples/webair-site.json) (and checked by
`publisher check`), together with the real signed `dist/webair-0.1.0.agent.pkg`, through a
fixture that replaces only DNS and sockets. The recorded acceptance,
[`webair-010-discovery.json`](../../examples/verification/webair-010-discovery.json)
(`agentpkg/.venv/bin/python scripts/verify_webair_discovery.py`), covers five scenarios: WebAir's
page leading to a valid signature and an unknown, then pinned, publisher; an ordinary site with no
advertisement; a cross-origin advertisement, rejected and never fetched; a valid advertisement of
an invalid or tampered package, failing inspection; and a valid signature by a stranger's key,
untrusted and reported as an impersonation once WebAir's key is pinned.

## Next steps

1. **A public HTTPS deployment**, for a live discovery of WebAir from the Agent Browser, never
   by relaxing the loopback policy.
2. **Host bindings** for the four declared tools (the generic `json_http` adapter already speaks
   this API's request and status shape), and a package version declaring the deployment's host.
3. **Host-owned personal and payment capabilities**: passenger details and a payment method
   come from the person's browser under explicit authorization, never from the package or the
   site.
