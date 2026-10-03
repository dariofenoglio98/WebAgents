# WebAir — a fictional airline origin

WebAir is a made-up airline that exists only for the WebAgents demo. It is a small, local web
origin with two faces over one set of business logic:

```text
                         WebAir origin
                         /           \
                     HTML           agent.pkg
                      |                |
                    human        agent-native browser
```

> **No real booking or payment ever occurs.** WebAir is not an airline. Every flight, schedule
> and price is invented; "purchases" are simulated, nothing is reserved, charged or issued, and
> the site collects no card details. It calls no airline, payment or other external service.

## Why it exists

It is the motivating story for WebAgents. A normal website serves pages and forms designed for
people, so a general-purpose agent has to reverse-engineer them: fill the search form, read
the results, click through fares, type passengers, pay. The same origin can also publish an
**agent package**: a signed `agent.pkg` that an agent-native browser can discover, verify,
authorize and run. It binds that package's tools to the origin's semantic operations instead of
scraping the HTML.

WebAir gives that story a concrete origin. Both interfaces use the same `WebAirService`, so a
search, a fare quote or a simulated purchase gives the same answer whichever interface asks.

## What this milestone implements

| Piece | Where |
|---|---|
| Deterministic, fictional inventory: 6 airports, 16 flight numbers, 20 itineraries (nonstop and one-stop), 4 fare families | [`origin/inventory.py`](origin/inventory.py) |
| Shared service layer: search, flight, fare rules, booking quote, simulated purchase | [`origin/service.py`](origin/service.py) |
| Typed, bounded request/response models | [`origin/models.py`](origin/models.py) |
| Human website: home → search → results → flight → fare → passengers → payment → confirmation | [`origin/web.py`](origin/web.py), [`origin/templates/`](origin/templates/), [`origin/static/webair.css`](origin/static/webair.css) |
| Semantic JSON API for a future package's tools | [`origin/api.py`](origin/api.py) |
| Experimental discovery hint plus a fixed `/agent.pkg` route | [`origin/agent_package.py`](origin/agent_package.py) |
| Tests: service, API, HTML journey, discovery, safety | [`tests/`](tests/) |

### Not implemented yet (on purpose)

The WebAir `agent.pkg` and its signature. Browser-side discovery or automatic opening of the
package. Registering WebAir's operations with any WebAgents host or Tool Broker. Personal-data
or payment capabilities, mid-run authorization, NANDA. Real airline or payment services. No
generic WebAgents code was changed or special-cased for WebAir.

## Running it

From the repository root:

```sh
python3 -m venv demo/webair/.venv
demo/webair/.venv/bin/python -m pip install -r demo/webair/requirements-dev.txt
cd demo/webair && .venv/bin/python -m origin
```

Then open **<http://127.0.0.1:8040/>**. Options: `--host`, `--port`, and `--agent-package PATH`
(see below). Python 3.11+ is required; the runtime dependencies are FastAPI, Pydantic, Jinja2
and uvicorn ([`requirements.txt`](requirements.txt)). The pages use no JavaScript, CDN or
external font.

Tests and lint:

```sh
cd demo/webair
.venv/bin/python -m pytest
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

## Human demo flow

1. **Home** (`/`): the search form is pre-filled with Boston (BOS) → Zurich (ZRH),
   **Fri 9 Oct 2026**, 1 passenger. `/flights` has the full form: cabin, maximum price, nonstop
   only.
2. **Results** (`/results?…`): four BOS→ZRH flights that day. Two are nonstop (WA101, WA105) and
   two connect via London (WA213 + WA741) or Reykjavik (WA205 + WA731).
3. **Flight** (`/flight/WA101-20261009`): compare Economy Basic, Standard, Flex and Business.
4. **Fare** (`/fare/WA101-20261009-STANDARD`): baggage, change and refund rules, total price.
5. **Passengers** (`/passenger?fare_id=…`): one name per traveler and a contact email. Use
   made-up details.
6. **Payment** (`POST /payment`): review, then pick *Demo Visa •••• 4242* or *Demo Travel Card
   •••• 1234*. No card number is ever asked for.
7. **Confirmation** (`POST /confirmation`): a demo code such as `WA-DEMO-HT8J6` and the notice
   **"No real transaction was performed."**

The journey is stateless. Passenger details travel only in the forms of the journey's own pages.
The origin writes nothing to disk and keeps nothing in memory between requests.

## Demo data

* **Dates.** The bookable window is explicit: 1 Oct 2026 – 31 Dec 2027. Nothing depends on
  today's date. Flights follow weekly patterns; for example, WA105 flies Mon/Wed/Fri/Sun.
* **Times.** Local departure time plus block time, converted with the IANA time zones of the
  airports, so arrivals and connections stay correct across both DST changes.
* **Prices.** Whole USD per passenger, taxes included:
  `itinerary base × fare-family % × weekday %`. The weekday factor is Fri 110%, Tue/Wed 92%, and
  so on.
* **Seats.** A fixed count per fare family. A fare is unavailable when fewer seats remain than
  passengers. Simulated purchases never consume seats.

The motivating query, *"a nonstop flight from Boston to Zurich next Friday under $900"* (Fri
9 Oct 2026), returns WA101 Basic $704, WA101 Standard $858 and WA105 Basic $749. Choosing among
them means reading the fare rules: only Standard includes a checked bag.

## Mock API operations

Each operation is one fixed path, `POST /api/v1/<operation>`, with the arguments as an
`application/json` body (≤ 16 KiB) and the result as JSON. This matches the request shape of the
WebAgents host's generic `json_http` tool adapter
([docs/tool-broker.md §3a](../../docs/tool-broker.md)). Answers use 200, and refusals use 400,
404 and 422, the statuses that adapter hands to a package as data. Requests are validated
strictly: no type coercion, and unknown fields are refused, not ignored.

| Operation | Arguments | Result |
|---|---|---|
| `search_flights` | `origin`, `destination`, `date`, `passengers` (1–6), `nonstop_only`, `max_price_usd`, `cabin` | matching flights, each with its matching fares |
| `get_flight` | `flight_id` (e.g. `WA205-WA731-20261009`), `passengers` | schedule, segments, layovers, every fare with availability |
| `get_fare_rules` | `fare_id` (e.g. `WA101-20261009-STANDARD`), `passengers` | price, total, baggage, change and refund policy |
| `prepare_booking` | `fare_id`, `passengers[]` (`given_name`, `family_name`), `contact_email` | a quote; `quote_id` is a digest binding the fare, price and passengers |
| `simulate_purchase` | `booking` (the `prepare_booking` arguments), `quote_id`, `payment_method_id` (`demo-visa-4242` \| `demo-travel-1234`) | `confirmation_id` `WA-DEMO-XXXXX`, `real_transaction: false`, `amount_charged_usd: 0` |

`GET /api/v1/schemas` publishes every request, response and error schema as JSON Schema.
Errors have the shape `{"error": {"code", "message", "details": [{"field", "message"}]}}`.
Their codes are `invalid_json`, `invalid_request`, `invalid_route`, `invalid_date`,
`date_out_of_range`, `unknown_flight`, `unknown_fare`, `insufficient_seats`, `quote_mismatch`,
`request_too_large` and `unsupported_media_type`. Rejected values are never echoed back.

Booking is stateless and deterministic. `simulate_purchase` recomputes the quote from `booking`
and refuses it if `quote_id` does not match, so the same inputs always give the same
confirmation code.

```sh
curl -s -X POST http://127.0.0.1:8040/api/v1/search_flights \
  -H 'content-type: application/json' \
  -d '{"origin":"BOS","destination":"ZRH","date":"2026-10-09","nonstop_only":true,"max_price_usd":900}'
```

## Experimental discovery link

Every WebAir page carries, in its `<head>`:

```html
<link rel="agent-package" type="application/vnd.webagents.agent-package" href="/agent.pkg">
```

**This is a WebAgents demo convention, not an HTML or web standard.** Neither
`rel="agent-package"` nor the media type is registered anywhere. The `href` is relative, so it
always resolves against the origin that served the page. Pages send
`Content-Security-Policy: base-uri 'none'` and contain no `<base>` element, so nothing can
retarget it.

`GET /agent.pkg` (and `HEAD`) serves **exactly one file**: the one passed to
`--agent-package PATH` (or `$WEBAIR_AGENT_PACKAGE`) when the origin starts. The file is checked
(regular file, 1 byte – 16 MiB), read once at startup and served from memory as
`application/vnd.webagents.agent-package`, with `X-Agent-Package-SHA256` and an ETag. No request
can name a path. There is no static directory mount and no directory listing, and a missing or
invalid configured file stops the origin from starting.

**Until the signed package exists, no package is configured, and `/agent.pkg` answers `404`**
with `{"error": {"code": "agent_package_unavailable", …}}`. This milestone creates no package
bytes.

## Next steps

1. **A signed WebAir `agent.pkg`**, under `agents/webair/`, built and signed with the same
   generic tooling as every other package. It declares semantic tools for these operations and
   is published with `--agent-package`.
2. **Generic browser discovery**: the Agent Browser notices `rel="agent-package"` on any origin,
   then fetches, verifies and authorizes it through the existing generic path.
3. **Host-owned personal and payment capabilities**: passenger details and a payment method come
   from the person's browser under explicit authorization, never from the package or the site.
