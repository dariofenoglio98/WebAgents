#!/usr/bin/env python3
"""Parity vectors for `src/html-text.ts`, produced by the resolver's real code.

Run with the Citation Resolver's own interpreter, so the expected values come
from the exact function (`app.providers.common.clean_text`) and CPython release
the resolver uses, not from a re-statement of it:

    (cd citation-resolver && .venv/bin/python \
        ../openclaw-agent-browser/scripts/generate-crossref-text-vectors.py)

Inputs are a curated set of markup edge cases plus every text field of a real
Crossref response captured under `test/fixtures/`. Nothing here is fetched.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
PLUGIN = HERE.parents[1]
sys.path.insert(0, str(PLUGIN.parent / "citation-resolver"))

from app.providers.common import clean_text  # noqa: E402

CURATED = [
    "plain text",
    "  leading and trailing  ",
    "tabs\tand\nnewlines\r\nand\x0bvertical\x0cfeed",
    "nbsp thin ideographic　space",
    "zero​width and bom﻿ are not whitespace",
    "file\x1cgroup\x1drecord\x1eunit\x1fseparators and nel\x85",
    "<jats:title>Abstract</jats:title><jats:p>We <jats:italic>study</jats:italic> x.</jats:p>",
    "<jats:p>First.</jats:p><jats:p>Second <jats:sub>2</jats:sub> and <jats:sup>3</jats:sup>.</jats:p>",
    "<jats:sec><jats:title>Background</jats:title><jats:p>Text</jats:p></jats:sec>",
    "Neural&#x2013;Heuristic Optimization",
    "decimal &#8211; dash",
    "&amp; &amp;amp; &lt;b&gt; &quot;q&quot; &apos;a&apos;",
    "remapped &#128; &#150; &#159;",
    "null &#0; surrogate &#xD800; beyond &#1114112; &#x110000;",
    "control &#1; &#x7f; &#xFFFE; noncharacter",
    "long &#00000000000000000000000065; digits",
    "&notit; &notin; &copy &copyright &AMP &Amp;",
    "AT&T Labs research",
    "Q&A",
    "Q&A test",
    "x &y",
    "&",
    "a&",
    "&;",
    "p < 0.05 and q <= 0.1",
    "a<b",
    "x <",
    "<3 hearts",
    "a</b>c",
    "empty </> end",
    "spaced </ p> end",
    "digit </3> end",
    "<!-- hidden -->visible",
    "visible<!-- unterminated",
    "<?xml version='1.0'?>after pi",
    "<!DOCTYPE html>after doctype",
    "<![CDATA[inside]]>after cdata",
    "<![foo[x]]>unknown marked section",
    "<!bogus>after bogus",
    "<script>var a = '<b>';</script>after script",
    "<style>p { color: red }</style>after style",
    "<script>never closed",
    "<a href='x>y'>link</a> tail",
    "<a b=c d>bare attribute</a>",
    "<a/>self closing",
    "<a / >spaced self closing",
    "unterminated <abc",
    '<a"b>odd tag</a>',
    "<p =x>equals</p>",
    "<jats:p>unterminated paragraph",
    "Café résumé \U0001d518\U0001d52b\U0001d526",
    "astral &#x1D518; reference",
    "emoji \U0001f600 text",
    "&" + "a" * 40 + ";",
    "<jats:inline-formula><mml:math><mml:mi>x</mml:mi></mml:math></jats:inline-formula> after",
    "<jats:ext-link xlink:href=\"https://example.org/a?b=1&amp;c=2\">link</jats:ext-link>",
    "<i>Italic</i> <b>bold</b> <sub>sub</sub>",
    "",
    "   ",
]


def texts_from_fixture(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    found: list[str] = []
    for item in data["message"]["items"]:
        found.extend(item.get("title") or [])
        found.extend(item.get("container-title") or [])
        if isinstance(item.get("abstract"), str):
            found.append(item["abstract"])
        for author in item.get("author") or []:
            for key in ("given", "family", "name"):
                if isinstance(author.get(key), str):
                    found.append(author[key])
    return found


def main() -> int:
    inputs = list(CURATED)
    for fixture in sorted((PLUGIN / "test" / "fixtures").glob("crossref-works-*.json")):
        inputs.extend(texts_from_fixture(fixture))
    vectors = [{"input": value, "expected": clean_text(value)} for value in inputs]
    out = PLUGIN / "test" / "fixtures" / "crossref-text-vectors.json"
    out.write_text(
        json.dumps(
            {
                "generator": "scripts/generate-crossref-text-vectors.py",
                "reference": "citation-resolver app.providers.common.clean_text",
                "python": sys.version.split()[0],
                "vectors": vectors,
            },
            ensure_ascii=True,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {out} ({len(vectors)} vectors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
