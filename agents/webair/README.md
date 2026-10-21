# WebAir Travel Agent — workflow.v0, conversational

`org.webagents.webair` 0.8.0, published by the fictional WebAir demo airline
(`demo/webair/`), whose public demo origin is <https://webagents-webair-production.up.railway.app/>.
WebAir serves the same business logic two ways: HTML pages and forms for people, and this
signed package for an agent-native host. **The package never touches WebAir's HTML.** It
declares WebAir's semantic operations as tools and carries the domain knowledge and
orchestration to use them. Nothing is ever booked or charged: WebAir is not an airline.

0.8.0 is 0.7.0 as a **conversation** ([conversation.v0](../../spec/conversation-v0.md)). The
person talks to WebAir in turns: a search, a refinement ("only nonstop, and the cheapest one"),
a question about the fares found, a quote of one of them, "buy it", goodbye. Each turn runs the
same signed graph; what outlives a turn is declared (`schemas/conversation-state.schema.json`):
the history (messages, intents, outcomes, the searches sent and the answers), the fares the
person may name, the open quote and the confirmation as the summaries the models see, and
whether the travel profile was read. Never a name, an e-mail, a payment identifier or the
payment method's label: every personal value is cleared before a turn ends, as before, and the
label stays in the reply's `purchase` only. The one consequential action, the simulated purchase, is
behind a **consent step** (`confirm-purchase`): in the turn that buys, after WebAir has quoted
the fare again for the granted passenger, the person's runtime shows a card with the quote's
facts (quote id, flight, fare, route, date, total, the passenger's name, the payment method's
display label) and the interpreter's one-sentence question, and waits for a yes or a no. A model
never decides a purchase, a declined card is never retried, and the `once` grant of the
purchase authority is spent by the first purchase of the conversation (a second "buy it" is not
even asked). The task's `booking` and `purchase` switches of 0.7.0 are gone: a quote or a
purchase is said in the conversation and decided by the graph and the person. It needs a
runtime that implements conversation.v0 (agentpkg 0.6.0, the Chrome Agent Browser's core
0.4.0); `agentpkg run` refuses it and says to use `agentpkg converse`.

0.7.0 was 0.6.0 with its fare totals checked by code that can only compute
([compute.v0](../../spec/compute-v0.md)): the WebAssembly module `modules/fares.wasm`
(AssemblyScript, `examples/compute/fares-as/`, SHA-256
`ef7e813b9ac330575c89c75d96aa63bfe25d77da8d3a699cf4718879a8f123c0`, declared in the graph and
covered by the signature) recomputes each fare total and the quote's total on the person's
device, and the graph's checks refuse a total WebAir misstates; one required permission
authorizes it (`compute.fares`, kind `compute`, in every profile). 0.6.0 was 0.5.0 with the
person's memory ([memory.v0](../../spec/memory-v0.md)): the travel profile is read from the
person's memory as a record view, and after a quote a `remember` step may **propose** one travel
preference (`memory.write`), which the person reviews afterwards. (0.5.0 answered a request that
names no departure airport instead of failing; 0.4.0 was 0.3.0 with [profiles](#profiles); 0.3.0
was 0.2.0 for the live deployment.)

**WebAir publishes the behavior. The person's runtime supplies the authority.** This version
asks the person's host for three personal records it does not own — a travel profile from the
person's memory, a passenger identity and a payment method — for a separate authority to
simulate a purchase, confirmed on a card in the turn that buys, and for leave to propose one
thing to remember. The package holds none of these: no name, email or payment record is in its
bytes.

## What it does

One message per turn, in plain language: *"Find me a flight from Boston to Zurich on 9 October
under $900"*, then *"Only nonstop, and the cheapest one."*, *"Quote WA101 Standard for me."*,
*"Buy it."*, *"That's all, thanks."* The interpreter reads the message with the conversation and
says what it asks for (`intent`: `search`, `quote`, `purchase`, `question` or `done`); the rest
of the turn graph follows that.

```text
interpret (model: the message, the history, the known fares, the open quote)
  ├─ search:   travel profile (host, only when the departure airport is unstated)
  │            ─► departure airport ─► fill unstated criteria ─► search_flights
  │            ─► select (model) ─► checks ─► get_fare_rules × ≤6, each total recomputed
  ├─ quote:    the fare named (checked against the known fares) or the one the search selects
  │            ─► passenger identity (host) ─► prepare_booking ─► total recomputed ─► checks
  │            ─► quote summary (no identity) ─► kept as the open quote
  ├─ purchase: payment method (host) ─► passenger identity (host) ─► prepare_booking (re-quote)
  │            ─► check it is the open quote ─► card: confirm-purchase (consent) ─► if yes:
  │            simulate_purchase ─► check ─► summary ─► kept as the confirmation
  ├─ question: nothing is called; the answer comes from the conversation
  └─ done:     the interpreter's goodbye is the reply; the conversation ends
answer (model: summaries and the history) ─► assemble + validate ─► history ─► clear personal state ─► output
after a quote or a purchase: remember (model: message, interpretation and quote summary) ─► proposals.json
```

48 nodes, all canonical operators: 4 `llm`, 6 `tool` (the three personal reads, search, quote,
purchase), 1 `consent`, 1 `compute` (the quote's total), 1 `map` (fare rules: a `tool`, a
`compute` and a `validate` step per fare), 3 `join` (the offered fares, the known fares, the
history), 31 `validate`, 1 `output`.

## The conversation

| Declared | Value |
|---|---|
| persistent state | `history` (≤ 8 turns), `known_fares`, `quote_ref` (the open quote's summary), `confirmation_ref` (the purchase summary, without the payment label), `profile_used` |
| budget | `max_turns` 8, `hard_tokens` 240,000, `max_remote_calls` 60, at most 1 `simulate-purchase` per conversation (per turn: 120,000 tokens, 22 remote calls) |
| end | when the reply's `intent` is `done` |
| consent step | `confirm-purchase`, on the coordinator, decides `booking.simulate_purchase`; `simulate-purchase` is the only tool that links it and runs only after the step was accepted in the same turn |
| fixture | `fixtures/transcript.json`: three turns of searches (a broad search, "only nonstop, and the cheapest one", goodbye), replayed by `agentpkg converse --mode fixture` with the graph's fixture |

The card's facts are built by the graph (`purchase-facts`) from WebAir's re-quote and the host's
two reads: the quote id, the fare and flight, the route and date, the total and currency, the
passenger's given and family name, the payment method's display label. The contact e-mail and
the payment identifier are never in them; the audit keeps only the hashes of the text and the
facts, the transcript keeps what the person saw.

## Personal records: requested, never owned

| Tool | Binding | Permission (kind) | What the package receives |
|---|---|---|---|
| `travel.profile` | `host.memory.travel.profile` | `memory.travel_profile` (`memory.read`, optional) | the record view of one travel profile: title, home airport, preferred cabin, nonstop preference, currency (only these fields are used) |
| `personal.passenger_identity` | `host.resource.personal.passenger_identity` | `identity.passenger` (`personal.read`, optional) | given name, family name, contact email |
| `wallet.payment_method` | `host.resource.wallet.payment_method` | `wallet.payment` (`personal.read`, optional) | an opaque demo identifier WebAir accepts, and a display label |

Each permission's scope names a host resource **type**; the host lists the resources of that
type it holds, and the person picks one when granting, for the whole conversation. The tools
take **no arguments**: the package cannot name, guess or enumerate a resource. The host returns
exactly the one the person granted, frozen into the authorization receipt and run plan by opaque
id and digest, or refuses. The travel profile is a memory record (memory.v0 §7.1).
`schemas/host/travel.profile.view.schema.json` is the type's record view (memory.v0 M-16); the
identity and payment schemas are copies of the host's own resource type schemas (generated from
`demo/webair/host-resources.json`), which a host binding pins.

## Tools of WebAir's own API

| Tool | Binding | Declared endpoint (upper bound) | Permissions | Side effects |
|---|---|---|---|---|
| `search-flights` | `webair.search_flights` | `POST https://webagents-webair-production.up.railway.app/api/v1/search_flights` | `network.webair` | read |
| `get-fare-rules` | `webair.get_fare_rules` | `POST https://webagents-webair-production.up.railway.app/api/v1/get_fare_rules` | `network.webair` | read |
| `prepare-booking` | `webair.prepare_booking` | `POST https://webagents-webair-production.up.railway.app/api/v1/prepare_booking` | `network.webair`, `identity.passenger` | read, approval |
| `simulate-purchase` | `webair.simulate_purchase` | `POST https://webagents-webair-production.up.railway.app/api/v1/simulate_purchase` | `network.webair`, `booking.simulate_purchase` (`payment`, gated by `confirm-purchase`), `identity.passenger`, `wallet.payment` | write, approval |

A tool's permissions are the authority it travels under: the runtime checks every one of them
at each call, and a host refuses to send a granted resource's sealed value (an email, a payment
identifier) to a tool that does not link the permission it was granted under. So the identity
can reach only `prepare-booking` and `simulate-purchase`, the payment identifier only
`simulate-purchase`, and the search and fare-rule tools neither. Search authority can never
become purchase authority: `simulate-purchase` also needs `booking.simulate_purchase`, the
package's only `payment` permission, which a person can grant `once`, for one purchase, and
which the card confirms at the moment it matters.

A declared endpoint is an upper bound, even on a real, public origin: a host binding must land
inside it, the host decides whether it binds anything there at all, and the package gains no
authority by naming it. The tool schemas in `schemas/api/` are generated from WebAir's published
API contract.

## What each model sees

- `interpret`: the message, the history (messages, intents, outcomes, searches, answers), the
  known fares' ids, the open quote and the confirmation as summaries, and `profile_used`.
  Unstated search criteria stay null; the graph fills them from the granted profile afterwards,
  so no model ever receives the profile as such.
- `select`: the message, the interpretation and WebAir's search answer, whose `query` echoes
  the criteria searched (including any the profile supplied: home airport, cabin, nonstop).
- `answer`: the same plus fare rules, the history, the open quote and the earlier purchase as
  summaries, the person's decision on the card (`{accepted}`) and **redacted summaries** of this
  turn's quote and purchase: quote and confirmation ids, fare, price, passenger count,
  `real_transaction: false`, `amount_charged_usd: 0`. Never a name, an email, a payment
  identifier or its label. On goodbye no model writes: the interpreter's note is the reply.
- `remember` (only after a quote or a purchase): the message, the interpretation and the quote
  summary. It returns at most one travel preference or nothing; the runtime checks the proposal
  before the turn completes and writes it to the turn's `proposals.json`; the person decides.

These are read sets in the graph, checked statically by the interpreter, not instructions: the
host-resource tools run in a `Personal` role with no model, and the state keys they write, the
card's facts included, are outside every model role's `state_read`. A final node clears every
state key that held a host resource or a request built from one, so neither the turn's final
state nor the persisted conversation state keeps any.

## Quote and purchase

- **Quote** (`intent: quote`): the fare is the one the person names, copied from the known fares
  and checked against them (`check-quote-fare`), or the one this turn's search selects; the
  passenger is the granted identity, one traveler. The quote is checked against the search when
  there was one (fare, price, party size), its total against the module's recomputation, and its
  summary becomes the conversation's open quote.
- **Simulated purchase** (`intent: purchase`): only with an open quote (`check-open-quote`). The
  turn reads the payment method first (so a purchase without one stops before any identity is
  read), then the identity, and asks WebAir to quote that fare for that passenger again. Only if
  today's quote is exactly the open one (id, fare, total; `check-quote-authorized`) is the card
  shown; only if the person accepts does the turn send `simulate_purchase`, with the quote id and
  the opaque payment identifier. A quote WebAir no longer honours, a declined card and a spent
  `once` grant each leave the purchase unmade, and the graph checks the confirmation against the
  request.

## Requirements

Model tasks `interpret`, `select`, `answer`, `remember`: structured output and reasoning, a
16,000-token context window, host routing, no fallback. The package names no provider, model or
credential. Required permissions: `network.webair`, `model.reasoning`, `memory.session`,
`compute.fares`; optional: `memory.travel_profile`, `identity.passenger`, `wallet.payment`,
`booking.simulate_purchase` (the consent step's permission), `memory.remember`. Budgets per
turn: 120,000 tokens, 22 remote calls, at most 1 search, 6 fare-rule reads, 1 quote, 1 purchase
and 1 read of each personal record, 3 parallel workers; per conversation: 8 turns, 240,000
tokens, 60 remote calls, 1 purchase. It declares a conversation (conversation.v0), ships a
WebAssembly module (compute.v0) and declares `memory.read` and `memory.write` (memory.v0), so its
minimum runtime is 0.6.0; agentpkg 0.5.0 and earlier, and the Chrome core before 0.4.0, refuse
it by its version before anything runs.

## Profiles

The manifest's noncritical extension `org.webagents:profiles-v0`
([specification](../../spec/extensions/profiles-v0.md)) groups what the package declares into
three profiles, each containing the previous one:

| Profile | Permissions | Tools | Host resources |
|---|---|---|---|
| `search` "Search flights" | `network.webair`, `model.reasoning`, `memory.session`, `compute.fares` | `search-flights`, `get-fare-rules` | none |
| `quote` "Search and quote" | adds `memory.travel_profile`, `identity.passenger`, `memory.remember` | adds `prepare-booking`, `travel.profile`, `personal.passenger_identity` | passenger identity (the travel profile is recalled from memory) |
| `book` "Book (simulated)" | adds `wallet.payment`, `booking.simulate_purchase` | adds `simulate-purchase`, `wallet.payment_method` | adds the payment method |

A profile presents authority; it grants nothing. Choosing one gives the host the decisions a
person could make item by item, for the whole conversation: the profile's permissions and tools
are granted and approved under the host's own rules, the person picks one resource of each
listed type, and everything else is denied. The purchase authority is granted `once` by the
host's rule for a payment permission; the card in the turn that buys is the person's consent to
this purchase with these facts, under D-261's floor (a payment is always asked). "Search
flights" reads nothing personal, so its messages must say where the trip starts; a turn that
asks for a quote under it stops at the identity read as `permission_denied`, and the
conversation goes on. Each profile's estimate (model calls, tool calls, tokens) is per turn,
from the publisher's recorded runs of the same graph, and is information, not a limit.

## Fixture

`fixtures/workflow.json` replays the fixture conversation (three turns) and eight single-turn
search scenarios (the default input is the fixture conversation's first message). They involve
no personal record and no quote, so the signed fixture holds no personal data and each turn's
`proposals.json` is the empty document. Its model outputs are scripted; its tool answers were
recorded from WebAir's own API by `demo/webair/publisher` (`python -m publisher sync`), which
runs the conversation turn by turn through the generic runner. The quote and purchase
conversations (profile, quote, a quote of a known fare, the card accepted, declined, denied) are
the demo tests over the demo host's data (`demo/webair/tests/`) and the live runs; see
[demo/webair/README.md](../../demo/webair/README.md).
