"""PDF text vectors for the Chrome paper reader (T6, D-082).

Runs the reference parser, `agentpkg.hostfiles.pdf.extract_text` (pypdf, under its
`DEFAULT_LIMITS` or the limits a case names), over deterministic minimal PDFs built by
`agentpkg/tests/pdf_fixtures.py`, the repository's probe PDF, an encrypted document and a set
of refusals, and writes each case's bytes (base64), limits and answer (pages or the refusal
reason) to `chrome-agent-browser/test/fixtures/pdf-text-vectors.json`. The Chrome reader
(pdf.js) is held to the same refusals and the same page text under the comparison rule its test
states.

    agentpkg/.venv/bin/python chrome-agent-browser/scripts/make-pdf-text-vectors.py [--out FILE]
"""

from __future__ import annotations

import argparse
import base64
import dataclasses
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))

from pdf_fixtures import make_pdf  # noqa: E402
from pypdf import PdfReader, PdfWriter  # noqa: E402

from agentpkg.hostfiles.pdf import DEFAULT_LIMITS, PdfLimits, PdfRefused, extract_text  # noqa: E402


def encrypted() -> bytes:
    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(make_pdf(["secret"]))).pages:
        writer.add_page(page)
    writer.encrypt("user-password")
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "chrome-agent-browser" / "test" / "fixtures" / "pdf-text-vectors.json"))
    args = parser.parse_args()
    small = make_pdf(["small"])
    cases = [
        ("two_pages", make_pdf([["First page, line one.", "Line two."], "Second page."]), None),
        ("punctuation", make_pdf([["Parentheses (like these) and a back\\slash.", "Quotes: \"double\" and 'single'."]]), None),
        ("latin1", make_pdf([["café naïve résumé"]]), None),
        ("many_lines", make_pdf([[f"Line {index} of a longer page." for index in range(40)]]), None),
        ("probe_file", (ROOT / "examples" / "probe-files" / "paper-reader-probe.pdf").read_bytes(), None),
        ("empty", b"", None),
        ("not_a_pdf", b"GIF89a not a pdf", None),
        ("leading_whitespace", b"   %PDF-1.4 leading whitespace", None),
        ("malformed", b"%PDF-1.4\nnot really a pdf at all\n%%EOF", None),
        ("too_large", small, {"max_bytes": len(small) - 1}),
        ("too_many_pages", make_pdf(["one", "two", "three"]), {"max_pages": 2}),
        ("page_text_too_large", make_pdf(["x" * 200]), {"max_page_text_bytes": 100}),
        ("page_text_too_large_on_page", make_pdf(["x" * 80]), {"max_page_text_bytes": 50}),
        ("text_too_large", make_pdf(["y" * 90, "z" * 90, "w" * 90]), {"max_page_text_bytes": 100, "max_total_text_bytes": 200}),
        ("encrypted", encrypted(), None),
        ("hundred_and_one_pages", make_pdf([f"p{index}" for index in range(101)]), None),
    ]
    vectors = []
    for name, data, overrides in cases:
        limits = dataclasses.replace(DEFAULT_LIMITS, **(overrides or {}))
        try:
            answer = {"pages": extract_text(data, limits)["pages"]}
        except PdfRefused as refusal:
            answer = {"refused": refusal.code}
        vectors.append(
            {
                "name": name,
                "base64": base64.b64encode(data).decode("ascii"),
                "limits": {
                    "max_bytes": limits.max_bytes,
                    "max_pages": limits.max_pages,
                    "max_page_text_bytes": limits.max_page_text_bytes,
                    "max_total_text_bytes": limits.max_total_text_bytes,
                },
                **answer,
            }
        )
    import pypdf

    document = {
        "generator": "chrome-agent-browser/scripts/make-pdf-text-vectors.py",
        "reference": "agentpkg.hostfiles.pdf.extract_text",
        "pypdf": pypdf.__version__,
        "python": sys.version.split()[0],
        "default_limits": dataclasses.asdict(PdfLimits()),
        "vectors": vectors,
    }
    Path(args.out).write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {args.out}: {len(vectors)} vectors (pypdf {pypdf.__version__})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
