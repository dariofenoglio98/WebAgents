"""The default host a case starts from, and the experiment's own publisher keys.

Every value here mirrors the recorded production configuration
(`docs/getting-started.md`, `experiments/contract_overhead/fixtures`) unless a
comment says otherwise. A case template changes exactly the fact it is about.
"""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .paths import OPENCLAW_VERIFIED, ROOT
from .synthetic import LR_QUESTION, PDF_PAPER

PLANNED_MODEL = "ollama/qwen3:30b"
DEFAULT_MODEL = "ollama/llama3.1:8b"  # the agent default OpenClaw falls back to
REMOTE_MODEL = "openai/gpt-5.6-luna"

QWEN_ROW = {
    "id": "qwen3:30b",
    "name": "qwen3:30b",
    "provider": "ollama",
    "reasoning": True,
    "input": ["text"],
    "contextWindow": 262144,
    "contextTokens": 65536,
    "baseUrl": "http://127.0.0.1:11434",
    "compat": {
        "supportsUsageInStreaming": True,
        "supportsTools": True,
        "supportsJsonSchemaResponseFormat": True,
    },
}
LLAMA_ROW = {
    "id": "llama3.1:8b",
    "name": "llama3.1:8b",
    "provider": "ollama",
    "reasoning": False,
    "input": ["text"],
    "contextWindow": 131072,
    "contextTokens": 32768,
    "baseUrl": "http://127.0.0.1:11434",
    "compat": {"supportsTools": True, "supportsJsonSchemaResponseFormat": True},
}
LUNA_ROW = {
    "id": "gpt-5.6-luna",
    "name": "GPT-5.6 Luna",
    "provider": "openai",
    "reasoning": True,
    "input": ["text"],
    "contextWindow": 400000,
    "contextTokens": 272000,
    "baseUrl": "https://chatgpt.com/backend-api",
    "compat": {"supportsTools": True, "supportsJsonSchemaResponseFormat": True},
}

# The recorded runs' execution bounds (getting-started §3; RQ2's fixture).
EXECUTION_POLICY = {
    "totalTokens": 180000,
    "maxRemoteCalls": 45,
    "maxParallelWorkers": 3,
    "maxOutputTokensPerCall": 16000,
    "runTimeoutSeconds": 4500,
    "modelCallTimeoutSeconds": 1200,
    "requireVerifiedHostRuntime": True,
    "maxCallsPerTool": 32,
    "maxToolResponseBytes": 524288,
}
SESSION_TTL_SECONDS = 7200

MA_INPUT_PATH = ROOT / "experiments/contract_overhead/fixtures/meeting-agenda-input.json"

DECISIONS = {
    "meeting-agenda": {"model.reasoning": "session", "memory.session": "session"},
    # A selected PDF is attached in the default Literature Review case, so the
    # selected-file permission is granted (the plugin refuses otherwise).
    "literature-review": {
        "network.scholarly": "session",
        "network.citations": "session",
        "files.pdfs": "session",
        "model.reasoning": "session",
        "memory.session": "session",
    },
}
APPROVALS = {
    "meeting-agenda": {},
    "literature-review": {
        "scholarly-search": True,
        "citation-resolver": True,
        "paper-reader": True,
    },
}


def model_host() -> dict:
    return {
        "rows": [copy.deepcopy(QWEN_ROW), copy.deepcopy(LLAMA_ROW), copy.deepcopy(LUNA_ROW)],
        "routable": {"ollama": ["qwen3:30b", "llama3.1:8b"], "openai": ["gpt-5.6-luna"]},
        "picker": {"ollama": ["qwen3:30b", "llama3.1:8b"], "openai": ["gpt-5.6-luna"]},
        "default": DEFAULT_MODEL,
        "names": {},
        "plugin_llm": {"allowModelOverride": True},
        "runtime_version": OPENCLAW_VERIFIED,
    }


def experiment_definitions(built_in: list[dict]) -> list[dict]:
    """The plugin's built-in bindings, with one documented deviation.

    Crossref's public pool asks for one request per second, which the shipped
    binding honours with `minIntervalMs: 1000`. The synthetic Crossref has no
    pool to protect, so the experiment host omits that one spacing value; it is
    part of the binding digest, so every plan in the experiment binds the
    experiment host's definition consistently. Nothing else differs.
    """
    definitions = copy.deepcopy(built_in)
    for definition in definitions:
        if definition.get("toolId") == "scholarly-search":
            definition.pop("minIntervalMs", None)
    return definitions


def task_input(package: str, file_id: str | None = None) -> dict:
    if package == "meeting-agenda":
        return json.loads(MA_INPUT_PATH.read_text(encoding="utf-8"))
    return {
        "question": LR_QUESTION,
        "seeds": [],
        "documents": {PDF_PAPER.doi: file_id} if file_id else {},
        "mode": "live",
    }


@dataclass
class HostSpec:
    model_host: dict = field(default_factory=model_host)
    policy: dict = field(default_factory=lambda: dict(EXECUTION_POLICY))
    tools: dict | None = None  # operator ToolsConfig
    definitions: list[dict] | None = None  # None: experiment_definitions(built-ins)
    session_ttl_seconds: int = SESSION_TTL_SECONDS
    browser_policy: dict = field(default_factory=dict)  # BrowserPolicy overrides (none by default)

    def copy(self) -> HostSpec:
        return copy.deepcopy(self)


# -- experiment keys ---------------------------------------------------------------
KEY_LABELS = ("trusted-publisher", "unknown-publisher", "other-publisher", "impostor")


def experiment_key(seed: int, label: str) -> Ed25519PrivateKey:
    """A deterministic Ed25519 key derived in memory from the experiment seed.

    It is never written anywhere. Deriving it from the seed makes re-signed
    artifacts — and therefore the case catalog hash — reproducible.
    """
    material = hashlib.sha256(
        f"contract_enforcement experiment key\x00{seed}\x00{label}".encode()
    ).digest()
    return Ed25519PrivateKey.from_private_bytes(material)
