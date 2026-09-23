"""Which public key signed which shipped artifact.

The two reference artifacts are no longer signed by one key. `meeting-agenda`
0.2.1 carries a **rotated development signing key**, because the original key's
private half does not exist on any machine this project builds on and the
package's local-model timing policy had to change (see
`docs/package-execution-report.md`). `literature-review` still carries the
original key, untouched.

Tests that open a shipped artifact must pin the key that actually signed *that*
artifact. Pinning the wrong one is not a weaker assertion, it is a different
one: the trust store answers `mismatch`, because a second key claiming an
already-pinned publisher id is exactly the impersonation signal it exists to
raise.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

DIST = {
    "literature-review": ROOT / "dist/literature-review.agent.pkg",
    "meeting-agenda": ROOT / "dist/meeting-agenda.agent.pkg",
}

#: The original development key. Signs `literature-review`.
ORIGINAL_KEY = ROOT / "examples/keys/workflow-publisher.pub.pem"
ORIGINAL_FINGERPRINT = "sha256:c7549e614dac7070e6b5b5355e7c2407e1185f831d7fff15670981229dd85a70"

#: The rotated development key. Signs `meeting-agenda` 0.2.1 and nothing else.
AGENDA_KEY = ROOT / "examples/keys/meeting-agenda-publisher.pub.pem"
AGENDA_FINGERPRINT = "sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4"

SIGNER_KEY = {
    "literature-review": ORIGINAL_KEY,
    "meeting-agenda": AGENDA_KEY,
}

SIGNER_FINGERPRINT = {
    "literature-review": ORIGINAL_FINGERPRINT,
    "meeting-agenda": AGENDA_FINGERPRINT,
}

#: The narrowest prefix each pin may carry while still covering its artifact.
PACKAGE_ID = {
    "literature-review": "org.webagents.literature-review",
    "meeting-agenda": "org.webagents.meeting-agenda",
}
