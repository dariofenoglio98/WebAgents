"""The first real execution of a portable package, driven by a fake host.

Every test here runs the actual generic interpreter over the actual signed
artifact: the same `Workflow`, the same `Runtime`, the same
`HostBridgeModelRouter` and the same wire protocol a live run uses. Only the
provider is replaced, so what is being tested is the execution host rather than
a simulation of one.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from execution_fakes import MEETING_AGENDA, MEETING_INPUT, Harness, authorization, plan_for

from agentpkg.execution.errors import ExecutionError
from agentpkg.execution.policy import HostExecutionLimits
from agentpkg.hostbridge.errors import BridgeError
from agentpkg.package import load_package, sha256
from agentpkg.signing import embedded_public_key, fingerprint

PACKAGE = load_package(MEETING_AGENDA)
ARCHIVE_SHA256 = sha256(MEETING_AGENDA.read_bytes())
SIGNER = fingerprint(embedded_public_key(PACKAGE.signature))


def plan(**overrides):
    return plan_for(
        PACKAGE, archive_sha256=ARCHIVE_SHA256, signer_fingerprint=SIGNER, **overrides
    )


def begin_params(**overrides):
    params = {
        "run_id": "run-0001",
        "run_plan": plan(),
        "authorization": authorization(),
        "limits": {"total_tokens": 120000, "max_output_tokens_per_call": 16000},
        "input": MEETING_INPUT,
        "host": {"runtime": "openclaw", "runtime_version": "2026.9.5"},
    }
    params.update(overrides)
    return params


async def _run(tmp_path, *, begin=None, host_options=None):
    async with Harness(tmp_path, host_options=host_options) as harness:
        started = await harness.call("execution.begin", begin or begin_params())
        result = await harness.call("execution.run", {}, timeout=60)
        ended = await harness.call("execution.end", {})
        return harness, started, result, ended


def run(tmp_path, **kwargs):
    return asyncio.run(_run(tmp_path, **kwargs))


# -- the happy path ----------------------------------------------------------
def test_a_real_package_runs_through_the_generic_interpreter(tmp_path):
    harness, started, result, ended = run(tmp_path)

    assert result["status"] == "completed"
    assert result["error_code"] is None
    assert ended == {"ended": True, "ran": True, "status": "completed"}

    # The runner verified the bytes it was handed, independently.
    assert started["package"]["digest"] == PACKAGE.digest
    assert started["package"]["archive_sha256"] == ARCHIVE_SHA256
    assert started["package"]["signer_fingerprint"] == SIGNER
    assert "publisher_signature" in started["package"]["verified"]

    # The graph ran: planner, three bounded perspective workers, writer.
    audit = result["audit"]
    assert audit["model_calls"] == 5  # plan + 3 perspectives + write
    assert audit["tasks_called"] == {"perspective": 3, "plan": 1, "write": 1}
    assert audit["workers_spawned"] == 5
    assert audit["nodes_completed"] >= 6
    assert audit["chain"]["valid"] is True
    assert audit["tool_calls"] == 0

    # Every call used exactly the model the plan bound.
    assert result["model"]["invoked"] == ["acme/big"]
    assert result["model"]["all_calls_used_planned_model"] is True
    assert result["model"]["calls"] == 5

    usage = result["usage"]
    assert usage["tokens"] > 0
    assert usage["remote_calls"] == 10  # one count and one completion per call
    assert usage["peak_parallel_workers"] >= 2
    assert usage["tool_calls"] == {}

    # The package's declared export is on disk beside the host's own artifacts.
    names = {item["name"] for item in result["artifacts"]}
    assert names == {"result.json", "audit.json", "usage.json", "provenance.json", "agenda.json"}
    agenda = harness.artifact("agenda.json")
    assert agenda["goal"] == MEETING_INPUT["goal"]
    assert agenda["duration"] == MEETING_INPUT["duration"]
    assert sum(item["minutes"] for item in agenda["agenda"]) == MEETING_INPUT["duration"]


def test_parallel_perspective_workers_are_bounded_by_the_package(tmp_path):
    """Three items, max_parallel three, and a host that would allow no more."""
    _, _, result, _ = run(tmp_path, host_options={"delay": 0.05})
    assert result["usage"]["peak_parallel_workers"] == 3
    assert result["limits"]["budget"]["effective"]["max_parallel_workers"] == 3


def test_a_tighter_host_limit_lowers_parallelism_but_never_raises_it(tmp_path):
    _, _, result, _ = run(
        tmp_path,
        begin=begin_params(
            limits={"max_parallel_workers": 1, "max_output_tokens_per_call": 16000}
        ),
        host_options={"delay": 0.02},
    )
    assert result["status"] == "completed"
    assert result["usage"]["peak_parallel_workers"] == 1
    budget = result["limits"]["budget"]
    assert budget["declared"]["max_parallel_workers"] == 3
    assert budget["effective"]["max_parallel_workers"] == 1


def test_host_limits_cannot_exceed_package_declarations(tmp_path):
    _, _, result, _ = run(
        tmp_path,
        begin=begin_params(
            limits={
                "total_tokens": 10_000_000,
                "max_remote_calls": 9999,
                "max_parallel_workers": 64,
                "max_output_tokens_per_call": 16000,
            }
        ),
    )
    budget = result["limits"]["budget"]
    assert budget["effective"]["hard_tokens"] == budget["declared"]["hard_tokens"]
    assert budget["effective"]["max_remote_calls"] == budget["declared"]["max_remote_calls"]
    assert budget["effective"]["max_parallel_workers"] == 3


def test_the_run_invocation_binds_the_plan_and_the_input(tmp_path):
    _, started, result, _ = run(tmp_path)
    invocation = started["invocation"]
    assert invocation["run_plan_sha256"] == plan()["run_plan_sha256"]
    assert invocation["package"]["digest"] == PACKAGE.digest
    assert result["input_sha256"] == invocation["input_sha256"]
    assert result["run_invocation_sha256"] == invocation["run_invocation_sha256"]

    # The hash is stable across equal inputs and differs for a changed one.
    again = run(tmp_path / "again")[1]["invocation"]
    assert again["input_sha256"] == invocation["input_sha256"]
    changed = dict(MEETING_INPUT, duration=30)
    other = run(tmp_path / "other", begin=begin_params(input=changed))[1]["invocation"]
    assert other["input_sha256"] != invocation["input_sha256"]


def test_usage_cost_is_real_or_explicitly_incomplete(tmp_path):
    _, _, result, _ = run(tmp_path)
    assert result["cost"]["status"] == "complete"
    assert result["cost"]["calls"] == result["cost"]["calls_with_reported_cost"] == 5
    assert result["cost"]["total_usd"] == pytest.approx(0.006)

    _, _, partial, _ = run(
        tmp_path / "nocost",
        host_options={"usage": {"input_tokens": 900, "output_tokens": 180}},
    )
    assert partial["cost"]["status"] == "unknown"
    assert partial["cost"]["total_usd"] is None


# -- authority ---------------------------------------------------------------
@pytest.mark.parametrize(
    "mutation,code",
    [
        ({"package": {"digest": "0" * 64}}, "execution_artifact_mismatch"),
        ({"package": {"archive_sha256": "0" * 64}}, "execution_artifact_mismatch"),
        ({"package": {"package_id": "org.other.thing"}}, "execution_artifact_mismatch"),
        ({"package": {"version": "9.9.9"}}, "execution_artifact_mismatch"),
        (
            {"publisher": {"signer_fingerprint": "sha256:" + "0" * 64}},
            "execution_artifact_mismatch",
        ),
    ],
)
def test_an_artifact_that_is_not_the_planned_one_is_refused(tmp_path, mutation, code):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call("execution.begin", begin_params(run_plan=plan(**mutation)))
            return error.value

    assert asyncio.run(main()).code == code


def test_a_denied_model_permission_refuses_the_run(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin",
                    begin_params(
                        authorization=authorization(
                            {"model.reasoning": "deny", "memory.session": "session"}
                        )
                    ),
                )
            return error.value

    assert asyncio.run(main()).code == "execution_permission_denied"


def test_a_denied_memory_permission_refuses_the_run(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin",
                    begin_params(
                        authorization=authorization(
                            {"model.reasoning": "session", "memory.session": "deny"}
                        )
                    ),
                )
            return error.value

    assert asyncio.run(main()).code == "execution_permission_denied"


def test_a_once_grant_is_refused_rather_than_widened(tmp_path):
    """`once` is consumed on first use, so a multi-call workflow cannot honour it."""

    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin",
                    begin_params(
                        authorization=authorization(
                            {"model.reasoning": "once", "memory.session": "session"}
                        )
                    ),
                )
            return error.value

    failure = asyncio.run(main())
    assert failure.code == "execution_grant_unsupported"
    assert "once" in str(failure)


def test_an_always_grant_is_refused_because_no_store_exists(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin",
                    begin_params(
                        authorization=authorization(
                            {"model.reasoning": "always", "memory.session": "session"}
                        )
                    ),
                )
            return error.value

    assert asyncio.run(main()).code == "execution_grant_unsupported"


def test_grants_missing_a_declared_permission_are_refused(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin",
                    begin_params(authorization=authorization({"model.reasoning": "session"})),
                )
            return error.value

    assert asyncio.run(main()).code == "execution_plan_invalid"


def test_a_model_that_cannot_satisfy_the_package_is_refused_before_dispatch(tmp_path):
    binding = plan()["model_binding"] | {
        "capabilities": {"structured_output": {"value": True, "basis": "derived"}}
    }

    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin", begin_params(run_plan=plan(model_binding=binding))
                )
            return error.value

    failure = asyncio.run(main())
    assert failure.code == "execution_model_incompatible"
    assert failure.detail["missing"] == ["reasoning"]


def test_a_context_window_below_the_package_requirement_is_refused(tmp_path):
    binding = plan()["model_binding"] | {"limits": {"context_tokens": 4096}}

    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin", begin_params(run_plan=plan(model_binding=binding))
                )
            return error.value

    assert asyncio.run(main()).code == "execution_model_incompatible"


# -- input -------------------------------------------------------------------
def test_invalid_input_is_refused_before_any_model_call(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin", begin_params(input={"goal": "no duration"})
                )
            return error.value, harness.host.requests

    failure, requests = asyncio.run(main())
    assert failure.code == "execution_input_invalid"
    assert requests == []  # not one token was spent


def test_oversized_input_is_refused_before_any_model_call(tmp_path):
    huge = dict(MEETING_INPUT, context="x" * 300_000)

    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call("execution.begin", begin_params(input=huge))
            return error.value, harness.host.requests

    failure, requests = asyncio.run(main())
    assert failure.code == "execution_input_invalid"
    assert requests == []


# -- model failures ----------------------------------------------------------
def test_a_model_failure_propagates_as_a_classified_run_failure(tmp_path):
    _, _, result, _ = run(
        tmp_path, host_options={"fail_with": BridgeError("model_call_failed", "provider down")}
    )
    assert result["status"] == "failed"
    assert result["error_code"] == "model_error"
    assert result["audit"]["chain"]["valid"] is True
    # A failed run still leaves its evidence, and no package export.
    assert {item["name"] for item in result["artifacts"]} == {
        "result.json",
        "audit.json",
        "usage.json",
        "provenance.json",
    }


def test_a_model_answering_with_another_model_fails_closed(tmp_path):
    _, _, result, _ = run(tmp_path, host_options={"model_id": "acme/small"})
    assert result["status"] == "failed"
    assert result["model"]["invoked"] == []


def test_output_that_does_not_satisfy_the_package_schema_fails(tmp_path):
    _, _, result, _ = run(
        tmp_path, host_options={"respond": lambda params: json.dumps({"wrong": True})}
    )
    assert result["status"] == "failed"
    assert result["error_code"] in {"model_error", "schema_validation"}


def test_a_broken_package_assertion_fails_the_run(tmp_path):
    """The package's own time-allocation assertion is what catches this."""
    from execution_fakes import scripted_model

    honest = scripted_model()

    def wrong_total(params):
        text = honest(params)
        value = json.loads(text)
        if isinstance(value, dict) and "agenda" in value:
            value["agenda"][0]["minutes"] += 5
            return json.dumps(value)
        return text

    _, _, result, _ = run(tmp_path, host_options={"respond": wrong_total})
    assert result["status"] == "failed"
    assert result["error_code"] == "schema_validation"


# -- budgets and deadlines ---------------------------------------------------
def test_a_tight_token_budget_stops_the_run(tmp_path):
    _, _, result, _ = run(
        tmp_path,
        begin=begin_params(limits={"total_tokens": 20000, "max_output_tokens_per_call": 16000}),
    )
    assert result["status"] == "failed"
    assert result["error_code"] == "budget_exhausted"


def test_a_tight_remote_call_budget_stops_the_run(tmp_path):
    _, _, result, _ = run(
        tmp_path,
        begin=begin_params(limits={"max_remote_calls": 2, "max_output_tokens_per_call": 16000}),
    )
    assert result["status"] == "failed"
    assert result["error_code"] == "budget_exhausted"


def test_the_host_run_timeout_stops_a_slow_run_and_says_so(tmp_path):
    _, _, result, _ = run(
        tmp_path,
        begin=begin_params(
            limits={"run_timeout_seconds": 1, "max_output_tokens_per_call": 16000}
        ),
        host_options={"delay": 5.0},
    )
    assert result["status"] == "failed"
    assert result["error_code"] == "timeout"
    assert result["deadline_exceeded"] is True
    assert result["limits"]["effective_deadline_seconds"] == 1


def test_one_model_call_is_bounded_by_the_host_s_own_timeout(tmp_path):
    """A completion that outlives the host's per-call limit fails, and says so.

    The limit is host policy, so it is reported with the other host limits, and
    it is what the router waits for — not a constant a slower local model server
    would silently run into.
    """
    _, _, result, _ = run(
        tmp_path,
        begin=begin_params(
            limits={"model_call_timeout_seconds": 1, "max_output_tokens_per_call": 16000}
        ),
        host_options={"delay": 5.0},
    )
    assert result["status"] == "failed"
    assert result["deadline_exceeded"] is False
    assert result["limits"]["host"]["model_call_timeout_seconds"] == 1


def test_the_model_call_timeout_defaults_to_the_previous_constant_and_is_capped():
    assert HostExecutionLimits().model_call_timeout_seconds == 300
    assert (
        HostExecutionLimits.normalize({"model_call_timeout_seconds": 1800}).as_json()[
            "model_call_timeout_seconds"
        ]
        == 1800
    )
    for bad in (0, -1, True, 1.5, 3601):
        with pytest.raises(ExecutionError):
            HostExecutionLimits.normalize({"model_call_timeout_seconds": bad})


# -- cancellation ------------------------------------------------------------
def test_cancellation_stops_a_running_workflow_and_reports_cancelled(tmp_path):
    async def main():
        async with Harness(tmp_path, host_options={"delay": 5.0}) as harness:
            await harness.call("execution.begin", begin_params())
            running = asyncio.create_task(harness.call("execution.run", {}, timeout=30))
            await asyncio.sleep(0.4)
            stop = await harness.call("execution.cancel", {})
            return stop, await running, harness

    stop, result, harness = asyncio.run(main())
    assert stop["cancel_requested"] is True and stop["running"] is True
    assert result["status"] == "cancelled"
    assert result["error_code"] == "cancelled"
    assert result["cancel_requested"] is True
    assert result["audit"]["chain"]["valid"] is True
    assert "result.json" in {item["name"] for item in result["artifacts"]}


def test_cancelling_before_the_run_starts_leaves_nothing_running(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            await harness.call("execution.begin", begin_params())
            stop = await harness.call("execution.cancel", {})
            result = await harness.call("execution.run", {}, timeout=30)
            return stop, result

    stop, result = asyncio.run(main())
    assert stop["running"] is False
    # The workflow is stopped before its first node rather than running anyway.
    assert result["status"] == "cancelled"
    assert result["cancel_requested"] is True
    assert result["audit"]["model_calls"] == 0


# -- lifecycle ---------------------------------------------------------------
def test_one_session_binds_once_and_runs_once(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            await harness.call("execution.begin", begin_params())
            with pytest.raises(BridgeError) as rebind:
                await harness.call("execution.begin", begin_params())
            await harness.call("execution.run", {}, timeout=60)
            with pytest.raises(BridgeError) as rerun:
                await harness.call("execution.run", {}, timeout=30)
            return rebind.value, rerun.value

    rebind, rerun = asyncio.run(main())
    assert rebind.code == "execution_already_started"
    assert rerun.code == "execution_already_started"


def test_running_without_binding_is_refused(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call("execution.run", {}, timeout=30)
            return error.value

    assert asyncio.run(main()).code == "execution_not_bound"


def test_unknown_methods_and_fields_are_refused(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(Exception) as unknown:
                await harness.call("execution.evaluate", {}, timeout=10)
            return unknown.value

    failure = asyncio.run(main())
    assert "not permitted" in str(failure)


def test_begin_refuses_unknown_fields(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin", begin_params(**{"limits": {"prompt": "hello"}})
                )
            return error.value

    assert asyncio.run(main()).code == "execution_plan_invalid"


# -- artifacts ---------------------------------------------------------------
def test_artifacts_are_owner_only_and_never_overwrite(tmp_path):
    harness, _, result, _ = run(tmp_path)
    for item in result["artifacts"]:
        path = harness.artifacts / item["name"]
        assert path.is_file() and not path.is_symlink()
        assert os.stat(path).st_mode & 0o777 == 0o600
        assert sha256(path.read_bytes()) == item["sha256"]

    # A second run into the same directory refuses rather than overwriting.
    async def again():
        async with Harness(tmp_path) as second:
            second.artifacts = harness.artifacts
            os.close(second.artifacts_fd)
            second.artifacts_fd = os.open(harness.artifacts, os.O_RDONLY | os.O_DIRECTORY)
            second.session._artifacts_fd = second.artifacts_fd
            await second.call("execution.begin", begin_params())
            with pytest.raises(BridgeError) as error:
                await second.call("execution.run", {}, timeout=60)
            return error.value

    assert asyncio.run(again()).code == "execution_artifacts_failed"


def test_the_result_artifact_is_the_full_execution_report(tmp_path):
    harness, _, result, _ = run(tmp_path)
    stored = harness.artifact("result.json")
    assert stored["status"] == "completed"
    assert stored["output"] == harness.artifact("agenda.json")
    assert stored["audit"] == harness.artifact("audit.json")
    assert stored["usage"] == harness.artifact("usage.json")
    assert stored["provenance"]["package_digest"] == PACKAGE.digest
    assert result["output"]["sha256"] is not None


# -- the artifact descriptor -------------------------------------------------
def test_a_package_descriptor_that_is_not_a_regular_file_is_refused(tmp_path):
    read_fd, write_fd = os.pipe()

    try:

        async def main():
            async with Harness(tmp_path) as harness:
                os.close(harness.package_fd)
                harness.package_fd = read_fd
                harness.session._package_fd = read_fd
                with pytest.raises(BridgeError) as error:
                    await harness.call("execution.begin", begin_params())
                return error.value

        assert asyncio.run(main()).code == "execution_artifact_invalid"
    finally:
        os.close(write_fd)


def test_replacing_the_source_path_after_the_descriptor_is_open_changes_nothing(tmp_path):
    """The run is the descriptor's inode, not whatever the path points at now."""
    staged = tmp_path / "staged.agent.pkg"
    staged.write_bytes(MEETING_AGENDA.read_bytes())

    async def main():
        async with Harness(tmp_path, archive=staged) as harness:
            # A substitution of the kind a TOCTOU attack would attempt: the path
            # now names entirely different bytes, and the open descriptor does not.
            substitute = tmp_path / "substitute"
            substitute.write_bytes(b"PK\x03\x04 substituted after the descriptor was opened")
            os.replace(substitute, staged)
            started = await harness.call("execution.begin", begin_params())
            result = await harness.call("execution.run", {}, timeout=60)
            return started, result

    started, result = asyncio.run(main())
    assert started["package"]["digest"] == PACKAGE.digest
    assert result["status"] == "completed"
    assert staged.read_bytes().startswith(b"PK\x03\x04 substituted")


def test_rewriting_the_bytes_behind_the_descriptor_is_caught_by_the_hash(tmp_path):
    """An in-place rewrite is visible through the descriptor, and refused."""
    staged = tmp_path / "staged.agent.pkg"
    staged.write_bytes(MEETING_AGENDA.read_bytes())

    async def main():
        async with Harness(tmp_path, archive=staged) as harness:
            staged.write_bytes(MEETING_AGENDA.read_bytes() + b"\x00trailing")
            with pytest.raises(BridgeError) as error:
                await harness.call("execution.begin", begin_params())
            return error.value, harness.host.requests

    failure, requests = asyncio.run(main())
    assert failure.code == "execution_artifact_mismatch"
    assert requests == []


# -- no package tools --------------------------------------------------------
def test_a_package_declaring_tools_is_refused_before_anything_runs(tmp_path):
    literature = Path(MEETING_AGENDA).parent / "literature-review.agent.pkg"
    package = load_package(literature)
    signer = fingerprint(embedded_public_key(package.signature))
    bound = plan_for(
        package,
        archive_sha256=sha256(literature.read_bytes()),
        signer_fingerprint=signer,
    )

    async def main():
        async with Harness(tmp_path, archive=literature) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin",
                    begin_params(
                        run_plan=bound,
                        input={"topic": "anything", "max_papers": 1},
                        authorization=authorization(
                            {item["id"]: "session" for item in package.policy["permissions"]}
                        ),
                    ),
                )
            return error.value, harness.host.requests

    failure, requests = asyncio.run(main())
    assert failure.code == "tools_not_supported"
    assert requests == []


def test_no_tool_handler_is_installed_for_a_run(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            await harness.call("execution.begin", begin_params())
            await harness.call("execution.run", {}, timeout=60)
            return harness.session._workflow.runtime.handlers

    assert asyncio.run(main()) == {}


def test_an_output_cap_above_the_host_ceiling_is_refused_not_lowered(tmp_path):
    async def main():
        async with Harness(tmp_path) as harness:
            with pytest.raises(BridgeError) as error:
                await harness.call(
                    "execution.begin",
                    begin_params(limits={"max_output_tokens_per_call": 4096}),
                )
            return error.value

    failure = asyncio.run(main())
    assert failure.code == "execution_output_cap_too_large"
    assert failure.detail["requested"] == 12000


def test_node_output_caps_reach_the_model_unchanged(tmp_path):
    harness, _, _, _ = run(tmp_path)
    caps = {params["max_output_tokens"] for params in harness.host.completions()}
    assert caps == {12000}
