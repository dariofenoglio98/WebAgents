"""Which public key signed which shipped artifact.

The two reference artifacts are no longer signed by one key, and each current
one has its own. `meeting-agenda` 0.2.1 and `literature-review` 0.2.1 each carry
a **package-specific development signing key**, because the original key's
private half does not exist on any machine this project builds on and both
packages' local-model timing policy had to change (see
`docs/package-execution-report.md` and `docs/literature-review-execution-report.md`).
The original key still signs the preserved 0.2.0 artifacts and the legacy
package, untouched.

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

#: The original development key. Signs the preserved 0.2.0 artifacts and the
#: legacy package.
ORIGINAL_KEY = ROOT / "examples/keys/workflow-publisher.pub.pem"
ORIGINAL_FINGERPRINT = "sha256:c7549e614dac7070e6b5b5355e7c2407e1185f831d7fff15670981229dd85a70"

#: The rotated development key. Signs `meeting-agenda` 0.2.1 and nothing else.
AGENDA_KEY = ROOT / "examples/keys/meeting-agenda-publisher.pub.pem"
AGENDA_FINGERPRINT = "sha256:2bcc374a7fe18e50622042b7d0375fcb24eb3607879a236f9f3c3ede1922c5c4"

#: The Literature Review key. Signs `literature-review` 0.2.1 and nothing else.
LITERATURE_KEY = ROOT / "examples/keys/literature-review-publisher.pub.pem"
LITERATURE_FINGERPRINT = "sha256:c5ca9763f9fc71253298ca381ec14c4d7432009c74dacc69df6344b71de05232"

SIGNER_KEY = {
    "literature-review": LITERATURE_KEY,
    "meeting-agenda": AGENDA_KEY,
}

SIGNER_FINGERPRINT = {
    "literature-review": LITERATURE_FINGERPRINT,
    "meeting-agenda": AGENDA_FINGERPRINT,
}

#: The narrowest prefix each pin may carry while still covering its artifact.
PACKAGE_ID = {
    "literature-review": "org.webagents.literature-review",
    "meeting-agenda": "org.webagents.meeting-agenda",
}
