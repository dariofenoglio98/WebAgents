"""Run the WebAir package through the generic WebAgents runtime against this origin.

`record_fixture` produces the package's `fixtures/workflow.json`: for every scenario it runs
the package's own graph in the generic `agentpkg.workflow` interpreter, with a scripted
model router and the in-process json_http binding (see `binding.py`), and keeps the exact
model inputs and tool calls that run made. The fixture's tool answers are therefore this
origin's answers, and its model cases match the exact inputs the graph builds.
"""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

from agentpkg.package import Package, integrity_statement
from agentpkg.validation import validate_payload
from agentpkg.workflow import run_workflow

from origin.app import create_app

from .binding import json_http_handlers
from .contract import PACKAGE_SOURCE
from .scenarios import Scenario, scenarios

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

    Used only to record the fixture. It does not look at its input, which is exactly why
    the recorded inputs are the graph's own: the fixture's replay router then matches them
    exactly. Accounting is the fixture router's synthetic four-bytes-per-token unit.
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
) -> dict:
    """One run of the package's graph in the generic interpreter, nothing WebAir-specific."""
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
    )


def _add(cases: dict, key: str, value_in, value_out, origin: str) -> None:
    bucket = cases.setdefault(key, {})
    identity = json.dumps(value_in, sort_keys=True, ensure_ascii=False)
    if identity in bucket and bucket[identity]["output"] != value_out:
        raise ValueError(f"{key}: scenario {origin} gives a second answer to the same input")
    bucket[identity] = {"input": value_in, "output": value_out}


def record_scenario(package: Package, scenario: Scenario, app) -> tuple[dict, list, list]:
    router = ScriptedRouter(scenario.models)
    tool_calls: list = []
    result = asyncio.run(
        run_package(package, scenario.input, router=router, app=app, record=tool_calls)
    )
    if router.unused():
        raise ValueError(f"scenario {scenario.id}: unused scripted outputs {router.unused()}")
    return result, router.calls, tool_calls


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
