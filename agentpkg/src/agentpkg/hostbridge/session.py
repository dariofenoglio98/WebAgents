"""The child side of the bridge: bind one run plan, answer three methods, exit.

There is no state here beyond one bound router, and no way to reach anything
else. The parent cannot name a package file, a model, a graph node or an
OpenClaw method through this surface: it can begin a session from a run-plan
binding it already holds, run the one host-owned probe, and end.
"""

from __future__ import annotations

import asyncio
import sys

from . import protocol
from .errors import BridgeError
from .peer import BridgePeer, stdio_streams
from .probe import run_probe
from .router import HostBridgeModelRouter

MAX_TEXT = 512
MAX_IDS = 64
MAX_CAPABILITIES = 64
DEFAULT_REQUEST_TIMEOUT_SECONDS = 120.0


def _invalid(message: str) -> BridgeError:
    return BridgeError("session_invalid", message)


def _fields(value, field: str, allowed: set[str], required: set[str] = frozenset()) -> dict:
    if not isinstance(value, dict):
        raise _invalid(f"{field} must be an object")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise _invalid(f"Unknown fields in {field}: {unknown}")
    missing = sorted(required - set(value))
    if missing:
        raise _invalid(f"Missing fields in {field}: {missing}")
    return value


def _text(value, field: str, *, limit: int = MAX_TEXT, allow_none: bool = False):
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise _invalid(f"{field} must be a string of at most {limit} characters")
    return value


def _count(value, field: str):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _invalid(f"{field} must be a nonnegative integer")
    return value


def _tristate(value, field: str):
    if value is None or isinstance(value, bool):
        return value
    raise _invalid(f"{field} must be true, false or null")


def normalize_binding(raw) -> dict:
    """Validate the model binding the parent copied out of the run plan."""
    record = _fields(
        raw,
        "model_binding",
        {
            "host_model_id",
            "provider_id",
            "model_id",
            "display_name",
            "compatibility_status",
            "evidence_strength",
            "capabilities",
            "limits",
            "properties",
        },
        {"host_model_id", "provider_id", "model_id"},
    )
    capabilities_raw = record.get("capabilities") or {}
    if not isinstance(capabilities_raw, dict) or len(capabilities_raw) > MAX_CAPABILITIES:
        raise _invalid("model_binding.capabilities must be a bounded object")
    capabilities = {}
    for name, answer in sorted(capabilities_raw.items()):
        _text(name, "model_binding.capabilities key", limit=128)
        entry = _fields(answer, f"model_binding.capabilities[{name}]", {"value", "basis", "detail"})
        capabilities[name] = {
            "value": _tristate(entry.get("value"), "capability value"),
            "basis": _text(entry.get("basis"), "capability basis", allow_none=True),
        }
    limits = _fields(
        record.get("limits") or {},
        "model_binding.limits",
        {"context_tokens", "native_context_window", "max_output_tokens"},
    )
    properties = _fields(
        record.get("properties") or {},
        "model_binding.properties",
        {"local", "privacy_class", "cost_class", "status", "tags"},
    )
    return {
        "host_model_id": _text(record["host_model_id"], "host_model_id", limit=256),
        "provider_id": _text(record["provider_id"], "provider_id", limit=128),
        "model_id": _text(record["model_id"], "model_id", limit=256),
        "display_name": _text(record.get("display_name"), "display_name", allow_none=True),
        "compatibility_status": _text(
            record.get("compatibility_status"), "compatibility_status", limit=64, allow_none=True
        ),
        "evidence_strength": _text(
            record.get("evidence_strength"), "evidence_strength", limit=64, allow_none=True
        ),
        "capabilities": capabilities,
        "limits": {
            "context_tokens": _count(limits.get("context_tokens"), "limits.context_tokens"),
            "native_context_window": _count(
                limits.get("native_context_window"), "limits.native_context_window"
            ),
            "max_output_tokens": _count(
                limits.get("max_output_tokens"), "limits.max_output_tokens"
            ),
        },
        "properties": {"local": _tristate(properties.get("local"), "properties.local")},
    }


def normalize_plan(raw) -> dict:
    """Validate the bounded run-plan facts the router binds itself to.

    Only identity travels: hashes, the execution mode and the model binding.
    Nothing here can address a file, and no bearer token, catalog, receipt body
    or package payload is accepted.
    """
    record = _fields(
        raw,
        "run_plan",
        {
            "run_plan_id",
            "run_plan_sha256",
            "session_id",
            "package",
            # Accepted and ignored, never used: one preflight builds the
            # binding for both this probe and the execution runner, and the
            # runner needs the signer to verify the artifact it is handed and
            # the tool bindings to install its handlers. This bridge holds no
            # interpreter and no tool broker, so neither reaches anything here.
            "publisher",
            "execution",
            "model_binding",
            "tool_bindings",
        },
        {"run_plan_id", "run_plan_sha256", "execution", "model_binding"},
    )
    package = _fields(
        record.get("package") or {},
        "run_plan.package",
        {"package_id", "name", "version", "digest", "archive_sha256", "execution_profile"},
    )
    publisher = _fields(
        record.get("publisher") or {},
        "run_plan.publisher",
        {"signer_fingerprint", "signature_status", "trust_status"},
    )
    execution = _fields(
        record["execution"],
        "run_plan.execution",
        {
            "mode",
            "profile",
            "required_permission_ids",
            # Accepted and ignored, for the same reason as `tool_bindings`.
            "required_tool_ids",
            "tool_binding_count",
        },
        {"mode"},
    )
    if execution["mode"] != "model":
        raise _invalid("Only a model-backed run plan can bind a router")
    permissions = execution.get("required_permission_ids") or []
    if not isinstance(permissions, list) or len(permissions) > MAX_IDS:
        raise _invalid("run_plan.execution.required_permission_ids must be a bounded list")
    return {
        "run_plan_id": _text(record["run_plan_id"], "run_plan_id", limit=128),
        "run_plan_sha256": _text(record["run_plan_sha256"], "run_plan_sha256", limit=128),
        "session_id": _text(record.get("session_id"), "session_id", limit=128, allow_none=True),
        "package": {
            key: _text(package.get(key), f"run_plan.package.{key}", allow_none=True)
            for key in ("package_id", "name", "version", "digest", "archive_sha256")
        }
        | {
            "execution_profile": _text(
                package.get("execution_profile"), "execution_profile", limit=64, allow_none=True
            )
        },
        "publisher": {
            key: _text(publisher.get(key), f"run_plan.publisher.{key}", limit=128, allow_none=True)
            for key in ("signer_fingerprint", "signature_status", "trust_status")
        },
        "execution": {
            "mode": "model",
            "profile": _text(
                execution.get("profile"), "execution.profile", limit=64, allow_none=True
            ),
            "required_permission_ids": [
                _text(item, "required_permission_ids[]", limit=200) for item in permissions
            ],
        },
        "model_binding": normalize_binding(record["model_binding"]),
        # Counted, never interpreted: a probe that could call a tool would not
        # be a router probe.
        "tool_binding_count": len(record.get("tool_bindings") or []),
    }


class BridgeSession:
    """Handles the three methods the parent may call, and holds one router."""

    def __init__(self, peer: BridgePeer):
        self._peer = peer
        self.plan: dict | None = None
        self.router: HostBridgeModelRouter | None = None
        self.probes = 0
        self.ended = asyncio.Event()

    async def __call__(self, method: str, params: dict) -> dict:
        if method == "session.begin":
            return self._begin(params)
        if method == "probe.run":
            return await self._probe(params)
        if method == "session.end":
            return self._end(params)
        # Unreachable: the peer refuses anything outside its allowlist first.
        raise BridgeError("unknown_method", f"Unsupported method {method[:64]!r}")

    def _begin(self, params: dict) -> dict:
        record = _fields(params, "session.begin", {"run_plan", "limits"}, {"run_plan"})
        limits = _fields(
            record.get("limits") or {}, "session.begin.limits", {"request_timeout_seconds"}
        )
        timeout = limits.get("request_timeout_seconds", DEFAULT_REQUEST_TIMEOUT_SECONDS)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise _invalid("request_timeout_seconds must be a number")
        if not 1 <= float(timeout) <= 600:
            raise _invalid("request_timeout_seconds must be between 1 and 600")
        if self.plan is not None:
            raise BridgeError("session_already_bound", "This bridge session is already bound")
        plan = normalize_plan(record["run_plan"])
        router = HostBridgeModelRouter(
            self._peer, plan["model_binding"], request_timeout_seconds=float(timeout)
        )
        self.plan, self.router = plan, router
        return {
            "protocol": protocol.PROTOCOL_VERSION,
            "run_plan_id": plan["run_plan_id"],
            "run_plan_sha256": plan["run_plan_sha256"],
            "router": router.describe(),
            "execution": {
                "workflow_supported": False,
                "note": (
                    "This bridge binds a ModelRouter to the planned model. It cannot "
                    "instantiate a workflow, spawn a worker or call a package tool."
                ),
            },
        }

    async def _probe(self, params: dict) -> dict:
        _fields(params, "probe.run", set())
        if self.router is None or self.plan is None:
            raise BridgeError("session_not_bound", "Begin a bridge session before probing")
        if self.probes:
            raise BridgeError(
                "probe_already_run",
                "A bridge session runs one probe; prepare a new session to probe again",
            )
        self.probes += 1
        return await run_probe(self.router, self.plan["model_binding"], self.plan)

    def _end(self, params: dict) -> dict:
        _fields(params, "session.end", set())
        self.ended.set()
        return {"ended": True, "probes": self.probes}


async def serve() -> int:
    """Run one bridge session on this process's stdio until EOF or session.end."""
    reader, writer = await stdio_streams()
    session: BridgeSession | None = None

    async def handler(method: str, params: dict) -> dict:
        return await session(method, params)

    peer = BridgePeer(
        reader,
        writer,
        outbound_methods=protocol.HOST_METHODS,
        inbound_methods=protocol.CHILD_METHODS,
        handler=handler,
        prefix="c",
    )
    session = BridgeSession(peer)
    serving = asyncio.create_task(peer.serve())
    ended = asyncio.create_task(session.ended.wait())
    try:
        done, _ = await asyncio.wait({serving, ended}, return_when=asyncio.FIRST_COMPLETED)
        if serving in done:
            serving.result()  # Re-raise a protocol violation.
        return 0
    except protocol.ProtocolError as exc:
        print(f"host-bridge: {exc}", file=sys.stderr, flush=True)
        return 3
    finally:
        ended.cancel()
        await peer.close(BridgeError("bridge_closed", "The bridge session ended"))
        serving.cancel()
        try:
            await serving
        except (asyncio.CancelledError, Exception):  # noqa: B014 - shutdown is best effort
            pass


__all__ = ["BridgeSession", "normalize_binding", "normalize_plan", "serve"]
