"""The private host-bridge wire contract: one JSON object per line, both ways.

This is the transport a future `agentpkg` execution process will use to reach
the intelligence the user selected, so it is designed as that transport rather
than as a probe-shaped detour.

    OpenClaw plugin backend  (parent, holds provider authority)
            |  stdin  <----- requests: session.begin / probe.run / session.end
            |                responses to model.* requests
            |  stdout -----> requests: model.count_tokens / model.complete
            |                responses to session.* requests
    agentpkg host bridge     (child, holds the ModelRouter contract)
            |  stderr -----> logs, diagnostics, tracebacks

Three properties make this safe enough for package data to flow through it
later:

* **it is not a network**. A pipe between a parent and the child it spawned has
  no address, no listener and no credential;
* **the method set is closed, per direction**. There is no generic dispatch, no
  name resolution, no file path, no model identifier and no OpenClaw method
  name anywhere in a frame. A method outside its direction's allowlist is an
  error, and a malformed frame ends the session;
* **stdout carries frames and nothing else**. Logging goes to stderr, so a
  stray diagnostic can never be parsed as a protocol message.
"""

from __future__ import annotations

import json
import re

from .errors import ProtocolError

PROTOCOL_VERSION = "agentpkg-host-bridge/0.1"

# One frame is one line. 1 MiB bounds a rendered request (skills, data and a
# bundled schema) with room to spare, and bounds an attacker-supplied line.
MAX_FRAME_BYTES = 1024 * 1024
# Outstanding requests per direction. The interpreter's own parallelism is
# bounded far below this by worker and role semaphores.
MAX_PENDING = 16
MAX_ID_LENGTH = 64
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")

# Requests the child (agentpkg) may send to the host. These are the ModelRouter
# operations and nothing else.
HOST_METHODS = frozenset({"model.count_tokens", "model.complete"})
# Requests the host may send to the child. Session lifecycle and the one
# host-owned probe; no package name, path or graph node can be named here.
CHILD_METHODS = frozenset({"session.begin", "probe.run", "session.end"})
# A notification, never a request: it carries no id of its own and is never
# answered.
CANCEL_METHOD = "$/cancel"


def _fail(message: str, **detail) -> ProtocolError:
    return ProtocolError("protocol_violation", message, detail=detail or None)


def encode(frame: dict) -> bytes:
    """Serialize one frame. Refuses anything that would not survive the wire."""
    try:
        line = json.dumps(frame, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise _fail(f"Frame is not finite JSON: {exc}") from exc
    data = line.encode("utf-8") + b"\n"
    if len(data) > MAX_FRAME_BYTES:
        raise _fail("Frame exceeds the maximum size", limit=MAX_FRAME_BYTES, size=len(data))
    return data


def decode(line: bytes | str) -> dict:
    """Parse one received line into a frame, or raise a fatal protocol error."""
    raw = line.encode("utf-8") if isinstance(line, str) else line
    if len(raw) > MAX_FRAME_BYTES:
        raise _fail("Received frame exceeds the maximum size", limit=MAX_FRAME_BYTES)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise _fail("Received frame is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise _fail("Received frame must be a JSON object")
    if value.get("v") != PROTOCOL_VERSION:
        raise _fail("Unsupported protocol version", expected=PROTOCOL_VERSION)
    return value


def request_id(value) -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise _fail("Request id must be 1-64 characters of [A-Za-z0-9_.:-]")
    return value


def request(identifier: str, method: str, params: dict, *, allowed: frozenset[str]) -> dict:
    """Build an outbound request after checking it against this direction."""
    if method not in allowed:
        raise _fail(f"Method {method!r} is not permitted in this direction")
    if not isinstance(params, dict):
        raise _fail("Request params must be an object")
    return {
        "v": PROTOCOL_VERSION,
        "id": request_id(identifier),
        "method": method,
        "params": params,
    }


def cancel(identifier: str) -> dict:
    return {
        "v": PROTOCOL_VERSION,
        "method": CANCEL_METHOD,
        "params": {"id": request_id(identifier)},
    }


def ok(identifier: str, result: dict) -> dict:
    return {"v": PROTOCOL_VERSION, "id": request_id(identifier), "ok": True, "result": result}


def err(identifier: str, code: str, message: str, detail=None) -> dict:
    error = {"code": str(code)[:128], "message": str(message)[:2048]}
    if detail:
        error["detail"] = detail
    return {"v": PROTOCOL_VERSION, "id": request_id(identifier), "ok": False, "error": error}


def classify(frame: dict, *, inbound_methods: frozenset[str]) -> tuple[str, dict]:
    """Sort one decoded frame into ('request'|'response'|'cancel', frame).

    Classification is strict on purpose: a frame that is neither a well-formed
    request, a well-formed response, nor a cancellation is a fatal protocol
    error rather than something to skip. Skipping is how a peer desynchronizes
    silently.
    """
    keys = set(frame) - {"v"}
    method = frame.get("method")
    if method == CANCEL_METHOD:
        if keys != {"method", "params"}:
            raise _fail("A cancellation carries exactly method and params")
        params = frame.get("params")
        if not isinstance(params, dict) or set(params) != {"id"}:
            raise _fail("A cancellation carries exactly one target id")
        request_id(params["id"])
        return "cancel", frame
    if "method" in frame:
        if keys != {"id", "method", "params"}:
            raise _fail("A request carries exactly id, method and params")
        if not isinstance(method, str):
            raise _fail("Request method must be a string")
        request_id(frame["id"])
        if not isinstance(frame.get("params"), dict):
            raise _fail("Request params must be an object")
        if method not in inbound_methods:
            # Refused, not dispatched: there is no fallback handler.
            raise _fail(f"Unknown method {method[:64]!r}")
        return "request", frame
    if "ok" not in frame:
        raise _fail("Frame is neither a request, a response, nor a cancellation")
    request_id(frame.get("id"))
    if frame["ok"] is True:
        if keys != {"id", "ok", "result"} or not isinstance(frame.get("result"), dict):
            raise _fail("A successful response carries exactly id, ok and an object result")
        return "response", frame
    if frame["ok"] is not False or keys != {"id", "ok", "error"}:
        raise _fail("A failed response carries exactly id, ok and error")
    error = frame["error"]
    if not isinstance(error, dict) or not isinstance(error.get("code"), str):
        raise _fail("A response error carries at least a string code")
    return "response", frame


__all__ = [
    "CANCEL_METHOD",
    "CHILD_METHODS",
    "HOST_METHODS",
    "MAX_FRAME_BYTES",
    "MAX_PENDING",
    "PROTOCOL_VERSION",
    "ProtocolError",
    "cancel",
    "classify",
    "decode",
    "encode",
    "err",
    "ok",
    "request",
    "request_id",
]
