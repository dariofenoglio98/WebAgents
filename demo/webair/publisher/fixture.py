"""Run the WebAir package through the generic WebAgents runtime against this origin.

`record_fixture` produces the package's `fixtures/workflow.json`: for every scenario it runs
the package's own turn graph in the generic `agentpkg.workflow` interpreter under the generic
conversation runner (`agentpkg.conversation.Conversation`, turn by turn), with a scripted model
router per turn and the in-process json_http binding (see `binding.py`), and keeps the exact
model inputs and tool calls those turns made. The fixture's tool answers are therefore this
origin's answers, and its model cases match the exact inputs the graph builds (a later turn's
`interpret` input carries the history, so each turn is its own case).
"""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

from agentpkg.conversation import Conversation
from agentpkg.package import Package, integrity_statement
from agentpkg.validation import validate_payload
from agentpkg.workflow import WorkflowError, run_workflow

from origin.app import create_app

from .binding import json_http_handlers
from .contract import PACKAGE_SOURCE
from .scenarios import Scenario, Turn, scenarios

FIXTURE_PATH = "fixtures/workflow.json"
FIXTURE_PROFILE = "workflow.fixture.v0"


def source_files(root: Path = PACKAGE_SOURCE) -> dict[str, bytes]:
    """The package source's files, as `agentpkg build` would read them."""
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file() and not any(part.startswith(".") for part in path.parts)
    }


def package_from_files(files: dict[str, bytes]) -> Package:
    manifest, graph, policy, tools = validate_payload(files)
    return Package(manifest, graph, policy, tools, files, integrity_statement(files))


def without_fixture(files: dict[str, bytes], input_value: dict) -> Package:
    """The package with an empty fixture, so a stale fixture never feeds its own refresh."""
    empty = {"profile": FIXTURE_PROFILE, "input": input_value, "models": {}, "tools": {}}
    return package_from_files({**files, FIXTURE_PATH: json.dumps(empty).encode()})


def all_grants(package: Package) -> dict[str, str]:
    return {permission["id"]: "session" for permission in package.policy["permissions"]}


class ScriptedRouter:
    """A ModelRouter that answers each task from a script, in order, and records the call.

    Used only to record the fixture and in tests. It does not look at its input, which is
    exactly why the recorded inputs are the graph's own: the fixture's replay router then
    matches them exactly. Accounting is the fixture router's synthetic four-bytes-per-token
    unit.
    """

    remote = False
    synthetic = True
    model_id = "webair-scenario-script"
    router_id = "webair-publisher"
    capabilities = frozenset({"reasoning", "structured_output"})
    context_window = 1_000_000

    def __init__(self, script: dict[str, list[dict]]):
        self.pending = {task: copy.deepcopy(outputs) for task, outputs in script.items()}
        self.calls: list[dict] = []

    @staticmethod
    def _tokens(value) -> int:
        return (len(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()) + 3) // 4

    async def count_tokens(self, request):
        return self._tokens(request)

    async def complete(self, request, *, max_output_tokens):
        await asyncio.sleep(0)
        outputs = self.pending.get(request["task"])
        if not outputs:
            raise RuntimeError(f"no scripted output left for task {request['task']!r}")
        output = outputs.pop(0)
        self.calls.append(
            {"task": request["task"], "input": copy.deepcopy(request["data"]), "output": output}
        )
        return {
            "output": copy.deepcopy(output),
            "input_tokens": self._tokens(request),
            "output_tokens": self._tokens(output),
        }

    def unused(self) -> dict[str, int]:
        return {task: len(left) for task, left in self.pending.items() if left}


def scripted_routers(scenario: Scenario) -> list[ScriptedRouter]:
    """One scripted router per turn of the scenario."""
    return [ScriptedRouter(turn.models) for turn in scenario.turns]


def transcript_of(turns, *, end=False) -> dict:
    """An input transcript (conversation.v0 V-14) from `Turn`s, message texts or entries."""
    entries = []
    for turn in turns:
        if isinstance(turn, Turn):
            entries.append(turn.transcript_entry())
        elif isinstance(turn, str):
            entries.append({"message": {"message": turn}})
        else:
            # a transcript entry: {"message": <message>, "consents"?: {...}}
            entries.append(turn)
    document = {"schema": "conversation.transcript.v0", "turns": entries}
    if end:
        document["end"] = True
    return document


def turn_failure(report: dict) -> WorkflowError:
    """The failed turn's exception, as `run_workflow` raised it inside the runner: the
    classified code and the node that failed, with the turn's report attached."""
    failed = [event for event in report["audit"] if event["action"] == "node.failed"]
    node_id = failed[-1]["node_id"] if failed else None
    error = WorkflowError(report["error_code"], node_id)
    error.execution_report = report
    return error


async def converse_package(
    package: Package,
    turns,
    *,
    routers,
    app=None,
    handlers=None,
    record: list | None = None,
    grants: dict | None = None,
    approved_tools=None,
    limits: dict | None = None,
    memory=None,
    end: bool = False,
) -> tuple[dict, list[dict]]:
    """One conversation of the package's turn graph in the generic runner, nothing
    WebAir-specific. `routers` is one router for every turn or one per turn; `memory` is a
    memory run for every turn or a callable of the turn index. Returns the conversation's
    report and each turn's own report, in order (a failed turn's report included)."""
    if handlers is None:
        handlers = json_http_handlers(
            package, app if app is not None else create_app(), record=record
        )
    reports: dict[int, dict] = {}

    def adapters(turn):
        router = routers[turn - 1] if isinstance(routers, list) else routers
        return {
            "router": router,
            "handlers": handlers,
            "memory": memory(turn) if callable(memory) else memory,
        }

    def on_turn(index, report, status):
        reports[index] = report

    conversation = Conversation(
        package,
        grants=all_grants(package) if grants is None else grants,
        approved_tools=sorted(package.tools) if approved_tools is None else approved_tools,
        adapters=adapters,
        limits=limits,
        on_turn=on_turn,
    )
    result = await conversation.run(transcript_of(turns, end=end))
    return result, [reports[index] for index in sorted(reports)]


async def run_package(
    package: Package,
    input_value: dict,
    *,
    router,
    app=None,
    handlers=None,
    record: list | None = None,
    grants: dict | None = None,
    approved_tools=None,
    limits: dict | None = None,
    memory=None,
    consents: dict | None = None,
) -> dict:
    """One run of the package's graph in the generic interpreter, nothing WebAir-specific:
    a one-shot run of a plain package (0.5.0's capability document), or one turn of a
    conversational package, whose failure is raised as the turn raised it."""
    if package.graph.get("conversation") is None:
        if handlers is None:
            handlers = json_http_handlers(
                package, app if app is not None else create_app(), record=record
            )
        return await run_workflow(
            package,
            input_value,
            grants=all_grants(package) if grants is None else grants,
            handlers=handlers,
            router=router,
            approved_tools=sorted(package.tools) if approved_tools is None else approved_tools,
            limits=limits,
            memory=memory,
        )
    turn = {"message": input_value, **({"consents": consents} if consents else {})}
    _, reports = await converse_package(
        package,
        [turn],
        routers=router,
        app=app,
        handlers=handlers,
        record=record,
        grants=grants,
        approved_tools=approved_tools,
        limits=limits,
        memory=memory,
    )
    report = reports[0]
    if report["status"] != "completed":
        raise turn_failure(report)
    return report


def _add(cases: dict, key: str, value_in, value_out, origin: str) -> None:
    bucket = cases.setdefault(key, {})
    identity = json.dumps(value_in, sort_keys=True, ensure_ascii=False)
    if identity in bucket and bucket[identity]["output"] != value_out:
        raise ValueError(f"{key}: scenario {origin} gives a second answer to the same input")
    bucket[identity] = {"input": value_in, "output": value_out}


def record_scenario(package: Package, scenario: Scenario, app) -> tuple[dict, list, list]:
    """Every turn of the scenario against the origin: the conversation's report, the model
    calls and the tool calls, in order."""
    routers = scripted_routers(scenario)
    tool_calls: list = []
    result, reports = asyncio.run(
        converse_package(
            package, scenario.turns, routers=routers, app=app, record=tool_calls, end=scenario.end
        )
    )
    for index, (router, report) in enumerate(zip(routers, reports, strict=False), start=1):
        if report["status"] != "completed":
            error = turn_failure(report)
            raise ValueError(f"scenario {scenario.id} turn {index}: {error}") from error
        if router.unused():
            raise ValueError(
                f"scenario {scenario.id} turn {index}: unused scripted outputs {router.unused()}"
            )
    if len(reports) != len(scenario.turns):
        raise ValueError(
            f"scenario {scenario.id}: {len(reports)} of {len(scenario.turns)} turns ran "
            f"(ended: {result['ended']})"
        )
    model_calls = [call for router in routers for call in router.calls]
    return result, model_calls, tool_calls


def record_fixture(files: dict[str, bytes] | None = None) -> dict:
    files = source_files() if files is None else files
    all_scenarios = scenarios()
    default_input = all_scenarios[0].input
    package = without_fixture(files, default_input)
    app = create_app()
    models: dict = {}
    tools: dict = {}
    for scenario in all_scenarios:
        _, model_calls, tool_calls = record_scenario(package, scenario, app)
        for call in model_calls:
            _add(models, call["task"], call["input"], call["output"], scenario.id)
        for call in tool_calls:
            _add(tools, call["tool"], call["input"], call["output"], scenario.id)

    def ordered(cases: dict) -> dict:
        return {key: [bucket[k] for k in sorted(bucket)] for key, bucket in sorted(cases.items())}

    return {
        "profile": FIXTURE_PROFILE,
        "input": default_input,
        "models": ordered(models),
        "tools": ordered(tools),
    }
