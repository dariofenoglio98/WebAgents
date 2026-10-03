"""The human journey, driven like a browser: follow rendered links and submit rendered forms."""

import re
from urllib.parse import urlencode

import pytest
from htmltools import Page

from origin.models import SearchFlightsRequest

NO_REAL_TRANSACTION = "No real transaction was performed."


def get(client, url, status=200):
    response = client.get(url)
    assert response.status_code == status, (url, response.text[:500])
    assert response.headers["content-type"] == "text/html; charset=utf-8"
    return Page(response.text)


def submit(client, form, values, status=200):
    assert form.method in ("get", "post")
    if form.method == "get":
        return get(client, f"{form.action}?{urlencode(values)}", status)
    response = client.post(form.action, data=values)
    assert response.status_code == status, (form.action, response.text[:500])
    return Page(response.text)


def book(client, passengers=1, fare="STANDARD", payment="demo-visa-4242"):
    """Run the whole journey from the home page; returns every page visited."""
    home = get(client, "/")
    search = home.form("/results")
    values = search.values()
    assert values == {
        "origin": "BOS",
        "destination": "ZRH",
        "date": "2026-10-09",
        "passengers": "1",
    }
    results = submit(client, search, values | {"passengers": str(passengers)})
    select = [h for h in results.hrefs("/flight/WA101-20261009")]
    assert select == [f"/flight/WA101-20261009?passengers={passengers}"]
    flight = get(client, select[0])
    fare_link = [h for h in flight.hrefs("/fare/") if f"-{fare}?" in h]
    assert len(fare_link) == 1
    fare_page = get(client, fare_link[0])
    continue_link = fare_page.hrefs("/passenger?")
    assert len(continue_link) == 1
    passenger = get(client, continue_link[0])
    details = passenger.form("/payment")
    names = [("Ada", "Lovelace"), ("Alan", "Turing"), ("Grace", "Hopper")][:passengers]
    filled = details.values() | {"contact_email": "ada@example.com"}
    for i, (given, family) in enumerate(names, start=1):
        filled |= {f"given_name_{i}": given, f"family_name_{i}": family}
    payment = submit(client, details, filled)
    pay = payment.form("/confirmation")
    confirmation = submit(
        client, pay, pay.values() | {"payment_method_id": payment_method(payment)}
    )
    return {
        "home": home,
        "results": results,
        "flight": flight,
        "fare": fare_page,
        "passenger": passenger,
        "payment": payment,
        "confirmation": confirmation,
        "payment_form": pay,
    }


def payment_method(page, which="demo-visa-4242"):
    radios = [f for f in page.form("/confirmation").fields if f.get("type") == "radio"]
    assert [r["value"] for r in radios] == ["demo-visa-4242", "demo-travel-1234"]
    return which


def test_home_page(client):
    page = get(client, "/")
    assert "WebAir" in page.text
    assert "Fictional demo airline" in page.text
    assert "no real reservation or payment ever occurs" in page.text
    assert page.hrefs("/flights")
    search = page.form("/results")
    assert search.method == "get"
    assert {"origin", "destination", "date", "passengers"} <= search.names()


def test_full_search_form(client):
    page = get(client, "/flights")
    form = page.form("/results")
    assert {
        "origin",
        "destination",
        "date",
        "passengers",
        "cabin",
        "max_price_usd",
        "nonstop_only",
    } == form.names()
    date = next(f for f in form.fields if f["name"] == "date")
    assert (date["min"], date["max"]) == ("2026-10-01", "2027-12-31")


def test_complete_booking_journey(client):
    pages = book(client, passengers=2)
    fare = pages["fare"]
    assert "Economy Standard" in fare.text
    assert "1 × 23 kg" in fare.text
    assert "Changes for $150 per passenger plus fare difference" in fare.text
    assert "Non-refundable" in fare.text
    assert "$1,716" in fare.text
    payment = pages["payment"]
    assert "Demo payment only" in payment.text
    assert "Ada Lovelace" in payment.text and "Alan Turing" in payment.text
    assert "Demo Visa •••• 4242" in payment.text
    assert re.search(r"Quote WAQ-[0-9A-F]{16}", payment.text)
    confirmation = pages["confirmation"]
    assert "Booking simulated" in confirmation.text
    assert NO_REAL_TRANSACTION in confirmation.text
    assert "no payment was charged" in confirmation.text
    assert "Actually charged $0" in confirmation.text
    ids = [d["data-confirmation-id"] for d in confirmation.data if "data-confirmation-id" in d]
    assert len(ids) == 1 and re.fullmatch(r"WA-DEMO-[A-Z2-9]{5}", ids[0])


def test_the_journey_is_deterministic(client):
    first = book(client)["confirmation"]
    second = book(client)["confirmation"]
    assert first.text == second.text


def test_human_and_api_confirmations_agree(client):
    pages = book(client)
    human_id = next(
        d["data-confirmation-id"] for d in pages["confirmation"].data if "data-confirmation-id" in d
    )
    booking = {
        "fare_id": "WA101-20261009-STANDARD",
        "passengers": [{"given_name": "Ada", "family_name": "Lovelace"}],
        "contact_email": "ada@example.com",
    }
    quote = client.post("/api/v1/prepare_booking", json=booking).json()
    hidden = pages["payment_form"].values()
    assert hidden["quote_id"] == quote["quote_id"]
    confirmation = client.post(
        "/api/v1/simulate_purchase",
        json={
            "booking": booking,
            "quote_id": quote["quote_id"],
            "payment_method_id": "demo-visa-4242",
        },
    ).json()
    assert confirmation["confirmation_id"] == human_id


@pytest.mark.parametrize(
    "query",
    [
        {"origin": "BOS", "destination": "ZRH", "date": "2026-10-09"},
        {
            "origin": "BOS",
            "destination": "ZRH",
            "date": "2026-10-09",
            "nonstop_only": True,
            "max_price_usd": 900,
        },
        {"origin": "ZRH", "destination": "BOS", "date": "2026-11-02", "passengers": 3},
        {"origin": "JFK", "destination": "GVA", "date": "2026-12-19", "cabin": "business"},
        {"origin": "BOS", "destination": "LHR", "date": "2027-03-28"},
    ],
)
def test_results_page_shows_exactly_what_the_api_returns(client, query):
    api = client.post("/api/v1/search_flights", json=query).json()
    params = {k: ("on" if v is True else v) for k, v in query.items()}
    page = get(client, f"/results?{urlencode(params)}")
    flights = [d["data-flight-id"] for d in page.data if "data-flight-id" in d]
    fares = [
        (d["data-fare-id"], int(d["data-price-usd"])) for d in page.data if "data-price-usd" in d
    ]
    assert flights == [f["flight_id"] for f in api["flights"]]
    assert fares == [(x["fare_id"], x["price_usd"]) for f in api["flights"] for x in f["fares"]]
    assert flights, "every parametrized query has results"


def test_results_page_details(client):
    page = get(client, "/results?origin=BOS&destination=ZRH&date=2026-10-09&passengers=1")
    assert "Boston (BOS) to Zurich (ZRH)" in page.text
    assert "4 flights found" in page.text
    assert "7h 35m · Nonstop · WA101" in page.text
    assert "1 stop via KEF · WA205 + WA731" in page.text
    assert page.hrefs("/flights?")


def test_no_results(client):
    page = get(client, "/results?origin=GVA&destination=KEF&date=2026-10-09")
    assert "No flights match your search" in page.text


@pytest.mark.parametrize(
    ("query", "message"),
    [
        ("origin=BOS&destination=BOS&date=2026-10-09", "Origin and destination must differ."),
        ("origin=BOS&destination=ZRH&date=2030-01-01", "demo schedule covers"),
        ("origin=BOS&destination=ZRH&date=tomorrow", "Enter a departure date"),
        ("origin=BOS&destination=ZRH", "Enter a departure date"),
        ("origin=XXX&destination=ZRH&date=2026-10-09", "Choose a departure airport."),
        ("origin=BOS&destination=ZRH&date=2026-10-09&passengers=12", "between 1 and 6 passengers"),
        ("origin=BOS&destination=ZRH&date=2026-10-09&max_price_usd=cheap", "maximum price"),
    ],
)
def test_invalid_searches_return_to_the_form_with_a_message(client, query, message):
    page = get(client, f"/results?{query}", status=422)
    assert message in page.text
    assert page.form("/results")


def test_search_form_values_are_escaped(client):
    response = client.get('/flights?date="><script>alert(1)</script>')
    assert response.status_code == 200
    assert "<script>" not in response.text
    assert "&#34;&gt;&lt;script&gt;" in response.text


def test_flight_page_marks_fares_without_enough_seats(client):
    page = get(client, "/flight/WA105-20261009?passengers=3")
    assert "Not enough seats" in page.text
    assert not [h for h in page.hrefs("/fare/") if "BUSINESS" in h]
    assert len(page.hrefs("/fare/")) == 3


@pytest.mark.parametrize(
    "url",
    [
        "/flight/WA999-20261009",
        "/flight/WA105-20261006",
        "/flight/not-a-flight",
        "/flight/WA101-20261009?passengers=99",
        "/fare/WA101-20261009-FIRST",
        "/fare/WA213-20261009-BUSINESS",
        "/passenger?fare_id=nope",
        "/passenger",
    ],
)
def test_unknown_flights_and_fares_render_a_not_found_page(client, url):
    page = get(client, url, status=404)
    assert "not find" in page.text


def test_passenger_page_refuses_more_passengers_than_seats(client):
    page = get(client, "/passenger?fare_id=WA105-20261009-BUSINESS&passengers=3", status=422)
    assert "Only 2 seat(s) are left" in page.text


def test_passenger_form_shows_one_fieldset_per_traveler(client):
    page = get(client, "/passenger?fare_id=WA101-20261009-FLEX&passengers=3")
    assert page.form("/payment").names() == {
        "fare_id",
        "passengers",
        "contact_email",
        "given_name_1",
        "family_name_1",
        "given_name_2",
        "family_name_2",
        "given_name_3",
        "family_name_3",
    }


def test_passenger_validation_errors_keep_the_entered_values(client):
    response = client.post(
        "/payment",
        data={
            "fare_id": "WA101-20261009-STANDARD",
            "passengers": "1",
            "given_name_1": "Ada",
            "family_name_1": "",
            "contact_email": "nope",
        },
    )
    assert response.status_code == 422
    page = Page(response.text)
    assert "Passenger 1: enter a family name" in page.text
    assert "Enter an email address" in page.text
    assert page.form("/payment").values()["given_name_1"] == "Ada"


def test_payment_page_collects_no_card_details(client):
    pay = book(client)["payment_form"]
    visible = [f for f in pay.fields if f.get("type") != "hidden"]
    assert {f["name"] for f in visible} == {"payment_method_id"}
    assert all(f.get("type") == "radio" for f in visible)
    assert not any(re.search(r"card|cvc|cvv|expir|iban|account", f["name"]) for f in pay.fields)


def test_payment_without_a_method_returns_to_payment(client):
    pay = book(client)["payment_form"]
    values = pay.values()
    values.pop("payment_method_id")
    response = client.post("/confirmation", data=values)
    assert response.status_code == 422
    assert "Choose one of the demo payment methods." in Page(response.text).text


def test_tampered_confirmation_is_refused(client):
    values = book(client, passengers=2)["payment_form"].values() | {
        "payment_method_id": "demo-visa-4242"
    }
    swapped = values | {"family_name_2": "Mallory"}
    response = client.post("/confirmation", data=swapped)
    assert response.status_code == 422
    assert "does not match the quote" in Page(response.text).text
    wrong_fare = values | {"fare_id": "WA101-20261009-BASIC"}
    assert client.post("/confirmation", data=wrong_fare).status_code == 422


def test_form_transport_refusals(client):
    assert (
        client.post(
            "/payment", content=b"fare_id=x", headers={"content-type": "text/plain"}
        ).status_code
        == 415
    )
    assert (
        client.post(
            "/payment",
            content=b"a=1&a=2",
            headers={"content-type": "application/x-www-form-urlencoded"},
        ).status_code
        == 400
    )
    big = b"x=" + b"a" * (17 * 1024)
    assert (
        client.post(
            "/payment", content=big, headers={"content-type": "application/x-www-form-urlencoded"}
        ).status_code
        == 413
    )
    assert (
        client.post(
            "/payment",
            content=b"\xff\xfe=\xff",
            headers={"content-type": "application/x-www-form-urlencoded"},
        ).status_code
        == 400
    )
    assert client.get("/payment").status_code == 405


def test_unknown_pages_render_html_404(client):
    page = get(client, "/no-such-page", status=404)
    assert "Page not found" in page.text


def test_stylesheet_is_local_and_pages_load_nothing_external(client):
    css = client.get("/static/webair.css")
    assert css.status_code == 200 and css.headers["content-type"].startswith("text/css")
    assert "http" not in css.text and "@import" not in css.text
    html = client.get("/").text
    assert "<script" not in html
    assert not re.search(r'(src|href)="(https?:)?//', html)


def test_html_pages_send_security_headers(client):
    headers = client.get("/").headers
    assert headers["x-content-type-options"] == "nosniff"
    assert "default-src 'none'" in headers["content-security-policy"]
    assert "base-uri 'none'" in headers["content-security-policy"]
    assert headers["referrer-policy"] == "no-referrer"


def test_search_results_include_date_in_change_link(client):
    page = get(
        client,
        "/results?"
        + urlencode(
            SearchFlightsRequest(origin="BOS", destination="ZRH", date="2026-10-09").model_dump(
                exclude_none=True
            )
        ),
    )
    link = page.hrefs("/flights?")[0]
    form = get(client, link).form("/results").values()
    assert (form["origin"], form["destination"], form["date"]) == ("BOS", "ZRH", "2026-10-09")
