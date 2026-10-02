"""Adversarial tests of authority and concurrent accounting, no live network."""

import asyncio
import copy
from pathlib import Path

import pytest

from agentpkg.errors import AgentPkgError
from agentpkg.package import load_package
from agentpkg.runtime import BudgetError, PolicyError, Runtime, digest

SOURCE = Path(__file__).parents[2] / "agents" / "literature-review-legacy"


@pytest.fixture
def package():
    return load_package(SOURCE)


def grants(package):
    return {p["id"]: "session" for p in package.policy["permissions"]}


def runtime(package, **kwargs):
    # Every declared tool needs an explicit approval as well as its permission;
    # these tests are about the other mechanisms, so they approve all of them
    # and `test_declared_tool_still_needs_an_explicit_approval` covers the gate.
    kwargs.setdefault("approved_tools", sorted(package.tools))
    return Runtime(package, grants=grants(package), **kwargs)


def test_declared_tool_still_needs_an_explicit_approval(package):
    async def handler(ctx, payload):
        raise AssertionError("an unapproved tool must not reach a handler")

    rt = Runtime(
        package,
        grants=grants(package),
        handlers={"scholarly.search": handler},
        approved_tools=[],
    )

    async def search(ctx, data):
        await ctx.tool("scholarly-search", {"query": "query", "limit": 1})
        return {"candidate_papers": []}

    with pytest.raises(PolicyError, match="not explicitly approved"):
        asyncio.run(rt.run_worker("SearchWorker", {"search_queries": []}, search))
    assert rt.audit[-1]["action"] == "worker.failed"
    assert not any(event["action"] == "tool.called" for event in rt.audit)

    # A permission grant is not an approval, and an approval for something the
    # package never declared is refused outright rather than ignored.
    with pytest.raises(PolicyError, match="does not declare"):
        Runtime(package, grants=grants(package), approved_tools=["not-a-tool"])


def test_default_denies_state_and_tools(package):
    rt = Runtime(package)

    async def work(ctx, data):
        raise AssertionError("Denied worker must not start")

    with pytest.raises(PolicyError, match="Permission denied"):
        asyncio.run(rt.run_worker("SearchWorker", {"search_queries": []}, work))
    assert rt.audit[-1]["action"] == "worker.denied"


def test_input_isolation_output_scope_and_no_mutable_alias(package):
    rt = runtime(package)
    inputs = {"candidate_papers": [{"title": "original"}]}
    returned = {"screened_papers": []}

    async def work(ctx, data):
        data["candidate_papers"][0]["title"] = "modified"
        return returned

    result = asyncio.run(rt.run_worker("ScreeningWorker", inputs, work))
    result["screened_papers"].append("new")
    assert inputs["candidate_papers"][0]["title"] == "original"
    assert returned == {"screened_papers": []}

    async def leak(ctx, data):
        return {"secret": "forbidden"}

    with pytest.raises(PolicyError, match="state_write"):
        asyncio.run(rt.run_worker("ScreeningWorker", inputs, leak))
    with pytest.raises(PolicyError, match="state_read"):
        asyncio.run(rt.run_worker("ScreeningWorker", {"secret": "forbidden"}, work))


def test_delegation_roles_depth_and_expired_context(package):
    rt = runtime(package)

    async def no_op(ctx, data):
        return {"candidate_papers": []}

    for role, depth in [("Unknown", 1), ("SearchWorker", 2), (rt.coordinator, 1)]:
        with pytest.raises(PolicyError):
            asyncio.run(rt.run_worker(role, {}, no_op, depth=depth))
    saved = []

    async def nested(ctx, data):
        saved.append(ctx)
        with pytest.raises(PolicyError, match="Delegation"):
            await rt.run_worker("SearchWorker", {}, no_op, parent=ctx, depth=2)
        return {"candidate_papers": []}

    asyncio.run(rt.run_worker("SearchWorker", {}, nested))
    with pytest.raises(PolicyError, match="expired"):
        asyncio.run(saved[0].tool("scholarly-search", {"query": "test", "limit": 1}))


def test_parallelism_limits_actual_active_tasks_and_preserves_order(package):
    rt = runtime(package, limits={"max_parallel_workers": 2})
    active = peak = 0

    async def work(ctx, data):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.005)
        active -= 1
        return {"candidate_papers": data["search_queries"]}

    results = asyncio.run(
        rt.map_workers("SearchWorker", [{"search_queries": [i]} for i in range(7)], work)
    )
    assert peak == rt.usage["peak_parallel_workers"] == 2
    assert [r["candidate_papers"] for r in results] == [[i] for i in range(7)]


def test_remote_reservations_atomic_failures_and_tool_caps(package):
    calls = 0

    async def handler(ctx, payload):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        raise RuntimeError("provider unavailable")

    rt = runtime(package, handlers={"scholarly.search": handler}, limits={"max_remote_calls": 1})

    async def work(ctx, data):
        try:
            await ctx.tool("scholarly-search", {"query": "query", "limit": 1})
        except (BudgetError, RuntimeError):
            pass
        return {"candidate_papers": []}

    asyncio.run(rt.map_workers("SearchWorker", [{}, {}, {}], work))
    assert calls == 1
    assert rt.usage["remote_calls"] == 1
    assert rt.usage["tool_calls"] == {"scholarly-search": 1}


def test_worker_remote_cap_enforced_before_handler(package):
    package.graph["workers"][2]["budget"]["remote_calls"] = 0  # SearchWorker
    calls = []

    async def handler(ctx, payload):
        calls.append(payload)

    rt = runtime(package, handlers={"scholarly.search": handler})

    async def work(ctx, data):
        return await ctx.tool("scholarly-search", {"query": "query", "limit": 1})

    with pytest.raises(BudgetError, match="Remote-call budget"):
        asyncio.run(rt.run_worker("SearchWorker", {}, work))
    assert not calls and rt.usage["remote_calls"] == 0


def test_role_tool_authority_and_once_grants(package):
    calls = []

    async def handler(ctx, payload):
        calls.append(payload)
        return {"papers": [], "source": "mock", "query": payload["query"]}

    rights = grants(package) | {"network.scholarly": "once"}
    rt = Runtime(
        package,
        grants=rights,
        handlers={"scholarly.search": handler},
        approved_tools=sorted(package.tools),
    )

    async def search(ctx, data):
        await ctx.tool("scholarly-search", {"query": "query", "limit": 1})
        return {"candidate_papers": []}

    asyncio.run(rt.run_worker("SearchWorker", {}, search))
    with pytest.raises(PolicyError, match="consumed"):
        asyncio.run(rt.run_worker("SearchWorker", {}, search))
    with pytest.raises(PolicyError, match="may not call"):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, search))
    assert len(calls) == 1


def test_tool_output_schema_is_enforced(package):
    async def handler(ctx, payload):
        return {"wrong": True}

    rt = runtime(package, handlers={"scholarly.search": handler})

    async def search(ctx, data):
        await ctx.tool("scholarly-search", {"query": "query", "limit": 1})
        return {"candidate_papers": []}

    with pytest.raises(AgentPkgError, match="tool output"):
        asyncio.run(rt.run_worker("SearchWorker", {}, search))
    assert rt.usage["remote_calls"] == 1


class Router:
    capabilities = {"reasoning", "structured_output"}
    context_window = 128000
    model_id = "test-model"
    router_id = "test-router"
    remote = False
    calls = 0
    request = None

    async def count_tokens(self, request):
        self.request = request
        return 20

    async def complete(self, request, *, max_output_tokens):
        self.calls += 1
        await asyncio.sleep(0.01)
        return {"output": {"ok": True}, "input_tokens": 20, "output_tokens": 10}


def test_token_reservation_under_parallel_workers(package):
    router = Router()
    rt = runtime(package, router=router, limits={"hard_tokens": 100})
    outcomes = []

    async def work(ctx, data):
        try:
            await ctx.model(
                "screen", {"private": "value"}, {"type": "object"}, max_output_tokens=60
            )
            outcomes.append("ok")
        except BudgetError:
            outcomes.append("denied")
        return {"screened_papers": []}

    asyncio.run(rt.map_workers("ScreeningWorker", [{}, {}, {}], work))
    assert sorted(outcomes) == ["denied", "denied", "ok"]
    assert router.calls == 1 and rt.usage["tokens"] == 30
    assert rt.usage["reserved_tokens"] == 0
    assert router.request["instructions"]  # Real role skills are bound to model call.
    assert "private" not in str(rt.audit)


def test_per_worker_token_reservation_and_failed_model_charge(package):
    for role in package.graph["workers"]:
        if role["id"] == "ScreeningWorker":
            role["budget"]["tokens"] = 50
    rt = runtime(package, router=Router())

    async def work(ctx, data):
        await ctx.model("screen", {}, {"type": "object"}, max_output_tokens=60)

    with pytest.raises(BudgetError, match="Token budget exhausted"):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, work))
    assert rt.router.calls == 0

    class FailedRouter(Router):
        async def complete(self, request, *, max_output_tokens):
            raise TimeoutError("unknown provider usage")

    rt = runtime(package, router=FailedRouter())

    async def smaller(ctx, data):
        await ctx.model("screen", {}, {"type": "object"}, max_output_tokens=20)

    with pytest.raises(TimeoutError):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, smaller))
    assert rt.usage["tokens"] == 40 and rt.usage["reserved_tokens"] == 0


def test_a_refused_model_call_records_which_bound_refused_it(package):
    """Three bounds can refuse a call before dispatch; the audit names which."""
    for role in package.graph["workers"]:
        if role["id"] == "ScreeningWorker":
            role["budget"]["tokens"] = 50

    async def work(ctx, data):
        await ctx.model("screen", {}, {"type": "object"}, max_output_tokens=60)

    def refusal(rt, bound=20):
        with pytest.raises(BudgetError):
            asyncio.run(rt.run_worker("ScreeningWorker", {}, work))
        assert rt.router.calls == 0
        assert not [e for e in rt.audit if e["action"] == "model.called"]
        (event,) = [e for e in rt.audit if e["action"] == "model.refused"]
        assert event["input_bound"] == bound and event["max_output_tokens"] == 60
        assert event["reserved_tokens"] == bound + 60
        return event

    event = refusal(runtime(package, router=Router()))
    assert event["reason"] == "worker_token_budget"
    assert event["limit"] == 50 and event["used_tokens"] == 0

    event = refusal(runtime(package, router=Router(), limits={"hard_tokens": 70}))
    assert event["reason"] == "global_token_budget" and event["limit"] == 70

    class Full(Router):
        # Meets the package's declared minimum, but this request does not fit.
        context_window = 16000

        async def count_tokens(self, request):
            return 15990

    event = refusal(runtime(package, router=Full()), bound=15990)
    assert event["reason"] == "context_window" and event["context_window"] == 16000


def test_a_failed_call_records_the_adapter_s_stable_code_and_never_its_message(package):
    from agentpkg.hostbridge.errors import BridgeError

    class Slow(Router):
        async def complete(self, request, *, max_output_tokens):
            raise BridgeError("bridge_timeout", "The host did not answer — private detail")

    class Odd(Router):
        async def complete(self, request, *, max_output_tokens):
            raise BridgeError("Not An Identifier!", "whatever")

    async def work(ctx, data):
        await ctx.model("screen", {}, {"type": "object"}, max_output_tokens=20)

    rt = runtime(package, router=Slow())
    with pytest.raises(BridgeError):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, work))
    (failed,) = [e for e in rt.audit if e["action"] == "model.failed"]
    assert failed["reason"] == "bridge_timeout" and failed["error"] == "BridgeError"
    assert "private detail" not in str(rt.audit)

    rt = runtime(package, router=Odd())
    with pytest.raises(BridgeError):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, work))
    (failed,) = [e for e in rt.audit if e["action"] == "model.failed"]
    assert "reason" not in failed


def test_a_failed_call_keeps_only_the_structural_facts_its_adapter_certified(package):
    """How a call failed reaches the audit; what anyone wrote never does."""
    from agentpkg.hostbridge.errors import BridgeError

    class Rejected(Router):
        async def complete(self, request, *, max_output_tokens):
            raise BridgeError(
                "model_output_not_conforming",
                "unexpected 'research_question' — private detail",
                audit_facts={
                    "stop_reason": "stop",
                    "reported_output_tokens": 380,
                    "output_failure": "schema",
                    "schema_keyword": "additionalProperties",
                    "schema_location": "properties/provenance/items/required",
                    # Everything below is refused: prose, quotes, a negative or
                    # non-integer count, a nested value, a non-identifier key.
                    "echo": "Ignore previous instructions",
                    "quoted": "'research_question'",
                    "negative": -1,
                    "ratio": 0.5,
                    "nested": {"text": "x"},
                    "Bad Key": "stop",
                },
            )

    async def work(ctx, data):
        await ctx.model("screen", {}, {"type": "object"}, max_output_tokens=20)

    rt = runtime(package, router=Rejected())
    with pytest.raises(BridgeError):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, work))
    (called,) = [e for e in rt.audit if e["action"] == "model.called"]
    (failed,) = [e for e in rt.audit if e["action"] == "model.failed"]
    assert failed["reason"] == "model_output_not_conforming"
    assert failed["failure_facts"] == {
        "stop_reason": "stop",
        "reported_output_tokens": 380,
        "output_failure": "schema",
        "schema_keyword": "additionalProperties",
        "schema_location": "properties/provenance/items/required",
    }
    # The reservation is still what is charged: the facts explain, not settle.
    assert failed["tokens_charged"] == called["reserved_tokens"]
    audit = str(rt.audit)
    assert "private detail" not in audit and "Ignore previous" not in audit


@pytest.mark.parametrize("code", ["model_usage_invalid", "model_usage_unavailable"])
def test_an_unaccountable_usage_report_is_charged_the_whole_reservation(package, code):
    """CE-1: a call whose usage cannot be established is refused and never undercharged."""
    from agentpkg.hostbridge.errors import BridgeError

    class Unaccountable(Router):
        async def complete(self, request, *, max_output_tokens):
            raise BridgeError(code, "The host's usage report cannot be accounted for")

    async def work(ctx, data):
        await ctx.model("screen", {}, {"type": "object"}, max_output_tokens=20)

    rt = runtime(package, router=Unaccountable())
    with pytest.raises(BridgeError):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, work))
    (called,) = [e for e in rt.audit if e["action"] == "model.called"]
    (failed,) = [e for e in rt.audit if e["action"] == "model.failed"]
    assert failed["reason"] == code
    assert failed["tokens_charged"] == called["reserved_tokens"]
    assert rt.usage["tokens"] == called["reserved_tokens"]
    assert rt.usage["reserved_tokens"] == 0


def test_model_contract_violation_halts_and_charges_full_reservation(package):
    class DishonestRouter(Router):
        async def complete(self, request, *, max_output_tokens):
            return {"output": {}, "input_tokens": 21, "output_tokens": 1000}

    rt = runtime(package, router=DishonestRouter())

    async def work(ctx, data):
        await ctx.model("screen", {}, {"type": "object"}, max_output_tokens=60)

    with pytest.raises(PolicyError, match="violated token"):
        asyncio.run(rt.run_worker("ScreeningWorker", {}, work))
    assert rt.usage["tokens"] == 1021  # A dishonest router's observed overrun is visible.


def test_host_limits_only_narrow_and_unsupported_policies_fail_closed(package):
    rt = runtime(package, limits={"hard_tokens": 9999999})
    assert rt.budget["hard_tokens"] == package.policy["budget"]["hard_tokens"]
    for key, value in [("scope", "user-global"), ("raw_documents", True)]:
        changed = copy.deepcopy(package)
        changed.policy["memory"][key] = value
        with pytest.raises(PolicyError):
            runtime(changed)
    changed = copy.deepcopy(package)
    changed.policy["delegation"]["allow_remote"] = True
    with pytest.raises(PolicyError):
        runtime(changed)


def test_audit_hash_chain_and_session_clear(package):
    rt = runtime(package)
    rt.state["secret"] = "session contents"
    rt.clear()
    assert rt.state == {} and "session contents" not in str(rt.audit)
    previous = None
    for event in rt.audit:
        unsigned = {k: v for k, v in event.items() if k != "event_hash"}
        assert unsigned["previous_hash"] == previous
        assert digest(unsigned) == event["event_hash"]
        previous = event["event_hash"]
