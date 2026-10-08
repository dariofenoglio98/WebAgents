"""Website discovery: a page can say where a package is, and nothing more.

`rel="agent-package"` is experimental WebAgents metadata. These tests drive the
production discovery path with only DNS and sockets replaced (`web_fixtures`), then the
unchanged package path for whatever a page advertised. They pin three separate facts:
discovery finds a location, verification decides what the bytes are, and trust is an
operator's pin. None of them implies the next.
"""

from __future__ import annotations

import gzip
import json
import random
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

import pytest
from tool_fakes import registry_for
from web_fixtures import (
    PACKAGE_MEDIA_TYPE,
    PUBLIC,
    WEBAIR_ARCHIVE,
    WEBAIR_ARCHIVE_SHA256,
    WEBAIR_DIGEST,
    WEBAIR_FINGERPRINT,
    WEBAIR_KEY,
    WEBAIR_SITE,
    FixtureWeb,
    link,
    page,
    publish_webair,
    resigned_webair,
    tampered_webair,
)

from agentpkg.browser import BrowserService, ControlPlane, ControlPlaneConfig, ControlPlaneError
from agentpkg.browser.discovery import (
    REJECTION_REASONS,
    SCHEMA,
    DiscoveryLimits,
    classify_candidate,
    discover_website,
    scan_head,
)
from agentpkg.browser.fetch import FetchLimits, download_to_file
from agentpkg.browser.trust import read_public_key_file

ROOT = Path(__file__).resolve().parents[2]
WEBAIR = "https://webair.example"
CATALOG = {
    "schema": "agentpkg-host-model-catalog-v0",
    "host": {"runtime": "test", "source": "test", "captured_at": "2026-10-02T00:00:00+00:00"},
    "models": [
        {
            "id": "host/alpha",
            "provider_id": "host",
            "model_id": "alpha",
            "display_name": "Alpha",
            "available": True,
            "selectable": True,
            "capabilities": {
                "reasoning": {"value": True, "basis": "declared"},
                "structured_output": {"value": True, "basis": "declared"},
            },
            "limits": {"context_tokens": 200000},
            "properties": {"local": False, "tags": []},
        }
    ],
    "notes": [],
}


@pytest.fixture
def web():
    fixture = FixtureWeb()
    try:
        yield fixture
    finally:
        fixture.close()


def discover(web: FixtureWeb, url: str, **limits) -> dict:
    return discover_website(
        url, network=web.network, limits=DiscoveryLimits(**limits) if limits else None
    )


def refusal(web: FixtureWeb, url: str, **limits) -> ControlPlaneError:
    with pytest.raises(ControlPlaneError) as error:
        discover(web, url, **limits)
    return error.value


def plane(tmp_path: Path, web: FixtureWeb) -> ControlPlane:
    """A control plane whose discovery and package downloads both reach only `web`."""
    return ControlPlane(
        ControlPlaneConfig(cache_dir=tmp_path / "cache", trust_store_path=tmp_path / "trust.json"),
        transport=web.package_transport,
        discovery_network=web.network,
    )


def scan(html: str | bytes, *, charset: str | None = "utf-8", complete: bool = True):
    body = html.encode("utf-8") if isinstance(html, str) else html
    return scan_head(body, http_charset=charset, complete=complete, max_links=16)


def hrefs(html: str | bytes, **options) -> list[str | None]:
    return [item["href"] for item in scan(html, **options).links]


def accepted(result: dict) -> list[str]:
    return [item["resolved_url"] for item in result["candidates"] if item["accepted"]]


def reasons(result: dict) -> list[str | None]:
    return [item["rejection_reason"] for item in result["candidates"]]


def pin_webair(control: ControlPlane):
    return control.trust_add(
        read_public_key_file(WEBAIR_KEY),
        display_name="WebAir demo publisher key",
        publisher_id="webair-demo",
        package_id_prefix="org.webagents.webair",
    )


# == 1. which links count: the document head, by the HTML parsing rules ==========
@pytest.mark.parametrize(
    "markup",
    [
        '<link rel="agent-package" href="/agent.pkg">',
        "<link href='/agent.pkg' rel='agent-package'>",
        "<link rel=agent-package href=/agent.pkg>",
        '<LINK REL="Agent-Package" HREF="/agent.pkg">',
        '<link\n\trel="agent-package"\n   href="/agent.pkg"\n/>',
        '<link rel="stylesheet agent-package" href="/agent.pkg">',
        '<link rel=" \tAGENT-PACKAGE\n  alternate " href="/agent.pkg">',
        '<link rel="agent&#45;package" href="/agent.pkg">',
        f'<link href="/agent.pkg" type="{PACKAGE_MEDIA_TYPE}" rel="agent-package">',
    ],
)
def test_link_variations_are_recognized(markup):
    assert hrefs(page(markup)) == ["/agent.pkg"]


@pytest.mark.parametrize(
    "markup",
    [
        '<link rel="agent-packages" href="/x.pkg">',
        '<link rel="agentpackage" href="/x.pkg">',
        # Only ASCII whitespace separates tokens, and only ASCII letters fold case.
        '<link rel="agent-package stylesheet" href="/x.pkg">',
        '<link rel="agent-pacKage" href="/x.pkg">',
        '<link rel href="/x.pkg">',
        '<link href="/x.pkg">',
        '<meta name="agent-package" content="/x.pkg">',
    ],
)
def test_lookalikes_are_not_advertisements(markup):
    assert hrefs(page(markup)) == []


def test_the_first_of_duplicated_attributes_wins_as_in_html():
    assert hrefs(
        page('<link rel="agent-package" href="/first.pkg" href="https://evil.example/x">')
    ) == ["/first.pkg"]
    assert hrefs(page('<link rel="stylesheet" rel="agent-package" href="/x.pkg">')) == []


@pytest.mark.parametrize(
    "markup",
    [
        "<script>document.write('<link rel=agent-package href=/s.pkg>')</script>",
        '<script type="text/template"><link rel="agent-package" href="/s.pkg"></script>',
        "<script/><link rel=agent-package href=/s.pkg></script>",
        "<style>/* <link rel=agent-package href=/s.pkg> */</style>",
        "<title>Deals <link rel=agent-package href=/s.pkg></title>",
        "<!-- <link rel=agent-package href=/s.pkg> -->",
        "<template><link rel=agent-package href=/s.pkg></template>",
        "<template><template></template><link rel=agent-package href=/s.pkg></template>",
        "<template><title></template><link rel=agent-package href=/s.pkg></title></template>",
        "<template><textarea></template><link rel=agent-package href=/s></textarea></template>",
        "<noframes><link rel=agent-package href=/s.pkg></noframes>",
    ],
)
def test_text_comments_and_templates_hold_no_advertisement(markup):
    assert hrefs(page(markup + link("/real.pkg"))) == ["/real.pkg"]


def test_plaintext_inside_a_template_never_ends():
    html = "<html><head><template><plaintext></plaintext></template>" + link("/after.pkg")
    assert hrefs(html) == []


def test_a_declared_charset_is_echoed_only_as_escaped_text():
    result = scan(b'<head><meta charset="\xe2\x80\xaeutf-8">' + link().encode(), charset=None)
    assert result.declared_charset == "\\u00e2\\u0080\\u00aeutf-8"
    assert [item["href"] for item in result.links] == ["/agent.pkg"]


def test_only_the_document_head_is_searched():
    html = page(link("/head.pkg"), body=link("/body.pkg") + "<p>text</p>" + link("/later.pkg"))
    result = scan(html)
    assert [item["href"] for item in result.links] == ["/head.pkg"]
    assert result.head_ended


@pytest.mark.parametrize(
    "opener",
    [
        "<body>",
        "<div>",
        "<img src=/pixel.png>",
        "<svg>",
        "<frameset>",
        "<textarea>",
        "Plain text",
        "&nbsp;",
        "\x00",
        "</body>",
        "</html>",
        "</br>",
    ],
)
def test_the_head_ends_where_the_html_tree_builder_ends_it(opener):
    html = f"<!doctype html><html><head>{link('/before.pkg')}{opener}{link('/after.pkg')}"
    result = scan(html)
    assert [item["href"] for item in result.links] == ["/before.pkg"]
    assert result.head_ended


def test_a_link_between_head_and_body_is_still_placed_in_the_head():
    html = (
        "<html><head><title>x</title></head>\n" + link("/between.pkg") + "\n<body>" + link("/b.pkg")
    )
    assert hrefs(html) == ["/between.pkg"]


def test_head_content_and_whitespace_keep_the_head_open():
    html = (
        "\n<!doctype html>\n<!-- comment --><?xml-stylesheet x?>\n<html lang=en>\n <head>\n"
        "  <meta charset=utf-8><base target=_self><meta name=viewport content=x>\n"
        "  <noscript><style>p {}</style></noscript>\n  <script src=/app.js></script>\n"
        "  <link rel=stylesheet href=/site.css><link rel=icon href=/favicon.ico>\n"
        "  <title>Shop</title>\n  </div>\n" + link("/x.pkg")
    )
    result = scan(html)
    assert [item["href"] for item in result.links] == ["/x.pkg"]
    assert result.head_ended is False  # The document ended inside its head.


def test_a_noscript_after_the_head_opens_the_body():
    assert hrefs("<head></head><noscript></noscript>" + link("/x.pkg")) == []


def test_a_base_element_is_noticed_and_never_used():
    result = scan(page('<base href="https://evil.example/">' + link("agent.pkg")))
    assert result.base_href is True
    assert [item["href"] for item in result.links] == ["agent.pkg"]


@pytest.mark.parametrize(
    "html,expected",
    [
        ('<head><link rel="agent-package href=/x.pkg>\n<body>', []),
        ("<head><link rel=agent-package href=/x.pkg", []),
        ("<head><<<>>>" + link("/x.pkg"), []),
        ("<head></div></span></p>" + link("/x.pkg"), ["/x.pkg"]),
        ("<head><title>never closed" + link("/x.pkg"), []),
        ("<head><template>" + link("/x.pkg"), []),
        ("<head><!-- never closed " + link("/x.pkg"), []),
        ("<head><script>" + link("/x.pkg"), []),
        ("<head><link rel='agent-package' href='/x.pkg'\"\">", ["/x.pkg"]),
    ],
)
def test_malformed_html_neither_raises_nor_invents_a_link(html, expected):
    assert hrefs(html) == expected


def test_arbitrary_bytes_never_escape_the_parser():
    rng = random.Random(20261002)
    pieces = [
        "<",
        ">",
        "</",
        "<!--",
        "-->",
        '"',
        "'",
        "=",
        "&",
        "#",
        ";",
        "head",
        "link",
        "rel",
        "agent-package",
        "href",
        "template",
        "script",
        "title",
        "\x00",
        " ",
        "\n",
    ]
    for _ in range(300):
        if rng.random() < 0.5:
            body = rng.randbytes(rng.randrange(0, 400))
        else:
            body = "".join(rng.choice(pieces) for _ in range(rng.randrange(0, 120))).encode()
        for complete in (True, False):
            try:
                result = scan(body, charset=None, complete=complete)
            except ControlPlaneError as exc:
                assert exc.code in {"discovery_failed", "discovery_encoding_unsupported"}
            else:
                assert len(result.links) <= 16


def test_link_count_is_bounded():
    result = scan(page("".join(link(f"/{index}.pkg") for index in range(40))))
    assert len(result.links) == 16
    assert result.overflow == 24


# == 2. character encodings ====================================================
def test_a_utf8_byte_order_mark_is_consumed():
    result = scan(b"\xef\xbb\xbf" + page(link()).encode(), charset="iso-8859-1")
    assert [item["href"] for item in result.links] == ["/agent.pkg"]
    assert (result.codec, result.encoding_source) == ("utf-8", "bom")


@pytest.mark.parametrize("codec", ["utf-16", "utf-16-le", "utf-16-be"])
def test_utf16_pages_with_a_byte_order_mark(codec):
    body = page(link()).encode(codec)
    if codec != "utf-16":
        body = ("﻿").encode(codec) + body
    result = scan(body, charset=None)
    assert [item["href"] for item in result.links] == ["/agent.pkg"]
    assert result.encoding_source == "bom"


def test_utf16_declared_by_http_is_decoded_as_utf16():
    result = scan(page(link()).encode("utf-16-le"), charset="UTF-16LE")
    assert [item["href"] for item in result.links] == ["/agent.pkg"]
    assert (result.codec, result.encoding_source) == ("utf-16-le", "http")


def test_a_meta_declaration_is_found_by_the_prescan():
    body = (
        '<html><head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">'
        + link()
        + "<meta charset=utf-8></head>"
    )
    result = scan(body.encode(), charset=None)
    assert [item["href"] for item in result.links] == ["/agent.pkg"]
    # The first declaration wins, as in the HTML prescan.
    assert (result.encoding_source, result.declared_charset) == ("meta", "iso-8859-1")


def test_a_meta_declaration_cannot_switch_a_page_to_utf16():
    result = scan(('<head><meta charset="utf-16">' + link()).encode(), charset=None)
    assert (result.codec, result.declared_charset) == ("utf-8", "utf-16")
    assert [item["href"] for item in result.links] == ["/agent.pkg"]


@pytest.mark.parametrize("label", ["iso-2022-jp", "ISO-2022-KR", "hz-gb-2312", "replacement"])
def test_stateful_and_replacement_encodings_are_refused(label):
    for body, charset in (
        (page(link()).encode(), label),
        (f'<html><head><meta charset="{label}">{link()}</head>'.encode(), None),
    ):
        with pytest.raises(ControlPlaneError) as error:
            scan(body, charset=charset)
        assert error.value.code == "discovery_encoding_unsupported"


@pytest.mark.parametrize("label", ["utf-7", "x-made-up", "windows-1252", "shift_jis", "UTF-8"])
def test_ascii_markup_reads_the_same_under_any_other_label(label):
    result = scan(page("<title>caf\xe9</title>" + link()).encode("latin-1"), charset=label)
    assert [item["href"] for item in result.links] == ["/agent.pkg"]
    assert result.codec == "utf-8"


def test_invalid_bytes_are_replaced_not_fatal():
    body = b"<html><head><title>\xff\xfe\xc3(\xa0\xa1</title>" + link().encode() + b"</head>"
    assert hrefs(body) == ["/agent.pkg"]


def test_a_truncated_page_is_trusted_only_where_its_head_ended():
    whole = page(link("/a.pkg"), body="x" * 4000).encode()
    early = scan(whole[:300], complete=False)
    assert early.head_ended and [item["href"] for item in early.links] == ["/a.pkg"]
    cut = scan(b'<head><title>t</title><link rel="agent-package" href="/agent.pk', complete=False)
    assert cut.links == [] and cut.head_ended is False
    # A character cut in half by the limit is withheld, not decoded as text.
    half = scan("<head><title>é".encode()[:-1], complete=False)
    assert half.head_ended is False


# == 3. candidates: resolution and the same-origin profile =====================
PAGE = "https://airline.example/travel/"


@pytest.mark.parametrize(
    "href,expected",
    [
        ("/agent.pkg", "https://airline.example/agent.pkg"),
        ("agents/current.agent.pkg", "https://airline.example/travel/agents/current.agent.pkg"),
        ("../agent.pkg", "https://airline.example/agent.pkg"),
        ("https://airline.example/agent.pkg", "https://airline.example/agent.pkg"),
        ("https://airline.example:443/agent.pkg", "https://airline.example/agent.pkg"),
        ("HTTPS://AIRLINE.EXAMPLE/agent.pkg", "https://airline.example/agent.pkg"),
        ("//airline.example/agent.pkg", "https://airline.example/agent.pkg"),
        ("https:agent.pkg", "https://airline.example/travel/agent.pkg"),
        ("  /agent.pkg\n", "https://airline.example/agent.pkg"),
        ("/agent.pkg?version=0.1.0", "https://airline.example/agent.pkg?version=0.1.0"),
    ],
)
def test_candidates_resolve_against_the_page_like_a_browser(href, expected):
    candidate = classify_candidate(0, {"href": href, "type": None}, page_url=PAGE)
    assert candidate["accepted"], candidate
    assert candidate["same_origin"] is True
    assert candidate["resolved_url"] == expected


@pytest.mark.parametrize(
    "href,reason",
    [
        (None, "href_missing"),
        ("", "href_empty"),
        (" \t\n", "href_empty"),
        ("#agent", "fragment_only"),
        ("#", "fragment_only"),
        ("/agent.pkg#v1", "fragment_not_allowed"),
        ("javascript:alert(1)", "unsupported_scheme"),
        ("data:application/zip;base64,UEsDBA==", "unsupported_scheme"),
        ("file:///etc/passwd", "unsupported_scheme"),
        ("ftp://airline.example/agent.pkg", "unsupported_scheme"),
        ("mailto:ops@airline.example", "unsupported_scheme"),
        ("blob:https://airline.example/0b8f", "unsupported_scheme"),
        ("https://user:secret@airline.example/agent.pkg", "credentials_not_allowed"),
        ("https://user@airline.example/agent.pkg", "credentials_not_allowed"),
        ("https://evil.example/agent.pkg", "cross_origin"),
        ("//evil.example/agent.pkg", "cross_origin"),
        ("https://sub.airline.example/agent.pkg", "cross_origin"),
        ("https://airline.example./agent.pkg", "cross_origin"),
        ("http://airline.example/agent.pkg", "cross_origin"),
        ("https://airline.example:8443/agent.pkg", "cross_origin"),
        ("https://airline.example:0/agent.pkg", "cross_origin"),
        ("/agent pkg", "href_malformed"),
        ("/\\evil.example/agent.pkg", "href_malformed"),
        ("/agent.pkg\x00", "href_malformed"),
        ("/café.pkg", "href_malformed"),
        ("/" + "a" * 2100, "href_malformed"),
        ("https://[::1/agent.pkg", "href_malformed"),
        ("https://airline.example:99999/agent.pkg", "href_malformed"),
        ("https://airline.example:port/agent.pkg", "href_malformed"),
        (".", "points_to_page"),
        ("/travel/", "points_to_page"),
    ],
)
def test_rejected_candidates_say_why(href, reason):
    candidate = classify_candidate(0, {"href": href, "type": None}, page_url=PAGE)
    assert candidate["accepted"] is False
    assert candidate["rejection_reason"] == reason
    assert reason in REJECTION_REASONS
    assert candidate["rejection_message"]


@pytest.mark.parametrize(
    "href,component",
    [
        ("https://evil.example/agent.pkg", "host"),
        ("http://airline.example/agent.pkg", "scheme"),
        ("https://airline.example:8443/agent.pkg", "port"),
    ],
)
def test_a_cross_origin_rejection_names_what_differs(href, component):
    candidate = classify_candidate(0, {"href": href, "type": None}, page_url=PAGE)
    assert candidate["same_origin"] is False
    assert f"different {component}" in candidate["rejection_message"]
    assert "https://airline.example" in candidate["rejection_message"]


def test_a_resolved_url_beyond_the_package_url_limit_is_rejected():
    long_page = "https://airline.example/" + "p/" * 990
    candidate = classify_candidate(0, {"href": "a" * 60, "type": None}, page_url=long_page)
    assert candidate["rejection_reason"] == "url_rejected"


@pytest.mark.parametrize(
    "type_,ok",
    [
        (None, True),
        ("", True),
        (PACKAGE_MEDIA_TYPE, True),
        ("Application/VND.WebAgents.Agent-Package", True),
        (f"{PACKAGE_MEDIA_TYPE}; version=0.1", True),
        ("text/html", False),
        ("application/zip", False),
        ("application/octet-stream", False),
    ],
)
def test_the_type_hint_is_a_hint(type_, ok):
    candidate = classify_candidate(0, {"href": "/agent.pkg", "type": type_}, page_url=PAGE)
    assert candidate["accepted"] is ok
    if not ok:
        assert candidate["rejection_reason"] == "unsupported_type"


def test_untrusted_href_text_is_shown_escaped():
    candidate = classify_candidate(0, {"href": "/agent‮gkp.exe", "type": None}, page_url=PAGE)
    assert candidate["rejection_reason"] == "href_malformed"
    assert candidate["href"] == "/agent\\u202egkp.exe"


# == 4. the fetch: WebAir and ordinary pages ===================================
def test_webair_home_page_advertises_its_package(web):
    publish_webair(web)
    result = discover(web, f"{WEBAIR}/")
    assert result["schema"] == SCHEMA
    assert result["discovery_status"] == "candidate"
    assert result["page_origin"] == WEBAIR
    (candidate,) = result["candidates"]
    assert candidate == {
        "index": 0,
        "href": "/agent.pkg",
        "type_hint": PACKAGE_MEDIA_TYPE,
        "resolved_url": f"{WEBAIR}/agent.pkg",
        "same_origin": True,
        "accepted": True,
        "rejection_reason": None,
        "rejection_message": None,
    }
    assert result["trust"]["package_verified"] is False
    assert result["trust"]["publisher_trusted"] is False
    assert result["execution"] == {
        "performed": False,
        "package_fetched": False,
        "note": result["execution"]["note"],
    }
    # Exactly one request: the page. Not its stylesheet, and not the package.
    assert web.paths() == ["/"]


def test_a_deeper_webair_page_resolves_to_the_same_package(web):
    publish_webair(web)
    deeper = WEBAIR_SITE["pages"][1]["path"]
    assert accepted(discover(web, WEBAIR + deeper)) == [f"{WEBAIR}/agent.pkg"]


def test_a_path_relative_candidate_resolves_against_the_page(web):
    web.serve("https://airline.example/travel/", page(link("agents/current.agent.pkg")))
    result = discover(web, "https://airline.example/travel/")
    assert accepted(result) == ["https://airline.example/travel/agents/current.agent.pkg"]


def test_an_absolute_same_origin_candidate(web):
    web.serve("https://airline.example/", page(link("https://airline.example/pkg/v1.agent.pkg")))
    assert accepted(discover(web, "https://airline.example/")) == [
        "https://airline.example/pkg/v1.agent.pkg"
    ]


def test_an_ordinary_website_advertises_nothing(web):
    web.serve("https://news.example/", page('<link rel="stylesheet" href="/s.css">'))
    result = discover(web, "https://news.example/")
    assert result["discovery_status"] == "no_candidate"
    assert result["candidates"] == [] and result["accepted_count"] == 0


def test_several_candidates_are_listed_and_none_is_chosen(web):
    web.serve(
        "https://multi.example/",
        page(link("/stable.agent.pkg") + link("/beta.agent.pkg") + link("/stable.agent.pkg")),
    )
    result = discover(web, "https://multi.example/")
    assert result["discovery_status"] == "multiple_candidates"
    assert accepted(result) == [
        "https://multi.example/stable.agent.pkg",
        "https://multi.example/beta.agent.pkg",
    ]
    assert reasons(result) == [None, None, "duplicate"]


def test_one_good_and_one_cross_origin_candidate(web):
    web.serve(
        "https://shop.example/", page(link("/agent.pkg") + link("https://cdn.example/a.agent.pkg"))
    )
    result = discover(web, "https://shop.example/")
    assert result["discovery_status"] == "candidate"
    assert reasons(result) == [None, "cross_origin"]


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_a_same_origin_redirect_is_followed_and_its_target_is_the_base(web, status):
    web.redirect("https://airline.example/", "/travel/?from=home#top", status=status)
    web.serve("https://airline.example/travel/?from=home", page(link("agents/current.agent.pkg")))
    result = discover(web, "https://airline.example/")
    assert result["final_url"] == "https://airline.example/travel/?from=home"
    assert result["redirects"] == [
        {
            "status": status,
            "from_url": "https://airline.example/",
            "to_url": "https://airline.example/travel/?from=home",
        }
    ]
    assert accepted(result) == ["https://airline.example/travel/agents/current.agent.pkg"]


def test_the_fragment_of_a_website_url_is_never_sent(web):
    web.serve("https://airline.example/fares", page(link()))
    result = discover(web, "https://airline.example/fares#economy")
    assert result["requested_url"] == "https://airline.example/fares#economy"
    assert result["final_url"] == "https://airline.example/fares"
    assert web.paths() == ["/fares"]


def test_requests_carry_no_cookie_credential_or_referrer(web):
    web.redirect("https://shop.example/", "/home", headers={"Set-Cookie": "session=secret; Path=/"})
    web.serve("https://shop.example/home", page(link()), headers={"Set-Cookie": "tracking=1"})
    discover(web, "https://shop.example/")
    assert [item["path"] for item in web.requests] == ["/", "/home"]
    for request in web.requests:
        headers = request["headers"]
        assert request["host"] == "shop.example"
        assert headers["accept-encoding"] == "identity"
        assert "text/html" in headers["accept"]
        for name in ("cookie", "authorization", "referer", "origin", "proxy-authorization"):
            assert name not in headers


def test_nothing_the_page_references_is_fetched(web):
    references = (
        '<script src="/app.js"></script><link rel="stylesheet" href="/site.css">'
        '<link rel="preload" href="/font.woff2" as="font"><link rel="icon" href="/favicon.ico">'
        '<link rel="manifest" href="/app.webmanifest">'
        '<meta http-equiv="refresh" content="0; url=/x">'
    )
    body = '<img src="/hero.png"><iframe src="/frame"></iframe><script>fetch("/beacon")</script>'
    web.serve("https://busy.example/", page(references + link(), body=body))
    discover(web, "https://busy.example/")
    assert web.paths() == ["/"]


@pytest.mark.parametrize(
    "content_type",
    ["text/html", "TEXT/HTML; charset=UTF-8", "application/xhtml+xml", 'text/html;charset="utf-8"'],
)
def test_html_content_types_are_read(web, content_type):
    web.serve("https://site.example/", page(link()), content_type=content_type)
    assert accepted(discover(web, "https://site.example/")) == ["https://site.example/agent.pkg"]


@pytest.mark.parametrize(
    "content_type",
    [
        None,
        "application/json",
        "text/plain",
        PACKAGE_MEDIA_TYPE,
        "application/octet-stream",
        "image/svg+xml",
        "text/htmlx",
    ],
)
def test_anything_but_html_is_refused(web, content_type):
    web.serve("https://site.example/", page(link()), content_type=content_type)
    error = refusal(web, "https://site.example/")
    assert error.code == "discovery_not_html"


@pytest.mark.parametrize("status", [204, 300, 304, 401, 403, 404, 410, 500, 503])
def test_only_a_200_page_is_read(web, status):
    web.serve("https://site.example/", page(link()), status=status)
    error = refusal(web, "https://site.example/")
    assert error.code == "discovery_http_status"
    assert error.details == {"status": status}


def test_gzip_and_deflate_content_is_read_under_the_same_cap(web):
    html = page(link()).encode()
    web.serve("https://gz.example/", gzip.compress(html), headers={"Content-Encoding": "gzip"})
    web.serve("https://df.example/", zlib.compress(html), headers={"Content-Encoding": "deflate"})
    gz = discover(web, "https://gz.example/")
    assert accepted(gz) == ["https://gz.example/agent.pkg"]
    assert gz["page"]["content_coding"] == "gzip" and gz["page"]["bytes_read"] == len(html)
    assert accepted(discover(web, "https://df.example/")) == ["https://df.example/agent.pkg"]


def test_a_compression_bomb_costs_at_most_the_cap(web):
    bomb = gzip.compress(b"<!doctype html><html><head><title>" + b"a" * (24 * 1024 * 1024))
    assert len(bomb) < 64 * 1024
    web.serve("https://bomb.example/", bomb, headers={"Content-Encoding": "gzip"})
    started = time.monotonic()
    error = refusal(web, "https://bomb.example/", max_html_bytes=256 * 1024)
    assert error.code == "discovery_too_large"
    assert time.monotonic() - started < 5


@pytest.mark.parametrize("coding", ["br", "zstd", "compress", "gzip, br", "gzip, gzip"])
def test_other_content_codings_are_refused(web, coding):
    web.serve("https://site.example/", page(link()), headers={"Content-Encoding": coding})
    assert refusal(web, "https://site.example/").code == "discovery_encoding_unsupported"


def test_a_large_page_is_fine_when_its_head_fits(web):
    web.serve("https://big.example/", page(link(), body="<p>" + "x" * 300_000 + "</p>"))
    result = discover(web, "https://big.example/", max_html_bytes=64 * 1024)
    assert accepted(result) == ["https://big.example/agent.pkg"]
    assert result["page"]["truncated"] is True
    assert result["page"]["bytes_read"] == 64 * 1024


def test_a_head_larger_than_the_cap_is_refused(web):
    web.serve("https://big.example/", "<html><head><style>" + "x" * 300_000 + "</style>" + link())
    error = refusal(web, "https://big.example/", max_html_bytes=64 * 1024)
    assert error.code == "discovery_too_large"
    assert error.status == 413


def test_a_declared_charset_that_is_refused_stops_discovery(web):
    web.serve("https://jp.example/", page(link()), content_type="text/html; charset=ISO-2022-JP")
    assert refusal(web, "https://jp.example/").code == "discovery_encoding_unsupported"


def test_a_page_with_invalid_utf8_still_yields_its_link(web):
    body = b"<html><head><title>\xc3\x28\xff</title>" + link().encode()
    web.serve("https://bytes.example/", body)
    assert accepted(discover(web, "https://bytes.example/")) == ["https://bytes.example/agent.pkg"]


def test_a_slow_website_is_cut_off_at_the_deadline(web):
    web.serve("https://slow.example/", page(link()), delay=3.0)
    web.serve("https://stall.example/", page(link()) + " " * 4096, stall=3.0)
    for url in ("https://slow.example/", "https://stall.example/"):
        started = time.monotonic()
        assert refusal(web, url, timeout_seconds=0.5).code == "discovery_timeout"
        assert time.monotonic() - started < 2.5


# == 5. redirects and the network policy ======================================
def test_redirects_are_bounded(web):
    for index in range(7):
        web.redirect(f"https://hops.example/{index}", f"/{index + 1}")
    web.serve("https://hops.example/5", page(link()))
    web.serve("https://hops.example/7", page(link()))
    assert len(discover(web, "https://hops.example/0")["redirects"]) == 5
    error = refusal(web, "https://hops.example/1", max_redirects=3)
    assert error.code == "discovery_redirect_refused"
    assert error.details == {"reason": "too_many_redirects"}
    web.redirect("https://loop.example/", "/")
    assert refusal(web, "https://loop.example/").details["reason"] == "too_many_redirects"


@pytest.mark.parametrize(
    "location,reason",
    [
        ("https://evil.example/", "cross_origin"),
        ("//evil.example/", "cross_origin"),
        ("http://site.example/", "cross_origin"),
        ("https://site.example:8443/", "cross_origin"),
        ("https://127.0.0.1/", "cross_origin"),
        ("https://localhost/admin", "cross_origin"),
        ("https://169.254.169.254/latest/meta-data/", "cross_origin"),
        ("javascript:alert(1)", "cross_origin"),
        ("file:///etc/passwd", "cross_origin"),
        ("/\\evil.example/", "invalid_location"),
        ("/café", "invalid_location"),
        ("https://[::1", "invalid_location"),
        (None, "missing_location"),
    ],
)
def test_a_redirect_cannot_leave_the_origin(web, location, reason):
    if location is None:
        web.serve("https://site.example/", status=302, content_type=None)
    else:
        web.redirect("https://site.example/", location)
    error = refusal(web, "https://site.example/")
    assert error.code == "discovery_redirect_refused"
    assert error.details["reason"] == reason
    # The refused target was neither resolved nor contacted.
    assert web.resolved == ["site.example"]
    assert [host for host, _ in web.connections] == ["site.example"]


def test_a_cross_origin_redirect_reports_where_it_pointed(web):
    web.redirect("https://old.example/", "https://new.example/home?x=1#y")
    error = refusal(web, "https://old.example/")
    assert error.details == {"reason": "cross_origin", "location": "https://new.example/home?x=1"}
    assert "new.example" in str(error)


@pytest.mark.parametrize(
    "url",
    [
        "http://webair.example/",
        "file:///etc/passwd",
        "data:text/html,<link rel=agent-package href=/x>",
        "javascript:alert(1)",
        "ftp://webair.example/",
        "https://user:secret@webair.example/",
        "https://webair.example:8443/",
        "https://webair.example/a b",
        "https://[::1/",
        "webair.example",
        "",
        "https://" + "a" * 2100,
    ],
)
def test_website_urls_are_held_to_the_package_url_syntax(web, url):
    error = refusal(web, url)
    assert error.code == "url_rejected"
    assert error.status == 400
    assert web.resolved == [] and web.connections == []


@pytest.mark.parametrize(
    "url,reason",
    [
        ("https://localhost/", "loopback_address"),
        ("https://127.0.0.1/", "loopback_address"),
        ("https://[::1]/", "loopback_address"),
        ("https://10.0.0.5/", "private_address"),
        ("https://172.16.0.5/", "private_address"),
        ("https://192.168.1.5/", "private_address"),
        ("https://169.254.10.10/", "link_local_address"),
        ("https://[fe80::1]/", "link_local_address"),
        ("https://169.254.169.254/latest/meta-data/", "cloud_metadata_address"),
        ("https://metadata.google.internal/", "cloud_metadata_address"),
        ("https://100.64.0.1/", "non_global_address"),
        ("https://224.0.0.1/", "multicast_address"),
        ("https://0.0.0.0/", "unspecified_address"),
        ("https://[::ffff:127.0.0.1]/", "loopback_address"),
        ("https://[64:ff9b::7f00:1]/", "nat64_address"),
    ],
)
def test_private_and_special_destinations_are_never_contacted(web, url, reason):
    error = refusal(web, url)
    assert error.code == "url_destination_denied"
    assert error.status == 403
    assert reason in str(error)
    assert web.connections == []


def test_a_name_that_resolves_privately_is_refused(web):
    web.answer("intranet.example", ["10.1.2.3"])
    web.answer("mixed.example", [PUBLIC, "127.0.0.1"])
    web.answer("nowhere.example", [])
    assert refusal(web, "https://intranet.example/").code == "url_destination_denied"
    assert refusal(web, "https://mixed.example/").code == "url_destination_denied"
    assert refusal(web, "https://nowhere.example/").code == "url_unresolvable"
    assert web.connections == []


def test_every_redirect_hop_is_resolved_and_classified_again(web):
    """A same-origin redirect cannot carry the second request to a private address."""
    web.answer("rebind.example", [PUBLIC], ["10.0.0.7"])
    web.redirect("https://rebind.example/", "/next")
    web.serve("https://rebind.example/next", page(link()))
    error = refusal(web, "https://rebind.example/")
    assert error.code == "url_destination_denied"
    assert web.resolved == ["rebind.example", "rebind.example"]
    assert web.connections == [("rebind.example", PUBLIC)]


# == 6. inspection: the existing package path decides what a candidate is =======
def test_scenario_a_webair_discovered_then_inspected(web, tmp_path):
    publish_webair(web)
    control = plane(tmp_path, web)
    result = control.discover_website(f"{WEBAIR}/")
    (url,) = accepted(result)
    assert web.paths() == ["/"]
    assert control.list_sessions()["sessions"] == []  # Discovery opened nothing.
    summary = control.open_url(url)
    assert web.paths() == ["/", "/agent.pkg"]
    assert summary["source"] == {
        "kind": "url",
        "display": f"{WEBAIR}/agent.pkg",
        "opened_at": summary["source"]["opened_at"],
    }
    assert summary["package"]["package_id"] == "org.webagents.webair"
    assert summary["package"]["digest"] == WEBAIR_DIGEST
    assert summary["snapshot"]["archive_sha256"] == WEBAIR_ARCHIVE_SHA256
    assert summary["validation"]["container_status"] == "valid"
    assert summary["validation"]["integrity_status"] == "valid"
    assert summary["validation"]["schema_status"] == "valid"
    assert summary["validation"]["runtime_status"] == "compatible"
    assert summary["publisher"]["signature_status"] == "valid"
    assert summary["publisher"]["signer_fingerprint"] == WEBAIR_FINGERPRINT
    # Reachable over HTTPS, advertised by its own origin, validly signed: still unknown.
    assert summary["publisher"]["trust_status"] == "unknown"
    pin_webair(control)
    assert control.summary(summary["session"]["id"])["publisher"]["trust_status"] == "trusted"


def test_scenario_b_an_ordinary_website(web, tmp_path):
    web.serve("https://blog.example/", page('<link rel="alternate" href="/feed.xml">'))
    control = plane(tmp_path, web)
    result = control.discover_website("https://blog.example/")
    assert result["discovery_status"] == "no_candidate"
    assert control.list_sessions()["sessions"] == []


def test_scenario_c_a_cross_origin_advertisement_is_never_fetched(web, tmp_path):
    web.serve(
        "https://victim.example/",
        page(link("https://other.example/evil.agent.pkg", type_=PACKAGE_MEDIA_TYPE)),
    )
    web.serve("https://other.example/evil.agent.pkg", WEBAIR_ARCHIVE.read_bytes())
    result = plane(tmp_path, web).discover_website("https://victim.example/")
    assert result["discovery_status"] == "candidates_rejected"
    (candidate,) = result["candidates"]
    assert candidate["accepted"] is False and candidate["same_origin"] is False
    assert candidate["rejection_reason"] == "cross_origin"
    assert candidate["resolved_url"] == "https://other.example/evil.agent.pkg"
    assert web.paths("other.example") == []
    assert "other.example" not in web.resolved


@pytest.mark.parametrize(
    "served,layer",
    [
        (b"PK\x03\x04 this is not an archive", "container_status"),
        (WEBAIR_SITE["pages"][0]["html"].encode(), "container_status"),
    ],
)
def test_scenario_d_an_invalid_package_fails_inspection_normally(web, tmp_path, served, layer):
    publish_webair(web, archive=served)
    control = plane(tmp_path, web)
    (url,) = accepted(control.discover_website(f"{WEBAIR}/"))
    with pytest.raises(ControlPlaneError) as error:
        control.open_url(url)
    assert error.value.code == "package_rejected"
    assert error.value.details["validation"][layer] == "invalid"
    assert control.list_sessions()["sessions"] == []


def test_scenario_d_a_package_url_that_redirects_is_refused_as_before(web, tmp_path):
    web.serve("https://moved.example/", page(link("/agent.pkg")))
    web.redirect("https://moved.example/agent.pkg", "/v2/agent.pkg")
    control = plane(tmp_path, web)
    (url,) = accepted(control.discover_website("https://moved.example/"))
    with pytest.raises(ControlPlaneError) as error:
        control.open_url(url)
    assert error.value.code == "download_redirect_denied"


def test_scenario_d_a_tampered_signature_stays_invalid(web, tmp_path):
    publish_webair(web, archive=tampered_webair())
    control = plane(tmp_path, web)
    pin_webair(control)
    (url,) = accepted(control.discover_website(f"{WEBAIR}/"))
    summary = control.open_url(url)
    assert summary["validation"]["integrity_status"] == "valid"
    assert summary["publisher"]["signature_status"] == "invalid"
    assert summary["publisher"]["trust_status"] == "unknown"
    assert summary["publisher"]["trust_reason"] == "no_valid_signature"


def test_scenario_e_a_valid_signature_from_an_unknown_key_stays_untrusted(web, tmp_path):
    publish_webair(web, archive=resigned_webair(tmp_path))
    control = plane(tmp_path, web)
    (url,) = accepted(control.discover_website(f"{WEBAIR}/"))
    summary = control.open_url(url)
    assert summary["publisher"]["signature_status"] == "valid"
    assert summary["publisher"]["signer_fingerprint"] != WEBAIR_FINGERPRINT
    assert summary["publisher"]["trust_status"] == "unknown"
    assert "publisher_unknown" in {item["code"] for item in summary["warnings"]}
    # With WebAir's real key pinned, the same bytes are an impersonation attempt.
    pin_webair(control)
    publisher = control.summary(summary["session"]["id"])["publisher"]
    assert publisher["trust_status"] == "mismatch"
    assert publisher["trust_reason"] == "claimed_publisher_pinned_to_other_key"


def test_a_second_unrelated_origin_travels_the_same_path(web, tmp_path):
    """Nothing in discovery knows WebAir: another site, another package, the same code."""
    agenda = ROOT / "dist/meeting-agenda.agent.pkg"
    web.serve(
        "https://meetings.example/team/",
        page(link("tools/agenda.agent.pkg", type_=PACKAGE_MEDIA_TYPE)),
    )
    web.serve("https://meetings.example/team/tools/agenda.agent.pkg", agenda.read_bytes())
    control = plane(tmp_path, web)
    result = control.discover_website("https://meetings.example/team/")
    assert accepted(result) == ["https://meetings.example/team/tools/agenda.agent.pkg"]
    summary = control.open_url(accepted(result)[0])
    assert summary["package"]["package_id"] == "org.webagents.meeting-agenda"
    assert summary["publisher"]["signature_status"] == "valid"
    assert summary["publisher"]["trust_status"] == "unknown"


# == 7. security regressions =====================================================
def test_a_website_cannot_become_trusted_by_being_reachable(web, tmp_path):
    publish_webair(web)
    control = plane(tmp_path, web)
    store = tmp_path / "trust.json"
    control.discover_website(f"{WEBAIR}/")
    assert not store.exists()
    pin_webair(control)
    before = store.read_bytes()
    result = control.discover_website(f"{WEBAIR}/")
    assert store.read_bytes() == before  # Discovery never touches trust.
    assert result["trust"] == {
        "conveys": "location_only",
        "package_verified": False,
        "publisher_trusted": False,
        "permissions_granted": False,
        "note": result["trust"]["note"],
    }
    # Trust is the key's, not the origin's: another origin serving WebAir's bytes
    # gets the same verdict, and WebAir's origin serving a stranger's bytes does not.
    web.serve("https://mirror.example/", page(link()))
    web.serve("https://mirror.example/agent.pkg", WEBAIR_ARCHIVE.read_bytes())
    mirrored = control.open_url(accepted(control.discover_website("https://mirror.example/"))[0])
    assert mirrored["publisher"]["trust_status"] == "trusted"


def test_a_page_cannot_grant_permissions(web, tmp_path):
    head = (
        '<link rel="agent-package" href="/agent.pkg" data-permissions="all" data-grant="session" '
        'data-approve-tools="*"><meta name="agent-permissions" content="network.webair=session">'
    )
    web.serve("https://webair.example/", page(head))
    web.serve("https://webair.example/agent.pkg", WEBAIR_ARCHIVE.read_bytes())
    control = plane(tmp_path, web)
    result = control.discover_website("https://webair.example/")
    assert set(result["candidates"][0]) == {
        "index",
        "href",
        "type_hint",
        "resolved_url",
        "same_origin",
        "accepted",
        "rejection_reason",
        "rejection_message",
    }
    summary = control.open_url(accepted(result)[0])
    request = control.permissions(summary["session"]["id"])
    assert {item["decision"] for item in request["permissions"]} == {"deny"}
    assert len(request["tool_approvals"]) == 4
    assert all(item["decision"] is False for item in request["tool_approvals"])


def test_a_website_cannot_cause_execution(web, tmp_path):
    publish_webair(web)
    control = plane(tmp_path, web)
    result = control.discover_website(f"{WEBAIR}/")
    assert result["execution"]["performed"] is False
    assert result["execution"]["package_fetched"] is False
    assert control.list_sessions()["sessions"] == []
    assert not [path for path in (tmp_path / "cache").iterdir()]
    assert web.paths() == ["/"]
    assert control.status()["capabilities"]["execute"] is False


def test_discovery_cannot_be_pointed_at_this_machine(web, tmp_path):
    control = plane(tmp_path, web)
    for url in ("https://localhost/", "https://127.0.0.1:443/", "https://[::1]/"):
        with pytest.raises(ControlPlaneError) as error:
            control.discover_website(url)
        assert error.value.code == "url_destination_denied"
    for url in ("http://127.0.0.1:8040/", "http://localhost:8040/"):
        with pytest.raises(ControlPlaneError) as error:
            control.discover_website(url)
        assert error.value.code == "url_rejected"
    web.redirect("https://public.example/", "https://127.0.0.1/")
    with pytest.raises(ControlPlaneError) as error:
        control.discover_website("https://public.example/")
    assert error.value.code == "discovery_redirect_refused"
    assert web.connections == [("public.example", PUBLIC)]


def test_a_discovered_package_cannot_choose_its_model(web, tmp_path):
    head = (
        link() + '<meta name="agent-model" content="openai/gpt-5"><meta name="model" content="x">'
    )
    web.serve("https://webair.example/", page(head))
    web.serve("https://webair.example/agent.pkg", WEBAIR_ARCHIVE.read_bytes())
    control = plane(tmp_path, web)
    pin_webair(control)
    result = control.discover_website("https://webair.example/")
    assert not any("model" in key for key in result)
    summary = control.open_url(accepted(result)[0])
    session, digest = summary["session"]["id"], summary["package"]["digest"]
    request = control.permissions(session)
    receipt = control.authorize(
        session,
        package_digest=digest,
        decisions={item["id"]: "session" for item in request["permissions"]},
        tool_approvals={item["tool_id"]: True for item in request["tool_approvals"]},
    )
    package = control._session(session).package
    for model_id in (None, ""):
        with pytest.raises(ControlPlaneError) as error:
            control.prepare_run_plan(
                session,
                package_digest=digest,
                receipt_id=receipt["receipt_id"],
                model_id=model_id,
                catalog=CATALOG,
                tool_registry=registry_for(package),
            )
        assert error.value.code == "invalid_request"
    with pytest.raises(ControlPlaneError) as error:
        control.prepare_run_plan(
            session,
            package_digest=digest,
            receipt_id=receipt["receipt_id"],
            model_id="openai/gpt-5",
            catalog=CATALOG,
            tool_registry=registry_for(package),
        )
    assert error.value.code == "model_unknown"
    state = control.prepare_run_plan(
        session,
        package_digest=digest,
        receipt_id=receipt["receipt_id"],
        model_id="host/alpha",
        catalog=CATALOG,
        tool_registry=registry_for(package),
    )
    assert state["run_plan"]["model_binding"]["host_model_id"] == "host/alpha"


def test_authorization_and_run_plans_are_unchanged_for_a_discovered_package(web, tmp_path):
    """The same bytes opened from a file and from a discovered URL behave identically."""
    publish_webair(web)
    control = plane(tmp_path, web)
    pin_webair(control)
    discovered = control.open_url(accepted(control.discover_website(f"{WEBAIR}/"))[0])
    local = control.open_file(str(WEBAIR_ARCHIVE))

    def comparable(summary):
        return {
            key: value
            for key, value in summary.items()
            if key not in {"session", "source", "snapshot"}
        }

    assert comparable(discovered) == comparable(local)
    outcomes = []
    for summary in (discovered, local):
        session, digest = summary["session"]["id"], summary["package"]["digest"]
        request = control.permissions(session)
        denied = control.authorize(session, package_digest=digest, decisions={})
        decisions = {item["id"]: "session" for item in request["permissions"]}
        approvals = {item["tool_id"]: True for item in request["tool_approvals"]}
        granted = control.authorize(
            session, package_digest=digest, decisions=decisions, tool_approvals=approvals
        )
        with pytest.raises(ControlPlaneError) as mismatch:
            control.authorize(session, package_digest="0" * 64, decisions=decisions)
        package = control._session(session).package
        state = control.prepare_run_plan(
            session,
            package_digest=digest,
            receipt_id=granted["receipt_id"],
            model_id="host/alpha",
            catalog=CATALOG,
            tool_registry=registry_for(package),
        )
        plan = state["run_plan"]
        outcomes.append(
            {
                "permissions": [
                    (item["id"], item["required"], item["decision"])
                    for item in request["permissions"]
                ],
                "denied": (denied["runnable"], [r["code"] for r in denied["blocking_reasons"]]),
                "granted": (granted["runnable"], granted["blocking_reasons"]),
                "granted_ids": granted["granted_permission_ids"],
                "mismatch": mismatch.value.code,
                "ready": state["preflight"]["ready"],
                "bindings": [item["tool_id"] for item in plan["tool_bindings"]],
                "performed": plan["execution"]["performed"],
            }
        )
    assert outcomes[0] == outcomes[1]
    assert outcomes[0]["ready"] is True and outcomes[0]["performed"] is False


# == 8. the HTTP service ========================================================
class _Client:
    def __init__(self, service: BrowserService):
        self.base, self.token = service.url, service.token

    def __call__(self, method, path, body=None, *, token=True, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method)
        if token:
            request.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())


@pytest.fixture
def service(web, tmp_path):
    instance = BrowserService(plane(tmp_path, web), host="127.0.0.1", port=0)
    instance.start_background()
    try:
        yield instance
    finally:
        instance.shutdown()
        instance.server_close()


def test_the_route_reports_a_page_and_creates_nothing(web, service):
    publish_webair(web)
    call = _Client(service)
    status, result = call("POST", "/v0/websites/discover", {"url": f"{WEBAIR}/"})
    assert status == 200
    assert result["discovery_status"] == "candidate"
    assert accepted(result) == [f"{WEBAIR}/agent.pkg"]
    assert call("GET", "/v0/packages")[1]["sessions"] == []
    status, info = call("GET", "/v0/status")
    assert info["capabilities"]["discover_website"] is True
    assert info["website_discovery"]["rel"] == "agent-package"
    assert info["website_discovery"]["same_origin_required"] is True


def test_the_route_is_strict(web, service):
    call = _Client(service)
    assert call("GET", "/v0/websites/discover")[0] == 405
    assert call("POST", "/v0/websites/discover", {})[1]["error"]["code"] == "invalid_request"
    status, body = call("POST", "/v0/websites/discover", {"url": f"{WEBAIR}/", "follow": True})
    assert (status, body["error"]["code"]) == (400, "unknown_field")
    assert call("POST", "/v0/websites/discover", {"url": 7})[1]["error"]["code"] == "url_rejected"
    status, body = call("POST", "/v0/websites/discover", {"url": f"{WEBAIR}/"}, token=False)
    assert (status, body["error"]["code"]) == (401, "unauthorized")
    status, body = call(
        "POST", "/v0/websites/discover", {"url": f"{WEBAIR}/"}, headers={"Origin": "https://x"}
    )
    assert (status, body["error"]["code"]) == (403, "browser_request_refused")
    status, body = call("POST", "/v0/websites/discover", {"url": "https://127.0.0.1/"})
    assert (status, body["error"]["code"]) == (403, "url_destination_denied")
    assert web.connections == []


def test_a_refusal_keeps_its_details_over_http(web, service):
    web.redirect("https://old.example/", "https://new.example/")
    status, body = _Client(service)(
        "POST", "/v0/websites/discover", {"url": "https://old.example/"}
    )
    assert status == 502
    assert body["error"]["code"] == "discovery_redirect_refused"
    assert body["error"]["details"] == {
        "reason": "cross_origin",
        "location": "https://new.example/",
    }


# == 9. the killable child (no seam, no network) ================================
def test_without_a_seam_discovery_runs_in_a_child_under_the_same_policy():
    """`localhost` is resolved by the real resolver inside the child, and refused there."""
    started = time.monotonic()
    with pytest.raises(ControlPlaneError) as error:
        discover_website("https://localhost/")
    assert error.value.code == "url_destination_denied"
    assert error.value.status == 403
    assert time.monotonic() - started < 30


def test_a_syntax_refusal_never_starts_a_child(monkeypatch):
    import agentpkg.browser.discovery as discovery

    def never(*args, **kwargs):
        raise AssertionError("no child may start for a refused URL")

    monkeypatch.setattr(discovery, "run_in_killable_child", never)
    for url in ("http://webair.example/", "https://user@webair.example/", "https://x:1/"):
        with pytest.raises(ControlPlaneError) as error:
            discover_website(url)
        assert error.value.code == "url_rejected"


def test_the_shared_child_still_runs_package_downloads(tmp_path):
    destination = tmp_path / "out.bin"
    destination.touch()
    with pytest.raises(ControlPlaneError) as error:
        download_to_file(
            "https://localhost/a.agent.pkg", destination, limits=FetchLimits(timeout_seconds=10)
        )
    assert error.value.code == "url_destination_denied"
    assert destination.read_bytes() == b""


# == 10. genericity ===============================================================
def test_discovery_code_names_no_site_package_or_publisher():
    browser = ROOT / "agentpkg/src/agentpkg/browser"
    for module in sorted(browser.glob("*.py")):
        # The profiles extension's key is a format identifier the spec defines
        # (`spec/extensions/profiles-v0.md`), not a site, package or publisher.
        text = module.read_text().lower().replace("org.webagents:profiles-v0", "")
        for word in ("webair", "org.webagents", "airline", "webair-demo"):
            assert word not in text, f"{module.name} mentions {word}"
