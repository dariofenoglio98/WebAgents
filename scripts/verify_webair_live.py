"""Live acceptance of the WebAir demo: the public origin, the real Agent Browser, real runs.

    agentpkg/.venv/bin/python scripts/verify_webair_live.py \\
        --ui <run-webair-live.mjs report> --observer <model-input-observer jsonl> \\
        --needles <the observer's needles file> [--bundle <the deployed bundle dir>] \\
        [--private-key PATH] [--report examples/verification/webair-030-live-demo.json]

It checks, now, over real HTTPS, that the public WebAir origin serves its human site and
advertises and serves exactly the signed `dist/webair-0.3.0.agent.pkg`; that its API answers
and refuses as designed and exposes nothing beyond its routes; and that the deployed bundle
holds no host data. It re-verifies the package (signature, reproducible build, earlier
versions unchanged) and the demo host's configuration (bindings to the public origin, host
resources by label). Then it reads what the live session left behind:

* the UI driver's report: what the real Agent Browser page showed at each step;
* each canonical run's own record (`~/.openclaw/agent-browser/runs/<id>/`): run record,
  hash-chained audit (re-verified here), structured result;
* the model-input observer's lines: per model call and per WebAir request, a body digest and
  how many values of each class of host data it held — never the values themselves.

and checks the demo's properties against them: the profile filled the search; the identity
reached only the booking calls and the payment identifier only the purchase call; no model
input held a name, an email, a payment method, a resource id or label, or card-like digits;
the purchase was simulated and charged $0; its once grant could not be used twice; a denied
purchase resolved nothing and called nothing.

The report holds no credential, no host-resource value and no path on the operator's machine.
`passed` is false if any check fails.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]

from agentpkg.browser.hosttools import tool_contract  # noqa: E402
from agentpkg.execution.report import verify_audit_chain  # noqa: E402
from agentpkg.netaddr import public_address_reason  # noqa: E402
from agentpkg.package import build_package, load_package, sha256  # noqa: E402
from agentpkg.signing import sign_package, verify_package  # noqa: E402

SITE = "https://webagents-webair-production.up.railway.app"
HOST = urlsplit(SITE).hostname
ARCHIVE = ROOT / "dist/webair-0.3.0.agent.pkg"
SOURCE = ROOT / "agents/webair"
KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
FINGERPRINT = "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b"
HOST_RESOURCES = ROOT / "demo/webair/host-resources.json"
HOST_BINDINGS = ROOT / "demo/webair/host-bindings.json"
BUNDLER = ROOT / "demo/webair/deploy/bundle.py"
RUNS = Path.home() / ".openclaw" / "agent-browser" / "runs"
V010 = "73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c"
V020 = "3f135be80c2ac43b93f42acbcb648a3460b1ab39a831c251122331c99107a616"
EARLIER = {
    "dist/webair-0.1.0.agent.pkg": V010,
    "dist/webair-0.2.0.agent.pkg": V020,
    "dist/webair.agent.pkg": "73872c3177a9ec281a8875ae154023a72ff10f9fe96c5a82ed1639a34ecb470c",
}
MEDIA_TYPE = "application/vnd.webagents.agent-package"
LINK = '<link rel="agent-package" type="application/vnd.webagents.agent-package" href="/agent.pkg">'
SEARCH = {
    "origin": "BOS",
    "destination": "ZRH",
    "date": "2026-10-09",
    "nonstop_only": True,
    "max_price_usd": 900,
}
HERO_FARES = {
    "WA101-20261009-BASIC": 704,
    "WA101-20261009-STANDARD": 858,
    "WA105-20261009-BASIC": 749,
}
# A made-up passenger for the origin's own API checks: not one of the demo host's identities.
PROBE_BOOKING = {
    "fare_id": "WA101-20261009-STANDARD",
    "passengers": [{"given_name": "Ada", "family_name": "Lovelace"}],
    "contact_email": "ada.lovelace@example.org",
}
# Classes of host data a model input may never hold; `profile_*` are checked where they apply.
PROHIBITED_IN_MODEL_INPUT = (
    "passenger_full_name",
    "passenger_email",
    "passenger_given_name_word",
    "passenger_family_name_word",
    "payment_method_id",
    "payment_display",
    "resource_id",
    "resource_label",
    "profile_fields",
)
IDENTITY = (
    "passenger_full_name",
    "passenger_email",
    "passenger_given_name_word",
    "passenger_family_name_word",
)
PAYMENT = ("payment_method_id", "payment_display")
CREDENTIAL_WORDS = re.compile(
    r"(?i)(api[_-]?key|secret|password|bearer\s|authorization:|private key"
    r"|\bsk-[a-z0-9]{8,}|ghp_[a-z0-9]{8,})"
)

CHECKS: list[dict] = []
# The observer's needle classes and values, read from the operator's private file; only class
# names and counts ever reach the report.
_NEEDLES: dict = {}


def check(identifier: str, passed: bool, detail=None) -> bool:
    CHECKS.append(
        {
            "id": identifier,
            "passed": bool(passed),
            **({"detail": detail} if detail is not None else {}),
        }
    )
    return bool(passed)


def scrub(text: str) -> str:
    """No path on the operator's machine leaves this script."""
    return re.sub(r"/(?:Users|home|private/tmp|tmp|var/folders)/[^\s\"']+", "<local path>", text)


# -- HTTP over the network, no redirects followed -------------------------------------------
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        return None


_OPENER = urllib.request.build_opener(
    _NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context())
)


def fetch(method: str, url: str, body: bytes | None = None, headers: dict | None = None):
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    request.add_header("User-Agent", "webair-live-verification/1")
    try:
        with _OPENER.open(request, timeout=40) as response:
            return (
                response.status,
                {k.lower(): v for k, v in response.headers.items()},
                response.read(),
            )
    except urllib.error.HTTPError as error:
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def post_json(path: str, payload, raw: bytes | None = None, media: str = "application/json"):
    data = raw if raw is not None else json.dumps(payload).encode()
    return fetch("POST", SITE + path, data, {"Content-Type": media})


class _Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_head = False
        self.links: list[dict] = []

    def handle_starttag(self, tag, attrs):
        if tag == "head":
            self.in_head = True
        elif tag == "body":
            self.in_head = False
        elif tag == "link" and self.in_head:
            self.links.append(dict(attrs))


def advertised(html: str) -> list[dict]:
    parser = _Links()
    parser.feed(html)
    return [link for link in parser.links if link.get("rel") == "agent-package"]


# -- the public origin ----------------------------------------------------------------------
def public_origin() -> dict:
    report: dict = {"site": SITE + "/"}
    seen_headers: list[dict] = []
    seen_bodies: list[bytes] = []

    addresses = sorted(
        {info[4][0] for info in socket.getaddrinfo(HOST, 443, proto=socket.IPPROTO_TCP)}
    )
    reasons = {address: public_address_reason(address) for address in addresses}
    report["dns"] = {"addresses": addresses, "rejections": {a: r for a, r in reasons.items() if r}}
    check("dns_public_addresses_only", addresses and not any(reasons.values()), report["dns"])

    context = ssl.create_default_context()
    with socket.create_connection((HOST, 443), timeout=20) as raw:
        with context.wrap_socket(raw, server_hostname=HOST) as tls:
            cert = tls.getpeercert()
            report["tls"] = {
                "version": tls.version(),
                "verified_for_hostname": True,
                "issuer": dict(item[0] for item in cert.get("issuer", ())).get("organizationName"),
                "not_after": cert.get("notAfter"),
                "port": 443,
            }
    check("tls_certificate_verified_on_443", True, report["tls"])

    pages = {}
    for path in (
        "/",
        "/flights",
        "/results?origin=BOS&destination=ZRH&date=2026-10-09&passengers=1&nonstop_only=on&max_price_usd=900",
        "/flight/WA101-20261009",
        "/fare/WA101-20261009-STANDARD",
    ):
        status, headers, body = fetch("GET", SITE + path)
        seen_headers.append(headers)
        seen_bodies.append(body)
        text = body.decode("utf-8", "replace")
        links = advertised(text)
        pages[path] = {
            "status": status,
            "content_type": headers.get("content-type"),
            "advertised_links": len(links),
            "csp": headers.get("content-security-policy"),
        }
        if path.startswith("/results"):
            pages[path]["hero_prices_shown"] = all(
                str(price) in text for price in HERO_FARES.values()
            )
        check(
            f"page_{path.split('?')[0]}_200_html",
            status == 200 and "text/html" in (headers.get("content-type") or ""),
        )
    report["human_pages"] = pages
    check(
        "results_page_shows_the_three_hero_fares",
        pages[next(p for p in pages if p.startswith("/results"))]["hero_prices_shown"],
    )

    status, headers, body = fetch("GET", SITE + "/")
    home = body.decode()
    links = advertised(home)
    resolved = urljoin(SITE + "/", links[0]["href"]) if len(links) == 1 else None
    report["discovery_link"] = {
        "raw": LINK if LINK in home else None,
        "count_in_head": len(links),
        "attributes": links[0] if links else None,
        "resolves_to": resolved,
        "same_origin": bool(resolved) and urlsplit(resolved)[:2] == urlsplit(SITE)[:2],
    }
    check("home_advertises_exactly_one_package_link", len(links) == 1 and LINK in home)
    check("advertised_link_is_same_origin_agent_pkg", resolved == SITE + "/agent.pkg")

    local = ARCHIVE.read_bytes()
    digest = sha256(local)
    status, headers, body = fetch("GET", SITE + "/agent.pkg")
    seen_headers.append(headers)
    head_status, head_headers, head_body = fetch("HEAD", SITE + "/agent.pkg")
    with tempfile.TemporaryDirectory() as directory:
        downloaded = Path(directory) / "downloaded.agent.pkg"
        downloaded.write_bytes(body)
        verification = verify_package(downloaded, KEY)
    report["agent_pkg"] = {
        "status": status,
        "content_type": headers.get("content-type"),
        "etag": headers.get("etag"),
        "x_agent_package_sha256": headers.get("x-agent-package-sha256"),
        "content_length": headers.get("content-length"),
        "cache_control": headers.get("cache-control"),
        "bytes": len(body),
        "sha256": sha256(body),
        "local_artifact": ARCHIVE.relative_to(ROOT).as_posix(),
        "local_sha256": digest,
        "byte_identical": body == local,
        "head": {
            "status": head_status,
            "etag": head_headers.get("etag"),
            "body_bytes": len(head_body),
        },
        "verify": {
            k: verification.get(k)
            for k in ("valid", "package_id", "version", "digest", "key_fingerprint")
        },
    }
    check("agent_pkg_bytes_equal_local_artifact", body == local)
    check("agent_pkg_media_type", headers.get("content-type") == MEDIA_TYPE)
    check(
        "agent_pkg_etag_and_digest_header",
        headers.get("etag") == f'"sha256:{digest}"'
        and headers.get("x-agent-package-sha256") == digest,
    )
    check(
        "agent_pkg_head_matches",
        head_status == 200 and head_body == b"" and head_headers.get("etag") == headers.get("etag"),
    )
    check(
        "agent_pkg_signature_valid_for_webair_key",
        verification.get("valid") is True and verification.get("key_fingerprint") == FINGERPRINT,
    )

    status, headers, body = fetch("GET", SITE + "/health")
    health = json.loads(body)
    report["health"] = {
        "status": status,
        "body": health,
        "cache_control": headers.get("cache-control"),
    }
    check(
        "health_states_only_public_facts",
        status == 200
        and set(health) == {"status", "service", "fictional", "agent_package_sha256"}
        and health["agent_package_sha256"] == digest,
    )

    # The API, as the host's bindings use it (a fictional passenger who is not a demo identity).
    api: dict = {}
    status, headers, body = post_json("/api/v1/search_flights", SEARCH)
    answer = json.loads(body)
    fares = {
        fare["fare_id"]: fare["price_usd"]
        for flight in answer["flights"]
        for fare in flight["fares"]
    }
    api["search_flights"] = {"status": status, "fares": fares, "query": answer.get("query")}
    check("api_search_returns_the_hero_fares", status == 200 and fares == HERO_FARES)
    status, _, body = post_json("/api/v1/get_fare_rules", {"fare_id": "WA101-20261009-STANDARD"})
    rules = json.loads(body)
    api["get_fare_rules"] = {
        "status": status,
        "fare_id": rules.get("fare_id"),
        "price_per_passenger_usd": rules.get("price_per_passenger_usd"),
    }
    check("api_fare_rules", status == 200 and rules.get("price_per_passenger_usd") == 858)
    status, _, body = post_json("/api/v1/prepare_booking", PROBE_BOOKING)
    quote = json.loads(body)
    status_again, _, body_again = post_json("/api/v1/prepare_booking", PROBE_BOOKING)
    api["prepare_booking"] = {
        "status": status,
        "quote_id_shape": bool(re.fullmatch(r"WAQ-[0-9A-F]{16}", quote.get("quote_id", ""))),
        "deterministic": json.loads(body_again).get("quote_id") == quote.get("quote_id"),
        "total_usd": quote.get("total_usd"),
    }
    purchase_body = {
        "booking": PROBE_BOOKING,
        "quote_id": quote.get("quote_id"),
        "payment_method_id": "demo-visa-4242",
    }
    status, _, body = post_json("/api/v1/simulate_purchase", purchase_body)
    confirmation = json.loads(body)
    api["simulate_purchase"] = {
        "status": status,
        "confirmation_id_shape": bool(
            re.fullmatch(r"WA-DEMO-[0-9A-Z]{5}", confirmation.get("confirmation_id", ""))
        ),
        "simulated": confirmation.get("simulated"),
        "real_transaction": confirmation.get("real_transaction"),
        "amount_charged_usd": confirmation.get("amount_charged_usd"),
    }
    check(
        "api_quote_is_deterministic",
        api["prepare_booking"]["quote_id_shape"] and api["prepare_booking"]["deterministic"],
    )
    check(
        "api_purchase_is_simulated_and_free",
        status == 200
        and confirmation.get("simulated") is True
        and confirmation.get("real_transaction") is False
        and confirmation.get("amount_charged_usd") == 0,
    )
    report["api"] = api

    # Refusals and exposure.
    probes: dict = {}

    def expect(name, response, status, code=None):
        got_status, got_headers, got_body = response
        seen_headers.append(got_headers)
        seen_bodies.append(got_body)
        got_code = None
        try:
            got_code = json.loads(got_body).get("error", {}).get("code")
        except Exception:  # noqa: BLE001
            pass
        probes[name] = {"status": got_status, "code": got_code}
        check(
            f"refuses_{name}",
            got_status == status and (code is None or got_code == code),
            probes[name],
        )

    expect(
        "malformed_json", post_json("/api/v1/search_flights", None, raw=b"{"), 400, "invalid_json"
    )
    expect(
        "unknown_field",
        post_json("/api/v1/search_flights", {**SEARCH, "admin": True}),
        422,
        "invalid_request",
    )
    expect(
        "oversized_body",
        post_json("/api/v1/search_flights", None, raw=b'{"x":"' + b"a" * (17 * 1024) + b'"}'),
        413,
        "request_too_large",
    )
    expect(
        "wrong_media_type",
        post_json(
            "/api/v1/search_flights", None, raw=json.dumps(SEARCH).encode(), media="text/plain"
        ),
        415,
        "unsupported_media_type",
    )
    expect(
        "card_number_in_purchase",
        post_json(
            "/api/v1/simulate_purchase", {**purchase_body, "card_number": "4111111111111111"}
        ),
        422,
        "invalid_request",
    )
    expect(
        "unknown_payment_method",
        post_json(
            "/api/v1/simulate_purchase", {**purchase_body, "payment_method_id": "real-card-0001"}
        ),
        422,
    )
    expect(
        "tampered_quote",
        post_json(
            "/api/v1/simulate_purchase", {**purchase_body, "quote_id": "WAQ-0000000000000000"}
        ),
        422,
        "quote_mismatch",
    )
    expect(
        "get_on_an_operation",
        fetch("GET", SITE + "/api/v1/search_flights"),
        405,
        "method_not_allowed",
    )
    for path in (
        "/docs",
        "/redoc",
        "/openapi.json",
        "/admin",
        "/debug",
        "/.env",
        "/.git/config",
        "/static/",
        "/host-resources.json",
        "/host-bindings.json",
        "/BUNDLE.json",
        "/railway.toml",
        "/railpack.json",
        "/requirements.txt",
        "/origin/app.py",
        "/agent.pkg/",
        "/health/",
        "/api/v1/",
    ):
        expect(f"path_{path}", fetch("GET", SITE + path), 404)
    status, headers, _ = fetch(
        "OPTIONS",
        SITE + "/api/v1/search_flights",
        headers={"Origin": "https://elsewhere.example", "Access-Control-Request-Method": "POST"},
    )
    probes["cors_preflight"] = {
        "status": status,
        "access_control_allow_origin": headers.get("access-control-allow-origin"),
    }
    check(
        "no_cors_preflight_grant",
        status >= 400 and "access-control-allow-origin" not in headers,
        probes["cors_preflight"],
    )
    status, headers, _ = fetch("GET", SITE + "/", headers={"Origin": "https://elsewhere.example"})
    check("no_cors_on_pages", "access-control-allow-origin" not in headers)
    try:
        plain_status, plain_headers, _ = fetch("GET", f"http://{HOST}/agent.pkg")
        location = plain_headers.get("location")
    except Exception as error:  # noqa: BLE001
        plain_status, location = None, f"error: {type(error).__name__}"
    probes["plain_http"] = {"status": plain_status, "location": location}
    check(
        "plain_http_only_redirects_to_the_same_https_origin",
        plain_status is None
        or plain_status < 300
        or plain_status >= 400
        or (location or "").startswith(f"https://{HOST}/"),
        probes["plain_http"],
    )
    report["probes"] = probes
    report["response_headers"] = {
        "set_cookie_seen": any("set-cookie" in h for h in seen_headers),
        "server_values": sorted({h.get("server") for h in seen_headers if h.get("server")}),
        "html_security_headers": {
            key: seen_headers[0].get(key)
            for key in (
                "content-security-policy",
                "x-frame-options",
                "x-content-type-options",
                "referrer-policy",
            )
        },
    }
    check("no_cookies", not report["response_headers"]["set_cookie_seen"])
    check(
        "html_security_headers",
        "base-uri 'none'" in (seen_headers[0].get("content-security-policy") or "")
        and seen_headers[0].get("x-frame-options") == "DENY"
        and seen_headers[0].get("x-content-type-options") == "nosniff",
    )
    leaked = [
        match.group(0)
        for blob in [*seen_bodies, *(json.dumps(h).encode() for h in seen_headers)]
        for match in CREDENTIAL_WORDS.finditer(blob.decode("utf-8", "replace"))
    ]
    report["credential_like_strings_in_responses"] = sorted(set(leaked))
    check("no_credentials_in_responses", not leaked, sorted(set(leaked)))
    return report


# -- the package and the deployment ---------------------------------------------------------
def package_facts(private_key: str | None) -> dict:
    package = load_package(ARCHIVE)
    data = ARCHIVE.read_bytes()
    verification = verify_package(ARCHIVE, KEY)
    with tempfile.TemporaryDirectory() as directory:
        # Resolved: agentpkg refuses to write under a symlinked parent (macOS /var).
        scratch = Path(directory).resolve()
        rebuilt_path = build_package(SOURCE, scratch / "rebuilt.agent.pkg")
        rebuilt = load_package(rebuilt_path)
        resigned = None
        if private_key:
            resigned = (
                sign_package(
                    rebuilt_path, Path(private_key), scratch / "resigned.agent.pkg"
                ).read_bytes()
                == data
            )
    text = "\n".join(blob.decode() for blob in package.files.values())
    facts = {
        "artifact": ARCHIVE.relative_to(ROOT).as_posix(),
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "bytes": len(data),
        "archive_sha256": sha256(data),
        "package_digest": package.digest,
        "signer_fingerprint": package.signature["key_fingerprint"],
        "publisher": package.manifest["publisher"],
        "payload_files": len(package.files),
        "graph_nodes": len(package.graph["nodes"]),
        "runtime": package.manifest["runtime"],
        "entrypoint": package.manifest["entrypoint"],
        "tools": [
            {
                "id": tool_id,
                "execution": tool["execution"],
                "binding": tool["binding"],
                "endpoint": tool.get("endpoint"),
                "permissions": tool["permissions"],
                "side_effects": tool["side_effects"],
            }
            for tool_id, tool in package.tools.items()
        ],
        "permissions": [
            {
                "id": p["id"],
                "kind": p["kind"],
                "required": p["required"],
                "resources": p["resources"],
            }
            for p in package.policy["permissions"]
        ],
        "network": package.policy["network"],
        "model_requirements": package.manifest["model_requirements"],
        "verify": {
            k: verification.get(k) for k in ("valid", "digest", "version", "key_fingerprint")
        },
        "source_rebuilds_to_payload": rebuilt.files == package.files
        and rebuilt.digest == package.digest,
        "resigned_byte_identical": resigned,
        "earlier_artifacts_unchanged": {
            path: sha256((ROOT / path).read_bytes()) == want for path, want in EARLIER.items()
        },
        "placeholder_host_absent": "webair.example" not in text,
        "declares_public_host": all(
            urlsplit(t["endpoint"]).hostname == HOST
            for t in package.tools.values()
            if t["execution"] == "remote"
        ),
    }
    check(
        "package_signature_valid",
        verification.get("valid") is True and facts["signer_fingerprint"] == FINGERPRINT,
    )
    check("package_is_0_3_0", facts["version"] == "0.3.0")
    check("package_source_rebuilds", facts["source_rebuilds_to_payload"])
    if private_key:
        check("package_resign_byte_identical", resigned is True)
    check("earlier_webair_artifacts_unchanged", all(facts["earlier_artifacts_unchanged"].values()))
    check(
        "package_declares_the_public_host_only",
        facts["placeholder_host_absent"]
        and facts["declares_public_host"]
        and package.policy["network"]["allowed_domains"] == [HOST],
    )
    return facts


def deployment_facts(bundle: Path | None) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory) / "bundle"
        result = subprocess.run(
            [sys.executable, str(BUNDLER), "--package", str(ARCHIVE), "--out", str(out)],
            capture_output=True,
            text=True,
            check=True,
        )
        manifest = json.loads(result.stdout)
        rebuilt = (out / "BUNDLE.json").read_bytes()
        deployed = (bundle / "BUNDLE.json").read_bytes() if bundle else None
        files = sorted(entry["path"] for entry in manifest["files"])
    facts = {
        "platform": "Railway",
        "service": "webagents-webair",
        "public_url": SITE + "/",
        "builder": "Railpack (Python 3.13 via .python-version; start command from railpack.json)",
        "config": [
            "demo/webair/deploy/railway.toml",
            "demo/webair/deploy/railpack.json",
            "demo/webair/deploy/.python-version",
        ],
        "bundle": {
            "assembled_by": "demo/webair/deploy/bundle.py",
            "bundle_json_sha256": hashlib.sha256(rebuilt).hexdigest(),
            "deployed_bundle_json_matches": None if deployed is None else deployed == rebuilt,
            "files": files,
            "agent_package": manifest["agent_package"],
        },
        "environment_variables": {"PORT": "8080 (platform port; not a secret)"},
        "secrets_required": [],
        "host_files_in_bundle": [
            name
            for name in files
            if Path(name).name in {"host-resources.json", "host-bindings.json"}
        ],
    }
    check("bundle_is_reproducible_and_was_deployed", deployed is None or deployed == rebuilt)
    check("bundle_holds_no_host_configuration", not facts["host_files_in_bundle"])
    check(
        "bundle_publishes_the_0_3_0_artifact",
        manifest["agent_package"]["sha256"] == sha256(ARCHIVE.read_bytes()),
    )
    return facts


def host_facts() -> dict:
    package = load_package(ARCHIVE)
    document = json.loads(HOST_BINDINGS.read_text())
    bindings = []
    for binding in document["bindings"]:
        contract = tool_contract(package, binding["tool_id"])
        permitted = (
            set(contract["domains"])
            & set(contract["network_resources"])
            & set(contract["allowed_domains"])
        )
        agrees = (
            binding["input_schema_sha256"] == contract["input_schema_sha256"]
            and binding["output_schema_sha256"] == contract["output_schema_sha256"]
            and sorted(binding["permission_kinds"]) == contract["permission_kinds"]
            and binding["side_effects"] == contract["side_effects"]
            and binding["endpoint"]["path"] == contract["endpoint_path"]
            and binding["endpoint"]["method"] == contract["method"]
            and urlsplit(binding["endpoint"]["origin"]).hostname in permitted
        )
        bindings.append(
            {
                "tool_id": binding["tool_id"],
                "binding": binding["binding"],
                "implementation_id": binding["implementation_id"],
                "endpoint": binding["endpoint"],
                "input_schema_sha256": binding["input_schema_sha256"],
                "output_schema_sha256": binding["output_schema_sha256"],
                "permission_kinds": binding["permission_kinds"],
                "side_effects": binding["side_effects"],
                "timeout_seconds": binding["timeout_seconds"],
                "max_request_bytes": binding.get("max_request_bytes"),
                "max_response_bytes": binding.get("max_response_bytes"),
                "max_concurrent": binding.get("max_concurrent"),
                "agrees_with_package_upper_bound": agrees,
            }
        )
        check(f"binding_{binding['tool_id']}_within_package_bounds", agrees)
    resources = json.loads(HOST_RESOURCES.read_text())
    generic = [ROOT / "agentpkg/src/agentpkg", ROOT / "openclaw-agent-browser/src"]
    words = re.compile(
        r"webair|airline|passenger_demo|payment_demo|profile_demo|alex\.traveler", re.IGNORECASE
    )
    offenders = [
        path.relative_to(ROOT).as_posix()
        for base in generic
        for path in base.rglob("*")
        if path.is_file()
        and path.suffix in {".py", ".json", ".ts", ".js", ".css"}
        and words.search(path.read_text(errors="replace"))
    ]
    check("no_webair_specific_generic_code", offenders == [], offenders)
    return {
        "tool_bindings": {
            "file": HOST_BINDINGS.relative_to(ROOT).as_posix(),
            "sha256": sha256(HOST_BINDINGS.read_bytes()),
            "schema": document["schema"],
            "configured_with": "plugins.entries.agent-browser.config.tools.bindingsFile",
            "address_policy": "the broker's fixed json_http policy for every binding: HTTPS on "
            "443 to the exact origin, path and method; every resolved address publicly routable; "
            "socket pinned to a validated address with TLS bound to the hostname; fixed headers; "
            "no redirects, proxy, cookies or ambient "
            "credential; bounded bytes and deadline. Not configurable per binding.",
            "authorization": "a call needs the package tool's permissions granted in the receipt, "
            "the person's "
            "approval of this exact binding, and a run plan that froze the binding's id and digest",
            "bindings": bindings,
        },
        "host_resources": {
            "file": HOST_RESOURCES.relative_to(ROOT).as_posix(),
            "configured_with": "plugins.entries.agent-browser.config.hostResources.file",
            "types": [
                {
                    "id": t["id"],
                    "permission_kind": t["permission_kind"],
                    "sealed_fields": t.get("sealed_fields", []),
                }
                for t in resources["types"]
            ],
            "resources_by_label": [
                {"id": r["id"], "type": r["type"], "label": r["label"]}
                for r in resources["resources"]
            ],
            "card_numbers_or_secrets": False,
        },
        "generic_code_offenders": offenders,
    }


# -- the live session -----------------------------------------------------------------------
def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def run_window(record: dict) -> tuple[datetime, datetime]:
    start = parse_time(record.get("startedAt") or record["createdAt"])
    end = parse_time(record.get("endedAt") or record.get("startedAt"))
    return start - timedelta(seconds=2), end + timedelta(seconds=2)


def classes(counts: dict) -> list[str]:
    return sorted(name for name, value in counts.items() if value)


def run_facts(phase: str, run_id: str, observed: list[dict]) -> dict:
    directory = RUNS / run_id
    record = json.loads((directory / "run.json").read_text())
    audit = json.loads((directory / "audit.json").read_text())
    result = json.loads((directory / "result.json").read_text())
    chain = verify_audit_chain(audit)
    start, end = run_window(record)
    window = [line for line in observed if start <= parse_time(line["at"]) <= end]
    models = [line for line in window if line.get("kind") != "tool_request"]
    tools = [line for line in window if line.get("kind") == "tool_request"]
    dispatched = [e for e in audit if e.get("action") == "tool.dispatched"]
    settled = [e for e in audit if e.get("action") == "tool.settled" and e.get("resource_id")]
    called_tasks = [e.get("task") for e in audit if e.get("action") == "model.called"]
    denied = sorted(
        {
            e["permission"]
            for e in audit
            if e.get("action") == "permission.checked" and e.get("allowed") is False
        }
    )
    output = result.get("output") or {}
    artifact_text = "\n".join(
        path.read_text(errors="replace") for path in sorted(directory.iterdir()) if path.is_file()
    )
    facts = {
        "run_id": run_id,
        "status": record["status"],
        "error_code": record.get("errorCode"),
        "failed_node": (record.get("failure") or {}).get("nodeId"),
        "package": record["package"],
        "model": {
            "planned": record["model"]["planned"],
            "invoked": record["model"]["invoked"],
            "calls": record["model"]["calls"],
            "all_calls_used_planned_model": record["model"]["allCallsUsedPlannedModel"],
            "local": record["selectedModel"].get("local"),
        },
        "usage": {
            "tokens": record["usage"]["tokens"],
            "remote_calls": record["usage"]["remoteCalls"],
            "tool_calls": record["usage"]["toolCalls"],
        },
        "cost_usd": record.get("cost", {}).get("totalUsd"),
        "duration_ms": record.get("durationMs"),
        "decisions": {d["permissionId"]: d["decision"] for d in record["grants"]["decisions"]},
        "resource_grants": [
            {
                "permission": g["permissionId"],
                "type": g["resourceType"],
                "resource_id": g["resourceId"],
                "digest_prefix": g["resourceDigest"][:12],
            }
            for g in record.get("resources", [])
        ],
        "revalidated_before_start": len(record.get("revalidated", [])),
        "audit": {
            "events": len(audit),
            "chain_valid": chain.get("valid"),
            "model_tasks": called_tasks,
            "tool_dispatches": [
                {
                    "tool": e["tool"],
                    "binding_id": e["binding_id"],
                    "endpoint_origin": e.get("endpoint_origin"),
                    "method": e.get("method"),
                }
                for e in dispatched
            ],
            "resources_resolved": [
                {
                    "tool": e["tool"],
                    "resource_id": e["resource_id"],
                    "permission": e["resource_permission"],
                }
                for e in settled
            ],
            "permissions_denied": denied,
        },
        "observed_model_inputs": [
            {
                "task": line["task"],
                "route": line["route"],
                "body_sha256": line["body_sha256"],
                "body_bytes": line["body_bytes"],
                "input_bytes": line["user_bytes"],
                "classes_in_request": classes(line["needle_matches"]),
                "classes_in_input": classes(line["user_needle_matches"]),
                "card_like_digits": line["card_like_digits"],
            }
            for line in models
        ],
        "observed_webair_requests": [
            {
                "path": line["path"],
                "method": line["method"],
                "body_sha256": line["body_sha256"],
                "body_bytes": line["body_bytes"],
                "classes_in_request": classes(line["needle_matches"]),
            }
            for line in tools
        ],
    }
    remote = [e for e in dispatched if e.get("remote")]
    check(f"{phase}_audit_chain_valid", chain.get("valid") is True)
    check(
        f"{phase}_used_the_selected_model_only",
        record["model"]["allCallsUsedPlannedModel"] is True or record["model"]["calls"] == 0,
    )
    check(
        f"{phase}_every_model_call_observed",
        len(models) == record["model"]["calls"] == len(called_tasks),
        {"observed": len(models), "recorded": record["model"]["calls"]},
    )
    check(
        f"{phase}_every_webair_call_observed",
        len(tools) == len(remote),
        {"observed": len(tools), "dispatched": len(remote)},
    )
    check(
        f"{phase}_webair_calls_went_to_the_public_origin",
        all(e.get("endpoint_origin") == SITE for e in remote),
    )
    for line in models:
        bad = [name for name in PROHIBITED_IN_MODEL_INPUT if line["needle_matches"].get(name)]
        check(
            f"{phase}_model_{line['task']}_holds_no_host_data",
            not bad and not line["card_like_digits"],
            bad or None,
        )
    facts["artifacts_hold_no_identity_or_payment_identifier"] = not any(
        value in artifact_text
        for value in _NEEDLES["passenger_email"]
        + _NEEDLES["passenger_full_name"]
        + _NEEDLES["payment_method_id"]
    )
    check(
        f"{phase}_artifacts_hold_no_email_name_or_payment_identifier",
        facts["artifacts_hold_no_identity_or_payment_identifier"],
    )

    if phase == "search":
        search = output.get("evidence", {}).get("search", {})
        fares = {
            fare["fare_id"]: fare["price_usd"]
            for flight in search.get("flights", [])
            for fare in flight["fares"]
        }
        facts["result"] = {
            "status": output.get("status"),
            "query": search.get("query"),
            "fares": fares,
            "selected_fare_id": output.get("selected_fare_id"),
        }
        check(
            "search_completed_with_the_hero_fares",
            record["status"] == "completed" and fares == HERO_FARES,
        )
        query = search.get("query", {})
        # The request named neither the origin, the cabin nor stops: the granted profile did.
        check(
            "search_profile_filled_the_criteria",
            query.get("origin") == "BOS"
            and query.get("cabin") == "economy"
            and query.get("nonstop_only") is True
            and query.get("max_price_usd") == 900,
            query,
        )
        check(
            "search_profile_resolved_through_the_host",
            [r["tool"] for r in facts["audit"]["resources_resolved"]]
            == ["personal.travel_profile"],
        )
        check(
            "search_used_no_identity_or_payment",
            not any(
                g["permission"] in ("identity.passenger", "wallet.payment")
                for g in facts["resource_grants"]
            ),
        )
        check(
            "search_called_only_search_and_fare_rules",
            {req["path"] for req in tools} <= {"/api/v1/search_flights", "/api/v1/get_fare_rules"},
        )
        interpret = [req for req in models if req["task"] == "interpret"]
        check(
            "search_interpret_input_has_no_profile",
            bool(interpret)
            and all(
                not req["user_needle_matches"].get("profile_origin")
                and not req["user_needle_matches"].get("profile_fields")
                for req in interpret
            ),
        )
        check(
            "search_requests_carry_no_identity_or_payment",
            not any(set(IDENTITY + PAYMENT) & set(classes(req["needle_matches"])) for req in tools),
        )
    elif phase == "booking":
        booking = output.get("booking") or {}
        facts["result"] = {
            "status": output.get("status"),
            "quote_id": booking.get("quote_id"),
            "fare_id": booking.get("fare_id"),
            "total_usd": booking.get("total_usd"),
            "passenger_count": booking.get("passenger_count"),
            "keys": sorted(booking),
        }
        check(
            "booking_completed_with_a_quote",
            record["status"] == "completed"
            and bool(re.fullmatch(r"WAQ-[0-9A-F]{16}", booking.get("quote_id", ""))),
        )
        check(
            "booking_identity_resolved_through_the_host",
            [r["tool"] for r in facts["audit"]["resources_resolved"]]
            == ["personal.passenger_identity"],
        )
        carrying = [
            req["path"] for req in tools if set(IDENTITY) & set(classes(req["needle_matches"]))
        ]
        check(
            "booking_identity_reached_only_prepare_booking",
            carrying == ["/api/v1/prepare_booking"],
            carrying,
        )
        check(
            "booking_requests_carry_no_payment",
            not any(set(PAYMENT) & set(classes(req["needle_matches"])) for req in tools),
        )
        check(
            "booking_result_is_redacted",
            "contact_email" not in json.dumps(booking) and "given_name" not in json.dumps(booking),
        )
    elif phase == "purchase":
        purchase = output.get("purchase") or {}
        facts["result"] = {
            k: purchase.get(k)
            for k in (
                "confirmation_id",
                "quote_id",
                "fare_id",
                "total_usd",
                "simulated",
                "real_transaction",
                "amount_charged_usd",
                "message",
                "payment_display",
                "passenger_count",
            )
        }
        check(
            "purchase_completed",
            record["status"] == "completed" and output.get("status") == "purchase_simulated",
        )
        check(
            "purchase_is_simulated_with_no_charge",
            purchase.get("simulated") is True
            and purchase.get("real_transaction") is False
            and purchase.get("amount_charged_usd") == 0,
        )
        check(
            "purchase_authority_was_once",
            facts["decisions"].get("booking.simulate_purchase") == "once",
        )
        check(
            "purchase_resolved_the_selected_payment_resource",
            [
                r["resource_id"]
                for r in facts["audit"]["resources_resolved"]
                if r["tool"] == "wallet.payment_method"
            ]
            == ["payment_demo_visa"],
        )
        payment_paths = [
            req["path"] for req in tools if "payment_method_id" in classes(req["needle_matches"])
        ]
        check(
            "purchase_payment_id_reached_only_simulate_purchase",
            payment_paths == ["/api/v1/simulate_purchase"],
            payment_paths,
        )
        check(
            "purchase_revalidated_the_exact_quote",
            [req["path"] for req in tools]
            == ["/api/v1/prepare_booking", "/api/v1/simulate_purchase"],
        )
        check(
            "purchase_no_payment_display_reached_webair",
            not any("payment_display" in classes(req["needle_matches"]) for req in tools),
        )
    elif phase == "denial":
        facts["result"] = {
            "status": record["status"],
            "error_code": record.get("errorCode"),
            "failed_node": facts["failed_node"],
        }
        check(
            "denial_failed_with_permission_denied",
            record["status"] == "failed" and record.get("errorCode") == "permission_denied",
        )
        check("denial_resolved_no_payment_resource", not facts["audit"]["resources_resolved"])
        check("denial_called_no_webair_operation", not tools and not dispatched)
        check("denial_made_no_model_call", not models and record["model"]["calls"] == 0)
        check("denial_denied_the_payment_permission", "wallet.payment" in denied)
    return facts


def ui_facts(ui: dict) -> dict:
    steps = ui["steps"]

    def outcome(step: dict) -> dict:
        return {
            "state": step["outcome"]["state"],
            "run_id": step["outcome"]["runId"],
            "elapsed_ms": step["outcome"]["elapsedMs"],
            "banner": step["outcome"]["banner"],
        }

    def authorization(step: dict) -> dict:
        return {
            "runnable": step["authorization"]["ok"],
            "decisions": step["authorization"].get("decisions"),
            "resource_grants_shown": step["authorization"].get("grants"),
            "blocking": step["authorization"]["blocking"],
        }

    facts = {
        "recorded_at": ui["recordedAt"],
        "openclaw": ui["openclaw"],
        "driver": "openclaw-agent-browser/scripts/run-webair-live.mjs "
        "(headless Chrome over CDP, the real Control UI)",
        "website_entered": ui["site"],
        "discovery": {
            "status_chip": steps["discovery"]["status"],
            "candidate": steps["discovery"]["candidate"],
            "candidate_chips": steps["discovery"]["candidateChip"],
            "inspect_offered": steps["discovery"]["inspect"],
        },
        "inspection": {
            "signature": "valid" if steps["inspection"]["signatureValid"] else "not valid",
            "publisher": "unknown" if steps["inspection"]["unknownPublisher"] else "not unknown",
            "trusted_before_decision": steps["inspection"]["trusted"],
            "advertised_note": steps["inspection"].get("advertised"),
        },
        "before_trust": {
            "runnable": steps["untrustedAuthorization"]["ok"],
            "blocking": steps["untrustedAuthorization"]["blocking"],
        },
        "trust_action": {
            "control": "Review publisher key → Trust this publisher key → "
            "Confirm: pin this key permanently",
            "scope": steps["trust"]["scope"],
            "trusted_after": "Trusted by this OpenClaw host" in steps["trust"]["text"],
        },
        "model_selected": ui["model"],
    }
    for phase in ("search", "booking", "purchase", "denial"):
        step = steps[phase]
        facts[phase] = {
            "task": step["task"],
            "decisions": step["decisions"],
            "resource_selections": step["selections"],
            "authorization": authorization(step),
            "run_plan_ready": step["plan"]["ready"],
            "model_row": step["plan"]["compatibility"]["text"].replace("\n", " "),
            "outcome": outcome(step),
        }
    facts["booking"]["quote"] = steps["booking"].get("quote")
    replay = steps["purchase"]["sameAuthorizationAgain"]
    facts["purchase"]["same_authorization_again"] = {
        "page": {
            "run_button_enabled": replay["page"]["enabledBeforePress"],
            "reason_shown": replay["page"]["refusal"]["banner"],
            "runs_started": len(replay["page"]["newRunDirectories"]),
        },
        "server": {
            "operation": "execution.start through the Gateway, same session, plan id and hash",
            "refused": replay["server"]["refused"],
            "code": replay["server"]["code"],
            "detail": replay["server"]["detail"],
            "runs_started": len(replay["server"].get("newRunDirectories", [])),
        },
    }
    check(
        "ui_website_advertises_a_candidate",
        steps["discovery"]["status"] == "Agent package advertised"
        and steps["discovery"]["candidate"] == SITE + "/agent.pkg"
        and "Unverified candidate" in steps["discovery"]["candidateChip"],
    )
    check(
        "ui_inspection_valid_signature_unknown_publisher",
        steps["inspection"]["signatureValid"]
        and steps["inspection"]["unknownPublisher"]
        and not steps["inspection"]["trusted"],
    )
    check(
        "ui_untrusted_package_not_runnable",
        steps["untrustedAuthorization"]["ok"] is False
        and "publisher_not_trusted" in steps["untrustedAuthorization"]["blocking"],
    )
    check("ui_trust_was_an_explicit_decision", facts["trust_action"]["trusted_after"])
    for phase in ("search", "booking", "purchase"):
        check(
            f"ui_{phase}_authorized_planned_and_completed",
            facts[phase]["authorization"]["runnable"]
            and facts[phase]["run_plan_ready"]
            and facts[phase]["outcome"]["state"] == "completed",
        )
    check("ui_denial_failed", facts["denial"]["outcome"]["state"] == "failed")
    check(
        "once_grant_refused_by_the_page",
        replay["page"]["enabledBeforePress"] is False and not replay["page"]["newRunDirectories"],
    )
    check(
        "once_grant_refused_by_the_server",
        replay["server"]["refused"] is True
        and not replay["server"].get("newRunDirectories")
        and "granted something once" in (replay["server"]["detail"] or ""),
    )
    return facts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--ui", required=True, type=Path)
    parser.add_argument("--observer", required=True, type=Path)
    parser.add_argument("--needles", required=True, type=Path)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--private-key")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    _NEEDLES.update(json.loads(args.needles.read_text()))
    ui = json.loads(args.ui.read_text())
    observed = [json.loads(line) for line in args.observer.read_text().splitlines() if line.strip()]

    report = {
        "profile": "webair-live-demo-v0",
        "milestone": "WebAir milestone 5: live end-to-end demo",
        "recorded": datetime.now(UTC).strftime("%Y-%m-%d"),
        "commands": {
            "ui": "node openclaw-agent-browser/scripts/run-webair-live.mjs --site "
            + SITE
            + "/ --model "
            + ui["model"]
            + " --out <ui.json>",
            "verify": "agentpkg/.venv/bin/python scripts/verify_webair_live.py --ui <ui.json> "
            "--observer <jsonl> --needles <json> --bundle <dir>",
        },
        "statement": "WebAir publishes behavior. The user's runtime supplies authority.",
        "notice": "WebAir is a fictional airline. No real booking, payment or transaction "
        "occurs; every person and card is fictional.",
    }
    report["public_origin"] = public_origin()
    report["package"] = package_facts(args.private_key)
    report["deployment"] = deployment_facts(args.bundle)
    report["host"] = host_facts()
    report["agent_browser"] = ui_facts(ui)
    search_record = json.loads(
        (RUNS / ui["steps"]["search"]["outcome"]["runId"] / "run.json").read_text()
    )
    selected = search_record["selectedModel"]
    report["model"] = {
        "selected": selected["hostModelId"],
        "provider": selected["providerId"],
        "locality": "local" if selected.get("local") else "remote",
        "chosen_on_the_page": ui["model"] == selected["hostModelId"],
        "package_compatibility": "compatible (structured_output, reasoning, 16,000-token "
        "context), as the "
        "Agent Browser's model card reported for this host",
        "named_in_package": ui["model"].split("/")[-1] in ARCHIVE.read_bytes().decode("latin-1"),
        "fallback": "none: the package declares routing host, fallback_policy deny",
    }
    check("model_not_named_in_package", not report["model"]["named_in_package"])
    report["observation"] = {
        "tool": "openclaw-agent-browser/scripts/model-input-observer.mjs, preloaded into the "
        "Gateway for this session",
        "points": [
            "undici request body as sent (model calls)",
            "node:https request body as written (WebAir calls)",
        ],
        "records": "per request: task or path, body SHA-256 and size, count of values per "
        "class; never text or values",
        "classes": sorted(_NEEDLES),
        "lines_in_session": len(observed),
    }
    runs = {}
    for phase in ("search", "booking", "purchase", "denial"):
        run_id = ui["steps"][phase]["outcome"]["runId"]
        runs[phase] = run_facts(phase, run_id, observed)
    report["runs"] = runs
    booking_quote = runs["booking"]["result"]["quote_id"]
    check(
        "purchase_used_the_quote_the_booking_returned",
        runs["purchase"]["result"]["quote_id"] == booking_quote,
    )
    report["checks"] = CHECKS
    report["passed"] = all(item["passed"] for item in CHECKS)
    rendered = scrub(json.dumps(report, indent=2, ensure_ascii=False)) + "\n"
    if args.report:
        args.report.write_text(rendered)
    print(rendered)
    failed = [item["id"] for item in CHECKS if not item["passed"]]
    if failed:
        print("FAILED: " + ", ".join(failed), file=sys.stderr)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
