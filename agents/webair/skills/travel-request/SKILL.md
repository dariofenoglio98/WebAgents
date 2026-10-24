---
name: travel-request
description: Read one message of a conversation with WebAir and say what it asks for: one WebAir flight search, a quote of one fare, the purchase of the open quote, a question the conversation answers, or goodbye.
---

# Interpreting a message

Your input has the person's `message`, the `history` of this conversation (each earlier turn's
message, what it asked for, how it ended, the search it sent WebAir and the answer), the
`known_fares` earlier turns offered or quoted, the `open_quote` (a quote summary, or null), the
earlier `purchase` (a confirmation summary, or null) and `profile_used`. Return `intent`,
`search`, `unsupported_reason`, `needs_travel_profile`, `fare_id` and `note`.

You never see the person's travel profile, identity or payment method, and you do not need
them. When you leave a search criterion open, the person's host fills it from the travel
profile they granted, after you answer, or the search runs without it.

## intent

- **search**: the message asks about flights, fares, prices, baggage, change or refund rules,
  or changes an earlier search ("only nonstop", "the cheapest one", "a day later", "business
  class"). A question about fares an earlier turn found is a search too: repeat that turn's
  search (from `history[].search`) with what the message changes, so the answer can quote
  WebAir's current rules. `search` is set (or `unsupported_reason`, see below); `fare_id` and
  `note` are null.
- **quote**: the message asks to quote, prepare or hold one fare for the person ("quote WA101
  Standard", "prepare the cheapest one for me"). Either name the fare in `fare_id`, copied
  exactly from `known_fares` (then `search` is null), or, when the person names a flight and
  fare the conversation has not found yet, set `search` for it and leave `fare_id` null: the
  fare the search selects is quoted. `note` is null.
- **purchase**: the message asks to buy, pay for or book the quote the conversation holds
  ("buy it", "book that quote"). Only when `open_quote` is not null and `purchase` is null (a
  quote is bought at most once). `note` is the one-sentence question the person will be asked
  before the simulated purchase: name the quote id, the flight and fare, the route, the date and
  the total, and end with a question mark. `search` and `fare_id` are null.
- **question**: the message asks something the conversation itself answers, with no WebAir
  call: what was found so far, which quote is open, whether anything was bought. Also a
  purchase without an open quote, or of a quote already bought: say so. `note` says what to
  tell the person, in one or two sentences. `search` and `fare_id` are null.
- **done**: the person ends the conversation ("that's all", "thanks, bye"). `note` is the
  goodbye, and it is the whole reply: say that nothing is booked or charged unless a purchase
  was simulated.

## search

- **origin**: the WebAir airport the person departs from, or **null when the message does not
  say and no earlier search of this conversation did**. Boston → `BOS`; New York JFK → `JFK`;
  Zurich → `ZRH`; Geneva → `GVA`; London Heathrow → `LHR`; Reykjavik or Keflavik → `KEF`. A
  WebAir flight number fixes its route (see the domain rules). Never substitute a nearby or
  similar airport for one WebAir does not serve.
- **destination**: the WebAir airport the person flies to.
- **date**: the local departure date, `YYYY-MM-DD`. A date without a year is its first
  occurrence on or after 1 October 2026. Resolve relative dates ("next Friday") against
  Friday 2 October 2026, the demo's today. Keep a stated date even if you think it is
  outside WebAir's schedule: WebAir itself answers that.
- **passengers**: the number of travelers stated, or 1 ("for me" is one).
- **nonstop_only**: true when the person asks for nonstop or direct flights, false when they
  say stops are fine, otherwise null.
- **max_price_usd**: a per-passenger price limit in whole dollars ("under $900" → 900), or
  null.
- **cabin**: `"business"` or `"economy"` only when the person asks for one, otherwise null.

A message that refines an earlier search keeps that search's criteria and changes only what it
says: "only nonstop, and the cheapest one" after a Boston to Zurich search on 9 October under
$900 is the same route, date and limit with `nonstop_only: true`. Plan one one-way search. If
the message asks for more (a return flight, several legs), plan its first outbound flight; the
answer will say what was not searched.

## needs_travel_profile

`true` when `origin` is null and no earlier turn supplies it, or when the person refers to
their usual preferences ("as usual", "my preferred cabin"). Otherwise `false`: a message that
says where it departs from is searched as stated, and what it leaves open stays open.

## When a search cannot be one search

Return `intent: "search"`, `search: null`, a short `unsupported_reason` (one sentence, for the
person) and `needs_travel_profile: false` when:

- a place is not one of WebAir's six airports (name it and say WebAir does not serve it);
- the message names no destination, or gives no departure date, and no earlier search does;
- the message is not about WebAir flights at all.

A missing departure airport is not one of these: leave `origin` null instead. Do not guess
anything else that is missing. For every other intent `unsupported_reason` is null.
