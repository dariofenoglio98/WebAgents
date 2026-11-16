"""The join (link.v0 §6): a declared slot bound during the run to a package the runtime found,
verified and put before the person.

What is here is host-neutral and decides nothing: where a slot may look (`locate_urls`), how it
looks (`find_candidate`, over the host's discovery and package fetch, each under its policy
unchanged), what refuses a candidate before any card (`refusal_before_card`), and the facts of
the card (`card_facts`). The mediator (`Runtime.call_join`) orders them, holds the reservation,
asks the person and records every step. A host supplies a `JoinHost`: its discovery and fetch,
its own trust evaluation, and what an accepted package's inner run is handed.

Nothing here is package-specific: the slot, its view and its ceiling come from the caller's
signed declaration, the candidate's facts from its own verified bytes.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import io
from collections.abc import Callable
from dataclasses import dataclass, field

from ..errors import AgentPkgError, ValidationError
from ..package import Package
from ..workflow_values import select
from .analysis import WORST_CASE_FIGURES, package_worst_case
from .declarations import MAX_LOCATE_REFERENCES, MAX_REASON_CHARS
from .resolve import (
    LinkRefusal,
    ResolvedLink,
    check_model,
    check_profile,
    verify_linked,
)

#: A run shows at most this many join cards in all (L-39).
MAX_RUN_CARDS = 2
#: Why a slot step did not join (L-33, L-35, L-38): data to the caller's program.
REASONS = (
    "unattended",
    "policy",
    "join_cap",
    "not_found",
    "verification",
    "conversational",
    "nested",
    "publisher_denied",
    "model_incompatible",
    "over_ceiling",
    "budget",
    "declined",
    "failed",
)
JOIN_FIXTURE_SCHEMA = "agentpkg-join-fixture-v0"


@dataclass
class JoinHost:
    """What a host gives a run so that its slots can look and join. `look(url)` is website
    discovery of one page (`browser.discovery.discover_website`'s result); `fetch(url)` returns
    a candidate's bytes under the package-URL policy; both raise an `AgentPkgError` that
    carries a `code`. `trust(signer, package)` is the person's own evaluation of a publisher
    key; `adapters(package)` returns `(router or None, handlers)` for an accepted package's
    inner run, as `links.operator.operator_links` takes it. `policy` is `forbid` where the
    host's signed policy forbids joins."""

    look: Callable[[str], dict]
    fetch: Callable[[str], bytes]
    trust: Callable[[str, Package], str]
    adapters: Callable[[Package], tuple] | None = None
    policy: str = "allow"


@dataclass
class Found:
    """What a slot found by looking: every fetch it made, in order, and the candidate's bytes
    when a page advertised a package that could be fetched."""

    fetches: list = field(default_factory=list)
    page_url: str | None = None
    package_url: str | None = None
    data: bytes | None = None
    #: `not_found` (no page advertised a package) or `verification` (its fetch failed).
    reason: str | None = None


def locate_urls(locate, environment) -> list[str]:
    """The URLs a slot looks at, in order (L-7): each reference of `locate` read from the run's
    input or an earlier tool step's result; a reference that selects nothing, or null, yields
    no URL; a `coalesce` yields its first member that yields any. At most three."""

    def read(expression) -> list[str]:
        if "from" in expression:
            try:
                value = select(environment[expression["from"]], expression["path"])
            except (KeyError, ValidationError):
                return []
            return [value] if isinstance(value, str) and value else []
        if "coalesce" in expression:
            for member in expression["coalesce"]:
                found = read(member)
                if found:
                    return found
            return []
        return [url for member in expression["array"] for url in read(member)]

    urls = []
    for url in read(locate):
        if url not in urls:
            urls.append(url)
    return urls[:MAX_LOCATE_REFERENCES]


def _code(exc: BaseException) -> str:
    return getattr(exc, "code", None) or "failed"


async def find_candidate(host: JoinHost, urls) -> Found:
    """L-31, L-32: each URL looked at in order by discovery; the first page that advertises a
    package gives the one candidate, whose bytes are fetched; a page that advertises none, or
    cannot be read, moves to the next URL. Every fetch is listed, read or refused."""
    found = Found()
    for url in urls:
        try:
            page = await asyncio.to_thread(host.look, url)
        except AgentPkgError as exc:
            found.fetches.append({"url": url, "kind": "discovery", "status": _code(exc)})
            continue
        accepted = [c for c in page.get("candidates", []) if c.get("accepted")]
        found.fetches.append(
            {"url": url, "kind": "discovery", "status": "ok" if accepted else "no_candidate"}
        )
        if not accepted:
            continue
        found.page_url, found.package_url = url, accepted[0]["resolved_url"]
        try:
            found.data = await asyncio.to_thread(host.fetch, found.package_url)
        except AgentPkgError as exc:
            status, found.reason = _code(exc), "verification"
        else:
            status = "ok"
        found.fetches.append({"url": found.package_url, "kind": "package", "status": status})
        return found
    found.reason = "not_found"
    return found


def ceiling(step) -> dict:
    """A slot's ceiling in the six figures of a worst case (L-6): a figure left out is zero,
    `tool_calls` is a total, and the step's time is its seconds."""
    declared = step["budget"]
    return {
        "model_calls": declared.get("model_calls", 0),
        "tool_calls": declared.get("tool_calls", 0),
        "compute_calls": declared.get("compute_calls", 0),
        "remote_calls": declared.get("remote_calls", 0),
        "tokens": declared.get("tokens", 0),
        "seconds": step["timeout_seconds"],
    }


def over_ceiling(worst_case: dict, step) -> str | None:
    """The first figure of a candidate's own worst case that passes the slot's ceiling."""
    limit = ceiling(step)
    for figure in WORST_CASE_FIGURES:
        value = worst_case[figure]
        if figure == "tool_calls":
            value = sum(value.values())
        if value > limit[figure]:
            return figure
    return None


def verify_candidate(found: Found, slot: str, host: JoinHost) -> ResolvedLink:
    """L-10 for a candidate: its bytes verified as any package's, with a valid signature, and
    described as a resolved link is. Raises the `LinkRefusal` of `links.resolve`.

    The profile is read before the worst case: W(p) is defined for a one-shot workflow.v0
    package one level deep (L-18), and only such a declaration is analysed. A candidate the
    profile refuses has no worst case (`worst_case` None); `refusal_before_card` names why."""
    label = f"slot {slot!r}"
    package, archive_sha256, signer = verify_linked(found.data, label)
    manifest = package.manifest
    try:
        check_profile(package, label)
    except LinkRefusal:
        worst_case = None
    else:
        worst_case = package_worst_case(package.graph, package.policy)
    return ResolvedLink(
        dependency=slot,
        record={
            "id": slot,
            "package_id": manifest["package_id"],
            "version": manifest["version"],
            "digest": package.digest,
            "locator": found.package_url,
        },
        package=package,
        archive_sha256=archive_sha256,
        signer=signer,
        trust=host.trust(signer, package),
        worst_case=worst_case,
    )


def refusal_before_card(link: ResolvedLink, step, *, caller: Package, denied_keys, router):
    """L-33: why a verified candidate is refused without a card, as `(reason, detail)`, or
    None. In this order: the profile (a conversation; depth one; the caller itself), a key the
    person denied in this run, the model route, the slot's ceiling."""
    label = f"slot {step['slot']!r}"
    if link.package.manifest["package_id"] == caller.manifest["package_id"]:
        return "nested", None
    try:
        check_profile(link.package, label)
    except LinkRefusal as exc:
        return ("conversational" if exc.code == "link_target_conversational" else "nested"), None
    if link.signer in denied_keys:
        return "publisher_denied", None
    try:
        check_model(link, router)
    except LinkRefusal:
        return "model_incompatible", None
    figure = over_ceiling(link.worst_case, step)
    if figure is not None:
        return "over_ceiling", figure
    return None


def candidate_facts(link: ResolvedLink) -> dict:
    return {
        "package_id": link.package.manifest["package_id"],
        "version": link.package.manifest["version"],
        "digest": link.package.digest,
        "signer": link.signer,
    }


def card_facts(link: ResolvedLink, step, found: Found, *, reason, left: dict, cards: dict) -> dict:
    """L-34: the join card, every member computed by the runtime from verified bytes and the
    caller's signed declaration. Two members carry words: `package.name` and
    `package.description` are the publisher's, `reason` is the agent's."""
    package = link.package
    manifest, policy = package.manifest, package.policy
    return {
        "slot": step["slot"],
        "publisher": {"signer": link.signer, "trust": link.trust},
        "package": {
            "package_id": manifest["package_id"],
            "version": manifest["version"],
            "digest": package.digest,
            "archive_sha256": link.archive_sha256,
            "name": manifest["name"],
            "description": manifest["description"],
        },
        "source": {"page_url": found.page_url, "package_url": found.package_url},
        "requirements": {
            "permissions": [
                {
                    key: permission[key]
                    for key in ("id", "kind", "description", "required", "resources")
                }
                for permission in policy["permissions"]
            ],
            "tools": [
                {
                    "id": tool_id,
                    "execution": tool["execution"],
                    "endpoint": tool.get("endpoint"),
                    "method": tool.get("method"),
                    "domains": list(tool.get("domains", [])),
                    "permissions": list(tool["permissions"]),
                    "side_effects": tool["side_effects"],
                }
                for tool_id, tool in sorted(package.tools.items())
            ],
            "allowed_domains": list(policy["network"]["allowed_domains"]),
            "model": {
                "tasks": [
                    {key: task[key] for key in ("id", "capabilities", "context_window")}
                    for task in manifest["model_requirements"]["tasks"]
                ],
                "privacy": manifest["model_requirements"].get("privacy"),
            },
        },
        # What the request to this package may draw from: the fields of the slot's `input`,
        # which validation requires to be an `object` constructor (`link_slot_input`), so
        # that these names are the whole of it.
        "view": sorted(step["input"]["object"]),
        "worst_case": {
            figure: copy.deepcopy(link.worst_case[figure]) for figure in WORST_CASE_FIGURES
        },
        "ceiling": ceiling(step),
        # The "at most" the person accepted before the run holds this join at its ceiling.
        "at_most_unchanged": True,
        "left": dict(left),
        "reason": reason,
        "cards": copy.deepcopy(cards),
    }


def slot_reason(value) -> str | None:
    """A slot's stated reason as the card shows it: a string of at most 500 characters, else
    nothing (the agent's words are never a failure of the step)."""
    if not isinstance(value, str) or not value.strip():
        return None
    return value[:MAX_REASON_CHARS]


# -- a recorded web: fixture mode's discovery and fetch (L-29) ---------------------------------


class _RecordedResponse:
    def __init__(self, status, headers, body):
        self.status = status
        self._headers = {name.lower(): value for name, value in headers.items()}
        self._body = io.BytesIO(body)

    def getheader(self, name, default=None):
        return self._headers.get(name.lower(), default)

    def read(self, amount=-1):
        return self._body.read(amount)


class _RecordedConnection:
    """One recorded page as a connection: the discovery code reads it as it reads a socket."""

    sock = None

    def __init__(self, pages, hostname):
        self._pages, self._hostname, self._response = pages, hostname, None

    def request(self, method, target, headers=None):
        page = self._pages.get(f"https://{self._hostname}{target}")
        if page is None:
            self._response = _RecordedResponse(404, {}, b"")
        else:
            self._response = _RecordedResponse(
                page.get("status", 200),
                {"Content-Type": page.get("content_type", "text/html; charset=utf-8")},
                page["body"],
            )

    def getresponse(self):
        return self._response

    def close(self):
        pass


class RecordedWeb:
    """Pages and package archives recorded by URL, replayed through the production discovery
    and package-URL code: the URL, redirect, content, size and same-origin rules run unchanged
    over the recorded bytes, and nothing touches the network. A URL that was not recorded
    answers 404 (a page) or fails (a package)."""

    #: A public address for every recorded host: the address policy still runs, on it.
    ADDRESS = "93.184.216.34"

    def __init__(self, pages: dict, packages: dict):
        self.pages = {url: dict(page) for url, page in pages.items()}
        self.packages = dict(packages)
        self.requests: list[dict] = []

    def _resolver(self, hostname, port, **kwargs):
        import socket

        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (self.ADDRESS, port))]

    def look(self, url: str) -> dict:
        from ..browser.discovery import DiscoveryLimits, DiscoveryNetwork, discover_website

        self.requests.append({"url": url, "kind": "discovery"})
        network = DiscoveryNetwork(
            resolver=self._resolver,
            connector=lambda hostname, address, timeout: _RecordedConnection(self.pages, hostname),
        )
        return discover_website(url, limits=DiscoveryLimits(), network=network)

    def fetch(self, url: str) -> bytes:
        from ..browser.errors import ControlPlaneError
        from ..browser.fetch import FetchLimits, validate_package_url

        self.requests.append({"url": url, "kind": "package"})
        validate_package_url(url)
        data = self.packages.get(url)
        if data is None:
            raise ControlPlaneError("download_failed", "The recorded web holds no such package")
        if len(data) > FetchLimits().max_bytes:
            raise ControlPlaneError("download_too_large", "Package exceeds the download limit")
        return data


class FixtureConsent:
    """A run's cards answered from a recorded list of decisions (`provenance: fixture`): a join
    by the slot that asks, in order; the raise by its one decision. A card the recording does
    not decide is declined: the absence of a yes is a no."""

    def __init__(self, joins: dict | None = None, raise_: dict | None = None):
        self.joins = {slot: list(decisions) for slot, decisions in (joins or {}).items()}
        self.raise_ = raise_
        self.asked: list = []

    async def ask(self, request) -> dict:
        await asyncio.sleep(0)
        self.asked.append(request)
        if request.kind == "budget.raise":
            return {"accepted": bool((self.raise_ or {}).get("accepted")), "provenance": "fixture"}
        queue = self.joins.get(request.facts["slot"], [])
        decision = queue.pop(0) if queue else {}
        if not decision.get("accepted"):
            return {"accepted": False, "provenance": "fixture"}
        return {
            "accepted": True,
            "provenance": "fixture",
            "grants": dict(decision.get("grants", {})),
            "approved_tools": list(decision.get("approved_tools", [])),
        }


def load_join_fixture(
    document: dict, directory
) -> tuple[RecordedWeb | None, FixtureConsent | None]:
    """A join fixture (`agentpkg run --join-fixture`): the recorded web (`pages` by URL with
    their `body` as text or `body_base64`; `packages` by URL as an archive path relative to the
    fixture) and the person's recorded decisions (`decisions.joins` by slot,
    `decisions.raise`). Either half may be absent. Without `pages` and `packages` no web is
    returned: a fixture run then looks at an empty recorded web and finds nothing, and only a
    live run looks at the real one (the host's choice; `agentpkg run` makes it by `--mode`).
    Without `decisions` nobody is there to ask."""
    from pathlib import Path

    from ..package import MAX_FILES, MAX_TOTAL_BYTES, read_regular_bytes

    if not isinstance(document, dict) or document.get("schema") != JOIN_FIXTURE_SCHEMA:
        raise AgentPkgError(f"a join fixture declares schema {JOIN_FIXTURE_SCHEMA!r}")
    unknown = sorted(set(document) - {"schema", "pages", "packages", "decisions"})
    if unknown:
        raise AgentPkgError(f"join fixture: unknown member {unknown[0]!r}")
    web = None
    if "pages" in document or "packages" in document:
        pages = {}
        for url, page in document.get("pages", {}).items():
            body = (
                base64.b64decode(page["body_base64"])
                if "body_base64" in page
                else page["body"].encode("utf-8")
            )
            pages[url] = {
                **{k: v for k, v in page.items() if k in ("status", "content_type")},
                "body": body,
            }
        packages = {
            url: read_regular_bytes(Path(directory) / path, MAX_TOTAL_BYTES + MAX_FILES * 1024)
            for url, path in document.get("packages", {}).items()
        }
        web = RecordedWeb(pages, packages)
    consent = None
    if "decisions" in document:
        decisions = document["decisions"]
        consent = FixtureConsent(decisions.get("joins"), decisions.get("raise"))
    return web, consent


__all__ = [
    "JOIN_FIXTURE_SCHEMA",
    "MAX_RUN_CARDS",
    "REASONS",
    "FixtureConsent",
    "Found",
    "JoinHost",
    "RecordedWeb",
    "candidate_facts",
    "card_facts",
    "ceiling",
    "find_candidate",
    "load_join_fixture",
    "locate_urls",
    "over_ceiling",
    "refusal_before_card",
    "slot_reason",
    "verify_candidate",
]
