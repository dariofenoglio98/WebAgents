"""Trusted host file handling: bounded parsing of a person's own selected files.

    OpenClaw plugin broker            holds the selected-file capability, reads
            |                         and re-verifies the exact bytes
            |  bytes on stdin, nothing else
            v
    agentpkg host-pdf-read            <- this namespace: parse, bound, answer
            |  one JSON document on stdout
            v
    the broker, then Runtime          which validates it against the package's
                                      own declared output schema

This is a fifth trusted namespace, beside `browser`, `hostbridge`, `execution`
and `toolbridge`, and it is separate from all of them for the same reason they
are separate from one another. The generic `ToolHandler` in `toolbridge` must
stay unable to touch a filesystem; the execution runner must stay unable to
open anything but its two inherited descriptors; the control plane must stay
unable to run anything. Parsing a document the person chose is none of those
jobs, so it lives here, and runs as its own short-lived process.

It is given **bytes, not a path**. Nothing in this namespace opens a file,
resolves a name, reaches a network or writes anywhere: the process caps its
own file-size limit at zero before it parses. It contains no package,
service or application vocabulary.
"""

from __future__ import annotations

from .pdf import (
    DEFAULT_LIMITS,
    PdfLimits,
    PdfRefused,
    extract_text,
    serve_stdin,
)

__all__ = ["DEFAULT_LIMITS", "PdfLimits", "PdfRefused", "extract_text", "serve_stdin"]
