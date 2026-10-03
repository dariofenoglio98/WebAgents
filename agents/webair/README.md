# WebAir Travel Agent — workflow.v0

`org.webagents.webair` 0.1.0, published by the fictional WebAir demo airline
(`demo/webair/`). WebAir serves the same business logic two ways: HTML pages and forms for
people, and this signed package for an agent-native host. **The package never touches
WebAir's HTML.** It does not click, parse pages, read a DOM or take screenshots. It declares
WebAir's semantic operations as tools and carries the domain knowledge and orchestration to
use them. Nothing is ever booked or charged: WebAir is not an airline.

## What it does

One task: a travel request in plain language, for example *"Find me a nonstop flight from
Boston to Zurich on 9 October under $900."* Optionally with made-up passenger details (a
booking quote), and optionally with an explicit authorization of one exact quote from an
earlier run (a simulated purchase).

```text
interpret (model) ─► search_flights (tool) ─► select (model) ─► checks ─┬─► get_fare_rules × ≤6 (tool)
                                                                        └─► prepare_booking (tool, only with booking details)
                                                                              └─► simulate_purchase (tool, only with an authorized quote)
                                                     answer (model) ◄─────────────┘
                                                     assemble + validate ─► output
```

21 nodes, all canonical workflow.v0 operators: 3 `llm`, 3 `tool` (search, booking quote,
simulated purchase), 1 `map` (fare rules, a `tool` step and a `validate` step per fare),
1 `join`, 12 `validate`, 1 `output`.

## Tools: what the package asks for, not what it may do

| Tool | Binding | Declared endpoint (upper bound) | Permission | Side effects |
|---|---|---|---|---|
| `search-flights` | `webair.search_flights` | `POST https://webair.example/api/v1/search_flights` | `network.webair` (required) | read |
| `get-fare-rules` | `webair.get_fare_rules` | `POST https://webair.example/api/v1/get_fare_rules` | `network.webair` (required) | read |
| `prepare-booking` | `webair.prepare_booking` | `POST https://webair.example/api/v1/prepare_booking` | `network.webair.booking` (optional) | read, approval |
| `simulate-purchase` | `webair.simulate_purchase` | `POST https://webair.example/api/v1/simulate_purchase` | `network.webair.booking` (optional) | write, approval |

`webair.example` is a reserved name that never resolves (RFC 2606). Under agent.pkg 0.1 a
declared endpoint is an upper bound: a host binding must land inside it, and the package
gains no authority by naming it. The host chooses the implementation, the person approves
every tool, and the host's tool broker makes every call. A public WebAir deployment
publishes a new package version declaring its real hostname. `get_flight` is part of
WebAir's API but not of this package: every declared tool must be bound and approved before
a package can run, and the workflow never needs it.

The tool schemas in `schemas/api/` are generated from WebAir's published API contract
(`GET /api/v1/schemas`), not written by hand: each output schema is the answer or WebAir's
refusal (`{"error": …}`), because a `json_http` binding hands 4xx bodies to the package as
data. `demo/webair/tests/test_package_contract.py` fails if the origin and the package
drift apart.

## Why the graph checks so much

workflow.v0 can branch only on `eq`/`ne` and cannot ask whether a field exists, and
WebAir's answer and refusal share no field. So the `select` model step classifies the
search (`options_found`, `no_matching_flights`, `request_refused`; the graph itself sets
`request_not_supported` when nothing was searched), and declarative checks verify that
classification against WebAir's own answer. A wrong classification, an invented or unlisted
fare id, a fare price that differs from the search, a quote for another fare, price or party
size, a purchase of a quote other than the one the person authorized, or an answer citing a
fare WebAir did not offer stops the run with `schema_validation`.

The result separates what a model wrote from what WebAir said. `answer`,
`interpreted_request` and the chosen ids are model output, with the ids checked against the
search. `evidence.search`, `evidence.fare_rules`, `evidence.booking_quote` and
`evidence.simulated_confirmation` are WebAir's answers, copied verbatim. A confirmation's
schema requires `real_transaction: false` and `amount_charged_usd: 0`.

## Booking and purchase

Both are opt-in per task and never chosen by a model:

- **Quote**: only when the task carries `booking` (made-up passengers and a contact email),
  for the fare the checked selection names. The search's party size must equal the booking's.
- **Simulated purchase**: only when the task also carries `purchase`, an explicit `quote_id`
  from an earlier run and a demo payment method (`demo-visa-4242` or `demo-travel-1234`).
  The run prepares the quote again; if it is not exactly that quote, nothing is sent. WebAir
  also recomputes the quote and refuses a mismatch.

Passenger details and the payment method arrive in the task for now. A later milestone
supplies them from host-owned capabilities of the person's browser; the package's tool
contracts stay the same.

## Requirements

Model tasks `interpret`, `select`, `answer`: structured output and reasoning, a 16,000-token
context window, host routing, no fallback. The package names no provider, model or
credential. Permissions: `network.webair` (required), `network.webair.booking` (optional),
`model.reasoning`, `memory.session`. Budgets: 120,000 tokens, 20 remote calls, at most 1
search, 6 fare-rule reads, 1 quote and 1 purchase per run, 3 parallel workers.

## Fixture

`fixtures/workflow.json` replays nine scenarios (the default input is the hero request).
Its model outputs are scripted; its tool answers were recorded from WebAir's own API by
`demo/webair/publisher` (`python -m publisher sync`), which runs this package's graph in the
generic interpreter against the origin. See [demo/webair/README.md](../../demo/webair/README.md).
