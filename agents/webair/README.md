# WebAir Travel Agent — workflow.v0

`org.webagents.webair` 0.4.0, published by the fictional WebAir demo airline
(`demo/webair/`), whose public demo origin is <https://webagents-webair-production.up.railway.app/>.
WebAir serves the same business logic two ways: HTML pages and forms for people, and this
signed package for an agent-native host. **The package never touches WebAir's HTML.** It
declares WebAir's semantic operations as tools and carries the domain knowledge and
orchestration to use them. Nothing is ever booked or charged: WebAir is not an airline.

0.4.0 is 0.3.0 with [profiles](#profiles): three named groups of what the package already
declares, which a host can offer as a short path to authorization. The graph, tools, schemas,
skills, fixture, policy, permissions and budgets are unchanged. (0.3.0 was 0.2.0 for the live
deployment: it names the public host instead of 0.2.0's reserved, never-resolving placeholder.)

**WebAir publishes the behavior. The person's runtime supplies the authority.** This version
asks the person's host for three personal resources it does not own — a travel profile, a
passenger identity and a payment method — and for a separate authority to simulate a
purchase. The package holds none of these: no name, email or payment record is in its bytes.

## What it does

One task: a travel request in plain language, for example *"Find me a flight to Zurich on
9 October under $900."* Optionally a booking quote of the selected fare (`booking: true`),
or, in a separate run, a simulated purchase of one exact quote an earlier run returned
(`purchase: {quote_id, fare_id}`). Both are the person's choice in the task, never a model's.

```text
interpret (model: the request only)
  └─► travel profile (host, only when the request leaves the origin unstated)
        └─► fill unstated criteria ─► search_flights ─► select (model) ─► checks ─► get_fare_rules × ≤6
booking:  passenger identity (host) ─► prepare_booking ─► check ─► quote summary (no identity)
purchase: payment method (host) ─► passenger identity (host) ─► prepare_booking (re-quote)
          ─► check it is the authorized quote ─► simulate_purchase ─► check ─► summary
answer (model: summaries only) ─► assemble + validate ─► clear personal state ─► output
```

34 nodes, all canonical workflow.v0 operators: 3 `llm`, 6 `tool` (the three host resources,
search, quote, purchase), 1 `map` (fare rules: a `tool` step and a `validate` step per fare),
2 `join`, 21 `validate`, 1 `output`.

## Host-owned resources: requested, never owned

| Tool | Binding | Permission (kind) | What the package receives |
|---|---|---|---|
| `personal.travel_profile` | `host.resource.personal.travel_profile` | `profile.travel` (`personal.read`, optional) | home airport, preferred cabin, nonstop preference, currency |
| `personal.passenger_identity` | `host.resource.personal.passenger_identity` | `identity.passenger` (`personal.read`, optional) | given name, family name, contact email |
| `wallet.payment_method` | `host.resource.wallet.payment_method` | `wallet.payment` (`personal.read`, optional) | an opaque demo identifier WebAir accepts, and a display label |

Each permission's scope names a host resource **type**; the host lists the resources of that
type it holds, and the person picks one when granting. The tools take **no arguments**: the
package cannot name, guess or enumerate a resource. The host returns exactly the one the
person granted, frozen into the authorization receipt and run plan by opaque id and digest,
or refuses. The tool schemas in `schemas/host/` are copies of the host's own resource type
schemas (generated from `demo/webair/host-resources.json`), which a host binding pins.

## Tools of WebAir's own API

| Tool | Binding | Declared endpoint (upper bound) | Permissions | Side effects |
|---|---|---|---|---|
| `search-flights` | `webair.search_flights` | `POST https://webagents-webair-production.up.railway.app/api/v1/search_flights` | `network.webair` | read |
| `get-fare-rules` | `webair.get_fare_rules` | `POST https://webagents-webair-production.up.railway.app/api/v1/get_fare_rules` | `network.webair` | read |
| `prepare-booking` | `webair.prepare_booking` | `POST https://webagents-webair-production.up.railway.app/api/v1/prepare_booking` | `network.webair`, `identity.passenger` | read, approval |
| `simulate-purchase` | `webair.simulate_purchase` | `POST https://webagents-webair-production.up.railway.app/api/v1/simulate_purchase` | `network.webair`, `booking.simulate_purchase` (`payment`), `identity.passenger`, `wallet.payment` | write, approval |

A tool's permissions are the authority it travels under: the runtime checks every one of them
at each call, and a host refuses to send a granted resource's sealed value (an email, a
payment identifier) to a tool that does not link the permission it was granted under. So the
identity can reach only `prepare-booking` and `simulate-purchase`, the payment identifier only
`simulate-purchase`, and the search and fare-rule tools neither. Search authority can never
become purchase authority: `simulate-purchase` also needs `booking.simulate_purchase`, the
package's only `payment` permission, which a person can grant `once`, for one run.

The declared host is WebAir's public demo deployment (versions up to 0.2.0 declared a
reserved, never-resolving placeholder name, RFC 2606). A declared endpoint is an upper bound,
even on a real, public origin: a host binding must land inside it, the host decides whether it
binds anything there at all, and the package gains no authority by naming it. The tool schemas
in `schemas/api/` are generated from WebAir's published API contract.

## What each model sees

- `interpret`: the request text only. Unstated criteria stay null; the graph fills them from
  the granted profile afterwards, so no model ever receives the profile as such.
- `select`: the request, the interpretation and WebAir's search answer, whose `query` echoes
  the criteria searched (including any the profile supplied: home airport, cabin, nonstop).
- `answer`: the same plus fare rules and **redacted summaries** of a quote and a purchase:
  quote and confirmation ids, fare, price, passenger count, `real_transaction: false`,
  `amount_charged_usd: 0`. Never a name, an email, a payment identifier or its label.

These are read sets in the graph, checked statically by the interpreter, not instructions: the
host-resource tools run in a `Personal` role with no model, and the state keys they write are
outside every model role's `state_read`. A final node clears every state key that held a host
resource or a request built from one, so the final state a host writes to disk keeps none.

## Booking and purchase

- **Quote**: `booking: true`. The fare is the checked selection; the passenger is the granted
  identity, one traveler. The quote is checked against the search (fare, price, party size) and
  against the request that was sent.
- **Simulated purchase**: a separate run whose task names `purchase.quote_id` and
  `purchase.fare_id` from a quote. It reads the payment method first (so a purchase without one
  stops before any identity is read), then the identity, and asks WebAir to quote that fare for
  that passenger again. Only if today's quote id is exactly the authorized one does it send
  `simulate_purchase`, with that quote id and the opaque payment identifier; a stale or
  substituted quote never reaches the purchase. WebAir recomputes the quote and refuses a
  mismatch too, and the graph checks the confirmation against the request.

## Requirements

Model tasks `interpret`, `select`, `answer`: structured output and reasoning, a 16,000-token
context window, host routing, no fallback. The package names no provider, model or
credential. Required permissions: `network.webair`, `model.reasoning`, `memory.session`;
optional: `profile.travel`, `identity.passenger`, `wallet.payment`, `booking.simulate_purchase`.
Budgets: 120,000 tokens, 20 remote calls, at most 1 search, 6 fare-rule reads, 1 quote, 1
purchase and 1 read of each host resource per run, 3 parallel workers. It declares
`personal.read`, a permission kind agentpkg accepts since the WebAgents v0.2.0 release, whose
runtime reports 0.2.2, the package's minimum; the v0.1.0 release's wheel carries the same
version number and rejects the package.

## Profiles

The manifest's noncritical extension `org.webagents:profiles-v0`
([specification](../../spec/extensions/profiles-v0.md)) groups what the package declares into
three profiles, each containing the previous one:

| Profile | Permissions | Tools | Host resources |
|---|---|---|---|
| `search` "Search flights" | `network.webair`, `model.reasoning`, `memory.session` | `search-flights`, `get-fare-rules` | none |
| `quote` "Search and quote" | adds `profile.travel`, `identity.passenger` | adds `prepare-booking`, `personal.travel_profile`, `personal.passenger_identity` | travel profile, passenger identity |
| `book` "Book (simulated)" | adds `wallet.payment`, `booking.simulate_purchase` | adds `simulate-purchase`, `wallet.payment_method` | adds the payment method |

A profile presents authority; it grants nothing. Choosing one gives the host the decisions a
person could make item by item: the profile's permissions and tools are granted and approved
under the host's own rules, the person picks one resource of each listed type, and everything
else is denied. "Search flights" reads nothing personal, so its requests must say where the
trip starts. Each profile's estimate (model calls, tool calls, tokens) comes from the
publisher's recorded runs of this graph and is information, not a limit: the budgets above are
the limits. A host that does not implement profiles ignores them, as agentpkg 0.2.2 does.

## Fixture

`fixtures/workflow.json` replays seven search scenarios (the default input is the hero
request). They involve no host resource, so the signed fixture holds no personal data. Its
model outputs are scripted; its tool answers were recorded from WebAir's own API by
`demo/webair/publisher` (`python -m publisher sync`). The host-capability scenarios — profile,
quote, denied and simulated purchase — run on the Agent Browser host with the demo host's
resources; see [demo/webair/README.md](../../demo/webair/README.md).
