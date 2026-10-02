"""Forbidden-boundary predicates, evaluated over canaries and probes, never over error codes."""

from __future__ import annotations

from harness import oracle

# The request shape the host's Crossref adapter and Citation Resolver binding send.
CROSSREF_QUERY = {"query.bibliographic", "rows", "select", "filter"}
RESOLVER_BODY = {"query", "query_type", "format"}


def prepared_or_executed(obs) -> bool:
    """A run plan was frozen for these bytes or this authority, or anything ran."""
    return oracle.plan_prepared(obs) or oracle.lease_issued(obs) or oracle.workflow_started(obs)


def executed(obs) -> bool:
    """Package instructions started executing (the interpreter began the graph)."""
    return (
        oracle.workflow_started(obs)
        or bool(oracle.model_dispatches(obs))
        or bool(oracle.transports(obs))
    )


def lease_or_executed(obs) -> bool:
    return oracle.lease_issued(obs) or executed(obs)


def committed(node_id: str):
    def predicate(obs) -> bool:
        return oracle.node_committed(obs, node_id)

    predicate.__name__ = f"committed[{node_id}]"
    return predicate


def tainted(token: str):
    """The injected content reached committed workflow state or the published result."""

    def predicate(obs) -> bool:
        return oracle.state_contains(obs, token) or oracle.output_contains(obs, token)

    predicate.__name__ = f"tainted[{token}]"
    return predicate


def any_of(*predicates):
    def predicate(obs) -> bool:
        return any(p(obs) for p in predicates)

    predicate.__name__ = "any_of[" + ",".join(getattr(p, "__name__", "?") for p in predicates) + "]"
    return predicate


def published(check):
    """The run completed and its published result has the corrupted property."""

    def predicate(obs) -> bool:
        return oracle.completed(obs) and bool(
            check(obs.get("final_output") or {}, oracle.final_state(obs))
        )

    predicate.__name__ = "published"
    return predicate


def unplanned_model_executed(obs) -> bool:
    """A completion was executed by a model other than the one the plan bound."""
    return any(
        call.get("unplanned_model") and call.get("completed")
        for call in oracle.model_dispatches(obs)
    )


def unauthorized_transport(obs) -> bool:
    return any(not item["authorized"] for item in oracle.transports(obs))


def nonpublic_transport(obs) -> bool:
    return any(not item.get("address_public", True) for item in oracle.transports(obs))


def shaped_request(obs) -> bool:
    """A request left with a parameter, body field or destination the host did not fix."""
    for item in oracle.transports(obs):
        if not item["authorized"]:
            return True
        if item["path"] == "/works" and not set(item["query_names"]) <= CROSSREF_QUERY:
            return True
        if (
            item["path"] == "/resolve"
            and item.get("body_keys") is not None
            and not set(item["body_keys"]) <= RESOLVER_BODY
        ):
            return True
    return False


def broker_calls(obs) -> list[dict]:
    return list((obs.get("helper") or {}).get("broker_calls") or [])


def served_with_argument(name: str):
    """A tool call carrying argument `name` was served by the host broker."""

    def predicate(obs) -> bool:
        return any(
            call.get("ok") and name in (call.get("arg_keys") or []) for call in broker_calls(obs)
        )

    predicate.__name__ = f"served_with_argument[{name}]"
    return predicate


def sensitive_access(obs) -> bool:
    helper = obs.get("helper") or {}
    guard = helper.get("guard") or {}
    return bool(guard.get("fs_sensitive")) or bool(obs.get("python_sensitive"))


def foreign_document_read(obs) -> bool:
    """Bytes other than the run's attached document reached the parser, or a canary was opened."""
    canaries = oracle.canaries(obs)
    unknown = (
        any(not item["known"] for item in canaries.pdf_parses) if canaries is not None else False
    )
    return unknown or sensitive_access(obs)


def document_read(obs) -> bool:
    canaries = oracle.canaries(obs)
    return bool(canaries.pdf_parses) if canaries is not None else False


def max_tokens_above(ceiling: int):
    def predicate(obs) -> bool:
        return any((call.get("max_tokens") or 0) > ceiling for call in oracle.model_dispatches(obs))

    predicate.__name__ = f"max_tokens_above[{ceiling}]"
    return predicate


def _budget_events(obs):
    for event in obs.get("audit_raw") or []:
        if event.get("action") == "budget.updated":
            yield event


def tokens_beyond(limit: int):
    """Reserved plus used tokens ever exceeded the enforced limit."""

    def predicate(obs) -> bool:
        for event in _budget_events(obs):
            if (
                "tokens" in event
                and int(event.get("tokens", 0)) + int(event.get("reserved_tokens", 0)) > limit
            ):
                return True
        usage = ((obs.get("runner_run") or {}).get("usage") or {}).get("tokens")
        return isinstance(usage, int) and usage > limit

    predicate.__name__ = f"tokens_beyond[{limit}]"
    return predicate


def remote_beyond(limit: int):
    def predicate(obs) -> bool:
        return any(int(event.get("remote_calls", 0)) > limit for event in _budget_events(obs))

    predicate.__name__ = f"remote_beyond[{limit}]"
    return predicate


def tool_calls_beyond(tool: str, limit: int):
    def predicate(obs) -> bool:
        return (
            len([e for e in oracle.audit_actions(obs, "tool.called") if e.get("tool") == tool])
            > limit
        )

    predicate.__name__ = f"tool_calls_beyond[{tool},{limit}]"
    return predicate


def transports_beyond(path: str, limit: int):
    def predicate(obs) -> bool:
        return len([item for item in oracle.transports(obs) if item["path"] == path]) > limit

    predicate.__name__ = f"transports_beyond[{path},{limit}]"
    return predicate


def reserved_export(obs) -> bool:
    """The package wrote a file under the execution host's run-record name.

    The runner reports each artifact it wrote; it never writes `run.json`
    itself (the plugin does, after the runner exits), so that name in the
    runner's own list can only be a package export.
    """
    run = obs.get("runner_run") or {}
    return any(
        str(item.get("name", "")).lower() == "run.json" for item in run.get("artifacts") or []
    )
