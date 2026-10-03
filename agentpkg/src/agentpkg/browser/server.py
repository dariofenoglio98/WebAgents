"""Loopback-only authenticated HTTP transport for the control plane.

Design constraints, in order of importance:

* it binds a loopback address and nothing else — there is no public-binding
  override in v0, so a misconfiguration cannot expose it to a network;
* every operation except `/v0/health` needs a bearer token that only this
  process and its operator hold;
* any local page in a real browser is refused (`Origin`/`Sec-Fetch-*` present,
  or a `Host` header that is not a loopback name), which blocks DNS-rebinding
  attempts against the loopback port even before the token check;
* requests and responses are bounded and always JSON.

The stdlib server is intentional: this milestone should not add a web
framework dependency to a package whose runtime dependencies are audited.
"""

from __future__ import annotations

import ipaddress
import json
import re
import socket
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from secrets import compare_digest, token_urlsafe

from .control import API_VERSION, SERVICE, ControlPlane
from .errors import ControlPlaneError
from .trust import public_key_from_pem

# 256 KiB rather than 64 KiB because a host model catalog is a request body:
# the bound still exists, it is just large enough for a few hundred bounded
# model descriptors. Every field inside one is separately length-limited.
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_CONCURRENT_REQUESTS = 16
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
LOOPBACK_HOST_NAMES = {"localhost", "127.0.0.1", "::1", "[::1]"}


def _bad(message, code="invalid_request", status=400):
    return ControlPlaneError(code, message, status=status)


def _object(body, allowed: set[str], required: set[str] = frozenset()) -> dict:
    """Strict body validation: unknown fields are refused, never ignored."""
    if not isinstance(body, dict):
        raise _bad("Request body must be a JSON object")
    unknown = set(body) - allowed
    if unknown:
        raise _bad(f"Unknown request fields: {sorted(unknown)}", code="unknown_field")
    missing = required - set(body)
    if missing:
        raise _bad(f"Missing required fields: {sorted(missing)}")
    return body


class BrowserAPI:
    """Route table over `ControlPlane`; holds no state of its own."""

    def __init__(self, control: ControlPlane):
        self.control = control

    def dispatch(self, method: str, path: str, body) -> tuple[int, dict]:
        parts = [segment for segment in path.split("/") if segment]
        if not parts or parts[0] != API_VERSION:
            raise ControlPlaneError("not_found", f"Unknown route {path}", status=404)
        route = parts[1:]
        if route == ["health"]:
            return self._only(method, "GET", lambda: (200, self.control.health()))
        if route == ["status"]:
            return self._only(method, "GET", lambda: (200, self.control.status()))
        if route == ["packages"]:
            return self._only(method, "GET", lambda: (200, self.control.list_sessions()))
        if route == ["packages", "open-file"]:
            return self._only(method, "POST", lambda: self._open_file(body))
        if route == ["packages", "open-url"]:
            return self._only(method, "POST", lambda: self._open_url(body))
        if route == ["websites", "discover"]:
            return self._only(method, "POST", lambda: self._discover_website(body))
        if route == ["trust"]:
            if method == "GET":
                return 200, self.control.trust_list()
            return self._only(method, "POST", lambda: self._trust_add(body))
        if len(route) == 2 and route[0] == "trust":
            return self._only(method, "DELETE", lambda: self._trust_remove(route[1]))
        if len(route) >= 2 and route[0] == "packages":
            return self._package_route(method, route[1], route[2:], body)
        raise ControlPlaneError("not_found", f"Unknown route {path}", status=404)

    @staticmethod
    def _only(method, expected, handler):
        if method != expected:
            raise ControlPlaneError(
                "method_not_allowed", f"This route accepts {expected}", status=405
            )
        return handler()

    def _package_route(self, method, session_id, rest, body):
        if not SESSION_ID.fullmatch(session_id):
            raise ControlPlaneError("session_unknown", "Malformed session id", status=404)
        if not rest:
            if method == "GET":
                return 200, self.control.summary(session_id)
            return self._only(method, "DELETE", lambda: (200, self.control.close(session_id)))
        if rest == ["permissions"]:
            return self._only(method, "GET", lambda: (200, self.control.permissions(session_id)))
        if rest == ["authorization"]:
            return self._only(method, "GET", lambda: (200, self.control.authorization(session_id)))
        if rest == ["authorize"]:
            return self._only(method, "POST", lambda: self._authorize(session_id, body))
        if rest == ["trust-publisher"]:
            return self._only(method, "POST", lambda: self._trust_session(session_id, body))
        if rest == ["models"]:
            return self._only(
                method, "GET", lambda: (200, self.control.model_requirements(session_id))
            )
        if rest == ["models", "evaluate"]:
            return self._only(method, "POST", lambda: self._evaluate_models(session_id, body))
        if rest == ["tools"]:
            return self._only(
                method, "GET", lambda: (200, self.control.tool_requirements(session_id))
            )
        if rest == ["tools", "evaluate"]:
            return self._only(method, "POST", lambda: self._evaluate_tools(session_id, body))
        if rest == ["input", "validate"]:
            return self._only(method, "POST", lambda: self._validate_input(session_id, body))
        if rest == ["run-plan"]:
            if method == "POST":
                return self._prepare_run_plan(session_id, body)
            if method == "DELETE":
                return 200, self.control.clear_run_plan(session_id)
            return self._only(method, "GET", lambda: (200, self.control.run_plan(session_id)))
        if rest == ["execution-lease"]:
            return self._only(method, "POST", lambda: self._issue_lease(session_id, body))
        if len(rest) == 2 and rest[0] == "execution-lease":
            return self._only(
                method,
                "DELETE",
                lambda: (200, self.control.release_execution_lease(session_id, rest[1])),
            )
        raise ControlPlaneError("not_found", "Unknown package route", status=404)

    def _issue_lease(self, session_id, body):
        """Issue one private copy of an immutable snapshot to a trusted runner.

        The response carries a local filesystem path, which is why this route,
        like every other, is reachable only over the authenticated loopback API
        by the host process that supervises this service.
        """
        payload = _object(
            body,
            {"package_digest", "run_plan_id", "run_plan_sha256"},
            {"package_digest", "run_plan_id", "run_plan_sha256"},
        )
        for field in ("run_plan_id", "run_plan_sha256"):
            if not isinstance(payload[field], str) or not payload[field]:
                raise _bad(f"{field} must be a non-empty string")
        return 201, self.control.issue_execution_lease(
            session_id,
            package_digest=payload["package_digest"],
            run_plan_id=payload["run_plan_id"],
            run_plan_sha256=payload["run_plan_sha256"],
        )

    def _validate_input(self, session_id, body):
        payload = _object(body, {"input"}, {"input"})
        return 200, self.control.validate_input(session_id, input_value=payload["input"])

    def _evaluate_models(self, session_id, body):
        payload = _object(body, {"package_digest", "catalog"}, {"package_digest", "catalog"})
        return 200, self.control.evaluate_models(
            session_id,
            package_digest=payload["package_digest"],
            catalog=payload["catalog"],
        )

    def _evaluate_tools(self, session_id, body):
        payload = _object(
            body, {"package_digest", "tool_registry"}, {"package_digest", "tool_registry"}
        )
        return 200, self.control.evaluate_tools(
            session_id,
            package_digest=payload["package_digest"],
            tool_registry=payload["tool_registry"],
        )

    def _prepare_run_plan(self, session_id, body):
        payload = _object(
            body,
            {
                "package_digest",
                "receipt_id",
                "model_id",
                "catalog",
                "tool_registry",
                "probe_tool_id",
                "execution_mode",
                "binding_strategy",
            },
            {"package_digest", "receipt_id", "catalog"},
        )
        return 201, self.control.prepare_run_plan(
            session_id,
            package_digest=payload["package_digest"],
            receipt_id=payload["receipt_id"],
            model_id=payload.get("model_id"),
            catalog=payload["catalog"],
            tool_registry=payload.get("tool_registry"),
            probe_tool_id=payload.get("probe_tool_id"),
            execution_mode=payload.get("execution_mode", "model"),
            binding_strategy=payload.get("binding_strategy", "single_model"),
        )

    def _open_file(self, body):
        payload = _object(body, {"path"}, {"path"})
        return 201, self.control.open_file(payload["path"])

    def _open_url(self, body):
        payload = _object(body, {"url"}, {"url"})
        return 201, self.control.open_url(payload["url"])

    def _discover_website(self, body):
        # 200, not 201: discovery creates nothing, it only reports a page.
        payload = _object(body, {"url"}, {"url"})
        return 200, self.control.discover_website(payload["url"])

    def _authorize(self, session_id, body):
        payload = _object(
            body, {"package_digest", "decisions", "tool_approvals"}, {"package_digest"}
        )
        receipt = self.control.authorize(
            session_id,
            package_digest=payload["package_digest"],
            decisions=payload.get("decisions"),
            tool_approvals=payload.get("tool_approvals"),
        )
        return 201, receipt

    def _trust_session(self, session_id, body):
        payload = _object(
            body,
            {"signer_fingerprint", "scope", "notes", "replace"},
            {"signer_fingerprint"},
        )
        if not isinstance(payload["signer_fingerprint"], str):
            raise _bad("signer_fingerprint must be a string")
        replace = payload.get("replace", False)
        if not isinstance(replace, bool):
            raise _bad("replace must be a boolean")
        scope = payload.get("scope", "package")
        if not isinstance(scope, str):
            raise _bad("scope must be a string")
        return 201, self.control.trust_session_publisher(
            session_id,
            signer_fingerprint=payload["signer_fingerprint"],
            scope=scope,
            notes=payload.get("notes"),
            replace=replace,
        )

    def _trust_add(self, body):
        payload = _object(
            body,
            {
                "public_key_pem",
                "display_name",
                "publisher_id",
                "package_id_prefix",
                "notes",
                "replace",
            },
            {"public_key_pem", "display_name"},
        )
        if not isinstance(payload["public_key_pem"], str):
            raise _bad("public_key_pem must be a PEM string")
        replace = payload.get("replace", False)
        if not isinstance(replace, bool):
            raise _bad("replace must be a boolean")
        key = public_key_from_pem(payload["public_key_pem"])
        return 201, self.control.trust_add(
            key,
            display_name=payload["display_name"],
            publisher_id=payload.get("publisher_id"),
            package_id_prefix=payload.get("package_id_prefix"),
            notes=payload.get("notes"),
            replace=replace,
        )

    def _trust_remove(self, key_fingerprint):
        if not FINGERPRINT.fullmatch(key_fingerprint):
            raise ControlPlaneError(
                "trust_entry_unknown", "Fingerprint must be sha256:<64 hex>", status=404
            )
        return 200, self.control.trust_remove(key_fingerprint)


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "agentpkg-browser/0.1"
    sys_version = ""

    # -- helpers -------------------------------------------------------------
    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2).encode("utf-8")
        if len(data) > MAX_RESPONSE_BYTES:
            status = 500
            data = json.dumps(
                {"error": {"code": "response_too_large", "message": "Response exceeded limit"}}
            ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _guard(self, path: str) -> None:
        """Browser-origin and Host checks run before authentication."""
        if any(self.headers.get(name) for name in ("Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode")):
            raise ControlPlaneError(
                "browser_request_refused",
                "Requests carrying browser origin headers are refused; this service is for "
                "local trusted host tooling only",
                status=403,
            )
        host = (self.headers.get("Host") or "").strip()
        name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
        if name.startswith("[") and "]" in host:
            name = host[: host.index("]") + 1]
        if name.lower() not in LOOPBACK_HOST_NAMES:
            raise ControlPlaneError(
                "host_header_rejected",
                "Host header must be a loopback name; this blocks DNS rebinding",
                status=403,
            )
        if path.split("/")[:3] == ["", API_VERSION, "health"]:
            return
        header = self.headers.get("Authorization", "")
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer" or not compare_digest(presented.strip(), self.server.token):
            raise ControlPlaneError("unauthorized", "A valid bearer token is required", status=401)

    def _body(self) -> object:
        if self.headers.get("Transfer-Encoding"):
            raise _bad("Chunked request bodies are not accepted", status=411)
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return None
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise _bad("Invalid Content-Length") from exc
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise ControlPlaneError(
                "request_too_large",
                f"Request bodies are limited to {MAX_REQUEST_BYTES} bytes",
                status=413,
            )
        if length == 0:
            return None
        data = self.rfile.read(length)
        if len(data) != length:
            raise _bad("Truncated request body")
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise _bad("Request body must be valid UTF-8 JSON") from exc

    def _handle(self, method: str) -> None:
        path = self.path.split("?", 1)[0]
        status = 500
        if not self.server.slots.acquire(blocking=False):
            self._send(503, {"error": {"code": "busy", "message": "Too many concurrent requests"}})
            return
        try:
            self._guard(path)
            body = self._body()
            if method in {"GET", "DELETE"} and body is not None:
                raise _bad(f"{method} requests must not carry a body")
            status, payload = self.server.api.dispatch(method, path, body)
            self._send(status, payload)
        except ControlPlaneError as exc:
            status = exc.status
            self._send(exc.status, exc.payload())
        except Exception:
            # Never leak internal detail, paths or tracebacks to the client.
            self._send(
                500, {"error": {"code": "internal_error", "message": "Unhandled service error"}}
            )
        finally:
            self.server.slots.release()
            self.log_request_json(method, path, status)

    def do_GET(self):  # noqa: N802 - stdlib handler contract
        self._handle("GET")

    def do_POST(self):  # noqa: N802
        self._handle("POST")

    def do_DELETE(self):  # noqa: N802
        self._handle("DELETE")

    def do_PUT(self):  # noqa: N802
        self._handle("PUT")

    def do_PATCH(self):  # noqa: N802
        self._handle("PATCH")

    def log_request_json(self, method, path, status):
        if self.server.quiet:
            return
        print(
            json.dumps(
                {"service": SERVICE, "method": method, "path": path, "status": status},
                ensure_ascii=False,
            ),
            flush=True,
        )

    def log_message(self, fmt, *args):  # Suppress stderr common-log noise.
        return


class BrowserService(ThreadingHTTPServer):
    """Loopback HTTP front end. Refuses to bind a non-loopback address."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, control: ControlPlane, *, host="127.0.0.1", port=0, token=None, quiet=True):
        address = ipaddress.ip_address(_require_loopback(host))
        if address.version == 6:
            self.address_family = socket.AF_INET6
        self.control = control
        self.api = BrowserAPI(control)
        self.token = token or token_urlsafe(32)
        self.quiet = quiet
        self.slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
        super().__init__((str(address), port), _Handler)
        self.timeout = 5

    def server_bind(self):
        # HTTPServer.server_bind also resolves the bound address back to a name
        # with socket.getfqdn(), a reverse DNS lookup. On a host whose own name
        # does not resolve (GitHub's macOS runners, for one) that takes about
        # 35 s, longer than a supervising host waits for readiness. The name is
        # never used: this service only ever binds a loopback literal.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    @property
    def url(self) -> str:
        host, port = self.server_address[0], self.server_address[1]
        bracket = f"[{host}]" if ":" in str(host) else host
        return f"http://{bracket}:{port}"

    def start_background(self) -> threading.Thread:
        thread = threading.Thread(target=self.serve_forever, name="agentpkg-browser", daemon=True)
        thread.start()
        return thread

    def server_close(self):
        try:
            super().server_close()
        finally:
            self.control.shutdown()


def _require_loopback(host: str) -> str:
    """Only loopback literals are accepted. There is no public-binding override."""
    candidate = (host or "").strip().strip("[]")
    if candidate in {"localhost", ""}:
        candidate = "127.0.0.1"
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError as exc:
        raise ControlPlaneError(
            "bind_rejected",
            f"--host must be a loopback IP literal, not {host!r}",
            status=400,
        ) from exc
    if not address.is_loopback:
        raise ControlPlaneError(
            "bind_rejected",
            f"Refusing to bind {host!r}: the agent browser control plane is loopback-only. "
            "It is trusted host infrastructure and has no public-binding mode.",
            status=400,
        )
    return str(address)
