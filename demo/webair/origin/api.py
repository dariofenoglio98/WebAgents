"""WebAir's semantic JSON API: the origin side a future agent package can bind to.

One fixed path per operation, `POST /api/v1/<operation>`, whose JSON body is the
operation's arguments and whose JSON answer is its result. That is the request
shape of the WebAgents host's generic `json_http` tool adapter, and the status
codes used for answers (200, 400, 404, 422) are the ones it returns to a package
as data. Nothing here is registered with any WebAgents host.

The API is a thin transport over `WebAirService`; it holds no business logic.
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from .bodies import BodyTooLarge, media_type, read_bounded_body
from .models import (
    BookingQuote,
    ErrorResponse,
    FareRules,
    FlightOffer,
    GetFareRulesRequest,
    GetFlightRequest,
    PrepareBookingRequest,
    SearchFlightsRequest,
    SearchFlightsResponse,
    SimulatedConfirmation,
    SimulatePurchaseRequest,
)
from .service import WebAirError, WebAirService

API_PREFIX = "/api/v1"
MAX_JSON_BYTES = 16 * 1024

# operation -> (request model, response model, description)
OPERATIONS: dict[str, tuple[type[BaseModel], type[BaseModel], str]] = {
    "search_flights": (
        SearchFlightsRequest,
        SearchFlightsResponse,
        "Find WebAir flights for one route and date, optionally nonstop, by cabin or under a "
        "per-passenger price.",
    ),
    "get_flight": (
        GetFlightRequest,
        FlightOffer,
        "One flight's schedule, segments and every fare sold on it.",
    ),
    "get_fare_rules": (
        GetFareRulesRequest,
        FareRules,
        "Price, baggage allowance, change and refund policy of one fare.",
    ),
    "prepare_booking": (
        PrepareBookingRequest,
        BookingQuote,
        "Quote a fare for named passengers. Reserves nothing and stores nothing.",
    ),
    "simulate_purchase": (
        SimulatePurchaseRequest,
        SimulatedConfirmation,
        "Simulate paying a quote with a demo payment method. No real transaction occurs.",
    ),
}

ERROR_STATUSES = {
    400: "invalid_json: the body is not JSON",
    404: "unknown_flight / unknown_fare: a well-formed identifier WebAir does not sell",
    413: "request_too_large: the body exceeds 16 KiB",
    415: "unsupported_media_type: the body is not application/json",
    422: "invalid_request / invalid_route / invalid_date / date_out_of_range / "
    "insufficient_seats / quote_mismatch: the arguments are refused",
}


def error_response(
    status: int, code: str, message: str, details: list[dict] | None = None
) -> JSONResponse:
    body = {"error": {"code": code, "message": message, "details": details or []}}
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


def _validation_details(exc: ValidationError) -> list[dict]:
    # Field path and reason only: the rejected value may be personal data, so it is not echoed.
    return [
        {"field": ".".join(str(part) for part in err["loc"]) or None, "message": err["msg"]}
        for err in exc.errors(include_input=False, include_url=False)
    ]


def _endpoint(name: str, request_model: type[BaseModel]) -> Callable:
    async def endpoint(request: Request) -> JSONResponse:
        if media_type(request) != "application/json":
            return error_response(
                415, "unsupported_media_type", "Send the arguments as an application/json body."
            )
        try:
            body = await read_bounded_body(request, MAX_JSON_BYTES)
        except BodyTooLarge:
            return error_response(
                413, "request_too_large", f"Request bodies are limited to {MAX_JSON_BYTES} bytes."
            )
        try:
            arguments = request_model.model_validate_json(body, strict=True)
        except ValidationError as exc:
            if any(err["type"] == "json_invalid" for err in exc.errors()):
                return error_response(400, "invalid_json", "The request body is not valid JSON.")
            return error_response(
                422,
                "invalid_request",
                f"The {name} arguments do not match the schema.",
                _validation_details(exc),
            )
        service: WebAirService = request.app.state.service
        try:
            result = getattr(service, name)(arguments)
        except WebAirError as exc:
            return error_response(
                exc.status, exc.code, exc.message, [{"field": exc.field, "message": exc.message}]
            )
        return JSONResponse(result.model_dump(mode="json"), headers={"Cache-Control": "no-store"})

    endpoint.__name__ = name
    return endpoint


def schemas_document() -> dict:
    return {
        "api": "webair-semantic-api",
        "version": "v1",
        "notice": "Fictional WebAir demo. No real booking or payment occurs.",
        "transport": {
            "method": "POST",
            "request_media_type": "application/json",
            "max_request_bytes": MAX_JSON_BYTES,
        },
        "operations": {
            name: {
                "method": "POST",
                "path": f"{API_PREFIX}/{name}",
                "description": description,
                "request_schema": request_model.model_json_schema(),
                "response_schema": response_model.model_json_schema(mode="serialization"),
            }
            for name, (request_model, response_model, description) in OPERATIONS.items()
        },
        "error_schema": ErrorResponse.model_json_schema(),
        "error_statuses": {str(code): meaning for code, meaning in ERROR_STATUSES.items()},
    }


def router() -> APIRouter:
    routes = APIRouter(prefix=API_PREFIX)
    for name, (request_model, response_model, description) in OPERATIONS.items():
        routes.add_api_route(
            f"/{name}",
            _endpoint(name, request_model),
            methods=["POST"],
            description=description,
            include_in_schema=False,
        )
    document = schemas_document()

    @routes.get("/schemas", include_in_schema=False)
    def schemas() -> JSONResponse:
        return JSONResponse(document)

    return routes
