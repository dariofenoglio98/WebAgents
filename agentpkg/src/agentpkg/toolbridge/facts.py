"""Closed tool failure facts; raw service strings never cross into the audit."""

STAGES = frozenset(
    {
        "transport",
        "status",
        "content_type",
        "body_size",
        "json_parse",
        "input_schema",
        "output_schema",
        "adapter_response",
        "timeout",
        "tls",
        "address_policy",
        "cancelled",
        "binding",
        "bridge",
    }
)
CONTENT_TYPES = frozenset({"json", "json_suffix", "html", "text", "missing", "other"})
KEYWORDS = frozenset(
    {
        "type",
        "required",
        "additionalProperties",
        "enum",
        "const",
        "anyOf",
        "oneOf",
        "allOf",
        "not",
        "pattern",
        "format",
        "minItems",
        "maxItems",
        "uniqueItems",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minProperties",
        "maxProperties",
        "contains",
        "false_schema",
    }
)


def safe_tool_facts(value):
    if not isinstance(value, dict):
        return {}
    safe = {}
    for key, entry in value.items():
        choices = {"stage": STAGES, "content_type": CONTENT_TYPES, "schema_keyword": KEYWORDS}
        if key in choices and isinstance(entry, str) and entry in choices[key]:
            safe[key] = entry
        elif key in {"response_bytes", "schema_depth", "instance_depth"}:
            if type(entry) is int and 0 <= entry < 2**53:
                safe[key] = entry
        elif key == "http_status" and type(entry) is int and 100 <= entry <= 599:
            safe[key] = entry
        elif key in {"body_exceeded", "json_parsed", "timeout", "cancelled"}:
            if isinstance(entry, bool):
                safe[key] = entry
    return safe


def schema_facts(error, stage):
    cause = error.__cause__
    return safe_tool_facts(
        {
            "stage": stage,
            "schema_keyword": getattr(cause, "validator", None),
            "schema_depth": len(getattr(cause, "absolute_schema_path", [])),
            "instance_depth": len(getattr(cause, "absolute_path", [])),
        }
    )
