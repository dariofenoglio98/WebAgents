"""Website discovery: which agent packages does one HTML page advertise?

A person may give the Agent Browser an ordinary website address instead of a
package URL. Discovery reads that one page and reports every

    <link rel="agent-package" type="application/vnd.webagents.agent-package" href="...">

in its document head as an **untrusted candidate**: a location the website
claims, and nothing more. `rel="agent-package"` and that media type are an
experimental WebAgents convention, not a registered HTML link relation or any
web standard.

Discovery never downloads, verifies, trusts, authorizes or runs a package. A
person chooses a candidate, and only the existing package acquisition path
(`ControlPlane.open_url`) then fetches it and decides what it is.

Network policy, for the page and for every redirect hop, is the package policy
of `fetch.py` with nothing relaxed: HTTPS on port 443, no credentials, every
resolved address publicly routable, the socket pinned to a validated address
with TLS bound to the hostname, one wall-clock deadline, all inside a killable
child. Discovery adds only what reading a web page needs:

* a redirect is followed only within the page's own origin, at most
  `MAX_REDIRECTS` times, and each hop is validated and resolved again;
* only a `200` response with an HTML Content-Type is read, at most
  `MAX_HTML_BYTES` of it, as identity, gzip or deflate content under that cap;
* the request carries no cookie, credential or referrer, and nothing the page
  references (scripts, styles, images, other links) is ever fetched;
* nothing runs: the page is tokenized, never rendered.

Only the document head is searched, as conforming HTML requires for a link
relation that is not body-ok, which also keeps text that a site's visitors can
post in its body out of discovery. `_HeadLinks` applies the HTML tree builder's
rules for where the head ends; reading stops there. Each candidate is resolved
against the page's final URL and accepted only when it is a plain HTTPS URL of
that same origin (this profile's rule); anything else is reported with a
reason and never fetched.
"""

from __future__ import annotations

import codecs
import hashlib
import http.client
import json
import time
import zlib
from collections.abc import Callable
from dataclasses import astuple, dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from .errors import ControlPlaneError
from .fetch import (
    DEFAULT_USER_AGENT,
    ChildOperation,
    FetchLimits,
    _default_connector,
    resolve_public_addresses,
    run_in_killable_child,
    validate_package_url,
)

SCHEMA = "agentpkg-website-discovery-v0"
PROFILE = "same-origin-v0"
# Experimental WebAgents conventions, not web standards.
DISCOVERY_REL = "agent-package"
PACKAGE_MEDIA_TYPE = "application/vnd.webagents.agent-package"

HTML_MEDIA_TYPES = frozenset({"text/html", "application/xhtml+xml"})
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
MAX_REDIRECTS = 5
MAX_HTML_BYTES = 1024 * 1024
MAX_LINKS = 16
MAX_URL_CHARS = 2048
DISCOVERY_TIMEOUT_SECONDS = 20.0
# A discovery result is small and bounded; this only frames it on the pipe.
MAX_RESULT_BYTES = 256 * 1024

REQUEST_HEADERS = {
    "Accept": "text/html,application/xhtml+xml;q=0.9",
    "Accept-Encoding": "identity",
    "User-Agent": DEFAULT_USER_AGENT,
}

DISCOVERY = ChildOperation(
    "Website discovery", "discovery", "discovery_timeout", "discovery_failed"
)

_ASCII_WHITESPACE = "\t\n\f\r "
_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")

# Labels (WHATWG Encoding Standard) of the two encodings that are not
# ASCII-compatible and are decoded as such, and of those this reader refuses:
# ISO-2022-JP, which browsers decode statefully, and the "replacement" family,
# which browsers deliberately render as nothing.
_UTF16BE_LABELS = frozenset({"unicodefffe", "utf-16be"})
_UTF16LE_LABELS = frozenset(
    {"csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"}
)
_REFUSED_LABELS = frozenset(
    {
        "csiso2022jp",
        "iso-2022-jp",
        "csiso2022kr",
        "iso-2022-kr",
        "iso-2022-cn",
        "iso-2022-cn-ext",
        "hz-gb-2312",
        "replacement",
    }
)

# The HTML tree builder keeps these start tags in the head; any other one opens
# the body. `noscript` only before `</head>`: after it, a noscript opens the
# body too. Text elements whose content is never markup are tracked here as
# well, so the result does not depend on the Python version's tokenizer.
_HEAD_START_TAGS = frozenset(
    {
        "html",
        "head",
        "base",
        "basefont",
        "bgsound",
        "link",
        "meta",
        "noframes",
        "noscript",
        "script",
        "style",
        "template",
        "title",
    }
)
_TEXT_ONLY_ELEMENTS = frozenset(
    {"iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp"}
)
_BODY_END_TAGS = frozenset({"body", "br", "html"})


@dataclass(frozen=True)
class DiscoveryLimits:
    max_html_bytes: int = MAX_HTML_BYTES
    max_redirects: int = MAX_REDIRECTS
    timeout_seconds: float = DISCOVERY_TIMEOUT_SECONDS
    max_addresses: int = 8
    max_links: int = MAX_LINKS


@dataclass(frozen=True)
class DiscoveryNetwork:
    """Trusted host/test seam: DNS and socket mechanics only, never policy.

    The same two seams `fetch_https_package` offers. URL syntax, address
    classification, the redirect, content and size rules and the parsing below
    run unchanged whichever mechanics are plugged in.
    """

    resolver: Callable | None = None
    connector: Callable = _default_connector


def _reject(code: str, message: str, *, status: int = 502, details=None) -> ControlPlaneError:
    return ControlPlaneError(code, message, status=status, details=details)


def _ascii_lower(value: str) -> str:
    return value.translate(_ASCII_LOWER)


def _printable(value: str, limit: int) -> str:
    """Untrusted text for display: anything outside printable ASCII is escaped.

    Accepted candidates are plain ASCII anyway; this keeps a rejected href from
    hiding behind control or bidirectional-override characters on screen.
    """
    shown = "".join(
        character if " " <= character <= "~" else f"\\u{ord(character):04x}"
        for character in value[: limit + 1]
    )
    return shown if len(shown) <= limit else shown[: limit - 1] + "…"


# -- URLs and origins ---------------------------------------------------------
def _origin(url: str) -> tuple[str, str, int] | None:
    """(scheme, host, effective port) of an http(s) URL, or None."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    default = 443 if parts.scheme == "https" else 80
    return parts.scheme, parts.hostname, default if port is None else port


def origin_text(origin: tuple[str, str, int]) -> str:
    scheme, host, port = origin
    shown = f"[{host}]" if ":" in host else host
    default = 443 if scheme == "https" else 80
    return f"{scheme}://{shown}" if port == default else f"{scheme}://{shown}:{port}"


def _canonical(url: str) -> str:
    """Lowercased host, default port dropped, no fragment: one spelling per URL."""
    parts = urlsplit(url)
    origin = _origin(url)
    if origin is None:
        return url
    path = parts.path or "/"
    return origin_text(origin) + path + (f"?{parts.query}" if parts.query else "")


def _unsafe_url_text(value: str) -> str | None:
    """Why a URL string may resolve differently here than in a browser, if it may."""
    if len(value) > MAX_URL_CHARS:
        return f"it is longer than {MAX_URL_CHARS} characters"
    if not value.isascii():
        return "it contains non-ASCII characters, which this profile does not accept"
    if any(ord(character) <= 0x20 or character in "\\\x7f" for character in value):
        return (
            "it contains whitespace, control characters or a backslash, which browsers "
            "and this resolver can interpret differently"
        )
    return None


def _document_url(url) -> str:
    """The website URL to request: the package URL policy, minus the fragment.

    A fragment is never sent to a server, so it is dropped rather than refused;
    everything else is validated exactly as a package URL would be.
    """
    if not isinstance(url, str) or not url or len(url) > MAX_URL_CHARS:
        raise _reject(
            "url_rejected",
            f"Website URL must be a string of at most {MAX_URL_CHARS} characters",
            status=400,
        )
    document, _, fragment = url.partition("#")
    validate_package_url(document, subject="Website")
    if any(character.isspace() or ord(character) < 32 for character in fragment):
        raise _reject(
            "url_rejected", "Website URL must not contain whitespace or control bytes", status=400
        )
    return _canonical(document)


# -- fetching -----------------------------------------------------------------
@dataclass
class _Response:
    status: int
    location: str | None = None
    content_type: str = ""
    charset: str | None = None
    content_coding: str = "identity"
    body: bytes = b""
    truncated: bool = False


@dataclass
class FetchedPage:
    requested_url: str
    final_url: str
    redirects: list[dict]
    content_type: str
    charset: str | None
    content_coding: str
    body: bytes
    truncated: bool


def _media_type(value: str | None) -> tuple[str, dict[str, str]]:
    if not value:
        return "", {}
    essence, _, rest = value.partition(";")
    parameters: dict[str, str] = {}
    for part in rest.split(";"):
        name, separator, raw = part.partition("=")
        if separator:
            parameters.setdefault(
                _ascii_lower(name.strip(_ASCII_WHITESPACE)), raw.strip(_ASCII_WHITESPACE).strip('"')
            )
    return _ascii_lower(essence.strip(_ASCII_WHITESPACE)), parameters


def _content_coding(value: str | None) -> str:
    codings = [
        _ascii_lower(token.strip(_ASCII_WHITESPACE))
        for token in (value or "").split(",")
        if token.strip(_ASCII_WHITESPACE)
    ]
    codings = [coding for coding in codings if coding != "identity"]
    if not codings:
        return "identity"
    if len(codings) == 1 and codings[0] in ("gzip", "x-gzip"):
        return "gzip"
    if len(codings) == 1 and codings[0] == "deflate":
        return "deflate"
    raise _reject(
        "discovery_encoding_unsupported",
        f"The website sent the page with content coding {_printable(value or '', 64)!r}; "
        "discovery reads identity, gzip or deflate content only",
    )


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise _reject("discovery_timeout", "Website discovery deadline exceeded", status=504)
    return left


def _read_bounded(connection, response, coding: str, deadline: float, cap: int):
    """At most `cap` bytes of content, decompressed under the same cap.

    Compressed input is capped too, and the decompressor is never asked for more
    than one byte past the cap, so a compression bomb costs at most `cap` bytes.
    """
    decompressor = None
    if coding != "identity":
        decompressor = zlib.decompressobj(31 if coding == "gzip" else 15)
    output = bytearray()
    consumed = 0
    while True:
        if connection.sock is not None:
            connection.sock.settimeout(max(0.01, _remaining(deadline)))
        chunk = response.read(65536)
        if not chunk:
            return bytes(output), False
        consumed += len(chunk)
        if decompressor is None:
            output += chunk[: cap + 1 - len(output)]
        else:
            output += decompressor.decompress(chunk, cap + 1 - len(output))
        if len(output) > cap or consumed > cap:
            return bytes(output[:cap]), True


def _request(network: DiscoveryNetwork, url: str, deadline: float, limits) -> _Response:
    """One GET of one validated URL. Redirects are returned, never followed here."""
    hostname, target = validate_package_url(url, subject="Website")
    addresses = resolve_public_addresses(
        hostname,
        limits=FetchLimits(max_addresses=limits.max_addresses),
        resolver=network.resolver,
        subject="Website",
    )
    try:
        connection = network.connector(hostname, addresses[0], min(_remaining(deadline), 60.0))
    except TimeoutError as exc:
        raise _reject(
            "discovery_timeout", "Website discovery deadline exceeded", status=504
        ) from exc
    except OSError as exc:
        raise _reject(
            "discovery_failed", f"Cannot connect to the website: {type(exc).__name__}"
        ) from exc
    try:
        connection.request("GET", target, headers=REQUEST_HEADERS)
        response = connection.getresponse()
        if response.status in REDIRECT_STATUSES:
            return _Response(response.status, location=response.getheader("Location"))
        if response.status != 200:
            return _Response(response.status)
        content_type, parameters = _media_type(response.getheader("Content-Type"))
        if content_type not in HTML_MEDIA_TYPES:
            raise _reject(
                "discovery_not_html",
                "The website did not answer with an HTML page "
                f"(Content-Type {_printable(content_type, 128) or 'absent'!r})",
                status=502,
                details={"content_type": _printable(content_type, 128) or None},
            )
        coding = _content_coding(response.getheader("Content-Encoding"))
        body, truncated = _read_bounded(
            connection, response, coding, deadline, limits.max_html_bytes
        )
        charset = parameters.get("charset")
        return _Response(
            200,
            content_type=content_type,
            charset=_printable(charset, 64) if charset else None,
            content_coding=coding,
            body=body,
            truncated=truncated,
        )
    except ControlPlaneError:
        raise
    except TimeoutError as exc:
        raise _reject(
            "discovery_timeout", "Website discovery deadline exceeded", status=504
        ) from exc
    except (OSError, http.client.HTTPException, ValueError, zlib.error) as exc:
        raise _reject(
            "discovery_failed", f"Reading the website failed: {type(exc).__name__}"
        ) from exc
    finally:
        connection.close()


def _redirect_target(current: str, location: str | None) -> str:
    """Where a redirect points, if this profile follows it; refuses otherwise."""
    if not location:
        raise _reject(
            "discovery_redirect_refused",
            "The website answered with a redirect that names no location",
            details={"reason": "missing_location"},
        )
    location = location.strip(_ASCII_WHITESPACE)
    problem = _unsafe_url_text(location)
    if problem:
        raise _reject(
            "discovery_redirect_refused",
            f"The website redirected to a location this browser does not follow: {problem}",
            details={"reason": "invalid_location"},
        )
    try:
        target = urljoin(current, location).partition("#")[0]
    except ValueError as exc:
        raise _reject(
            "discovery_redirect_refused",
            "The website redirected to a malformed location",
            details={"reason": "invalid_location"},
        ) from exc
    origin = _origin(target)
    if origin != _origin(current):
        raise _reject(
            "discovery_redirect_refused",
            "The website redirected to "
            + (origin_text(origin) if origin else "a non-web location")
            + f", a different origin from {origin_text(_origin(current))}. Discovery follows "
            "redirects only within one origin; open that address yourself to inspect it.",
            details={
                "reason": "cross_origin",
                "location": _canonical(target) if origin else None,
            },
        )
    return _canonical(target)


def fetch_page(url: str, *, limits: DiscoveryLimits, network: DiscoveryNetwork) -> FetchedPage:
    """GET the page, following same-origin redirects, each hop validated again."""
    requested = url
    current = _document_url(url)
    deadline = time.monotonic() + limits.timeout_seconds
    redirects: list[dict] = []
    while True:
        response = _request(network, current, deadline, limits)
        if response.status in REDIRECT_STATUSES:
            if len(redirects) >= limits.max_redirects:
                raise _reject(
                    "discovery_redirect_refused",
                    f"The website redirected more than {limits.max_redirects} times",
                    details={"reason": "too_many_redirects"},
                )
            target = _redirect_target(current, response.location)
            redirects.append({"status": response.status, "from_url": current, "to_url": target})
            current = target
            continue
        if response.status != 200:
            raise _reject(
                "discovery_http_status",
                f"The website answered HTTP {response.status} instead of a page",
                details={"status": response.status},
            )
        return FetchedPage(
            requested_url=requested,
            final_url=current,
            redirects=redirects,
            content_type=response.content_type,
            charset=response.charset,
            content_coding=response.content_coding,
            body=response.body,
            truncated=response.truncated,
        )


# -- character encoding -------------------------------------------------------
def _label(value: str | None) -> str | None:
    if not value:
        return None
    # A label is page or header text: it is matched, and echoed, only as escaped ASCII.
    label = _ascii_lower(value.strip(_ASCII_WHITESPACE).strip("\"'"))
    return _printable(label, 64) or None


def _charset_from_content(content: str) -> str | None:
    """The WHATWG algorithm for a charset in `<meta http-equiv content=...>`."""
    lowered = _ascii_lower(content)
    position = 0
    while True:
        found = lowered.find("charset", position)
        if found < 0:
            return None
        position = found + len("charset")
        while position < len(content) and content[position] in _ASCII_WHITESPACE:
            position += 1
        if position >= len(content) or content[position] != "=":
            continue
        position += 1
        while position < len(content) and content[position] in _ASCII_WHITESPACE:
            position += 1
        if position >= len(content):
            return None
        quote = content[position]
        if quote in "\"'":
            end = content.find(quote, position + 1)
            return content[position + 1 : end] if end > position else None
        end = position
        while end < len(content) and content[end] not in _ASCII_WHITESPACE + ";":
            end += 1
        return content[position:end] or None


class _MetaCharset(HTMLParser):
    """The prescan: a `<meta>` charset declaration within the first 1024 bytes."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.label: str | None = None

    def handle_starttag(self, tag, attrs):
        if tag != "meta" or self.label is not None:
            return
        first = _first_attributes(attrs)
        if first.get("charset"):
            self.label = first["charset"]
        elif _ascii_lower(first.get("http-equiv", "").strip(_ASCII_WHITESPACE)) == "content-type":
            self.label = _charset_from_content(first.get("content", ""))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


def choose_decoding(body: bytes, http_charset: str | None) -> tuple[str, str, str | None]:
    """(codec, source, declared label), after the HTML encoding-sniffing order.

    A byte-order mark wins, then the HTTP charset, then a `<meta>` declaration in
    the first 1024 bytes. Markup, attribute names and every URL this profile can
    accept are ASCII, and identical in every ASCII-compatible encoding, so all of
    those are read as UTF-8 with replacement characters. UTF-16 is decoded as
    UTF-16; the stateful and "replacement" encodings are refused.
    """
    # The BOM-aware codecs consume the mark, so it never reaches the tokenizer.
    if body.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig", "bom", None
    if body.startswith((b"\xfe\xff", b"\xff\xfe")):
        return "utf-16", "bom", None
    source, label = "http", _label(http_charset)
    if label is None:
        prescan = _MetaCharset()
        try:
            prescan.feed(body[:1024].decode("latin-1"))
        except Exception:  # A tokenizer failure here only means no declaration.
            prescan.label = None
        source, label = "meta", _label(prescan.label)
    if label is None:
        return "utf-8", "default", None
    if label in _REFUSED_LABELS:
        raise _reject(
            "discovery_encoding_unsupported",
            f"The page declares the {label!r} character encoding, which discovery does not read",
        )
    # Per the HTML standard a <meta> cannot switch a page to UTF-16.
    if label in _UTF16BE_LABELS and source == "http":
        return "utf-16-be", source, label
    if label in _UTF16LE_LABELS and source == "http":
        return "utf-16-le", source, label
    return "utf-8", source, label


# -- the document head --------------------------------------------------------
class _BodyStarted(Exception):
    """Raised from a handler: the head has ended and reading stops."""


def _first_attributes(attrs) -> dict[str, str]:
    """HTML keeps the first of duplicated attributes; the tokenizer reports all."""
    first: dict[str, str] = {}
    for name, value in attrs:
        first.setdefault(name, "" if value is None else value)
    return first


def rel_tokens(value: str) -> set[str]:
    """A rel attribute is a set of ASCII-whitespace-separated, ASCII case-insensitive tokens."""
    for character in "\t\n\f\r":
        value = value.replace(character, " ")
    return {_ascii_lower(token) for token in value.split(" ") if token}


class _HeadLinks(HTMLParser):
    """`rel="agent-package"` links in the document head, in document order.

    The tokenizer yields tags; these rules decide which of them the HTML tree
    builder would put in the head. The head ends at the first start tag that
    cannot be in it, the first non-whitespace text, or `</body>`, `</html>` or
    `</br>`; a link after `</head>` but before any of those is still placed in
    the head. Template contents are inert, text-only elements hold no tags (also
    inside a template), and `<plaintext>` never ends; all are tracked here, so
    the answer does not depend on how a given Python version tokenizes them.
    Comments and declarations change nothing, and HTML ignores a self-closing
    slash, so `<script/>` still opens a script.
    """

    def __init__(self, max_links: int):
        super().__init__(convert_charrefs=True)
        self.max_links = max_links
        self.links: list[dict[str, str | None]] = []
        self.overflow = 0
        self.base_href = False
        self.head_ended = False
        self._after_head = False
        self._text_only: str | None = None
        self._template_depth = 0

    def _end_head(self):
        self.head_ended = True
        raise _BodyStarted

    def handle_starttag(self, tag, attrs):
        if self._text_only is not None:
            return
        if self._template_depth:
            if tag == "template":
                self._template_depth += 1
            elif tag in _TEXT_ONLY_ELEMENTS:
                self._text_only = tag
            return
        if tag not in _HEAD_START_TAGS or (tag == "noscript" and self._after_head):
            self._end_head()
        if tag == "template":
            self._template_depth = 1
        elif tag in _TEXT_ONLY_ELEMENTS:
            self._text_only = tag
        elif tag == "link":
            self._link(_first_attributes(attrs))
        elif tag == "base" and "href" in _first_attributes(attrs):
            self.base_href = True

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self._text_only is not None:
            if tag == self._text_only and tag != "plaintext":
                self._text_only = None
            return
        if self._template_depth:
            if tag == "template":
                self._template_depth -= 1
            return
        if tag == "head":
            self._after_head = True
        elif tag in _BODY_END_TAGS:
            self._end_head()

    def handle_data(self, data):
        if self._text_only is None and not self._template_depth:
            if data.strip(_ASCII_WHITESPACE):
                self._end_head()

    def _link(self, attributes: dict[str, str]):
        if DISCOVERY_REL not in rel_tokens(attributes.get("rel", "")):
            return
        if len(self.links) >= self.max_links:
            self.overflow += 1
            return
        self.links.append({"href": attributes.get("href"), "type": attributes.get("type")})


@dataclass
class HeadScan:
    links: list[dict]
    overflow: int
    head_ended: bool
    base_href: bool
    codec: str
    encoding_source: str
    declared_charset: str | None


def scan_head(body: bytes, *, http_charset: str | None, complete: bool, max_links: int):
    """Decode the page and collect the agent-package links of its head.

    `complete` is false when only a prefix of the page was read. Then only an
    incremental decode is done and the tokenizer is never closed, so a tag or a
    character cut off by the limit is withheld rather than misread, and the scan
    is trusted only if the head ended inside the prefix.
    """
    codec, source, declared = choose_decoding(body, http_charset)
    text = codecs.getincrementaldecoder(codec)(errors="replace").decode(body, final=complete)
    parser = _HeadLinks(max_links)
    try:
        parser.feed(text)
        if complete:
            parser.close()
    except _BodyStarted:
        pass
    except Exception as exc:  # A tokenizer failure on hostile input is a refusal.
        raise _reject(
            "discovery_failed", f"The page could not be tokenized: {type(exc).__name__}"
        ) from exc
    return HeadScan(
        links=parser.links,
        overflow=parser.overflow,
        head_ended=parser.head_ended,
        base_href=parser.base_href,
        codec="utf-8" if codec == "utf-8-sig" else codec,
        encoding_source=source,
        declared_charset=declared,
    )


# -- candidates ---------------------------------------------------------------
REJECTION_REASONS = (
    "href_missing",
    "href_empty",
    "href_malformed",
    "fragment_only",
    "unsupported_scheme",
    "credentials_not_allowed",
    "cross_origin",
    "fragment_not_allowed",
    "points_to_page",
    "url_rejected",
    "unsupported_type",
    "duplicate",
)


def _rejected(candidate: dict, reason: str, message: str) -> dict:
    return {
        **candidate,
        "accepted": False,
        "rejection_reason": reason,
        "rejection_message": message,
    }


def classify_candidate(index: int, link: dict, *, page_url: str) -> dict:
    """One advertised link, judged against the page it came from. Fetches nothing."""
    page_origin = _origin(page_url)
    raw_href, raw_type = link.get("href"), link.get("type")
    # Both attributes are values potentially surrounded by ASCII whitespace.
    href = raw_href.strip(_ASCII_WHITESPACE) if raw_href is not None else None
    type_hint = raw_type.strip(_ASCII_WHITESPACE) if raw_type else ""
    candidate = {
        "index": index,
        "href": None if href is None else _printable(href, MAX_URL_CHARS),
        "type_hint": _printable(type_hint, 128) if type_hint else None,
        "resolved_url": None,
        "same_origin": None,
        "accepted": True,
        "rejection_reason": None,
        "rejection_message": None,
    }
    if href is None:
        return _rejected(candidate, "href_missing", "The link has no href attribute.")
    if not href:
        return _rejected(
            candidate, "href_empty", "The href is empty, which points at the page itself."
        )
    problem = _unsafe_url_text(href)
    if problem:
        return _rejected(candidate, "href_malformed", f"The href is not accepted: {problem}.")
    if href.startswith("#"):
        return _rejected(
            candidate,
            "fragment_only",
            "The href is only a fragment, which points at the page itself.",
        )
    try:
        resolved = urljoin(page_url, href)
        parts = urlsplit(resolved)
        _ = parts.port  # Raises on a port that is not a number in range.
    except ValueError:
        return _rejected(candidate, "href_malformed", "The href is not a well-formed URL.")
    candidate["resolved_url"] = _printable(resolved, MAX_URL_CHARS)
    if parts.scheme not in ("http", "https"):
        return _rejected(
            candidate,
            "unsupported_scheme",
            f"Only https:// candidates are accepted; this link uses {parts.scheme or 'no'!r}.",
        )
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return _rejected(
            candidate, "credentials_not_allowed", "The URL embeds credentials, which are refused."
        )
    origin = _origin(resolved)
    candidate["same_origin"] = origin == page_origin
    if origin != page_origin:
        differs = [
            name
            for name, here, there in zip(
                ("scheme", "host", "port"), page_origin, origin or ("", "", 0), strict=True
            )
            if here != there
        ]
        return _rejected(
            candidate,
            "cross_origin",
            f"The package is advertised at {origin_text(origin) if origin else 'another origin'}, "
            f"not at this page's origin {origin_text(page_origin)} (different "
            f"{' and '.join(differs)}). This discovery profile accepts only packages served "
            "by the page's own origin.",
        )
    if parts.fragment or "#" in resolved:
        return _rejected(
            candidate, "fragment_not_allowed", "Package URLs must not contain a fragment."
        )
    canonical = _canonical(resolved)
    candidate["resolved_url"] = canonical
    if canonical == _canonical(page_url):
        return _rejected(
            candidate, "points_to_page", "The href resolves to this page itself, not a package."
        )
    try:
        validate_package_url(canonical)
    except ControlPlaneError as exc:
        return _rejected(candidate, "url_rejected", str(exc))
    if type_hint and _media_type(type_hint)[0] != PACKAGE_MEDIA_TYPE:
        return _rejected(
            candidate,
            "unsupported_type",
            f"The link declares type {_printable(type_hint, 128)!r}, not {PACKAGE_MEDIA_TYPE}.",
        )
    return candidate


def _status(accepted: int, total: int) -> str:
    if total == 0:
        return "no_candidate"
    if accepted == 0:
        return "candidates_rejected"
    return "candidate" if accepted == 1 else "multiple_candidates"


def profile(limits: DiscoveryLimits | None = None) -> dict:
    limits = limits or DiscoveryLimits()
    return {
        "name": PROFILE,
        "rel": DISCOVERY_REL,
        "media_type": PACKAGE_MEDIA_TYPE,
        "convention": "experimental WebAgents metadata; not a registered link relation or a "
        "web standard",
        "scope": "document head",
        "same_origin_required": True,
        "redirects": "same origin only",
        "max_redirects": limits.max_redirects,
        "max_html_bytes": limits.max_html_bytes,
        "max_links": limits.max_links,
        "timeout_seconds": limits.timeout_seconds,
    }


def discover(url, *, limits: DiscoveryLimits, network: DiscoveryNetwork) -> dict:
    """Fetch one page, scan its head, judge every advertised link. Open nothing."""
    page = fetch_page(url, limits=limits, network=network)
    scan = scan_head(
        page.body,
        http_charset=page.charset,
        complete=not page.truncated,
        max_links=limits.max_links,
    )
    if page.truncated and not scan.head_ended:
        raise _reject(
            "discovery_too_large",
            f"The page's head did not end within the first {limits.max_html_bytes} bytes; "
            "discovery reads no further",
            status=413,
        )
    candidates = [
        classify_candidate(index, link, page_url=page.final_url)
        for index, link in enumerate(scan.links)
    ]
    seen: set[str] = set()
    for position, candidate in enumerate(candidates):
        if not candidate["accepted"]:
            continue
        if candidate["resolved_url"] in seen:
            candidates[position] = _rejected(
                candidate, "duplicate", "The same package URL is advertised earlier on this page."
            )
        seen.add(candidate["resolved_url"])
    accepted = sum(1 for candidate in candidates if candidate["accepted"])
    return {
        "schema": SCHEMA,
        "requested_url": page.requested_url,
        "final_url": page.final_url,
        "page_origin": origin_text(_origin(page.final_url)),
        "redirects": page.redirects,
        "discovery_status": _status(accepted, len(candidates)),
        "candidates": candidates,
        "accepted_count": accepted,
        "rejected_count": len(candidates) - accepted,
        "links_not_listed": scan.overflow,
        "page": {
            "content_type": page.content_type,
            "declared_charset": scan.declared_charset,
            "decoded_as": scan.codec,
            "encoding_source": scan.encoding_source,
            "content_coding": page.content_coding,
            "bytes_read": len(page.body),
            "truncated": page.truncated,
            "head_ended": scan.head_ended,
            "html_sha256": hashlib.sha256(page.body).hexdigest(),
            "base_element_ignored": scan.base_href,
        },
        "profile": profile(limits),
        "trust": {
            "conveys": "location_only",
            "package_verified": False,
            "publisher_trusted": False,
            "permissions_granted": False,
            "note": "A website's advertisement is an untrusted candidate. Identity, integrity, "
            "signature, publisher trust and permissions are established only by inspecting "
            "the package, through the same path as any package URL.",
        },
        "execution": {
            "performed": False,
            "package_fetched": False,
            "note": "Discovery read one HTML page. It fetched no package, created no session "
            "and ran nothing.",
        },
        "discovered_at": datetime.now(UTC).isoformat(),
    }


def _discovery_child(url: str, limits: tuple, sender) -> None:
    """Runs in a killable child: resolve, connect, read and scan one page."""
    try:
        message = {
            "ok": True,
            "result": discover(url, limits=DiscoveryLimits(*limits), network=DiscoveryNetwork()),
        }
    except ControlPlaneError as exc:
        message = {
            "ok": False,
            "code": exc.code,
            "message": str(exc),
            "status": exc.status,
            "details": exc.details,
        }
    except BaseException as exc:  # Never transport page content or tracebacks.
        message = {
            "ok": False,
            "code": "discovery_failed",
            "message": f"Website discovery failed: {type(exc).__name__}",
            "status": 502,
        }
    data = json.dumps(message).encode()
    if len(data) > MAX_RESULT_BYTES:
        data = json.dumps(
            {"ok": False, "code": "discovery_failed", "message": "Discovery result too large"}
        ).encode()
    try:
        sender.send_bytes(data)
    finally:
        sender.close()


def discover_website(
    url, *, limits: DiscoveryLimits | None = None, network: DiscoveryNetwork | None = None
) -> dict:
    """The control plane's entry point.

    With no `network` seam, everything after the syntax check runs in a killable
    child. A URL refused by syntax never starts one.
    """
    limits = limits or DiscoveryLimits()
    _document_url(url)
    if network is not None:
        return discover(url, limits=limits, network=network)
    message = run_in_killable_child(
        _discovery_child,
        (url, astuple(limits)),
        timeout_seconds=limits.timeout_seconds,
        operation=DISCOVERY,
        max_message_bytes=MAX_RESULT_BYTES,
    )
    result = message.get("result")
    if not isinstance(result, dict) or result.get("schema") != SCHEMA:
        raise _reject("discovery_failed", "Invalid discovery child response")
    return result
