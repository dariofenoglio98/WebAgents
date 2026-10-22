# WebAir — a fictional airline origin

WebAir is a made-up airline that exists only for the WebAgents demo. It is a small web origin,
publicly deployed at <https://webagents-webair-production.up.railway.app/>, with two interfaces
over one set of business logic:

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

Since milestone 4 the package also asks the person's own host for what WebAir must never own:

```text
                    WebAir origin
                   /             \
                HTML           agent.pkg
                                  |
                             requests capability
                                  |
                         +--------+---------+
                         |                  |
                    OpenClaw host      WebAir tools
                         |
             +-----------+-----------+
             |           |           |
          profile     identity     demo wallet
             |           |           |
             +----- user grants -----+
                         |
                      Run Plan
                         |
                       execute
```

**WebAir publishes behavior. The user's runtime supplies authority.**

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
| **The signed WebAir agent package** (milestone 2) | source [`agents/webair/`](../../agents/webair/README.md); artifact [`dist/webair-0.1.0.agent.pkg`](../../dist/README.md#webair) |
| Publisher tooling: tool schemas from the API contract, the recorded fixture, example tasks, the captured pages | [`publisher/`](publisher/) |
| Tests: service, API, HTML journey, discovery, safety; package contract, package runs, package serving | [`tests/`](tests/) |
| **Agent Browser discovery of this origin** (milestone 3): generic `rel="agent-package"` discovery, tested offline against these pages and this package | [below](#how-the-agent-browser-discovers-webair); evidence [`webair-010-discovery.json`](../../examples/verification/webair-010-discovery.json) |
| **Host-owned capabilities** (milestone 4): WebAir 0.2.0 requests a travel profile, a passenger identity and a payment method from the person's host, and a separate simulated-purchase authority; the demo host's fictional resources | [below](#host-owned-capabilities-milestone-4); package [`dist/webair-0.2.0.agent.pkg`](../../dist/README.md#webair); host resources [`host-resources.json`](host-resources.json); evidence [`webair-020-host-capabilities.json`](../../examples/verification/webair-020-host-capabilities.json) |
| **The live demo** (milestone 5): this origin deployed on Railway; WebAir 0.3.0 declaring its real hostname; the demo host's bindings of the four tools to it; discovery, trust, search, booking and a simulated purchase through the real Agent Browser | [below](#public-deployment-milestone-5); bindings [`host-bindings.json`](host-bindings.json); script [docs/webair-live-demo.md](../../docs/webair-live-demo.md); evidence [`webair-030-live-demo.json`](../../examples/verification/webair-030-live-demo.json), offline [`webair-030-host-capabilities.json`](../../examples/verification/webair-030-host-capabilities.json) |
| **Publisher-declared profiles**: WebAir 0.4.0 groups what it declares into "Search flights", "Search and quote" and "Book (simulated)", a noncritical manifest extension that presents authority and grants none | [below](#profiles); specification [`spec/extensions/profiles-v0.md`](../../spec/extensions/profiles-v0.md); validator [`publisher/profiles.py`](publisher/profiles.py); evidence that the current runtimes ignore it [`webair-040-host-capabilities.json`](../../examples/verification/webair-040-host-capabilities.json) |

### Not implemented yet (on purpose)

Mid-run authorization, NANDA, persistent personal accounts, Apple Wallet or any real wallet, card
or payment service, and optional tools in the agentpkg runtime (its Agent Browser binds and
approves all seven of the package's tools; 0.4.0's profiles prepare runtimes that leave some out). The
local origin stays plain HTTP on loopback, which the Agent Browser refuses by design; the live
demo uses the public deployment instead, under the unchanged policy. **No generic WebAgents code
was changed or special-cased for WebAir:** discovery works on any origin that publishes the link,
host resources are generic types an operator configures, tool bindings to WebAir's API are an
operator's file for the service-neutral JSON adapter, and the browser's code mentions no site or
demo resource (`scripts/verify_webair.py`, `scripts/verify_webair_capabilities.py` and the
plugin's structural tests check this).

## Running it

From the repository root (the dev requirements install the local `agentpkg` for the package
tests and tooling, by a path relative to the repository root; the origin itself never imports
it):

```sh
python3 -m venv demo/webair/.venv
demo/webair/.venv/bin/python -m pip install -r demo/webair/requirements-dev.txt
cd demo/webair && .venv/bin/python -m origin --agent-package ../../dist/webair-0.8.0.agent.pkg
```

Then open **<http://127.0.0.1:8040/>**; the signed package is at
**<http://127.0.0.1:8040/agent.pkg>**. Options: `--host`, `--port` (default `$PORT`, else 8040),
and `--agent-package PATH` (or `$WEBAIR_AGENT_PACKAGE`); without a package `/agent.pkg` answers
404. `GET /health` answers `{"status": "ok", "service": "webair-origin", "fictional": true,
"agent_package_sha256": …}` for a platform health check. One process, at most 64 concurrent
connections. Python 3.11+ is required; the runtime dependencies are FastAPI, Pydantic, Jinja2 and
uvicorn ([`requirements.txt`](requirements.txt)). The pages use no JavaScript, CDN or external
font.

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
| Package | `org.webagents.webair` **0.8.0**, "WebAir Travel Agent" |
| Publisher | `webair-demo`, "WebAir (fictional demo airline)": a dedicated demo key, `sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b` ([public key](../../examples/keys/webair-publisher.pub.pem)) |
| Artifact | `dist/webair-0.8.0.agent.pkg` (signed after T24's review; `dist/README.md` lists its archive SHA-256 and digest) |
| Execution profile | `workflow.v0` with a **conversation** (conversation.v0), minimum runtime **0.6.0** (it also ships a WebAssembly module, compute.v0, and declares `memory.read` and `memory.write`, memory.v0); 48 nodes, canonical operators only |
| What changed from 0.7.0 | the package is a conversation (T24, D-274): the task's `request`, `booking` and `purchase` fields are one `message` per turn; the interpreter says what the message asks for (`intent`: `search`, `quote`, `purchase`, `question`, `done`) and the turn graph follows that; the history, the known fares, the open quote and the confirmation (summaries only) outlive the turn in a declared persistent state; the simulated purchase is behind the consent step `confirm-purchase`, whose card shows the quote's facts and the passenger's name (never the e-mail or the payment identifier); `once` on the purchase authority is one purchase per conversation; the budget per conversation is 8 turns, 240,000 tokens, 60 remote calls, 1 purchase; the fixture is recorded anew as conversations (searches only) and `fixtures/transcript.json` is the three-turn fixture conversation; the skills `travel-request` (0.3.0), `answer-writing` (0.4.0) and `webair-domain` (0.3.0). Tools, permissions, the module and the per-turn budgets are 0.7.0's (`agentpkg/tests/test_webair_package.py`) |
| What 0.7.0 changed from 0.6.0 | WebAir's fare totals are checked on the person's device by the fares module (`modules/fares.wasm`, AssemblyScript, SHA-256 `ef7e813b…23c0`; permission `compute.fares`, in every profile): a `total` compute step in the fare-rules map and `quote-total-input`, `quote-total` before `check-quote` recompute price × passengers, and the checks refuse a total WebAir misstates (`tests/test_package_workflow.py`); the `remember` step has 10,000 output tokens, 600 s and a 40,000-token budget (B-220). Nothing a model sees changed; the fixture is 0.6.0's (T22, D-252) |
| What 0.6.0 changed from 0.5.0 | the travel profile is read from the person's memory (`memory.read` of `travel.profile`, permission `memory.travel_profile`, tool `travel.profile`, the record view), and after a quote or a purchase a `remember` model step (after `answer`) may propose one `travel.preference` (`memory.write`, permission `memory.remember`), written to `proposals.json` and reviewed by the person after the run; the profiles `quote` and `book` gain `memory.remember`; the fixture is unchanged (searches only, so its `proposals.json` is the empty document); the publisher's capability document stays on the signed 0.5.0, which the OpenClaw host runs (D-233) |
| What 0.5.0 changed from 0.4.0 | a request that names no departure airport, with no travel profile that supplies one, is answered ("say where you depart from") instead of failing the package's own search-request check: the `search-origin` node resolves the airport first and the search runs only when there is one (B-124); the request field's description is one sentence and its example *"Find me a flight from Boston to Zurich on 9 October under $900"* (F-11); the answer-writing skill (0.3.0), one fixture scenario (`no-departure`), the manifest and the package README. Tools, permissions, budgets, policy and profiles are unchanged (`agentpkg/tests/test_webair_package.py`). Under "Search flights" a model that asks for the travel profile still stops the run as `permission_denied`: the graph cannot see the person's grants |
| Current | `dist/webair-0.8.0.agent.pkg` (signed 2026-10-21 with the user's approval; deployed by the next bundle), archive `9c81a936…eae0`, digest `b346a474…72c2`, 270,099 bytes |
| Earlier | `dist/webair-0.7.0.agent.pkg` (the public origin's package since 2026-10-19, until 0.8.0 is deployed), archive `c0265a28…d808`, digest `abab1e37…409b`; `dist/webair-0.6.0.agent.pkg` (the public origin's package from 2026-10-16 to 2026-10-19), archive `3055dd93…8862`, digest `e1ef5ad0…022f`; `dist/webair-0.5.0.agent.pkg` (the public origin's package from 2026-10-09 to 2026-10-16), archive `4b087557…101b`, digest `6192614e…bb48`; `dist/webair-0.4.0.agent.pkg` (0.3.0 plus the profiles; the public origin's package from 2026-10-06 to 2026-10-09), archive `c12f9db3…7f63`, digest `0e8317f1…4fbb`; `dist/webair-0.3.0.agent.pkg` (the live demo's version, the first to declare the public host), archive `b537cf5c…2887`, digest `ffe8f5b3…5e94`; `dist/webair-0.2.0.agent.pkg` (declares the reserved `webair.example`), archive `3f135be8…a616`, digest `74f05a8d…b9e1`; `dist/webair-0.1.0.agent.pkg` (= `dist/webair.agent.pkg`, which stays 0.1.0 because the recorded evidence pins it), archive `73872c31…470c`, digest `3b7c61a7…2fb6`; all unchanged |

### The conversation

One message per turn, in plain language: *"Find me a flight from Boston to Zurich on 9 October
under $900."*, *"Only nonstop, and the cheapest one."*, *"Quote WA101 Standard for me."*, *"Buy
it."*, *"That's all, thanks."* Turn input:

```json
{"message": "Find me a flight from Boston to Zurich on 9 October under $900."}
```

The interpreter reads the message with the conversation so far and says what it asks for
(`intent`): a **search** (also any question about fares or rules, which repeats or changes the
last search), a **quote** of one fare (named from the fares the conversation found, or the one
this turn's search selects), the **purchase** of the open quote, a **question** the conversation
itself answers, or **done**. A model never decides to book or buy: a quote needs the person's
identity grant, and a purchase needs the person's yes on a card the runtime shows in the turn
that buys, with the quote's facts (quote id, flight, fare, route, date, total, the passenger's
name, the payment method's display label) and the interpreter's one-sentence question. No name,
email or payment method is ever part of a message, a persisted state or a card beyond the name
and the label.

```text
interpret (model: the message, the history, the known fares, the open quote)
  ├─ search:   travel profile (host, only when the departure airport is unstated) ─► fill unstated
  │            criteria ─► search_flights ─► select (model) ─► verify ─► get_fare_rules × ≤6
  ├─ quote:    the fare named (checked against the known fares) or the one the search selects
  │            ─► passenger identity (host) ─► prepare_booking ─► check ─► quote summary (no identity)
  ├─ purchase: payment method (host) ─► passenger identity (host) ─► prepare_booking (today's quote)
  │            ─► it must be the open quote ─► card (consent) ─► if yes: simulate_purchase ─► check
  ├─ question: nothing is called
  └─ done:     the interpreter's goodbye is the reply; the conversation ends
answer (model: summaries and the history) ─► assemble + validate ─► history ─► clear personal state ─► output
```

What outlives a turn is declared (`schemas/conversation-state.schema.json`): the `history` (≤ 8
turns: message, intent, outcome, the search sent, the answer), the `known_fares` (ids), the
`quote_ref` and `confirmation_ref` summaries and `profile_used`. The reply separates WebAir's
evidence (search and fare rules, copied verbatim; a quote and a confirmation, summarized without
the passenger or the payment method) from what a model wrote. Every fare id a model names is
checked against the fares the conversation knows, every fare-rule price against the search, a
quote against the selected fare, price, party size and the request that was sent, a purchase
against the open quote before the card is shown, and a confirmation against the request; a
mismatch stops the turn, and a failed turn never ends the conversation.

### Tools, permissions, models

| Tool | Binding | Declared endpoint (upper bound only) | Permissions | Effects |
|---|---|---|---|---|
| `search-flights` | `webair.search_flights` | `POST https://webagents-webair-production.up.railway.app/api/v1/search_flights` | `network.webair` | read |
| `get-fare-rules` | `webair.get_fare_rules` | `POST https://webagents-webair-production.up.railway.app/api/v1/get_fare_rules` | `network.webair` | read |
| `prepare-booking` | `webair.prepare_booking` | `POST https://webagents-webair-production.up.railway.app/api/v1/prepare_booking` | `network.webair`, `identity.passenger` | read, approval required |
| `simulate-purchase` | `webair.simulate_purchase` | `POST https://webagents-webair-production.up.railway.app/api/v1/simulate_purchase` | `network.webair`, `booking.simulate_purchase` (gated by the consent step `confirm-purchase`), `identity.passenger`, `wallet.payment` | write, approval required |
| `travel.profile` | `host.memory.travel.profile` | none: local, the person's memory | `memory.travel_profile` | read, approval required |
| `personal.passenger_identity` | `host.resource.personal.passenger_identity` | none: local, the person's host | `identity.passenger` | read, approval required |
| `wallet.payment_method` | `host.resource.wallet.payment_method` | none: local, the person's host | `wallet.payment` | read, approval required |

Permissions: `network.webair`, `model.reasoning`, `memory.session` and `compute.fares` are
required; `memory.travel_profile` (kind `memory.read`), `identity.passenger` and
`wallet.payment` (kind `personal.read`), `memory.remember` (kind `memory.write`) and
`booking.simulate_purchase` (kind `payment`, the package's only one, so it can be granted
*once*: one purchase per conversation, confirmed on the card) are optional. The declared host is this origin's public deployment (0.2.0 and earlier
declared the reserved, never-resolving `webair.example`, RFC 2606). A declared endpoint is an
upper bound that a host binding must land inside; it is not authority, and nothing in the package
selects a URL, header, credential, path, command or host resource. Model tasks
`interpret`, `select`, `answer` and `remember` need structured output and reasoning with a
16,000-token context window, routed by the host with no fallback; the package names no provider, model or
credential. `get_flight` stays an origin-only operation.

### Profiles

0.4.0 groups what the package declares into three profiles, the noncritical manifest extension
[`org.webagents:profiles-v0`](../../spec/extensions/profiles-v0.md). A runtime that implements it
can offer them as a short path to authorization beside its per-item view; agentpkg 0.2.2 and the
OpenClaw Agent Browser ignore them and run 0.4.0 exactly as 0.3.0
([`webair-040-host-capabilities.json`](../../examples/verification/webair-040-host-capabilities.json)).

| Profile | Adds | Personal data it lets the host use |
|---|---|---|
| `search` "Search flights" | `network.webair`, `model.reasoning`, `memory.session`; `search-flights`, `get-fare-rules` | none, so a request must say where the trip starts |
| `quote` "Search and quote" | `profile.travel`, `identity.passenger`; `prepare-booking` and the two host-resource tools | the travel profile; the passenger identity, sent only to `prepare_booking` |
| `book` "Book (simulated)" | `wallet.payment`, `booking.simulate_purchase`; `simulate-purchase`, `wallet.payment_method` | also the demo payment method, sent only to `simulate_purchase` |

Each contains the previous one, and `book` is everything the package declares. A profile grants
nothing: choosing one yields the decisions a person could make item by item, and everything
outside it is denied. Each profile's estimate in the manifest (model calls, tool calls, tokens)
is the largest recorded run of the same graph that the profile serves, tokens rounded up to the
next 1,000, from the 0.3.0 runs in
[`webair-030-table1-runs.json`](../../examples/verification/webair-030-table1-runs.json) and
[`webair-030-live-demo.json`](../../examples/verification/webair-030-live-demo.json).
[`tests/test_profiles.py`](tests/test_profiles.py) recomputes the estimates and checks the
profiles against the extension's rules, which `python -m publisher check` enforces before a build.

### Keeping the package and the API aligned

The package's host-resource schemas (`agents/webair/schemas/host/*.json`) are likewise
**generated**, from the demo host's own type definitions in
[`host-resources.json`](host-resources.json): a host binding pins its type's schema digest, so
the package must declare exactly the host's schema. The package's tool schemas
(`agents/webair/schemas/api/*.json`) are **generated** from the
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
# refresh the generated files after an origin or host-resource change (then review the diff)
(cd demo/webair && .venv/bin/python -m publisher sync)

agentpkg/.venv/bin/agentpkg build agents/webair -o /tmp/webair-0.8.0.unsigned.agent.pkg
agentpkg/.venv/bin/agentpkg sign /tmp/webair-0.8.0.unsigned.agent.pkg \
  --private-key ~/.config/agentpkg/keys/webagents-webair.private.pem -o dist/webair-0.8.0.agent.pkg
agentpkg/.venv/bin/agentpkg verify dist/webair-0.8.0.agent.pkg \
  --trust-key examples/keys/webair-publisher.pub.pem

# the fixture conversation (three turns of searches): generic CLI, conversation runner,
# interpreter, model router and tool handlers, with every personal permission denied (a search
# needs none). `agentpkg run` refuses a conversational package. Running the module needs
# agentpkg[compute]. A transcript with a quote and a purchase (examples/webair-0.8.0-book-
# transcript.json) is for live runs: the fixture holds no quote and the CLI holds no identity.
agentpkg/.venv/bin/agentpkg converse dist/webair-0.8.0.agent.pkg --mode fixture \
  --grants examples/webair-0.8.0-grants.json \
  --approve-tool search-flights --approve-tool get-fare-rules \
  --out examples/my-webair

agentpkg/.venv/bin/python scripts/verify_webair.py               # the fixture conversations, offline
agentpkg/.venv/bin/python scripts/verify_webair_capabilities.py  # host capabilities on 0.4.0, offline (needs Node; its source-rebuild check describes 0.4.0's source)
```

Because the package declares the public deployment's hostname, a change of hostname is a new
package version (and a regenerated `host-bindings.json`: `DECLARED_HOST` in
[`publisher/contract.py`](publisher/contract.py)).

The private key lives outside the repository (`0600`, in a `0700` directory), as the other
publishers' keys do; only the public key is in the tree. Building and signing again with the
same key reproduces the artifact byte for byte. The package fixture replays the fixture
conversation and eight single-turn search scenarios
([`examples/webair-0.8.0-conversations.json`](../../examples/webair-0.8.0-conversations.json),
`fixture`): a broad Boston–Zurich search with stops allowed, then "only nonstop, and the
cheapest one", then goodbye; the hero search, the checked-bag question, Standard-fare rules,
JFK→GVA in business, a route WebAir does not fly (no results), a date outside the schedule
(WebAir refuses), a city WebAir does not serve (nothing searched) and a request without a
departure airport. None involves a host resource, so the signed fixture holds no personal data.
Its model answers are scripted; its tool answers were recorded from this origin by `python -m
publisher sync`, which runs the package's own turn graph through the generic conversation runner
against the in-process API. The one-shot scenarios of 0.3.0 to 0.7.0 stay in
[`examples/webair-scenarios.json`](../../examples/webair-scenarios.json) for those archives.

The hero result: **WA101 Economy Basic $704, WA101 Economy Standard $858, WA105 Economy Basic
$749**, all nonstop; only WA101 Standard includes a checked bag (one, 23 kg).

### Limitations

- **One quote at a time.** The conversation holds one open quote; quoting another fare replaces
  it, and a purchase is of the open quote only. "Those fares" and "the first one" resolve
  through the history the interpreter reads, not through a model's memory.
- **The search outcome is classified by a model and verified by the graph.** workflow.v0 can
  test only `eq`/`ne` and cannot ask whether a field exists, and WebAir's answer and refusal
  share no field; a wrong classification stops the run instead of producing an answer.
- **The declared host is one deployment.** 0.3.0 and later name `webagents-webair-production.up.railway.app`;
  another deployment needs another package version and bindings (the host never redirects a
  declared endpoint).
- **No optional tools in agent.pkg 0.1.** A host must bind and approve all seven tools to run
  the package at all, even for a search-only task — including the three host-resource tools,
  so a host that holds no resources cannot run the package through agentpkg (the personal
  permissions themselves are optional, and a search never reads one). The "Search flights"
  profile names the two tools a search needs; a runtime that honours profiles may leave the
  rest out.
- **One passenger per booking.** A quote is for the one identity the person grants; a request
  for several travelers cannot be quoted (the graph refuses rather than quoting fewer).
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

Started with `--agent-package ../../dist/webair-0.8.0.agent.pkg` — as the next deployment's
bundle is — the link resolves to the exact signed bytes: `X-Agent-Package-SHA256` and the ETag carry
`9c81a9362754fc3c48c923b4968e75daa9e0260ae422be7e77b30f1df1a7eae0`, and `agentpkg verify` on the
downloaded file succeeds against WebAir's pinned key
([`tests/test_package_serving.py`](tests/test_package_serving.py) checks every signed version; the
public origin's bytes, headers and signature are in
[`webair-030-live-demo.json`](../../examples/verification/webair-030-live-demo.json), and the
earlier local `curl` checks in
[`webair-020-serving.json`](../../examples/verification/webair-020-serving.json) and
[`webair-010-serving.json`](../../examples/verification/webair-010-serving.json)). Publishing a
different version needs no origin change, only a different `--agent-package` path.

### How the Agent Browser discovers WebAir

Give the Agent Browser WebAir's address instead of the package's:

```text
 https://webagents-webair-production.up.railway.app/          the human page
      │  read once, under the browser's URL policy; nothing on it runs or loads
      ▼
 <link rel="agent-package" … href="/agent.pkg">   in the page's head
      │  resolved against the page, accepted because it is WebAir's own origin
      ▼
 https://webagents-webair-production.up.railway.app/agent.pkg  an untrusted candidate
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

**Tested live and offline.** Live: the real Agent Browser discovered the public deployment from
its home page address and showed the package as an unverified candidate, then a valid signature
from an unknown publisher ([the live demo](../../docs/webair-live-demo.md)). The local origin
above is plain HTTP on loopback, which the browser refuses by design, and that policy is
unchanged. Offline, the discovery tests serve WebAir's own
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

## Host-owned capabilities (milestone 4)

The division the demo makes visible:

| WebAir (origin and package) owns | The person's host owns |
|---|---|
| the airline workflow, search semantics, fare rules, the booking protocol, its API contracts | the model, personal preferences, the passenger identity, the payment capability, which resource is used, authorization, credentials, budgets |

A package may **request** a capability. It can never **grant** itself one.

### What the demo host holds

[`host-resources.json`](host-resources.json) is the demo host's configuration — what an operator
names with `plugins.entries.agent-browser.config.hostResources.file`. It is never part of the
package. Everything in it is fictional:

| Type (`personal.read`) | Resources (display label) | Sealed field |
|---|---|---|
| `personal.travel_profile` | `profile_demo_traveler` "Demo Traveler — BOS / Economy / Nonstop"; `profile_demo_explorer` "Demo Explorer — JFK / Business / Any stops" | — (preferences) |
| `personal.passenger_identity` | `passenger_demo_alex` "Alex Traveler — a\*\*\*@example.com" (alex.traveler@example.com); `passenger_demo_sam` "Sam Traveler — s\*\*\*@example.com" | `/contact_email` |
| `wallet.payment_method` | `payment_demo_visa` "Demo Visa •••• 4242" → `demo-visa-4242`; `payment_demo_travel` "Demo Travel Card •••• 1234" → `demo-travel-1234` | `/payment_method_id` |

A payment method is an opaque identifier the merchant accepts (WebAir's demo identifiers) and a
display label. There is no card number, security code, wallet credential or token anywhere, and
no Apple Wallet, Apple Pay, bank or card API is involved: this is a *host-owned payment
capability* over a *demo wallet*.

### How the person grants them

In the Agent Browser's Permissions card, each `personal.read` permission shows the host's labels
in a chooser under its decision (Deny / Allow once / Allow for session); nothing is chosen by
default, and allowing one without choosing is refused. The purchase authority is an ordinary
permission, `booking.simulate_purchase` (*Allow once* is the natural choice: since 0.8.0 it
covers one purchase of the conversation, and the consent step `confirm-purchase` asks the
person on a card, with the quote's facts, in the turn that buys). The receipt and the run plan
freeze each pick by opaque id and keyed digest; the run plan's preflight compares them with the
host's store before anything runs, and the broker resolves only those grants, for the tools
that link their permissions. A `once` grant is spent by the first purchase: a second "buy it" in
the same conversation is not even asked (the step resolves denied by the plan), and a new
conversation needs a new decision.

### Who sees what

| | Travel profile | Passenger identity | Payment method |
|---|---|---|---|
| **Package (workflow state)** | home airport, cabin, nonstop, currency — only when a request leaves the origin unstated | given and family name, email — only for a quote or a purchase | the opaque identifier and display label — only for a purchase |
| **Models** | never the profile; the select and answer steps see WebAir's echo of the *search criteria* (e.g. BOS, economy, nonstop), which may have come from it | never | never (not even the label) |
| **WebAir (origin)** | the criteria, as an ordinary search | names and email in `prepare_booking` and `simulate_purchase` only | `demo-visa-4242` in `simulate_purchase` only |
| **Result, exports, run record** | the search query echo | the passenger *count* | `payment_display: "Demo Visa •••• 4242"` in a purchase result |
| **Audit** | permission checks; the grant's opaque id and digest | the same | the same |

The models' isolation is structural: the host-resource tools run in a `Personal` role with no
model, and the state they fill is outside every model role's `state_read`, which the interpreter
checks statically. The Writer reads redacted summaries of a quote and a purchase. A final node
clears every state key that held a host resource or a request built from one, so the state the
host writes to `result.json` keeps none.

### Scenarios, offline

Since 0.8.0 the capability demo is a set of conversations,
[`examples/webair-0.8.0-conversations.json`](../../examples/webair-0.8.0-conversations.json)
(`capability`, generated by `python -m publisher sync`): a profile-assisted search (A), an
explicit search with the profile denied (B), a quote searched and quoted in one turn (C), the
hero search then a quote of a fare it offered by its id (C'), "buy it" with the payment method
denied, which stops at the payment read before any card (D), "buy it" declined on the card (E')
and "buy it" accepted on the card, then goodbye (E). [`tests/test_package_workflow.py`](tests/test_package_workflow.py)
runs each through the generic conversation runner against the in-process origin, the demo
host's stand-in answering the picked resources and the transcript answering the card, and checks
what each turn sends, reads, asks and keeps: the identity reaches only `prepare_booking` and
`simulate_purchase`, the payment identifier only `simulate_purchase`, the card's facts carry the
passenger's name and the card's label and never the e-mail or the identifier, a declined card
buys nothing and keeps the quote open, a spent `once` grant is not asked again, and nothing
personal is in a reply, a persisted state or a transcript.

The same demo as one-shot tasks of the 0.5.0 package,
[`examples/webair-capability-scenarios.json`](../../examples/webair-capability-scenarios.json)
(also generated), holds each task, grants and picks, scripted model answers, and every request
WebAir received with its answer in a reference run; the OpenClaw Agent Browser's acceptance
suite
([`webair-capabilities.test.ts`](../../openclaw-agent-browser/test/webair-capabilities.test.ts))
runs them through the real control plane, runner and broker, serving those answers at the
broker's transport:

| | Scenario | Result |
|---|---|---|
| A | *"Find me a flight to Zurich on 9 October under $900."*, Demo Traveler granted | BOS→ZRH nonstop economy ≤ $900: WA101 Basic $704 / Standard $858, WA105 Basic $749 |
| B | the same route stated in full, profile denied | the same three fares; the profile is never read |
| C | *"Prepare WA101 Standard for 9 October for me."*, Alex Traveler granted | quote `WAQ-C82CB5B08515FAE6`, $858, one passenger; the identity reaches only `prepare_booking` |
| D | purchase of that quote, payment method and purchase denied | stops at the payment method: nothing resolved, nothing sent |
| E | purchase of that quote, Demo Visa granted, purchase *once* | `WA-DEMO-TYD4M`, `real_transaction: false`, $0 charged; the identifier reaches only `simulate_purchase` |
| F | a signed, trusted package variant that sends the Travel Card's identifier, or another passenger's email | refused by the host before WebAir is asked |
| G | the granted Visa changed or removed after the plan | the plan is stale; nothing runs |
| H | the spent `once` grant replayed; a superseded pick; picks for denied or non-resource permissions | refused |

The recorded acceptance is
[`webair-030-host-capabilities.json`](../../examples/verification/webair-030-host-capabilities.json)
(`agentpkg/.venv/bin/python scripts/verify_webair_capabilities.py`), against 0.3.0 with the
four WebAir tools bound by the shipped [`host-bindings.json`](host-bindings.json) through the
Agent Browser's `tools.bindingsFile`; the milestone-4 record of the same scenarios against 0.2.0
is [`webair-020-host-capabilities.json`](../../examples/verification/webair-020-host-capabilities.json).
Scenarios A–E then ran live, on the public origin with a real model:
[`webair-030-live-demo.json`](../../examples/verification/webair-030-live-demo.json). The same
offline acceptance against 0.4.0, which the script now checks, is
[`webair-040-host-capabilities.json`](../../examples/verification/webair-040-host-capabilities.json).

## Public deployment (milestone 5)

| | |
|---|---|
| Public URL | <https://webagents-webair-production.up.railway.app/> (DNS → Railway's edge, public addresses; TLS on 443) |
| Platform | Railway, service `webagents-webair`, builder Railpack, Python 3.13 |
| What runs | `python -m origin --host 0.0.0.0 --agent-package agent.pkg --demo-documents demo` — this origin, publishing `dist/webair-0.6.0.agent.pkg` (since 2026-10-16; 0.5.0 from 2026-10-09, 0.4.0 from 2026-10-06, 0.3.0 before; 0.7.0 from the next deploy) and, since T8, the WebAgents demo documents beside it (below) |
| Health check | `GET /health` (states only that this is the fictional demo, the published package's SHA-256 and the demo documents' SHA-256s) |
| Environment | `PORT` (the platform's port; the service sets `8080`). No secret, database, external API or persistence |
| Configuration | [`deploy/railway.toml`](deploy/railway.toml) (start, health check, restart policy), [`deploy/railpack.json`](deploy/railpack.json) (the start command again: Railpack plans the image before `railway.toml` applies), [`deploy/.python-version`](deploy/.python-version) |

The deployment is an **allowlisted bundle**, never this directory: this directory also holds the
demo host's configuration (`host-resources.json`: fictional passengers and payment methods;
`host-bindings.json`), which belongs to the person's runtime and must never sit on WebAir's
server. [`deploy/bundle.py`](deploy/bundle.py) assembles exactly the origin's code, templates and
stylesheet, its pinned `requirements.txt`, the three platform files and the one signed package (as
`agent.pkg`), writes `BUNDLE.json` with every file's SHA-256, refuses if any resource id, name,
email or label from `host-resources.json` appears, and is reproducible byte for byte
([`tests/test_deploy_bundle.py`](tests/test_deploy_bundle.py)).

```sh
# from the repository root, with the Railway CLI signed in (railway login)
python3 demo/webair/deploy/bundle.py --package dist/webair-0.8.0.agent.pkg \
  --expect-sha256 9c81a9362754fc3c48c923b4968e75daa9e0260ae422be7e77b30f1df1a7eae0 \
  --out /tmp/webair-bundle
railway up /tmp/webair-bundle --path-as-root --service webagents-webair --environment production

# then: the page, the health check, and the exact bytes
curl -sS https://webagents-webair-production.up.railway.app/health
curl -sS https://webagents-webair-production.up.railway.app/agent.pkg -o /tmp/public.agent.pkg
cmp /tmp/public.agent.pkg dist/webair-0.8.0.agent.pkg && \
  agentpkg/.venv/bin/agentpkg verify /tmp/public.agent.pkg --trust-key examples/keys/webair-publisher.pub.pem
```

**WebAgents demo documents (T8).** The Chrome Agent Browser's search and policy subscription need
a public home for the signed demo index, the signed example research policy and the Literature
Review package the index lists. They do not belong to the airline; they are served here because this
is the demo deployment that exists. `origin/demo_documents.py` reads exactly seven files from the
directory named by `--demo-documents` (`$WEBAIR_DEMO_DOCUMENTS`) once at startup and serves each at
one fixed path: `/agent-index.json`, `/policies/webagents-research.json`,
`/packages/literature-review-0.2.9.agent.pkg` (the package indexes 1.4.0 and 1.5.0 list, T22, T24), and 0.2.8, 0.2.7,
0.2.6 and 0.2.5 at their paths (the ones indexes 1.3.0, 1.2.0, 1.1.0 and 1.0.0 listed, kept so their URLs
still resolve). The bundle carries them under `demo/`, byte for byte from `examples/` and `dist/`; without
the option the paths answer 404. Index 1.5.0 names WebAir 0.8.0, so it is deployed in the same bundle
as `dist/webair-0.8.0.agent.pkg`. After a redeploy:

```sh
for doc in agent-index.json policies/webagents-research.json; do
  curl -sS "https://webagents-webair-production.up.railway.app/$doc" | cmp - "examples/$doc"; done
node chrome-agent-browser/dist/cli.js document verify --type agent-index \
  --key examples/keys/webagents-index.pub.pem examples/agent-index.json
for version in 0.2.8 0.2.7 0.2.6 0.2.5; do
  curl -sS "https://webagents-webair-production.up.railway.app/packages/literature-review-$version.agent.pkg" \
    | cmp - "dist/literature-review-$version.agent.pkg"; done
```

To reproduce it in another Railway account: create a service, set `PORT=8080`, generate a domain
(`railway domain --port 8080`), set `DECLARED_HOST` in [`publisher/contract.py`](publisher/contract.py)
to that domain, run `python -m publisher sync` (it regenerates `host-bindings.json`), edit the
package's declared endpoints and policy to the same host, bump the version, build, sign with your
own key, and deploy the bundle. No credential is part of the bundle or the repository; the
Railway CLI keeps its own sign-in.

**The demo host's bindings.** [`host-bindings.json`](host-bindings.json) (generated by
`python -m publisher sync` from the contract this origin publishes) is the operator configuration
the Agent Browser reads through `plugins.entries.agent-browser.config.tools.bindingsFile`: four
entries of the service-neutral `openclaw.tool.json_http` adapter, one exact POST each to
`https://webagents-webair-production.up.railway.app/api/v1/<operation>`, with the schema digests,
permission kinds, side effects (`simulate_purchase` writes; the rest read), a 20 s timeout and
request/response bounds. The broker's fixed policy applies to them as to every binding (public
addresses only, pinned socket, TLS to the hostname, no redirects), and the package's declarations
bound them from above; a call still needs the person's permission, the tool's approval and a run
plan that froze the binding.

**Live demo.** [docs/webair-live-demo.md](../../docs/webair-live-demo.md) is the presentation
script; [`webair-030-live-demo.json`](../../examples/verification/webair-030-live-demo.json) the
recorded acceptance (real Agent Browser page, `openai/gpt-6-astra`, search → booking → simulated
purchase → refused replay → denied purchase, 133 checks).

## Next steps

1. **Optional tools.** 0.4.0's profiles say which tools each kind of task needs; once a runtime
   honours them, a host without resources can still run a search.
2. **Moving the unversioned alias.** v0.2.0 ships a runtime that accepts `personal.read`,
   but `dist/webair.agent.pkg` stays 0.1.0 because the recorded discovery, serving and live-demo
   evidence pins it; a later release can move it to the newest WebAir together with that evidence.
