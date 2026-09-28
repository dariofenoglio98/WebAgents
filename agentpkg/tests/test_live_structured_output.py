"""Opt-in live acceptance: a real hosted model on the exact Literature Review schemas.

Offline CI never runs this: it spends real tokens. Enable it with

    AGENTPKG_TEST_LIVE_MODEL=openai/gpt-5.6-luna \
    AGENTPKG_TEST_LIVE_CALLS=10 \
        .venv/bin/python -m pytest tests/test_live_structured_output.py -q

The request is rendered by `HostBridgeModelRouter`'s own `render` from the
shipped package — the screen node's bundled `$ref`-rooted schema, the
ScreeningWorker's signed skills and the package's own fixture input — and sent
through the installed OpenClaw by `scripts/structured-output-probe.mjs`, which
calls the plugin's `completeWithBoundModel`. Every real answer is then replayed
into `HostBridgeModelRouter.complete`, so the production classification and
validation code decides whether it conforms. Nothing is relaxed for the probe.

Only the probe's own temporary files ever hold model text; the assertion
messages carry stop reasons, usage and failure facts only.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import types
from pathlib import Path

import pytest
from shipped_keys import DIST

from agentpkg.hostbridge.errors import BridgeError
from agentpkg.hostbridge.router import HostBridgeModelRouter, render
from agentpkg.package import load_package
from agentpkg.workflow import Workflow

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "openclaw-agent-browser/scripts/structured-output-probe.mjs"
MODEL = os.environ.get("AGENTPKG_TEST_LIVE_MODEL")
CALLS = int(os.environ.get("AGENTPKG_TEST_LIVE_CALLS", "10"))

pytestmark = pytest.mark.skipif(
    not MODEL or not shutil.which("node") or not shutil.which("openclaw"),
    reason="Live structured-output acceptance is opt-in: AGENTPKG_TEST_LIVE_MODEL=<provider/model>",
)


class Replay:
    """A peer that answers `model.complete` with recorded real host answers."""

    def __init__(self, answers):
        self.answers = list(answers)

    async def call(self, method, params, *, timeout=None):
        if method == "model.count_tokens":
            return {"supported": False, "detail": "replay"}
        return self.answers.pop(0)


def binding(model_id: str) -> dict:
    provider, _, model = model_id.partition("/")
    return {
        "host_model_id": model_id,
        "provider_id": provider,
        "model_id": model,
        "capabilities": {"reasoning": {"value": True, "basis": "declared"}},
        "limits": {"context_tokens": 200000},
        "properties": {"local": False},
    }


def screen_request() -> tuple[dict, int]:
    package = load_package(DIST["literature-review"])
    node = next(
        step
        for node in package.graph["nodes"]
        if node["type"] == "map"
        for step in node["steps"]
        if step.get("task") == "screen"
    )
    roles = {role["id"]: role for role in package.graph["workers"]}
    skills = {skill["id"]: skill["path"] for skill in package.manifest["skills"]}
    fixture = json.loads(package.files["fixtures/workflow.json"])["models"]["screen"][0]
    request = {
        "task": "screen",
        "instructions": [
            package.files[skills[s]].decode() for s in roles["ScreeningWorker"]["skills"]
        ],
        "data": fixture["input"],
        "output_schema": Workflow._model_schema(
            types.SimpleNamespace(package=package), node["output_schema"]
        ),
    }
    return request, node["max_output_tokens"]


def test_a_live_model_conforms_to_the_exact_screen_schema(tmp_path):
    request, cap = screen_request()
    rendered = render(request)
    requests = tmp_path / "requests.json"
    requests.write_text(
        json.dumps(
            {
                "screen": {
                    "system": rendered["system"],
                    "user": rendered["user"],
                    "output_schema": rendered["output_schema"],
                    "max_output_tokens": cap,
                    "reasoning": "low",
                }
            }
        )
    )
    answers_path = tmp_path / "answers.jsonl"
    subprocess.run(
        [
            "node",
            str(PROBE),
            "--requests",
            str(requests),
            "--case",
            "screen",
            "--model",
            MODEL,
            "--count",
            str(CALLS),
            "--concurrency",
            "3",
            "--out",
            str(answers_path),
        ],
        check=True,
        timeout=60 + CALLS * 120,
        capture_output=True,
    )
    answers = [json.loads(line) for line in answers_path.read_text().splitlines()]
    assert len(answers) == CALLS
    host_errors = [a["error"] for a in answers if "error" in a]
    assert not host_errors, host_errors

    router = HostBridgeModelRouter(Replay(answers), binding(MODEL))
    outcomes = []
    for answer in answers:
        # Exact-model binding holds for every call, not just the first.
        assert answer["model_id"] == MODEL
        try:
            asyncio.run(router.complete(request, max_output_tokens=cap))
            outcomes.append({"ok": True, "stop_reason": answer["stop_reason"]})
        except BridgeError as exc:
            outcomes.append({"ok": False, "code": exc.code, **exc.audit_facts})
    failures = [o for o in outcomes if not o["ok"]]
    usage = [(a["usage"]["input_tokens"], a["usage"]["output_tokens"]) for a in answers]
    assert not failures, {"failures": failures, "calls": CALLS, "usage": usage}
