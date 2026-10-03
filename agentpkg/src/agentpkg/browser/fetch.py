"""SSRF-hardened package download. A package URL is never a host network primitive.

Policy order for every URL, with no exception path:

1. syntax: HTTPS on port 443, no credentials, no fragment, no control characters;
2. resolution: every resolved address must be publicly routable
   (`agentpkg.netaddr`), so a hostname that resolves to a private destination
   is refused before a socket exists;
3. connection: the socket is pinned to the validated address while TLS still
   verifies the original hostname, so a second DNS answer cannot rebind it;
4. transfer: bounded status handling, no redirects, byte cap during streaming,
   whole-operation deadline.

Steps 2-4 run inside a killable child process, so DNS, connect and read time
are all bounded by one wall clock and the sockets die with the child. This
mirrors the existing `tools._read_pdf` child pattern without importing any
execution module.

Website discovery (`discovery.py`) applies steps 1-3 and the killable child
unchanged to an HTML page; it allows redirects only within one origin, each hop
re-validated and re-resolved. A package download still refuses every redirect.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import multiprocessing
import os
import socket
import ssl
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from ..netaddr import public_address_reason
from .errors import ControlPlaneError

MAX_MESSAGE_BYTES = 64 * 1024
DEFAULT_USER_AGENT = "AgentPkgBrowser/0.1"


@dataclass(frozen=True)
class FetchLimits:
    max_bytes: int = 32 * 1024 * 1024 + 256 * 1024
    timeout_seconds: float = 60.0
    max_addresses: int = 8


def _reject(code: str, message: str, *, status: int = 400) -> ControlPlaneError:
    return ControlPlaneError(code, message, status=status)


def validate_package_url(url: str, *, subject: str = "Package") -> tuple[str, str]:
    """Syntax gate. Returns (hostname, request_target); raises on anything else.

    `subject` only names the URL in messages ("Package", "Website"); the policy
    is the same for every caller.
    """
    noun = subject.lower()
    if not isinstance(url, str) or not url or len(url) > 2048:
        raise _reject("url_rejected", f"{subject} URL must be a string of at most 2048 characters")
    if any(character.isspace() or ord(character) < 32 for character in url):
        raise _reject("url_rejected", f"{subject} URL must not contain whitespace or control bytes")
    try:
        parts = urlsplit(url)
    except ValueError as exc:  # For example an unterminated IPv6 literal.
        raise _reject("url_rejected", f"{subject} URL is malformed") from exc
    if parts.scheme != "https":
        raise _reject(
            "url_rejected",
            f"Only https:// {noun} URLs are accepted; refused scheme {parts.scheme or 'none'!r}",
        )
    if parts.username or parts.password or "@" in parts.netloc:
        raise _reject("url_rejected", f"{subject} URLs must not embed credentials")
    if parts.fragment:
        raise _reject("url_rejected", f"{subject} URLs must not contain a fragment")
    try:
        port = parts.port
    except ValueError as exc:
        raise _reject("url_rejected", f"{subject} URL has an invalid port") from exc
    if port not in (None, 443):
        raise _reject("url_rejected", f"{subject} URLs must use the default HTTPS port 443")
    hostname = parts.hostname
    if not hostname or len(hostname) > 253:
        raise _reject("url_rejected", f"{subject} URL must name a host")
    target = parts.path or "/"
    if parts.query:
        target += "?" + parts.query
    return hostname, target


def resolve_public_addresses(
    hostname: str, *, limits: FetchLimits, resolver=None, subject: str = "Package"
) -> list[str]:
    """Resolve and require every answer to be publicly routable."""
    resolver = resolver or socket.getaddrinfo
    try:
        answers = resolver(hostname, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise _reject(
            "url_unresolvable", f"Cannot resolve {subject.lower()} host: {type(exc).__name__}"
        ) from exc
    addresses = sorted({answer[4][0] for answer in answers})[: limits.max_addresses]
    if not addresses:
        raise _reject("url_unresolvable", f"{subject} host has no addresses")
    for address in addresses:
        reason = public_address_reason(address)
        if reason:
            # The literal address is withheld; the class of destination is enough.
            raise _reject(
                "url_destination_denied",
                f"{subject} host resolves to a non-public destination ({reason})",
                status=403,
            )
    return addresses


def _default_connector(hostname: str, address: str, timeout: float):
    """Pin the socket to the validated address; TLS still checks the real hostname."""
    connection = http.client.HTTPSConnection(
        hostname, port=443, timeout=timeout, context=ssl.create_default_context()
    )
    sock = socket.create_connection((address, 443), timeout=timeout)
    try:
        connection.sock = connection._context.wrap_socket(sock, server_hostname=hostname)
    except BaseException:
        sock.close()
        raise
    return connection


def fetch_https_package(
    url: str, *, limits: FetchLimits, resolver=None, connector=_default_connector
) -> bytes:
    """Run the whole URL policy and return the downloaded bytes.

    `resolver`/`connector` are trusted host seams used by tests. They replace
    transport mechanics only; the syntax, address and transfer policy above is
    always applied.
    """
    hostname, target = validate_package_url(url)
    addresses = resolve_public_addresses(hostname, limits=limits, resolver=resolver)
    deadline = time.monotonic() + limits.timeout_seconds
    try:
        connection = connector(hostname, addresses[0], min(limits.timeout_seconds, 60.0))
    except OSError as exc:
        raise _reject(
            "download_failed", f"Cannot connect to package host: {type(exc).__name__}"
        ) from exc
    try:
        connection.request(
            "GET",
            target,
            headers={"Accept": "application/octet-stream", "User-Agent": DEFAULT_USER_AGENT},
        )
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise _reject(
                "download_redirect_denied",
                "Package host returned a redirect; redirects are disabled because each hop "
                "would need the full destination policy re-applied",
                status=502,
            )
        if response.status != 200:
            raise _reject(
                "download_failed",
                f"Package host returned HTTP {response.status}",
                status=502,
            )
        declared = response.getheader("Content-Length")
        if declared is not None:
            try:
                declared_bytes = int(declared)
            except ValueError as exc:
                raise _reject(
                    "download_failed", "Package host sent an invalid Content-Length"
                ) from exc
            if declared_bytes > limits.max_bytes:
                raise _reject(
                    "download_too_large",
                    f"Declared package size exceeds the {limits.max_bytes}-byte limit",
                    status=413,
                )
        chunks: list[bytes] = []
        total = 0
        while True:
            if time.monotonic() > deadline:
                raise _reject("download_timeout", "Package download deadline exceeded", status=504)
            if connection.sock is not None:
                connection.sock.settimeout(max(0.01, deadline - time.monotonic()))
            chunk = response.read(min(65536, limits.max_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > limits.max_bytes:
                raise _reject(
                    "download_too_large",
                    f"Package exceeds the {limits.max_bytes}-byte download limit",
                    status=413,
                )
        return b"".join(chunks)
    except ControlPlaneError:
        raise
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise _reject("download_failed", f"Package download failed: {type(exc).__name__}") from exc
    finally:
        connection.close()


def _download_child(url: str, destination: str, limits: tuple, sender) -> None:
    """Runs in a killable child: resolve, connect, stream to one private file."""
    try:
        data = fetch_https_package(
            url, limits=FetchLimits(max_bytes=limits[0], timeout_seconds=limits[1])
        )
        fd = os.open(destination, os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        message = {
            "ok": True,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
        }
    except ControlPlaneError as exc:
        message = {"ok": False, "code": exc.code, "message": str(exc), "status": exc.status}
    except BaseException as exc:  # Never transport provider bodies or tracebacks.
        message = {
            "ok": False,
            "code": "download_failed",
            "message": f"Package download failed: {type(exc).__name__}",
            "status": 502,
        }
    try:
        sender.send_bytes(json.dumps(message).encode()[:MAX_MESSAGE_BYTES])
    finally:
        sender.close()


@dataclass(frozen=True)
class ChildOperation:
    """How one killable child operation names itself and its own failures."""

    operation: str  # "Package download"
    child: str  # "download"
    timeout_code: str
    failure_code: str


DOWNLOAD = ChildOperation("Package download", "download", "download_timeout", "download_failed")


def run_in_killable_child(
    target,
    args: tuple,
    *,
    timeout_seconds: float,
    operation: ChildOperation,
    max_message_bytes: int = MAX_MESSAGE_BYTES,
) -> dict:
    """Run `target(*args, sender)` in a spawned child and return its one JSON message.

    The child owns DNS and sockets; the parent owns only the deadline, after which
    it terminates, kills and reaps the child, so a hostile or slow host cannot hold
    a request thread, a socket or a resolver call open. A message with `ok: false`
    becomes the ControlPlaneError it describes.
    """
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=target, args=(*args, sender), daemon=True)
    process.start()
    sender.close()
    try:
        if not receiver.poll(timeout_seconds + 10):
            raise _reject(
                operation.timeout_code, f"{operation.operation} deadline exceeded", status=504
            )
        message = json.loads(receiver.recv_bytes(max_message_bytes))
        if not isinstance(message, dict):
            raise _reject(
                operation.failure_code, f"Invalid {operation.child} child response", status=502
            )
        if not message.get("ok"):
            details = message.get("details")
            raise ControlPlaneError(
                str(message.get("code", operation.failure_code)),
                str(message.get("message", f"{operation.operation} failed")),
                status=int(message.get("status", 502)),
                details=details if isinstance(details, dict) else None,
            )
        return message
    except (EOFError, OSError, ValueError, KeyError) as exc:
        raise _reject(
            operation.failure_code,
            f"{operation.child.capitalize()} child failed: {type(exc).__name__}",
            status=502,
        ) from exc
    finally:
        receiver.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=2)
        process.close()


def download_to_file(url: str, destination, *, limits: FetchLimits, transport=None) -> dict:
    """Download one package into an existing private file owned by the service.

    `transport(url, limits) -> bytes` is an explicit trusted host/test seam. With
    no transport, the download runs in a killable child so a hostile or slow
    host cannot hold a request thread, a socket, or a resolver call open.
    """
    validate_package_url(url)  # Applies to every path, including an injected transport.
    if transport is not None:
        data = transport(url, limits)
        if not isinstance(data, bytes):
            raise _reject("download_failed", "Injected transport must return bytes")
        if len(data) > limits.max_bytes:
            raise _reject(
                "download_too_large",
                f"Package exceeds the {limits.max_bytes}-byte download limit",
                status=413,
            )
        with open(destination, "wb") as stream:
            stream.write(data)
        return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    message = run_in_killable_child(
        _download_child,
        (url, str(destination), (limits.max_bytes, limits.timeout_seconds)),
        timeout_seconds=limits.timeout_seconds,
        operation=DOWNLOAD,
    )
    try:
        return {"sha256": message["sha256"], "bytes": message["bytes"]}
    except KeyError as exc:
        raise _reject(
            "download_failed", f"Download child failed: {type(exc).__name__}", status=502
        ) from exc
