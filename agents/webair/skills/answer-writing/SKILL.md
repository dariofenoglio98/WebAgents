---
name: answer-writing
description: Answer the person from WebAir's own tool results, naming only fares that exist and never personal data.
---

# Writing the answer

Your input has the person's `request` (this turn's message), the `interpreted_request` (with
its `intent`), the `selection`, WebAir's `search` answer, the `fare_rules` of the selected
fares, and, when they exist, a `booking_quote` and a `simulated_purchase`. It also has the
conversation so far: the `history` of earlier turns (message, intent, status, search, answer),
the `open_quote` and the `earlier_purchase` summaries, the `intent` and `note` of this turn and
the `purchase_decision` (`{accepted}`) when the person was asked before a purchase. Return
`answer` and `mentioned_fare_ids`. You write one reply in a conversation: refer to earlier
turns when the message does ("those fares", "the first one"), and do not repeat what the person
already read.

The quote and the purchase reach you as summaries: they carry no passenger name, email or
payment method, because you do not need them. Never mention, ask for or invent any of these;
refer to "the passenger you granted" and "the payment method you chose" instead.

## answer

Plain language, at most about 200 words, built only from these results.

By `intent`:

- **purchase** with `simulated_purchase` present: the person confirmed the purchase of the open
  quote and nothing was searched; report the purchase only (see below) and ignore `selection`.
- **purchase** with `purchase_decision.accepted` false: the person declined on the card. Say in
  one or two sentences that nothing was bought, that the quote stays open (name it from
  `booking_quote`) and that nothing is reserved or charged.
- **quote**: report the quote (see `booking_quote` below) and, when this turn searched, the fare
  it selected; invite the person to say "buy it" and tell them they will be asked to confirm.
- **question**: answer from `note`, `history`, `open_quote` and `earlier_purchase` only; nothing
  was searched. Never invent a flight or a price the conversation has not seen.
- **search**: by `selection.outcome`:

- **options_found**: the flights and fares that answer the request: flight number,
  local departure and arrival (say when arrival is the next day), fare name and price per
  passenger in USD. Name the selected fare and why it fits. State checked-bag, change and
  refund terms from `fare_rules` whenever the request is about them, and always say when a
  fare includes no checked bag. If the search used criteria the request did not state (they
  appear in `search.query`), mention them briefly ("nonstop, economy, from Boston").
- **no_matching_flights**: WebAir returned no flights for this search. Restate the route,
  date and filters searched. Do not suggest flights WebAir did not return.
- **request_refused**: WebAir refused the search; give its reason from `search.error`.
- **request_not_supported**: nothing was searched. When
  `interpreted_request.unsupported_reason` is set, explain it. When it is null,
  `interpreted_request.search` names a destination and a date but its `origin` is null and no
  travel profile supplied one: say in one sentence that you did not search because the request
  does not say where the person departs from, and ask them to name their departure airport
  (one of WebAir's six) or to use the agent in a way that lets it read their travel profile.

Then, if present:

- **booking_quote**: a quote, not a reservation. Give the quote id, the fare id, the fare,
  the number of passengers and the total in USD, and say nothing is reserved or charged.
- **simulated_purchase**: give the demo confirmation id and the quote id, and say plainly that
  the purchase was simulated, no real transaction was performed and the amount charged is $0
  (the fare would have cost `total_usd`).

If the request asked for something not searched (a return flight, a second leg), say so.
Never claim that a reservation, ticket or payment exists.

## mentioned_fare_ids

Every fare id whose price or terms the answer states, copied exactly from the search result,
the quote, the simulated purchase or an earlier turn's answer. An empty list when the answer
states none.
