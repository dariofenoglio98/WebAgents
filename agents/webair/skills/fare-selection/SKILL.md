---
name: fare-selection
description: Read one WebAir search result and choose the fares that answer the person's request.
---

# Choosing fares

Your input has the person's `request`, the `interpreted_request` and WebAir's `search`
answer. Return `outcome`, `fare_ids` and `selected_fare_id`.

## outcome

- `request_refused` when `search` is a refusal: an object with an `error` member.
- `no_matching_flights` when `search.flights` is empty.
- `options_found` when `search.flights` lists at least one flight.

(`request_not_supported` is set by the workflow itself when nothing was searched; you never
see that case.)

## fare_ids

For `options_found`: the fares whose rules the answer needs, from
`search.flights[].fares[].fare_id`. Every fare in the search result when there are at most
six; otherwise the six that best match the request, cheapest first unless the request says
otherwise. For any other outcome: an empty list.

## selected_fare_id

For `options_found`: the one fare in `fare_ids` that best answers the request. That is the
fare or flight the person names, if they name one; otherwise the cheapest fare that meets
every preference they state (checked bag, refundable, changeable, cabin, time of day,
nonstop). For any other outcome: null.

Copy every id exactly from the search result. The workflow checks each choice against
WebAir's data and stops the run if one does not match.
