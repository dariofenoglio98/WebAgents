"""Deterministic, minimal PDF documents for parser tests.

Each page carries its text as Helvetica `Tj` operations, so `pypdf` extracts
exactly what was written. The byte layout (and therefore the SHA-256) depends
only on the arguments. Nothing here is a real paper.
"""

from __future__ import annotations


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def make_pdf(pages: list[list[str]] | list[str]) -> bytes:
    """Build a PDF whose page N shows the given lines, top to bottom."""
    normalized = [[page] if isinstance(page, str) else list(page) for page in pages]
    count = len(normalized)
    font_number = 3 + 2 * count
    objects: list[bytes] = []
    kids = " ".join(f"{3 + 2 * index} 0 R" for index in range(count))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode())
    for index, lines in enumerate(normalized):
        content_number = 4 + 2 * index
        objects.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 {font_number} 0 R >> >> "
                f"/Contents {content_number} 0 R >>"
            ).encode()
        )
        body = "BT /F1 12 Tf 72 720 Td 14 TL\n" + "\n".join(
            f"({_escape(line)}) Tj T*" for line in lines
        )
        body += "\nET"
        stream = body.encode("latin-1")
        objects.append(
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(out)


__all__ = ["make_pdf"]
