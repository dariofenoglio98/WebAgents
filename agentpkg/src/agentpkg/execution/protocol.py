"""The private execution wire contract, and the two descriptors it replaces.

The execution session reuses the host bridge's framing — one JSON object per
line, bounded, correlated, cancellable — and changes exactly two things.

**A different protocol version.** A probe parent and an execution child can
never complete a handshake, because each peer refuses a frame carrying any
version but its own. Two components that spend money should not be able to
mistake each other for one another.

**A different method set, and no filesystem vocabulary at all.**

    OpenClaw plugin backend (parent)          agentpkg execution runner (child)
    ────────────────────────────────          ─────────────────────────────────
    execution.begin / run / cancel / end  ──▶  stdin      (fd 0)
    model.count_tokens / model.complete    ◀──  stdout     (fd 1)
    logs, diagnostics, tracebacks          ◀──  stderr     (fd 2)
    the immutable package archive          ──▶  PACKAGE_FD (fd 3, read-only)
    the run's artifact directory           ──▶  ARTIFACTS_FD (fd 4, a directory)

There is no path, no filename, no model identifier and no OpenClaw method name
anywhere in a frame. The child cannot open the package from anywhere else,
because it never learns where the package is; it cannot write outside the run's
artifact directory, because it never learns where that is either. Both
descriptors are opened by the trusted parent and inherited, so the only things
this process can read and write are the two the parent chose.
"""

from __future__ import annotations

from ..hostbridge.protocol import HOST_METHODS

EXECUTION_PROTOCOL_VERSION = "agentpkg-execution/0.1"

# Requests the parent may send to the runner. Nothing else exists, and none of
# them can name a prompt, a schema, a model or a file.
EXECUTION_METHODS = frozenset(
    {"execution.begin", "execution.run", "execution.cancel", "execution.end"}
)

# Requests the runner may send to the parent: the ModelRouter operations, the
# same two the router probe already proved, and nothing more.
RUNNER_OUTBOUND_METHODS = HOST_METHODS

# Inherited descriptors. Fixed numbers rather than negotiated ones: a number
# that arrives over the wire would be a way to name a descriptor.
PACKAGE_FD = 3
ARTIFACTS_FD = 4

__all__ = [
    "ARTIFACTS_FD",
    "EXECUTION_METHODS",
    "EXECUTION_PROTOCOL_VERSION",
    "PACKAGE_FD",
    "RUNNER_OUTBOUND_METHODS",
]
