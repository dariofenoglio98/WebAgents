# WebAir Travel Agent — workflow.v0

`org.webagents.webair` 0.7.0, published by the fictional WebAir demo airline
(`demo/webair/`), whose public demo origin is <https://webagents-webair-production.up.railway.app/>.
WebAir serves the same business logic two ways: HTML pages and forms for people, and this
signed package for an agent-native host. **The package never touches WebAir's HTML.** It
declares WebAir's semantic operations as tools and carries the domain knowledge and
orchestration to use them. Nothing is ever booked or charged: WebAir is not an airline.

0.7.0 is 0.6.0 with its fare totals checked by code that can only compute
([compute.v0](../../spec/compute-v0.md)). WebAir states a total for every fare whose rules it
returns and for every quote (the per-passenger price times the party size). The package ships a
WebAssembly module, `modules/fares.wasm` (AssemblyScript, `examples/compute/fares-as/`, SHA-256
`ef7e813b9ac330575c89c75d96aa63bfe25d77da8d3a699cf4718879a8f123c0`, declared in the graph and
covered by the signature), that recomputes each total on the person's device, and the graph's
checks refuse any WebAir total that differs: a step in the fare-rules map (`total`) and two nodes
after the quote (`quote-total-input`, `quote-total`). The module imports nothing, so it can only
compute over the prices the graph gives it; it runs under the host's memory and time bounds, in
every mode. One required permission authorizes it (`compute.fares`, kind `compute`, in every
profile); the agent page says "runs code that can only compute" and shows the hash. WebAir's
prices are whole dollars, so the module's integer amounts are dollars here. 0.7.0 also gives the
`remember` step room for a model that thinks before it answers (10,000 output tokens instead of
4,000, 600 s, a 40,000-token budget): on a local thinking model 0.6.0's step could be cut off and
fail a run that had already made the quote. It needs a runtime that implements compute.v0
(agentpkg 0.5.0, the Chrome Agent Browser's core 0.3.0). Nothing a model sees changed.

0.6.0 was 0.5.0 with the person's memory ([memory.v0](../../spec/memory-v0.md)). The travel
profile is read from the person's memory (`memory.read` of the type `travel.profile`, as a
record view) instead of a host resource, and after a booking quote or a simulated purchase a
new `remember` model step may **propose** one travel preference to remember (`memory.write`).
Nothing is written by the run: the person reviews each proposal afterwards and accepts, edits
or rejects it. It needs a runtime that implements memory.v0 (agentpkg 0.4.0, the Chrome Agent
Browser's core 0.2.0). (0.5.0 answered a request that names no departure airport instead of
failing; 0.4.0 was 0.3.0 with [profiles](#profiles); 0.3.0 was 0.2.0 for the live deployment:
it names the public host instead of 0.2.0's reserved, never-resolving placeholder.)

**WebAir publishes the behavior. The person's runtime supplies the authority.** This version
asks the person's host for three personal records it does not own — a travel profile from the
person's memory, a passenger identity and a payment method — for a separate authority to
simulate a purchase, and for leave to propose one thing to remember. The package holds none of
these: no name, email or payment record is in its bytes.

## What it does

One task: a travel request in plain language, for example *"Find me a flight from Boston to
Zurich on 9 October under $900"*. Optionally a booking quote of the selected fare (`booking: true`),
or, in a separate run, a simulated purchase of one exact quote an earlier run returned
(`purchase: {quote_id, fare_id}`). Both are the person's choice in the task, never a model's.

```text
interpret (model: the request only)
  └─► travel profile (host, only when the request leaves the origin unstated)
        └─► departure airport (the request's, else the profile's; none: nothing is searched)
              └─► fill unstated criteria ─► search_flights ─► select (model) ─► checks
                    ─► get_fare_rules × ≤6, each total recomputed by the module and checked
booking:  passenger identity (host) ─► prepare_booking ─► total recomputed by the module
          ─► check ─► quote summary (no identity)
purchase: payment method (host) ─► passenger identity (host) ─► prepare_booking (re-quote)
          ─► check it is the authorized quote ─► simulate_purchase ─► check ─► summary
answer (model: summaries only) ─► assemble + validate ─► clear personal state ─► output
after a quote: remember (model: request and quote summary only) ─► proposals.json
```

38 nodes, all canonical workflow.v0 operators: 4 `llm`, 6 `tool` (the three personal reads,
search, quote, purchase), 1 `compute` (the quote's total), 1 `map` (fare rules: a `tool`, a
`compute` and a `validate` step per fare), 2 `join`, 23 `validate`, 1 `output`.

## Personal records: requested, never owned

| Tool | Binding | Permission (kind) | What the package receives |
|---|---|---|---|
| `travel.profile` | `host.memory.travel.profile` | `memory.travel_profile` (`memory.read`, optional) | the record view of one travel profile: title, home airport, preferred cabin, nonstop preference, currency (only these fields are used) |
| `personal.passenger_identity` | `host.resource.personal.passenger_identity` | `identity.passenger` (`personal.read`, optional) | given name, family name, contact email |
| `wallet.payment_method` | `host.resource.wallet.payment_method` | `wallet.payment` (`personal.read`, optional) | an opaque demo identifier WebAir accepts, and a display label |

Each permission's scope names a host resource **type**; the host lists the resources of that
type it holds, and the person picks one when granting. The tools take **no arguments**: the
package cannot name, guess or enumerate a resource. The host returns exactly the one the
person granted, frozen into the authorization receipt and run plan by opaque id and digest,
or refuses. The travel profile is a memory record (memory.v0 §7.1): the host recalls the
person's travel profiles, proposes the one used last, and the person confirms or picks another.
`schemas/host/travel.profile.view.schema.json` is the type's record view (memory.v0 M-16),
which a host binds only when it equals the view of its own type; the identity and payment
schemas are copies of the host's own resource type schemas (generated from
`demo/webair/host-resources.json`), which a host binding pins.

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
- `remember` (only after a quote or a purchase): the request, the interpretation and the quote
  summary. It returns at most one travel preference (a kind, a value, a title and a one-line
  rationale) or nothing. The runtime checks the proposal before the run completes (its type is
  one the package declared, its fields match the type, no sealed value anywhere in it) and
  writes it to `proposals.json`; the person decides after the run.

These are read sets in the graph, checked statically by the interpreter, not instructions: the
host-resource tools run in a `Personal` role with no model, and the state keys they write are
outside every model role's `state_read`. A final node clears every state key that held a host
resource or a request built from one, so the final state a host writes to disk keeps none.

## Booking and purchase

- **Quote**: `booking: true`. The fare is the checked selection; the passenger is the granted
  identity, one traveler. The quote is checked against the search (fare, price, party size) and
  against the request that was sent, and its total against the module's recomputation.
- **Simulated purchase**: a separate run whose task names `purchase.quote_id` and
  `purchase.fare_id` from a quote. It reads the payment method first (so a purchase without one
  stops before any identity is read), then the identity, and asks WebAir to quote that fare for
  that passenger again. Only if today's quote id is exactly the authorized one does it send
  `simulate_purchase`, with that quote id and the opaque payment identifier; a stale or
  substituted quote never reaches the purchase. WebAir recomputes the quote and refuses a
  mismatch too, and the graph checks the confirmation against the request.

## Requirements

Model tasks `interpret`, `select`, `answer`, `remember`: structured output and reasoning, a
16,000-token context window, host routing, no fallback. The package names no provider, model or
credential. Required permissions: `network.webair`, `model.reasoning`, `memory.session`,
`compute.fares` (`compute`, the fare-totals module); optional: `memory.travel_profile`, `identity.passenger`, `wallet.payment`,
`booking.simulate_purchase`, `memory.remember` (`memory.write` of `travel.preference`).
Budgets: 120,000 tokens, 22 remote calls, at most 1 search, 6 fare-rule reads, 1 quote, 1
purchase and 1 read of each personal record per run, 3 parallel workers. It ships a
WebAssembly module (compute.v0) and declares `memory.read` and `memory.write` (memory.v0), so its
minimum runtime is 0.5.0; agentpkg 0.4.0 and earlier, and the Chrome core before 0.3.0, refuse it
before anything runs (at the archive's `.wasm` member, which they read before the version).

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
person could make item by item: the profile's permissions and tools are granted and approved
under the host's own rules, the person picks one resource of each listed type, and everything
else is denied; the travel profile, a memory record, is recalled from the person's memory
rather than listed as a host resource. "Search flights" reads nothing personal, so its requests must say where the
trip starts; one that does not is answered with that request, and searches nothing. (The graph
cannot see the person's grants: if the interpreting model asks for the travel profile under
"Search flights", the runtime refuses that call and the run stops as `permission_denied`.) Each profile's estimate (model calls, tool calls, tokens) comes from the
publisher's recorded runs of the 0.5.0 graph, plus the one model call 0.6.0 adds after a booking
(0.7.0's module calls are not counted: they reach no model and no network),
and is information, not a limit: the budgets above are
the limits. A host that does not implement profiles ignores them, as agentpkg 0.2.2 does.

## Fixture

`fixtures/workflow.json` replays eight search scenarios (the default input is the hero
request). They involve no personal record and no booking, so the signed fixture holds no
personal data and its `proposals.json` is the empty document. Its
model outputs are scripted; its tool answers were recorded from WebAir's own API by
`demo/webair/publisher` (`python -m publisher sync`). The host-capability scenarios — profile,
quote, denied and simulated purchase — run on the Agent Browser host with the demo host's
resources (on the OpenClaw host with the signed 0.5.0, which reads no memory); see
[demo/webair/README.md](../../demo/webair/README.md).
