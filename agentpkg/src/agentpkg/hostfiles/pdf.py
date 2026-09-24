"""Bounded page-text extraction from PDF bytes.

One function does the parsing, and two callers use it: the process entry point
below (`agentpkg host-pdf-read`, which the Agent Browser's tool broker spawns
per call) and the legacy development CLI's killable child in `agentpkg.tools`.
Keeping one parser means one set of limits to reason about, not two drifting
copies.

What it refuses, before or during parsing, with a stable reason each:

* anything larger than the byte limit, or not beginning with `%PDF-`;
* an encrypted document;
* more pages than the page limit;
* one page whose extracted text exceeds the per-page limit;
* more extracted text in total than the total limit.

What it never does: OCR, render, run JavaScript, follow a link, fetch a remote
resource, extract an embedded attachment, or write a file. `pypdf`'s
`extract_text` reads the content streams of each page and nothing else.

These are resource bounds for a trusted parser in a killable process, not an
operating-system sandbox. On macOS the address-space limit may be refused by
the kernel; the parent's wall-clock deadline and output cap still apply.
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
from dataclasses import dataclass

PDF_MAGIC = b"%PDF-"


@dataclass(frozen=True)
class PdfLimits:
    max_bytes: int = 20 * 1024 * 1024
    max_pages: int = 100
    max_page_text_bytes: int = 64 * 1024
    # The answer travels as one bounded frame to a package whose tool output
    # is capped at 512 KiB; the text must fit with room for its JSON escaping.
    max_total_text_bytes: int = 256 * 1024
    cpu_seconds: int = 10
    address_space_bytes: int = 1024 * 1024 * 1024


DEFAULT_LIMITS = PdfLimits()


class PdfRefused(Exception):
    """A document this parser will not read, with a stable reason code."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def extract_text(data: bytes, limits: PdfLimits = DEFAULT_LIMITS) -> dict:
    """Return `{pages, sha256, source}` for one PDF, or raise `PdfRefused`."""
    if not isinstance(data, bytes | bytearray):
        raise PdfRefused("not_bytes")
    if len(data) == 0:
        raise PdfRefused("empty")
    if len(data) > limits.max_bytes:
        raise PdfRefused("too_large")
    if not bytes(data[: len(PDF_MAGIC)]) == PDF_MAGIC:
        raise PdfRefused("not_a_pdf")
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(bytes(data)), strict=True)
        if reader.is_encrypted:
            raise PdfRefused("encrypted")
        count = len(reader.pages)
        if count > limits.max_pages:
            raise PdfRefused("too_many_pages")
        pages, total = [], 0
        for index, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            size = len(text.encode("utf-8"))
            if size > limits.max_page_text_bytes:
                raise PdfRefused("page_text_too_large")
            total += size
            if total > limits.max_total_text_bytes:
                raise PdfRefused("text_too_large")
            pages.append({"page": index, "text": text})
    except PdfRefused:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, IndexError, AttributeError) as exc:
        raise PdfRefused("malformed_pdf") from exc
    return {
        "pages": pages,
        "sha256": hashlib.sha256(bytes(data)).hexdigest(),
        "source": "user_pdf",
    }


def _apply_process_limits(limits: PdfLimits) -> None:
    """Bound this process before it touches untrusted bytes. POSIX only."""
    try:
        import resource
    except ImportError:  # pragma: no cover - non-POSIX
        return
    resource.setrlimit(resource.RLIMIT_CPU, (limits.cpu_seconds, limits.cpu_seconds))
    # Nothing here writes a file, so the parser may not either.
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    try:
        resource.setrlimit(
            resource.RLIMIT_AS, (limits.address_space_bytes, limits.address_space_bytes)
        )
    except (ValueError, OSError):
        pass  # macOS can refuse RLIMIT_AS; the parent's deadline still applies.


def serve_stdin(limits: PdfLimits = DEFAULT_LIMITS) -> int:
    """`agentpkg host-pdf-read`: bytes on stdin, one JSON document on stdout.

    Exit 0 with `{pages, sha256, source}`; exit 3 with `{"error": reason}` for a
    refused document; exit 4 with `{"error": "parse_failed"}` for anything
    else. No document content ever appears in a refusal.
    """
    # The answer goes to the broker over a pipe. A regular file on stdout would
    # be caught by the zero file-size cap below and fail silently, so it is
    # refused plainly instead: this command is spawned, not run by hand.
    import os
    import stat

    mode = os.fstat(1).st_mode
    if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
        print(
            "agentpkg host-pdf-read: stdout must be a pipe from the trusted host that spawned it",
            file=sys.stderr,
        )
        return 2
    # Load the parser first, with no bytecode cache writes, so that capping the
    # file-size limit at zero below cannot catch an import writing a .pyc.
    sys.dont_write_bytecode = True
    import pypdf  # noqa: F401

    try:
        import signal

        # Past the zero file-size cap a write must fail, not kill the process.
        signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
    except (ImportError, AttributeError, ValueError):  # pragma: no cover - non-POSIX
        pass
    _apply_process_limits(limits)
    data = sys.stdin.buffer.read(limits.max_bytes + 1)
    try:
        answer, status = extract_text(data, limits), 0
    except PdfRefused as exc:
        answer, status = {"error": exc.code}, 3
    except Exception:  # noqa: BLE001 - a parser crash is a controlled refusal
        answer, status = {"error": "parse_failed"}, 4
    sys.stdout.write(json.dumps(answer, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    return status


__all__ = ["DEFAULT_LIMITS", "PdfLimits", "PdfRefused", "extract_text", "serve_stdin"]
