---
name: travel-request
description: Turn a person's travel request into one WebAir flight search, leaving open what the request does not say, or say why it cannot be one.
---

# Interpreting a travel request

Your input has the person's `request`. Return `search` (one WebAir `search_flights` call, with
some criteria possibly left open), `unsupported_reason` and `needs_travel_profile`. Exactly
one of `search` and `unsupported_reason` is null.

You never see the person's travel profile, identity or payment method, and you do not need
them. When you leave a criterion open, the person's host fills it from the travel profile they
granted, after you answer, or the search runs without it.

## search

- **origin**: the WebAir airport the person departs from, or **null when the request does not
  say**. Boston → `BOS`; New York JFK → `JFK`; Zurich → `ZRH`; Geneva → `GVA`; London
  Heathrow → `LHR`; Reykjavik or Keflavik → `KEF`. A WebAir flight number fixes its route (see
  the domain rules). Never substitute a nearby or similar airport for one WebAir does not
  serve.
- **destination**: the WebAir airport the person flies to.
- **date**: the local departure date, `YYYY-MM-DD`. A date without a year is its first
  occurrence on or after 1 October 2026. Resolve relative dates ("next Friday") against
  Friday 2 October 2026, the demo's today. Keep a stated date even if you think it is
  outside WebAir's schedule: WebAir itself answers that.
- **passengers**: the number of travelers the request states, or 1 ("for me" is one).
- **nonstop_only**: true when the person asks for nonstop or direct flights, false when they
  say stops are fine, otherwise null.
- **max_price_usd**: a per-passenger price limit in whole dollars ("under $900" → 900), or
  null.
- **cabin**: `"business"` or `"economy"` only when the person asks for one, otherwise null.

Plan one one-way search. If the request asks for more (a return flight, several legs), plan
its first outbound flight; the answer will say what was not searched. A request to book or
buy is still interpreted as the search it describes: whether a quote or a purchase happens is
the person's own choice in the task, never yours.

## needs_travel_profile

`true` when `origin` is null, or when the person refers to their usual preferences ("as
usual", "my preferred cabin"). Otherwise `false`: a request that says where it departs from is
searched as stated, and what it leaves open stays open.

## When it cannot be one search

Return `search: null`, a short `unsupported_reason` (one sentence, for the person) and
`needs_travel_profile: false` when:

- a place is not one of WebAir's six airports (name it and say WebAir does not serve it);
- the request names no destination, or gives no departure date;
- the request is not about WebAir flights at all.

A missing departure airport is not one of these: leave `origin` null instead. Do not guess
anything else that is missing.
