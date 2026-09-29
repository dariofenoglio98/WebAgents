"""Tool structural facts survive the real IPC/audit boundary without service data."""

import asyncio
import json

import pytest
from test_tool_execution import ToolHarness
from tool_fakes import ECHO_TOOL, FakeToolHost

from agentpkg.hostbridge.errors import BridgeError
from agentpkg.runtime import failure_reason
from agentpkg.toolbridge.errors import ToolBridgeError
from agentpkg.toolbridge.facts import safe_tool_facts


@pytest.mark.parametrize(
    "stage",
    [
        "transport",
        "status",
        "content_type",
        "body_size",
        "json_parse",
        "input_schema",
        "output_schema",
        "adapter_response",
        "timeout",
        "tls",
        "address_policy",
        "cancelled",
    ],
)
def test_structural_facts_reach_audit_over_real_ipc(tmp_path, stage):
    facts = {
        "stage": stage,
        "http_status": 502,
        "content_type": "html",
        "response_bytes": 27,
        "body": "PRIVATE BODY",
        "authorization": "Bearer SECRET",
        "url": "https://secret.test",
    }

    async def execute():
        host = FakeToolHost(
            answers={},
            fail_with=BridgeError(
                "tool_response_invalid", "A host refusal", detail={"failure_facts": facts}
            ),
        )
        async with ToolHarness(tmp_path, host=host) as harness:
            await harness.begin()
            result = await harness.call("execution.run", {})
            audit = json.loads((harness.artifacts / "audit.json").read_text())
            return result, audit, harness.artifacts

    result, audit, artifacts = asyncio.run(execute())
    assert result["status"] == "failed"
    event = next(e for e in audit if e["action"] == "tool.failed")
    assert event["reason"] == "tool_response_invalid"
    assert event["failure_facts"] == {
        "stage": stage,
        "http_status": 502,
        "content_type": "html",
        "response_bytes": 27,
    }
    serialized = json.dumps(result) + "".join(p.read_text() for p in artifacts.glob("*.json"))
    for secret in ["PRIVATE BODY", "Bearer SECRET", "secret.test"]:
        assert secret not in serialized


def test_output_schema_failure_records_keyword_and_depth_not_data(tmp_path):
    async def execute():
        host = FakeToolHost(answers={ECHO_TOOL: lambda args: {"value": {"PRIVATE": "SECRET"}}})
        async with ToolHarness(tmp_path, host=host) as harness:
            await harness.begin()
            result = await harness.call("execution.run", {})
            return result, json.loads((harness.artifacts / "audit.json").read_text())

    result, audit = asyncio.run(execute())
    assert result["error_code"] == "schema_validation"
    event = next(e for e in audit if e["action"] == "tool.failed")
    assert event["failure_facts"] == {
        "stage": "output_schema",
        "schema_keyword": "type",
        "schema_depth": 3,
        "instance_depth": 1,
    }
    assert "PRIVATE" not in json.dumps(audit) and "SECRET" not in json.dumps(result)


def test_closed_facts_refuse_token_shaped_secrets_and_bad_counts():
    assert (
        safe_tool_facts(
            {
                "stage": "sk-secret",
                "content_type": "sk-secret",
                "schema_keyword": "sk-secret",
                "response_bytes": -1,
                "http_status": True,
                "timeout": "true",
            }
        )
        == {}
    )
    error = ToolBridgeError("tool_response_invalid", "fixed", audit_facts={"stage": "json_parse"})
    assert failure_reason(error)["failure_facts"] == {"stage": "json_parse"}
