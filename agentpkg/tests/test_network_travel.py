"""The travel network (examples/network/travel-network): the worst case computed from the
declaration equals the maximum observed over an exhaustive enumeration of the allowed walks
(T25's acceptance check), and the example sources regenerate identically."""

import asyncio
import importlib.util
import json
from collections import Counter
from pathlib import Path

import pytest

from agentpkg.delegation.analysis import enumerate_walks, worst_case
from agentpkg.execution.report import verify_audit_chain
from agentpkg.fixtures import FixtureRouter, fixture_adapters
from agentpkg.package import build_package, load_package
from agentpkg.workflow import run_workflow

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "examples" / "network"
TRAVEL = EXAMPLES / "travel-network"
DESK = EXAMPLES / "network-test"
GRANTS = {"model.reasoning": "session", "memory.session": "session", "travel.index": "session"}
TOOLS = ["search-flights", "search-hotels", "check-calendar"]


def _generator():
    spec = importlib.util.spec_from_file_location(
        "make_network_examples", EXAMPLES / "make_network_examples.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WalkRouter(FixtureRouter):
    """A remote router that answers `understand` from the fixture's first understanding and
    follows one scripted walk at every `route`, handing off with a fixed message."""

    remote = True

    def __init__(self, cases, walk):
        super().__init__(cases)
        # The front man decides at each of its activations; a specialist's return is fixed.
        self.walk = [walk[i + 1] for i in range(len(walk) - 1) if walk[i] == "FrontMan"]
        self.walk.append("done")
        self.understanding = cases["understand"][0]["output"]

    async def complete(self, request, *, max_output_tokens):
        await asyncio.sleep(0)
        if request["task"] == "understand":
            output = self.understanding
        else:
            target = self.walk.pop(0)
            output = {"next": target, "message": {"text": f"Next: {target}."}}
        used = (len(json.dumps(output, sort_keys=True).encode()) + 3) // 4
        self.calls.append(request["task"])
        return {
            "output": output,
            "input_tokens": await self.count_tokens(request),
            "output_tokens": used,
        }


def _observed(report):
    audit = report["audit"]
    activations = Counter(e["role"] for e in audit if e["action"] == "network.activated")
    completed = [e for e in audit if e["action"] == "network.completed"]
    return {
        "activations": dict(activations),
        "hops": completed[0]["hops"],
        "model_calls": len([e for e in audit if e["action"] == "model.completed"]),
        "tool_calls": dict(Counter(e["tool"] for e in audit if e["action"] == "tool.called")),
        "remote_calls": report["usage"]["remote_calls"],
        "tokens": report["usage"]["tokens"],
    }


def test_the_bound_equals_the_maximum_over_every_allowed_walk():
    package = load_package(TRAVEL)
    network = package.graph["network"]
    walks = enumerate_walks(network)
    assert len(walks) == 16
    specialists = {"Flights", "Hotel", "Calendar"}
    # Every walk is a tour of distinct specialists from the front man, each returning once.
    for walk in walks:
        assert walk[0] == "FrontMan" and walk[-1] == "FrontMan"
        visited = [r for r in walk if r in specialists]
        assert len(visited) == len(set(visited)) and walk[1::2] == tuple(visited)
    bound = worst_case(package.graph, package.policy)
    fixture = package.json(package.graph["fixture"])
    _, handlers, input_value = fixture_adapters(package)
    observed = []
    for walk in walks:
        router = WalkRouter(fixture["models"], walk)
        report = asyncio.run(
            run_workflow(
                package,
                input_value,
                grants=GRANTS,
                handlers=handlers,
                router=router,
                approved_tools=TOOLS,
            )
        )
        assert report["status"] == "completed", walk
        assert verify_audit_chain(report["audit"])["valid"] is True
        usage = _observed(report)
        assert [e["role"] for e in report["audit"] if e["action"] == "network.activated"] == list(
            walk
        )
        observed.append(usage)
    # Counts: the maximum over the walks equals the bound, component by component.
    assert max(u["hops"] for u in observed) == bound["max_hops"] == 6
    assert max(sum(u["activations"].values()) for u in observed) == bound["max_activations"] == 7
    for role_id, cap in bound["activations"].items():
        assert max(u["activations"].get(role_id, 0) for u in observed) == cap, role_id
    assert max(u["model_calls"] for u in observed) == bound["model_calls"] == 8
    for tool, cap in bound["tool_calls"].items():
        assert max(u["tool_calls"].get(tool, 0) for u in observed) == cap == 1, tool
    assert max(u["remote_calls"] for u in observed) == bound["remote_calls"] == 16
    # Budgets: never passed; the full tour is the costliest walk in every component at once.
    assert all(u["tokens"] <= bound["tokens"] for u in observed)
    full = max(observed, key=lambda u: (u["hops"], u["tokens"]))
    assert full["activations"] == {"FrontMan": 4, "Flights": 1, "Hotel": 1, "Calendar": 1}
    assert full["hops"] == 6 and full["remote_calls"] == 16 and full["model_calls"] == 8
    assert bound["relaxation"]["tokens"] == 32000 == bound["tokens"]


def test_the_fixture_walk_of_the_travel_network_is_the_full_tour():
    package = load_package(TRAVEL)
    router, handlers, input_value = fixture_adapters(package)
    report = asyncio.run(
        run_workflow(
            package,
            input_value,
            grants=GRANTS,
            handlers=handlers,
            router=router,
            approved_tools=TOOLS,
        )
    )
    assert report["status"] == "completed"
    assert _observed(report)["activations"] == {
        "FrontMan": 4,
        "Flights": 1,
        "Hotel": 1,
        "Calendar": 1,
    }
    assert report["output"]["flights"][1]["id"] == "WA203" and report["output"]["plan"].startswith(
        "Boston to Zurich"
    )
    assert report["output"]["trip"]["origin"] == "BOS"


@pytest.mark.parametrize(
    "name,builder", [("network-test", "desk_members"), ("travel-network", "travel_members")]
)
def test_the_example_sources_are_the_generator_output(name, builder):
    generator = _generator()
    members = getattr(generator, builder)()
    directory = EXAMPLES / name
    committed = {
        str(path.relative_to(directory)): path for path in directory.rglob("*") if path.is_file()
    }
    assert set(committed) == set(members)
    for member, value in members.items():
        text = committed[member].read_text(encoding="utf-8")
        if isinstance(value, str):
            assert text == value, member
        else:
            assert json.loads(text) == value, member


def test_the_unsigned_test_archive_is_its_source(tmp_path):
    archive = load_package(EXAMPLES / "network-test.agent.pkg")
    rebuilt = load_package(build_package(DESK, tmp_path / "rebuilt.agent.pkg"))
    assert archive.digest == rebuilt.digest
    assert archive.manifest["package_id"] == "org.webagents.network-test"
    assert archive.manifest["runtime"]["minimum_version"] == "0.7.0"
