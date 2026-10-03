---
name: travel-request
description: Turn a person's travel request into one WebAir flight search, or say why it cannot be one.
---

# Interpreting a travel request

Your input has the person's `request` and, when they want a booking quote, `booking` with
the passengers. Return `search` (the arguments of one WebAir `search_flights` call) and
`unsupported_reason`: exactly one of the two is null.

## search

- **origin, destination**: WebAir airport codes. Boston → `BOS`; New York JFK → `JFK`;
  Zurich → `ZRH`; Geneva → `GVA`; London Heathrow → `LHR`; Reykjavik or Keflavik → `KEF`.
  Never substitute a nearby or similar airport for one WebAir does not serve.
- **date**: the local departure date, `YYYY-MM-DD`. A date without a year is its first
  occurrence on or after 1 October 2026. Resolve relative dates ("next Friday") against
  Friday 2 October 2026, the demo's today. Keep a stated date even if you think it is
  outside WebAir's schedule: WebAir itself answers that.
- **passengers**: the number of passengers in `booking` when it is given; otherwise the
  number of travelers the request states, or 1.
- **nonstop_only**: true only when the person asks for nonstop or direct flights.
- **max_price_usd**: a per-passenger price limit in whole dollars ("under $900" → 900), or
  null.
- **cabin**: `"business"` or `"economy"` only when the person asks for one, otherwise null.

Plan one one-way search. If the request asks for more (a return flight, several legs), plan
its first outbound flight; the answer will say what was not searched.

## When it cannot be one search

Return `search: null` and a short `unsupported_reason` (one sentence, for the person) when:

- a place is not one of WebAir's six airports (name it and say WebAir does not serve it);
- the request does not name both ends of a trip, or gives no departure date;
- the request is not about WebAir flights at all.

Do not guess the missing part.
