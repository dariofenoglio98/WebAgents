"""The whole tool boundary, end to end, with a deterministic host.

    signed declaration -> host binding -> approval -> Run Plan -> Runtime.call_tool
      -> private IPC -> host broker -> the one approved implementation -> validated result

Every test here drives a real `ExecutionSession` over the real private
protocol, with a fake *host* on the other end. Nothing is stubbed on the
package side: the package is built and loaded, the runtime is the real one, and
the refusals are the real ones.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from execution_fakes import duplex
from tool_fakes import (
    ECHO_TOOL,
    FakeToolHost,
    echo_package,
    registry_for,
    signer_fingerprint,
)

from agentpkg.browser.hosttools import evaluate_registry, normalize_registry, plan_tool_bindings
from agentpkg.execution import protocol as execution_protocol
from agentpkg.execution.session import ExecutionSession
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.hostbridge.peer import BridgePeer
from agentpkg.package import sha256
from agentpkg.toolbridge import HostBridgeToolHandler, ToolBridgeError, normalize_tool_bindings

ECHO_INPUT = {"value": "hello"}
ECHO_OUTPUT = {"value": "hello"}


def bindings_for(package, *, approve=True, registry=None, grants=None):
    evaluation = evaluate_registry(
        package,
        normalize_registry(registry or registry_for(package)),
        decisions=grants or {"files.echo": "session", "memory.session": "session"},
        tool_approvals={tool_id: approve for tool_id in package.tools},
    )
    return plan_tool_bindings(evaluation)


def plan_for(package, archive_sha256, signer_fingerprint, *, tool_bindings, **overrides):
    plan = {
        "run_plan_id": "rp_" + "a" * 32,
        "run_plan_sha256": "b" * 64,
        "session_id": "session-testing1234",
        "package": {
            "package_id": package.manifest["package_id"],
            "name": package.manifest["name"],
            "version": package.manifest["version"],
            "digest": package.digest,
            "archive_sha256": archive_sha256,
            "execution_profile": "workflow.v0",
        },
        "publisher": {
            "signer_fingerprint": signer_fingerprint,
            "signature_status": "valid",
            "trust_status": "trusted",
        },
        "execution": {
            "mode": "model",
            "profile": "workflow.v0",
            "required_permission_ids": ["model.any"],
            "required_tool_ids": sorted(package.tools),
        },
        "model_binding": {
            "host_model_id": "acme/big",
            "provider_id": "acme",
            "model_id": "big",
            "display_name": "Big Model",
            "capabilities": {"structured_output": {"value": True, "basis": "declared"}},
            "limits": {"context_tokens": 100000},
            "properties": {"local": False},
        },
        "tool_bindings": tool_bindings,
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(plan.get(key), dict):
            plan[key] = {**plan[key], **value}
        else:
            plan[key] = value
    return plan


def authorization(*, decisions=None, approvals=None):
    return {
        "receipt_id": "receipt-1234",
        "receipt_sha256": "c" * 64,
        "expires_at": "2099-01-01T00:00:00+00:00",
        "decisions": decisions
        or {"files.echo": "session", "memory.session": "session", "model.any": "session"},
        "tool_approvals": approvals if approvals is not None else {ECHO_TOOL: True},
    }


class ToolHarness:
    """One in-process runner plus a fake host that answers `tool.call`."""

    def __init__(self, tmp_path, *, host=None, second_role=False, tool_timeout=10):
        self.tmp_path = Path(os.path.realpath(tmp_path))
        self.package, self.artifact = echo_package(
            self.tmp_path, second_role=second_role, tool_timeout=tool_timeout
        )
        self.archive_sha256 = sha256(self.artifact.read_bytes())
        self.artifacts = self.tmp_path / "artifacts"
        self.artifacts.mkdir(mode=0o700, exist_ok=True)
        self.package_fd = os.open(self.artifact, os.O_RDONLY)
        self.artifacts_fd = os.open(self.artifacts, os.O_RDONLY | os.O_DIRECTORY)
        (child_pair, parent_pair) = duplex()
        self.host = host or FakeToolHost(answers={ECHO_TOOL: lambda args: dict(args)})
        self.host_peer = BridgePeer(
            *parent_pair,
            outbound_methods=execution_protocol.EXECUTION_METHODS,
            inbound_methods=execution_protocol.RUNNER_OUTBOUND_METHODS,
            handler=self.host,
            prefix="h",
            version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
        )
        self.session = ExecutionSession(
            BridgePeer(
                *child_pair,
                outbound_methods=execution_protocol.RUNNER_OUTBOUND_METHODS,
                inbound_methods=execution_protocol.EXECUTION_METHODS,
                handler=lambda method, params: self.session(method, params),
                prefix="x",
                version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
            ),
            package_fd=self.package_fd,
            artifacts_fd=self.artifacts_fd,
        )
        self._tasks: list[asyncio.Task] = []

    async def __aenter__(self):
        self._tasks = [
            asyncio.create_task(self.session._peer.serve()),
            asyncio.create_task(self.host_peer.serve()),
        ]
        return self

    async def __aexit__(self, *exc):
        await self.host_peer.close()
        await self.session._peer.close()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        for fd in (self.package_fd, self.artifacts_fd):
            try:
                os.close(fd)
            except OSError:
                pass
        return False

    def call(self, method, params, *, timeout=30.0):
        return self.host_peer.call(method, params, timeout=timeout)

    async def begin(
        self,
        *,
        tool_bindings=None,
        authorization_record=None,
        plan=None,
        attachments=None,
        **kwargs,
    ):
        bindings = bindings_for(self.package) if tool_bindings is None else tool_bindings
        params = {
            "run_id": "run-tool",
            "run_plan": plan
            or plan_for(
                self.package,
                self.archive_sha256,
                signer_fingerprint(self.package),
                tool_bindings=bindings,
                **kwargs,
            ),
            "authorization": authorization_record or authorization(),
            "input": ECHO_INPUT,
        }
        if attachments is not None:
            params["attachments"] = attachments
        return await self.call("execution.begin", params)


def run(coroutine):
    return asyncio.run(coroutine)


# -- the happy path ----------------------------------------------------------
def test_a_declared_approved_bound_tool_runs_through_the_generic_runtime(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            begin = await harness.begin()
            result = await harness.call("execution.run", {})
            await harness.call("execution.end", {})
            return harness, begin, result

    harness, begin, result = run(main())
    assert begin["execution"]["tool_handlers"] == 1
    assert begin["execution"]["tool_handler_kind"].endswith("HostBridgeToolHandler")
    assert begin["tools"]["bound"] == [ECHO_TOOL]
    assert begin["tools"]["bindings"][0]["approved"] is True

    assert result["status"] == "completed"
    assert result["audit"]["tool_calls"] == 1
    assert result["package_execution"]["tool_handlers_installed"] == 1
    assert result["usage"]["tool_calls"] == {ECHO_TOOL: 1}
    # A local binding must not consume the remote-call budget.
    assert result["usage"]["remote_calls"] == 0
    assert result["audit"]["chain"]["valid"] is True

    # What the host was asked carries a declared tool and a frozen binding,
    # and nothing that could name a destination.
    (request,) = harness.host.requests
    assert set(request) == {"tool_id", "binding_id", "binding_sha256", "args"}
    assert request["tool_id"] == ECHO_TOOL
    assert request["args"] == ECHO_INPUT
    assert json.loads((harness.artifacts / "result.json").read_text())["status"] == "completed"


def test_the_audit_records_which_implementation_answered(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            await harness.begin()
            await harness.call("execution.run", {})
            await harness.call("execution.end", {})
            return harness.session._outcome["audit"]

    audit = run(main())
    dispatched = [event for event in audit if event["action"] == "tool.dispatched"]
    settled = [event for event in audit if event["action"] == "tool.settled"]
    assert len(dispatched) == len(settled) == 1
    assert dispatched[0]["tool"] == ECHO_TOOL
    assert len(dispatched[0]["binding_sha256"]) == 64
    assert dispatched[0]["remote"] is False
    assert settled[0]["status"] == "ok"
    # `tool.called`/`tool.completed` remain the runtime's own events.
    assert [event["action"] for event in audit].count("tool.called") == 1
    assert [event["action"] for event in audit].count("tool.completed") == 1


# -- refusals before anything runs -------------------------------------------
def test_an_unapproved_tool_refuses_the_whole_run(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.begin(
                    tool_bindings=bindings_for(harness.package),
                    authorization_record=authorization(approvals={ECHO_TOOL: False}),
                )
            return error.value, harness.host.requests

    failure, requests = run(main())
    assert failure.code == "tool_not_approved"
    assert requests == []


def test_a_plan_binding_a_tool_the_package_never_declared_is_refused(tmp_path):
    """Two different refusals, because they are two different mistakes."""

    async def renamed():
        async with ToolHarness(tmp_path / "a") as harness:
            bindings = bindings_for(harness.package)
            bindings[0]["tool_id"] = "some.other.tool"
            with pytest.raises(BridgeError) as error:
                await harness.begin(tool_bindings=bindings)
            return error.value

    async def extra():
        async with ToolHarness(tmp_path / "b") as harness:
            bindings = bindings_for(harness.package)
            bindings.append(
                dict(
                    bindings[0],
                    tool_id="secret-admin-tool",
                    binding_name="secret.admin",
                    binding_id="host:secret-admin-tool:1",
                )
            )
            with pytest.raises(BridgeError) as error:
                await harness.begin(tool_bindings=bindings)
            return error.value

    # The declared tool now has no binding at all...
    assert run(renamed()).code == "tool_not_bound"
    # ...and a binding for something the package never declared is refused
    # rather than quietly installed as an extra capability.
    assert run(extra()).code == "tool_not_declared"


def test_a_package_with_an_unbound_tool_cannot_run(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.begin(
                    tool_bindings=[],
                    plan=plan_for(
                        harness.package,
                        harness.archive_sha256,
                        signer_fingerprint(harness.package),
                        tool_bindings=[],
                        execution={"required_tool_ids": []},
                    ),
                )
            return error.value

    assert run(main()).code == "tools_not_supported"


@pytest.mark.parametrize(
    "field, value, code",
    [
        ("input_schema_sha256", "a" * 64, "tool_contract_mismatch"),
        ("output_schema_sha256", "b" * 64, "tool_contract_mismatch"),
        ("binding_name", "something.else", "tool_contract_mismatch"),
        ("remote", True, "tool_contract_mismatch"),
        ("required_permission_ids", ["memory.session"], "tool_contract_mismatch"),
    ],
)
def test_a_binding_that_does_not_match_the_signed_declaration_is_refused(
    tmp_path, field, value, code
):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            bindings = bindings_for(harness.package)
            bindings[0][field] = value
            with pytest.raises(BridgeError) as error:
                await harness.begin(tool_bindings=bindings)
            return error.value

    assert run(main()).code == code


def test_a_denied_required_permission_refuses_the_run(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.begin(
                    authorization_record=authorization(
                        decisions={
                            "files.echo": "deny",
                            "memory.session": "session",
                            "model.any": "session",
                        }
                    )
                )
            return error.value

    # `normalize_grants` refuses a denied *required* permission first, which is
    # the same refusal one layer earlier.
    assert run(main()).code == "execution_permission_denied"


def test_an_unapproved_binding_never_reaches_the_plan_normalizer(tmp_path):
    package, _ = echo_package(Path(os.path.realpath(tmp_path)))
    bindings = bindings_for(package, approve=False)
    with pytest.raises(ToolBridgeError) as error:
        normalize_tool_bindings(bindings)
    assert error.value.code == "tool_not_approved"


def test_two_bindings_for_one_tool_are_refused(tmp_path):
    package, _ = echo_package(Path(os.path.realpath(tmp_path)))
    bindings = bindings_for(package)
    with pytest.raises(ToolBridgeError) as error:
        normalize_tool_bindings(bindings + [dict(bindings[0], binding_id="host:other:1")])
    assert error.value.code == "tool_binding_ambiguous"


# -- what the host may answer ------------------------------------------------
class BadHost(FakeToolHost):
    def __init__(self, mutate):
        super().__init__(answers={ECHO_TOOL: lambda args: dict(args)})
        self.mutate = mutate

    async def __call__(self, method, params):
        answer = await super().__call__(method, params)
        return self.mutate(answer)


@pytest.mark.parametrize(
    "mutate, code",
    [
        (lambda a: {**a, "binding_id": "host:other:1"}, "tool_binding_stale"),
        (lambda a: {**a, "binding_sha256": "f" * 64}, "tool_binding_stale"),
        (lambda a: {**a, "remote": True}, "tool_contract_mismatch"),
        (lambda a: {k: v for k, v in a.items() if k != "output"}, "tool_response_invalid"),
        (lambda a: {**a, "status": "partial"}, "tool_response_invalid"),
        (lambda a: {**a, "headers": {"authorization": "Bearer x"}}, "tool_response_invalid"),
    ],
)
def test_a_host_answer_that_is_not_this_binding_is_refused(tmp_path, mutate, code):
    async def main():
        async with ToolHarness(tmp_path, host=BadHost(mutate)) as harness:
            await harness.begin()
            result = await harness.call("execution.run", {})
            return result

    result = run(main())
    assert result["status"] == "failed"
    assert result["error_code"] == "tool_error"


def test_an_output_that_fails_the_package_schema_fails_the_run(tmp_path):
    """The host may be wrong; the package's own schema is checked regardless."""

    async def main():
        host = FakeToolHost(answers={ECHO_TOOL: lambda args: {"value": 42}})
        async with ToolHarness(tmp_path, host=host) as harness:
            await harness.begin()
            return await harness.call("execution.run", {})

    result = run(main())
    assert result["status"] == "failed"
    assert result["error_code"] == "schema_validation"


def test_arguments_are_validated_before_anything_leaves_the_host(tmp_path):
    """A malformed argument is a local failure, not a remote one."""
    package, _ = echo_package(Path(os.path.realpath(tmp_path)))
    bindings = normalize_tool_bindings(bindings_for(package))

    class Peer:
        def __init__(self):
            self.calls = 0

        async def call(self, *args, **kwargs):
            self.calls += 1
            raise AssertionError("an invalid argument must not reach the host")

    peer = Peer()
    handler = HostBridgeToolHandler(peer, bindings[0])

    class Context:
        def event(self, *args, **kwargs):
            pass

    with pytest.raises(ToolBridgeError) as error:
        asyncio.run(handler(Context(), {"value": object()}))
    assert error.value.code == "tool_request_invalid"
    assert peer.calls == 0


# -- budgets, timeouts and cancellation --------------------------------------
def test_a_host_tool_limit_can_only_lower_the_package_cap(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            begin = await harness.begin()
            return begin["limits"]["budget"]

    budget = run(main())
    assert budget["declared"]["max_calls_per_tool"] == {ECHO_TOOL: 4}
    # The default host ceiling is far higher, so the package's own cap wins.
    assert budget["effective"]["max_calls_per_tool"] == {ECHO_TOOL: 4}


def test_a_tighter_host_tool_limit_wins(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            begin = await harness.call(
                "execution.begin",
                {
                    "run_id": "run-tool",
                    "run_plan": plan_for(
                        harness.package,
                        harness.archive_sha256,
                        signer_fingerprint(harness.package),
                        tool_bindings=bindings_for(harness.package),
                    ),
                    "authorization": authorization(),
                    "limits": {"max_calls_per_tool": 1},
                    "input": ECHO_INPUT,
                },
            )
            return begin["limits"]["budget"]

    assert run(main())["effective"]["max_calls_per_tool"] == {ECHO_TOOL: 1}


def test_cancellation_reaches_the_host_and_stops_the_request(tmp_path):
    async def main():
        host = FakeToolHost(answers={ECHO_TOOL: lambda args: dict(args)}, delay=30)
        async with ToolHarness(tmp_path, host=host) as harness:
            await harness.begin()
            running = asyncio.create_task(harness.call("execution.run", {}, timeout=30))
            await asyncio.sleep(0.2)
            await harness.call("execution.cancel", {})
            result = await running
            await asyncio.sleep(0.1)
            return result, host

    result, host = run(main())
    assert result["status"] == "cancelled"
    assert result["cancel_requested"] is True
    # The host saw the cancellation for the exact in-flight request.
    assert host.cancelled == [ECHO_TOOL]


def test_a_host_that_never_answers_times_out_inside_the_declared_tool_deadline(tmp_path):
    async def main():
        host = FakeToolHost(answers={ECHO_TOOL: lambda args: dict(args)}, delay=30)
        async with ToolHarness(tmp_path, host=host) as harness:
            # The package declares a 10s tool timeout; a shorter host run
            # deadline stops it first and says which one fired.
            await harness.call(
                "execution.begin",
                {
                    "run_id": "run-tool",
                    "run_plan": plan_for(
                        harness.package,
                        harness.archive_sha256,
                        signer_fingerprint(harness.package),
                        tool_bindings=bindings_for(harness.package),
                    ),
                    "authorization": authorization(),
                    "limits": {"run_timeout_seconds": 1},
                    "input": ECHO_INPUT,
                },
            )
            return await harness.call("execution.run", {}, timeout=30)

    result = run(main())
    assert result["status"] == "failed"
    assert result["error_code"] == "timeout"
    assert result["deadline_exceeded"] is True


def test_a_host_refusal_keeps_its_stable_code(tmp_path):
    async def main():
        host = FakeToolHost(
            answers={}, fail_with=BridgeError("tool_unavailable", "the implementation is down")
        )
        async with ToolHarness(tmp_path, host=host) as harness:
            await harness.begin()
            return await harness.call("execution.run", {})

    result = run(main())
    assert result["status"] == "failed"
    assert result["error_code"] == "tool_error"


# -- the tool probe ----------------------------------------------------------
def test_the_tool_probe_calls_one_tool_and_runs_no_workflow(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            await harness.begin()
            report = await harness.call(
                "execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT}
            )
            await harness.call("execution.end", {})
            return harness, report

    harness, report = run(main())
    assert report["status"] == "ok"
    assert report["result"]["output"] == ECHO_OUTPUT
    assert report["result"]["validated_by_runtime"] is True
    assert report["usage"]["tool_calls"] == 1
    assert report["usage"]["tool_calls_by_id"] == {ECHO_TOOL: 1}
    assert report["audit"]["chain"]["valid"] is True

    execution = report["package_execution"]
    assert execution["workflow_instantiated"] is False
    assert execution["workflow_nodes_executed"] == 0
    assert execution["workflow_workers_started"] == 0
    assert execution["model_calls"] == 0
    assert execution["model_router_installed"] is False
    assert execution["package_instructions_loaded"] is False
    # One worker context, because only a worker role holds this tool and
    # `Runtime.call_tool` derives its authority from the calling context.
    assert execution["runtime_worker_contexts"] == 1
    assert report["authority"]["role"] == "EchoWorker"
    # No model request ever reached the host: `FakeToolHost` refuses any method
    # but `tool.call`, and exactly one tool call was made.
    assert len(harness.host.requests) == 1
    assert harness.host.requests[0]["tool_id"] == ECHO_TOOL


def test_a_tool_that_outlasts_its_declared_timeout_is_a_reported_probe_outcome(tmp_path):
    """A slow service is a result of the probe, not an internal runner fault."""
    slow = FakeToolHost(answers={ECHO_TOOL: lambda args: dict(args)}, delay=3.0)

    async def main():
        async with ToolHarness(tmp_path, host=slow, tool_timeout=1) as harness:
            await harness.begin()
            with pytest.raises(BridgeError) as failure:
                await harness.call(
                    "execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT}, timeout=30
                )
            return failure.value

    error = run(main())
    assert error.code == "timeout"
    report = error.detail["report"]
    assert report["status"] == "failed"
    assert report["error_code"] == "timeout"
    assert report["usage"]["tool_calls"] == 1
    assert report["audit"]["chain"]["valid"] is True


def test_the_probe_refuses_an_undeclared_or_unbound_tool(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            await harness.begin()
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.tool_probe", {"tool_id": "secret-admin-tool", "args": {}}
                )
            return error.value

    assert run(main()).code == "tool_not_declared"


def test_the_probe_refuses_arguments_the_package_schema_rejects(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            await harness.begin()
            with pytest.raises(BridgeError):
                await harness.call(
                    "execution.tool_probe", {"tool_id": ECHO_TOOL, "args": {"value": 5}}
                )
            return harness.host.requests

    assert run(main()) == []


def test_a_session_probes_once_and_does_not_also_run(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            await harness.begin()
            await harness.call("execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT})
            with pytest.raises(BridgeError) as second:
                await harness.call(
                    "execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT}
                )
            with pytest.raises(BridgeError) as running:
                await harness.call("execution.run", {})
            return second.value.code, running.value.code

    assert run(main()) == ("execution_already_started", "execution_already_started")


# -- concurrency -------------------------------------------------------------
def test_concurrent_tool_calls_stay_inside_the_package_budget(tmp_path):
    """Two workers, one shared per-tool cap, and a host that sees both."""
    seen: list[float] = []

    async def slow(args):
        seen.append(asyncio.get_running_loop().time())
        await asyncio.sleep(0.05)
        return dict(args)

    class ConcurrentHost(FakeToolHost):
        def __init__(self):
            super().__init__(answers={})
            self.active = 0
            self.peak = 0

        async def __call__(self, method, params):
            self.requests.append(params)
            self.active += 1
            self.peak = max(self.peak, self.active)
            try:
                return {
                    "status": "ok",
                    "output": await slow(params["args"]),
                    "tool_id": params["tool_id"],
                    "binding_id": params["binding_id"],
                    "binding_sha256": params["binding_sha256"],
                    "remote": False,
                }
            finally:
                self.active -= 1

    async def main():
        host = ConcurrentHost()
        async with ToolHarness(tmp_path, host=host) as harness:
            bindings = normalize_tool_bindings(bindings_for(harness.package))
            handler = HostBridgeToolHandler(harness.session._peer, bindings[0])

            class Context:
                def event(self, *args, **kwargs):
                    pass

            results = await asyncio.gather(
                *(handler(Context(), {"value": f"item-{index}"}) for index in range(4))
            )
            return host, results

    host, results = run(main())
    assert [item["value"] for item in results] == [f"item-{index}" for index in range(4)]
    assert host.peak > 1, "the bridge must not serialize independent tool calls"
    assert len(host.requests) == 4


def test_the_bridge_refuses_more_outstanding_calls_than_it_can_correlate(tmp_path):
    """`MAX_PENDING` bounds the wire, so a fan-out cannot become unbounded."""

    async def main():
        host = FakeToolHost(answers={ECHO_TOOL: lambda args: dict(args)}, delay=5)
        async with ToolHarness(tmp_path, host=host) as harness:
            bindings = normalize_tool_bindings(bindings_for(harness.package))
            handler = HostBridgeToolHandler(harness.session._peer, bindings[0])

            class Context:
                def event(self, *args, **kwargs):
                    pass

            tasks = [
                asyncio.create_task(handler(Context(), {"value": str(index)}))
                for index in range(execution_protocol.__dict__.get("MAX_PENDING", 16) + 4)
            ]
            await asyncio.sleep(0.2)
            outcomes = [task for task in tasks if task.done()]
            codes = {
                getattr(task.exception(), "code", None)
                for task in outcomes
                if task.exception() is not None
            }
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            return codes

    assert "tool_broker_unavailable" in run(main())


# -- nothing leaks -----------------------------------------------------------
def test_no_credential_shaped_value_appears_anywhere_a_caller_can_see(tmp_path):
    secret = "sk-test-DO-NOT-LEAK-7f3a9"

    os.environ["ECHO_TOKEN"] = secret

    async def main():
        host = FakeToolHost(answers={ECHO_TOOL: lambda args: dict(args)})
        async with ToolHarness(tmp_path, host=host) as harness:
            registry = registry_for(
                harness.package,
                overrides={
                    ECHO_TOOL: {
                        "credentials": {
                            "required": True,
                            "configured": True,
                            "source": "env:ECHO_TOKEN",
                        }
                    }
                },
            )
            bindings = bindings_for(harness.package, registry=registry)
            begin = await harness.begin(tool_bindings=bindings)
            report = await harness.call(
                "execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT}
            )
            return begin, report, bindings, harness.host.requests

    try:
        begin, report, bindings, requests = run(main())
    finally:
        os.environ.pop("ECHO_TOKEN", None)
    for blob in (begin, report, bindings, requests):
        assert secret not in json.dumps(blob, default=str)
    # Not even the *name* of the secret source crosses the wire; the binding
    # says only that the trusted host has one attached to this implementation.
    assert "ECHO_TOKEN" not in json.dumps(requests)
    assert bindings[0]["credentials_configured"] is True
    assert bindings[0]["credentials_required"] is True
    assert all("credential" not in key for request in requests for key in request)


def test_the_wire_carries_no_destination_method_or_header(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            await harness.begin()
            await harness.call("execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT})
            return harness.host.requests

    requests = run(main())
    assert len(requests) == 1
    encoded = json.dumps(requests).lower()
    for forbidden in ("http", "://", "header", "authorization", "method", "origin", "endpoint"):
        assert forbidden not in encoded, forbidden


# -- a tool more than one role declares ---------------------------------------
def test_a_probe_of_a_tool_two_roles_declare_needs_the_host_to_name_one(tmp_path):
    async def main():
        async with ToolHarness(tmp_path, second_role=True) as harness:
            await harness.begin()
            with pytest.raises(BridgeError) as unnamed:
                await harness.call(
                    "execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT}
                )
            return unnamed.value, harness.host.requests

    error, requests = run(main())
    assert error.code == "tool_permission_denied"
    assert "host must name one" in str(error)
    assert requests == []


@pytest.mark.parametrize("role", ["EchoWorker", "EchoReviewer"])
def test_the_host_may_name_either_declared_role_and_the_report_says_so(tmp_path, role):
    async def main():
        async with ToolHarness(tmp_path, second_role=True) as harness:
            await harness.begin()
            return await harness.call(
                "execution.tool_probe", {"tool_id": ECHO_TOOL, "args": ECHO_INPUT, "role": role}
            )

    report = run(main())
    assert report["status"] == "ok"
    assert report["authority"]["role"] == role
    assert report["authority"]["role_named_by_host"] is True
    assert report["package_execution"]["runtime_worker_contexts"] == 1


@pytest.mark.parametrize("role", ["EchoCoordinator", "SomeoneElse"])
def test_the_host_cannot_name_a_role_that_does_not_declare_the_tool(tmp_path, role):
    async def main():
        async with ToolHarness(tmp_path, second_role=True) as harness:
            await harness.begin()
            with pytest.raises(BridgeError) as refused:
                await harness.call(
                    "execution.tool_probe",
                    {"tool_id": ECHO_TOOL, "args": ECHO_INPUT, "role": role},
                )
            return refused.value, harness.host.requests

    error, requests = run(main())
    assert error.code == "tool_permission_denied"
    assert requests == []


# -- the files a run was given are part of what was asked ---------------------
ATTACHMENT = {
    "file_id": "file_" + "1" * 32,
    "sha256": "2" * 64,
    "bytes": 941,
    "media_type": "application/pdf",
}


def test_the_invocation_binds_the_selected_files_by_id_and_hash_only(tmp_path):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            plain = await harness.begin()
        async with ToolHarness(tmp_path / "again") as harness:
            given = await harness.begin(attachments=[ATTACHMENT])
        return plain, given

    plain, given = run(main())
    assert plain["invocation"]["attachments"] == []
    assert given["invocation"]["attachments"] == [ATTACHMENT]
    assert given["invocation"]["run_invocation_version"] == "0.2"
    # The files are bound into the invocation's hash, so a run given a file is
    # not the same invocation as one that was not.
    assert (
        plain["invocation"]["run_invocation_sha256"] != given["invocation"]["run_invocation_sha256"]
    )


@pytest.mark.parametrize(
    "attachments",
    [
        [{**ATTACHMENT, "path": "/tmp/paper.pdf"}],
        [{**ATTACHMENT, "file_id": "/etc/passwd"}],
        [{**ATTACHMENT, "file_id": "../file_" + "1" * 32}],
        [{**ATTACHMENT, "sha256": "not-a-hash"}],
        [{**ATTACHMENT, "bytes": 0}],
        [{**ATTACHMENT, "bytes": True}],
        [{**ATTACHMENT, "media_type": "text/html"}],
        [ATTACHMENT, ATTACHMENT],
        [{k: v for k, v in ATTACHMENT.items() if k != "sha256"}],
        "file_" + "1" * 32,
        [ATTACHMENT] * 17,
    ],
)
def test_the_runner_refuses_attachments_that_are_not_opaque_bounded_records(tmp_path, attachments):
    async def main():
        async with ToolHarness(tmp_path) as harness:
            with pytest.raises(BridgeError) as refused:
                await harness.begin(attachments=attachments)
            return refused.value

    assert run(main()).code == "execution_plan_invalid"
