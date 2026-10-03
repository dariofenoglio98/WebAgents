"""The package's tool contracts, derived from the origin's published API schemas.

`GET /api/v1/schemas` is WebAir's machine-readable contract. The package's tool schemas
are copies of it, generated here rather than maintained by hand, so the two cannot drift
silently: `python -m publisher check` and the contract tests fail when they differ.
"""

from __future__ import annotations

import copy
from pathlib import Path
from urllib.parse import urlsplit

from origin.api import schemas_document

DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema"
REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_SOURCE = REPO_ROOT / "agents" / "webair"
API_SCHEMA_DIR = "schemas/api"

# The host the package declares for WebAir's API: the public demo deployment (Railway).
# It is an upper bound on where a host binding may send a call, never authority to send
# one. Versions up to 0.2.0 declared the reserved, never-resolving `webair.example`
# (RFC 2606); 0.3.0 declares this real hostname.
DECLARED_HOST = "webagents-webair-production.up.railway.app"

# Origin operation -> package tool id, for the operations the workflow uses. `get_flight`
# stays an origin-only operation: agent.pkg 0.1 has no optional tool, so every declared
# tool must be bound and approved before the package can run, and the workflow never
# needs it (a search result already carries each flight and its fares).
PACKAGE_TOOLS = {
    "search_flights": "search-flights",
    "get_fare_rules": "get-fare-rules",
    "prepare_booking": "prepare-booking",
    "simulate_purchase": "simulate-purchase",
}


def input_schema_path(operation: str) -> str:
    return f"{API_SCHEMA_DIR}/{operation}.input.schema.json"


def output_schema_path(operation: str) -> str:
    return f"{API_SCHEMA_DIR}/{operation}.output.schema.json"


def binding_name(operation: str) -> str:
    return f"webair.{operation}"


def tool_input_schema(document: dict, operation: str) -> dict:
    """Exactly the request schema the origin publishes for the operation."""
    return {
        "$schema": DRAFT_2020_12,
        **copy.deepcopy(document["operations"][operation]["request_schema"]),
    }


def tool_output_schema(document: dict, operation: str) -> dict:
    """What a json_http binding hands the package: the answer, or a refusal, as data.

    The origin answers 200 with the operation's response and 400/404/422 with its error
    body; a json_http binding returns both to the package as data. The package's output
    schema is therefore the union of the two published schemas, each kept verbatim under
    its own title in one `$defs`.
    """
    response = copy.deepcopy(document["operations"][operation]["response_schema"])
    error = copy.deepcopy(document["error_schema"])
    definitions: dict = {}
    for schema in (response, error):
        for name, definition in schema.pop("$defs", {}).items():
            if definitions.setdefault(name, definition) != definition:
                raise ValueError(f"{operation}: conflicting definitions named {name!r}")
    for schema in (response, error):
        if schema["title"] in definitions:
            raise ValueError(f"{operation}: {schema['title']!r} would shadow a definition")
        definitions[schema["title"]] = schema
    return {
        "$schema": DRAFT_2020_12,
        "anyOf": [
            {"$ref": f"#/$defs/{response['title']}"},
            {"$ref": f"#/$defs/{error['title']}"},
        ],
        "$defs": definitions,
    }


def contract_files(document: dict | None = None) -> dict[str, dict]:
    """Every generated package schema, keyed by its package-relative path."""
    document = schemas_document() if document is None else document
    files = {}
    for operation in PACKAGE_TOOLS:
        files[input_schema_path(operation)] = tool_input_schema(document, operation)
        files[output_schema_path(operation)] = tool_output_schema(document, operation)
    return files


def endpoint_operation(endpoint: str) -> tuple[str, str]:
    """(host, path) of a declared endpoint, for comparing it with the published path."""
    parts = urlsplit(endpoint)
    return parts.hostname or "", parts.path
