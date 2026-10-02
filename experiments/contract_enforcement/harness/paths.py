"""Repository locations and fixed identities the experiment depends on."""

from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXPERIMENT = HERE.parent
ROOT = EXPERIMENT.parents[1]
RESULTS = EXPERIMENT / "results"

EXPERIMENT_NAME = "contract_enforcement"
EXPERIMENT_VERSION = "1.0.0"
THREAT_MODEL_VERSION = "1.0"

AGENTPKG_SRC = ROOT / "agentpkg" / "src"
AGENTPKG_PACKAGE = AGENTPKG_SRC / "agentpkg"
PLUGIN = ROOT / "openclaw-agent-browser"
PLUGIN_SRC = PLUGIN / "src"
PLUGIN_NODE_MODULES = PLUGIN / "node_modules"
TSC = PLUGIN_NODE_MODULES / "typescript" / "bin" / "tsc"
HOST_HELPER = HERE / "host_helper.mjs"

# The OpenClaw release the plugin verifies and the recorded runs used.
OPENCLAW_VERIFIED = "2026.9.5"

PACKAGES = {
    "meeting-agenda": {
        "label": "Meeting Agenda",
        "archive": ROOT / "dist" / "meeting-agenda.agent.pkg",
        "publisher_key": ROOT / "examples" / "keys" / "meeting-agenda-publisher.pub.pem",
        "package_id": "org.webagents.meeting-agenda",
        "version": "0.2.2",
    },
    "literature-review": {
        "label": "Literature Review",
        "archive": ROOT / "dist" / "literature-review.agent.pkg",
        "publisher_key": ROOT / "examples" / "keys" / "literature-review-publisher.pub.pem",
        "package_id": "org.webagents.literature-review",
        "version": "0.2.5",
    },
}
PACKAGE_KEYS = tuple(PACKAGES)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path) -> str:
    """A repository-relative path for records; never an absolute local path."""
    try:
        return str(Path(path).resolve().relative_to(ROOT))
    except ValueError:
        return Path(path).name
