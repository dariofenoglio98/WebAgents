"""E3's TS-L PDF placement (PROTOCOL.md §3 E3, D-360): a selected PDF whose text carries the
payload.

Each TS-L question has one real, relevant arXiv paper (`documents.json`): the run's input names
it as a **seed** (the person's own hint, `seeds`) and selects a **stand-in PDF** for its DOI
(`documents`), so Literature Review resolves the seed, attaches the file and reads it
(`paper-reader`) in its screening and evidence steps. The stand-in is built here, deterministically,
from the paper's arXiv metadata (title, authors, abstract; arXiv's metadata is CC0) with the
arm's text appended after the abstract as a "Note" paragraph; the same bytes on every side (rule
5), hashed into the run's record. The writer is a minimal PDF 1.4 (one Helvetica font, wrapped
lines, as many pages as needed); `agentpkg`'s own reader (`hostfiles.pdf.extract_text`, pypdf)
reads it back (tests/test_documents.py).
"""

from __future__ import annotations

import hashlib
import json
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES = HERE / "documents.json"
PLACEMENT = "pdf.text"
LINE_WIDTH = 92
LINES_PER_PAGE = 54


def sources() -> dict:
    return json.loads(SOURCES.read_text())["questions"]


def sources_sha256() -> str:
    return hashlib.sha256(SOURCES.read_bytes()).hexdigest()


def document_text(question_id: str, insertion: str | None) -> str:
    """The stand-in's text: title, authors, abstract, and the arm's text as a note."""
    paper = sources()[question_id]
    parts = [paper["title"], ", ".join(paper["authors"]), "", "Abstract", paper["abstract"]]
    if insertion:
        parts += ["", "Note", insertion.strip()]
    return "\n".join(parts)


def _escape(line: str) -> str:
    safe = line.encode("latin-1", "replace").decode("latin-1")
    return safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def pdf_bytes(text: str) -> bytes:
    """A deterministic PDF 1.4 of `text` (no dates, no ids): one Helvetica font, wrapped lines."""
    lines: list[str] = []
    for paragraph in text.split("\n"):
        lines += textwrap.wrap(paragraph, LINE_WIDTH) or [""]
    pages = [lines[i : i + LINES_PER_PAGE] for i in range(0, len(lines), LINES_PER_PAGE)] or [[]]
    objects: list[bytes] = []
    kids = []
    font_ref = 3 + 2 * len(pages)
    for index, page in enumerate(pages):
        page_obj, content_obj = 3 + 2 * index, 4 + 2 * index
        kids.append(f"{page_obj} 0 R")
        stream = (
            "BT /F1 10 Tf 12 TL 56 760 Td\n"
            + "".join(f"({_escape(line)}) Tj T*\n" for line in page)
            + "ET\n"
        )
        data = stream.encode("latin-1")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_obj} 0 R "
            f"/Resources << /Font << /F1 {font_ref} 0 R >> >> >>".encode()
        )
        objects.append(f"<< /Length {len(data)} >>\nstream\n".encode() + data + b"endstream")
    body = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(pages)} >>".encode(),
        *objects,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, obj in enumerate(body, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(body) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    out += f"trailer\n<< /Size {len(body) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def selected_for(question_id: str, insertion: str | None, directory: Path) -> tuple[dict, list]:
    """The run's selection and seeds: (`{doi: (file_id, path)}`, `[doi]`), the stand-in written
    into `directory` (the run's own directory)."""
    paper = sources()[question_id]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{paper['file_id']}.pdf"
    path.write_bytes(pdf_bytes(document_text(question_id, insertion)))
    return {paper["doi"]: (paper["file_id"], path)}, [paper["doi"]]
