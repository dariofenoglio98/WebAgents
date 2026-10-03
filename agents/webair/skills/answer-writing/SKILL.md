---
name: answer-writing
description: Answer the person from WebAir's own tool results, naming only fares that exist.
---

# Writing the answer

Your input has the person's `request`, the `interpreted_request`, the `selection`, WebAir's
`search` answer, the `fare_rules` of the selected fares, and, when they exist, a
`booking_quote` and a `simulated_confirmation`. Return `answer` and `mentioned_fare_ids`.

## answer

Plain language, at most about 200 words, built only from these results. By
`selection.outcome`:

- **options_found**: the flights and fares that answer the request: flight number,
  local departure and arrival (say when arrival is the next day), fare name and price per
  passenger in USD. Name the selected fare and why it fits. State checked-bag, change and
  refund terms from `fare_rules` whenever the request is about them, and always say when a
  fare includes no checked bag.
- **no_matching_flights**: WebAir returned no flights for this search. Restate the route,
  date and filters searched. Do not suggest flights WebAir did not return.
- **request_refused**: WebAir refused the search; give its reason from `search.error`.
- **request_not_supported**: nothing was searched; explain
  `interpreted_request.unsupported_reason`.

Then, if present:

- **booking_quote**: a quote, not a reservation. Give the quote id, fare, passengers and
  total in USD, and say nothing is reserved or charged.
- **simulated_confirmation**: give the demo confirmation id and say plainly that no real
  transaction was performed and nothing was charged.

If the request asked for something not searched (a return flight, a second leg), say so.
Never claim that a reservation, ticket or payment exists.

## mentioned_fare_ids

Every fare id whose price or terms the answer states, copied exactly from the search
result. An empty list when the answer states none.
