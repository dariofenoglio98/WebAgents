"""A real agentpkg control plane whose only network is a fixture web.

Started by `openclaw-agent-browser/test/discovery.test.ts` with
`agentpkg/.venv/bin/python`. It runs the production `BrowserService` and
`ControlPlane` on loopback with one difference: website discovery and package
downloads reach only the synthetic public origins below, through the DNS and
socket seams agentpkg's own tests use (`agentpkg/tests/web_fixtures.py`). Every
URL policy, parser, verifier and trust decision on the way is production code.

Prints one JSON line, {"url", "token"}, and serves until stdin closes.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))

from agentpkg.browser import BrowserService, ControlPlane, ControlPlaneConfig  # noqa: E402
from web_fixtures import (  # noqa: E402
    PACKAGE_MEDIA_TYPE,
    WEBAIR_ARCHIVE,
    FixtureWeb,
    link,
    page,
    publish_webair,
    resigned_webair,
    tampered_webair,
)


def publish(web: FixtureWeb, scratch: Path) -> None:
    # A: WebAir's own pages and its real signed package.
    publish_webair(web)
    # B: an ordinary site.
    web.serve("https://news.example/", page('<link rel="alternate" href="/feed.xml">'))
    # C: an advertisement for a package on another origin, which serves real bytes.
    web.serve(
        "https://victim.example/",
        page(link("https://other.example/evil.agent.pkg", type_=PACKAGE_MEDIA_TYPE)),
    )
    web.serve("https://other.example/evil.agent.pkg", WEBAIR_ARCHIVE.read_bytes())
    # D: same-origin advertisements of bytes that are not a valid package.
    publish_webair(web, "https://broken.example", archive=b"PK\x03\x04 not an archive")
    publish_webair(web, "https://tampered.example", archive=tampered_webair())
    # E: WebAir's source, validly signed by a key nobody pinned.
    publish_webair(web, "https://stranger.example", archive=resigned_webair(scratch))
    # A second, unrelated origin and package: discovery knows neither.
    web.serve("https://meetings.example/team/", page(link("tools/agenda.agent.pkg")))
    web.serve(
        "https://meetings.example/team/tools/agenda.agent.pkg",
        (ROOT / "dist/meeting-agenda.agent.pkg").read_bytes(),
    )
    web.serve("https://multi.example/", page(link("/stable.agent.pkg") + link("/beta.agent.pkg")))


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="agent-browser-discovery-") as directory:
        # Resolved: agentpkg writes artifacts only under symlink-free paths.
        scratch = Path(directory).resolve()
        web = FixtureWeb()
        publish(web, scratch)
        control = ControlPlane(
            ControlPlaneConfig(
                cache_dir=scratch / "cache", trust_store_path=scratch / "trust.json"
            ),
            transport=web.package_transport,
            discovery_network=web.network,
        )
        service = BrowserService(control, host="127.0.0.1", port=0)
        service.start_background()
        print(json.dumps({"url": service.url, "token": service.token}), flush=True)
        try:
            sys.stdin.read()
        finally:
            service.shutdown()
            service.server_close()
            web.close()


if __name__ == "__main__":
    main()
