"""Fixed, host-installed tools. URLs found in responses are never fetched."""

from __future__ import annotations

import asyncio
import hashlib
import http.client
import io
import ipaddress
import json
import multiprocessing
import os
import socket
import ssl
import stat
import time
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from .runtime import PolicyError

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_PDF_BYTES = 20 * 1024 * 1024
DEFAULT_RESOLVER = "https://webagents-citation-resolver-production.up.railway.app"


class ToolError(PolicyError):
    """A provider or document failed without exposing private response bodies."""


def validate_https_url(url, allowed_domains):
    try:
        parts = urlsplit(url)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.port not in {None, 443}
            or parts.fragment
            or parts.hostname not in allowed_domains
            or any(c.isspace() or ord(c) < 32 for c in url)
        ):
            raise ValueError()
    except ValueError as exc:
        raise PolicyError("Remote URL must be HTTPS on an explicitly approved domain") from exc
    return parts


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        sock = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def request_json(url, *, method, payload=None, timeout=40, allowed_domains=(), headers=None):
    """DNS validated and connection pinned to that public address, TLS hostname checked.

    The async wrapper runs this in a killable child. Bounded reads apply;
    no redirects, proxies, cookies, retries, or ambient credentials are supported.
    """
    parts = validate_https_url(url, allowed_domains)
    try:
        addresses = sorted(
            {a[4][0] for a in socket.getaddrinfo(parts.hostname, 443, type=socket.SOCK_STREAM)}
        )
        if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
            raise PolicyError("DNS destination is not public; private/loopback access denied")
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode()
        if body and len(body) > MAX_RESPONSE_BYTES:
            raise ToolError("Request body exceeds transport limit")
        conn = _PinnedHTTPS(parts.hostname, addresses[0], timeout=min(timeout, 40))
        deadline = time.monotonic() + timeout
        try:
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
            request_headers = {"Accept": "application/json", "User-Agent": "AgentPkg/0.1"}
            if body is not None:
                request_headers["Content-Type"] = "application/json"
            request_headers.update(headers or {})
            conn.request(method, path, body=body, headers=request_headers)
            response = conn.getresponse()
            if 300 <= response.status < 400:
                raise ToolError("Provider redirect denied")
            content_length = response.getheader("Content-Length")
            if content_length and int(content_length) > MAX_RESPONSE_BYTES:
                raise ToolError("Provider response too large")
            chunks, total = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ToolError("Provider whole-operation deadline exceeded")
                if conn.sock is not None:
                    conn.sock.settimeout(max(0.01, remaining))
                chunk = response.read(min(65536, MAX_RESPONSE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise ToolError("Provider response too large")
            return response.status, json.loads(b"".join(chunks))
        finally:
            conn.close()
    except PolicyError:
        raise
    except (OSError, ValueError, http.client.HTTPException) as exc:
        raise ToolError(f"Remote request failed: {type(exc).__name__}") from exc


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def _text(value):
    if not isinstance(value, str):
        return None
    parser = _Text()
    parser.feed(value)
    return " ".join("".join(parser.parts).split()) or None


def _pdf_child(data, connection):
    try:
        # A killable child bounds parser CPU and address-space consumption on POSIX.
        import resource

        from pypdf import PdfReader

        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
        try:
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        except (ValueError, OSError):
            pass  # macOS can decline RLIMIT_AS; parent timeout/byte/page caps still apply.
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ValueError("Encrypted PDF unsupported")
        if len(reader.pages) > 100:
            raise ValueError("PDF exceeds 100-page limit")
        pages, total = [], 0
        for i, page in enumerate(reader.pages, 1):
            text = page.extract_text() or ""
            total += len(text.encode())
            if total > 1024 * 1024:
                raise ValueError("PDF extracted text exceeds 1 MiB limit")
            pages.append({"page": i, "text": text})
        connection.send(
            {"pages": pages, "sha256": hashlib.sha256(data).hexdigest(), "source": "user_pdf"}
        )
    except BaseException as exc:
        connection.send({"error": type(exc).__name__})
    finally:
        connection.close()


def _read_pdf(path):
    path = Path(path).absolute()
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise PolicyError("Selected PDF path may not contain symlinks")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PDF_BYTES:
            raise ToolError("Selected PDF must be a regular file at most 20 MiB")
        data = stream.read(MAX_PDF_BYTES + 1)
    if len(data) > MAX_PDF_BYTES or not data.startswith(b"%PDF-"):
        raise ToolError("Selected file is not a bounded PDF document")
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_pdf_child, args=(data, sender), daemon=True)
    process.start()
    sender.close()
    try:
        if not receiver.poll(15):
            raise ToolError("PDF parser exceeded 15-second deadline")
        result = receiver.recv()
        if "error" in result:
            raise ToolError(f"PDF parse failed: {result['error']}")
        return result
    except EOFError as exc:
        raise ToolError("PDF parser exited without a result") from exc
    finally:
        receiver.close()
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=2)
        process.close()


def create_handlers(
    package,
    *,
    mode="live",
    fixtures=None,
    resolver_base_url=None,
    selected_files=None,
    transport=None,
):
    """Bind known IDs only. Override endpoints must stay inside package + grant domains."""
    if mode != "live" or fixtures is not None:
        raise PolicyError("Fixture handlers are supplied by the reference workflow")
    selected_files = dict(selected_files or {})
    # An explicitly supplied transport is a trusted host/test seam.
    by_binding = {t["binding"]: t for t in package.tools.values()}
    if len(by_binding) != len(package.tools):
        raise PolicyError("Host tool bindings must be unique within a package")
    permissions = {p["id"]: p for p in package.policy["permissions"]}
    expected = {
        "scholarly.search": ("remote", "GET", "network"),
        "citation.resolve": ("remote", "POST", "network"),
        "paper.read": ("local", None, "files.read"),
    }
    for binding, tool in by_binding.items():
        if binding not in expected:
            raise PolicyError(f"Unsupported host tool binding: {binding}")
        execution, method, required_kind = expected[binding]
        kinds = {permissions[p]["kind"] for p in tool["permissions"]}
        if (
            tool["execution"] != execution
            or tool["method"] != method
            or required_kind not in kinds
            or tool["side_effects"] != "read"
        ):
            raise PolicyError(
                f"Binding {binding} has incompatible execution or permission contract"
            )
        if binding == "scholarly.search" and tool["endpoint"] != "https://api.crossref.org/works":
            raise PolicyError("scholarly.search requires the supported Crossref endpoint")
        if binding == "citation.resolve" and urlsplit(tool["endpoint"]).path != "/resolve":
            raise PolicyError("citation.resolve requires the /resolve endpoint")

    async def remote(ctx, binding, payload=None, params=None, endpoint=None):
        tool = by_binding[binding]
        url = endpoint or tool["endpoint"]
        domains = set(tool["domains"]) & set(package.policy["network"]["allowed_domains"])
        # Permission resources constrain actual network destinations, not just a display list.
        permission_map = {p["id"]: p for p in package.policy["permissions"]}
        granted_domains = set()
        for pid in tool["permissions"]:
            perm = permission_map[pid]
            if perm["kind"] == "network":
                granted_domains.update(perm["resources"])
        domains &= granted_domains
        validate_https_url(url, domains)
        if params:
            url += ("&" if "?" in url else "?") + urlencode(params)
        ctx.event(
            "network.requested",
            tool=tool["id"],
            domain=urlsplit(url).hostname,
            method=tool["method"],
        )
        options = dict(
            method=tool["method"],
            payload=payload,
            timeout=tool["timeout_seconds"],
            allowed_domains=domains,
        )
        if transport is None:
            from .network import async_request_json

            return await async_request_json(url, **options)
        return await asyncio.to_thread(transport, url, **options)

    async def search(ctx, payload):
        status, data = await remote(
            ctx,
            "scholarly.search",
            params={"query.bibliographic": payload["query"], "rows": payload.get("limit", 8)},
        )
        if status != 200:
            raise ToolError(f"Scholarly search unavailable (HTTP {status})")
        try:
            papers = []
            for item in data["message"]["items"][: payload.get("limit", 8)]:
                titles = item.get("title") or []
                title = _text(titles[0]) if titles else None
                if not title:
                    continue
                authors = [
                    {
                        "name": " ".join(filter(None, [a.get("given"), a.get("family")]))
                        or a.get("name", "")
                    }
                    for a in item.get("author", [])
                ]
                parts = (item.get("published") or item.get("issued") or {}).get("date-parts", [])
                doi = item.get("DOI")
                papers.append(
                    {
                        "title": title,
                        "doi": doi,
                        "arxiv_id": None,
                        "abstract": _text(item.get("abstract")),
                        "authors": authors,
                        "year": parts[0][0] if parts and parts[0] else None,
                        "venue": (item.get("container-title") or [None])[0],
                        "url": item.get("URL"),
                        "source": "crossref",
                        "provenance": [
                            {
                                "source": "crossref",
                                "query": payload["query"],
                                "locator": doi,
                                "synthetic": False,
                                "retrieved_at": datetime.now(UTC).isoformat(),
                            }
                        ],
                    }
                )
            return {"papers": papers, "query": payload["query"], "source": "crossref"}
        except (KeyError, TypeError, IndexError) as exc:
            raise ToolError("Invalid scholarly search response") from exc

    async def resolve(ctx, payload):
        base = resolver_base_url or os.environ.get("CITATION_RESOLVER_BASE_URL")
        endpoint = None
        if base:
            parsed = urlsplit(base)
            if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
                raise PolicyError("CITATION_RESOLVER_BASE_URL must be an HTTPS origin")
            endpoint = base.rstrip("/") + "/resolve"
        status, data = await remote(ctx, "citation.resolve", payload, endpoint=endpoint)
        if status not in {200, 400, 404, 502}:
            raise ToolError(f"Citation Resolver unavailable (HTTP {status})")
        expected = {
            200: {"resolved", "ambiguous"},
            400: {"invalid_request"},
            404: {"not_found"},
            502: {"provider_error"},
        }
        if not isinstance(data, dict) or data.get("status") not in expected[status]:
            raise ToolError("Citation Resolver HTTP/status contract mismatch")
        return data

    async def read(ctx, payload):
        file_id = payload["file_id"]
        if file_id not in selected_files:
            raise PolicyError("PDF was not explicitly selected by the user")
        ctx.event("file.read", file_id_hash=hashlib.sha256(file_id.encode()).hexdigest())
        # A cancelled asyncio.to_thread await does not stop its thread. Keep the
        # bounded parser/reaper alive and drain it before releasing the worker.
        task = asyncio.create_task(asyncio.to_thread(_read_pdf, selected_files[file_id]))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    pass
                except Exception:
                    break
            if task.done() and not task.cancelled():
                task.exception()
            raise

    return {"scholarly.search": search, "citation.resolve": resolve, "paper.read": read}
