"""Agent Links through the whole reference path (link.v0 §3 and §5, D-691, D-692): the control
plane resolves, authorizes and plans the caller and each linked package; the execution session
re-verifies every archive against its own inner plan, builds the same link host the CLI builds,
and runs. The fake host answers model and tool calls from the packages' own fixtures."""

import asyncio
import copy
import json
import os
import re
from pathlib import Path

from execution_fakes import duplex
from test_link_control import Stack

from agentpkg.execution import protocol as execution_protocol
from agentpkg.execution.session import ExecutionSession
from agentpkg.hostbridge.peer import BridgePeer

TASK = re.compile(r"^## Task\n(.+)$", re.MULTILINE)
PLAN_KEYS = ("run_plan_id", "run_plan_sha256", "session_id", "tool_bindings", "resource_grants")
PACKAGE_KEYS = ("package_id", "name", "version", "digest", "archive_sha256", "execution_profile")
EXECUTION_KEYS = ("mode", "profile", "required_permission_ids", "required_tool_ids")


def execution_view(plan: dict) -> dict:
    """The bounded facts of a control-plane Run Plan a host hands the runner."""
    plan = copy.deepcopy(plan)
    binding = plan["model_binding"]
    view = {key: plan[key] for key in PLAN_KEYS}
    view["package"] = {key: plan["package"][key] for key in PACKAGE_KEYS}
    view["publisher"] = {
        key: plan["publisher"][key]
        for key in ("signer_fingerprint", "signature_status", "trust_status")
    }
    view["execution"] = {key: plan["execution"][key] for key in EXECUTION_KEYS}
    view["model_binding"] = {
        **{key: binding[key] for key in ("host_model_id", "provider_id", "model_id")},
        "display_name": binding["display_name"],
        "capabilities": {
            name: {"value": fact["value"], "basis": fact["basis"]}
            for name, fact in binding["descriptor"]["capabilities"].items()
        },
        "limits": {"context_tokens": binding["descriptor"]["limits"]["context_tokens"]},
        "properties": {"local": binding["descriptor"]["properties"]["local"]},
    }
    for key in ("links", "parent"):
        if key in plan:
            view[key] = plan[key]
    return view


def authorization_view(plan: dict) -> dict:
    keys = ("receipt_id", "receipt_sha256", "issued_at", "expires_at", "decisions")
    record = copy.deepcopy(plan["authorization"])
    return {key: record[key] for key in (*keys, "tool_approvals")}


class ReplayHost:
    """The parent: every model and tool answer comes from a package's own fixture."""

    def __init__(self, fixtures):
        self.models = {}
        self.tools = {}
        for fixture in fixtures:
            for task, cases in fixture["models"].items():
                self.models.setdefault(task, []).extend(cases)
            for tool, cases in fixture["tools"].items():
                self.tools.setdefault(tool, []).extend(cases)
        self.requests = []

    async def __call__(self, method, params):
        if method == execution_protocol.PROGRESS_METHOD:
            return {"accepted": True}
        self.requests.append((method, params))
        if method == "model.count_tokens":
            # A tokenizer, so that the probe's small budgets hold: without one the bound is the
            # request's bytes.
            return {"supported": True, "input_tokens": 60}
        if method == "tool.call":
            case = next(c for c in self.tools[params["tool_id"]] if c["input"] == params["args"])
            return {
                "status": "ok",
                "output": case["output"],
                "tool_id": params["tool_id"],
                "binding_id": params["binding_id"],
                "binding_sha256": params["binding_sha256"],
                "remote": False,
                "duration_ms": 1.0,
            }
        task = TASK.search(params["system"]).group(1).strip()
        data = json.loads(params["user"])
        case = next(c for c in self.models[task] if c["input"] == data)
        return {
            "text": json.dumps(case["output"]),
            "model_id": "host/alpha",
            "provider_id": "host",
            "response_model": "alpha-test",
            "stop_reason": "stop",
            "execution": {"mode": "direct-provider", "owner": {"kind": "provider", "id": "host"}},
            "constrained": True,
            "constraint_detail": "json_schema response format",
            "usage": {"input_tokens": 60, "output_tokens": 20, "cost_usd": 0.0},
        }


class Composition:
    """One caller planned with its links, and a runner fed from the control plane's leases."""

    def __init__(self, tmp_path, keys, variant=None, *, deny=(), once=None):
        self.stack = stack = Stack(tmp_path, keys, variant)
        review = stack.resolve()
        self.inner = {}
        for link in review["links"]:
            name = link["dependency"]
            if name in deny:
                stack.control.decide_link(
                    stack.session, package_digest=stack.digest, dependency=name, decision="denied"
                )
                continue
            self.inner[name] = self.plan_link(link, once if once and once[0] == name else None)
        self.plan = stack.plan_caller()["run_plan"]
        self.tmp_path = tmp_path
        self.leases = []
        self.fixtures = [
            json.loads((stack.built.caller / "fixtures" / "workflow.json").read_text())
        ] + [
            json.loads(
                (tmp_path / "one" / "linked" / name / "fixtures" / "workflow.json").read_text()
            )
            for name in ("index", "scribe")
        ]

    def plan_link(self, link, once=None):
        stack, session, digest = self.stack, link["session_id"], link["package"]["digest"]
        if once is None:
            return stack.plan(session, digest)["run_plan"]
        from tool_fakes import registry_for

        control = stack.control
        request = control.permissions(session)
        decisions = {p["id"]: "session" for p in request["permissions"]} | {once[1]: "once"}
        receipt = control.authorize(
            session,
            package_digest=digest,
            decisions=decisions,
            tool_approvals={t["tool_id"]: True for t in request["tool_approvals"]},
        )
        package = control._session(session).package
        from test_link_control import CATALOG

        return control.prepare_run_plan(
            session,
            package_digest=digest,
            receipt_id=receipt["receipt_id"],
            model_id="host/alpha",
            catalog=CATALOG,
            tool_registry=registry_for(package) if package.tools else None,
        )["run_plan"]

    def lease(self, session, plan):
        issued = self.stack.control.issue_execution_lease(
            session,
            package_digest=plan["package"]["digest"],
            run_plan_id=plan["run_plan_id"],
            run_plan_sha256=plan["run_plan_sha256"],
        )
        self.leases.append((session, issued["lease"]["lease_id"]))
        return os.open(issued["lease"]["path"], os.O_RDONLY)

    def links_params(self):
        return {
            name: {"run_plan": execution_view(plan), "authorization": authorization_view(plan)}
            for name, plan in self.inner.items()
        }

    async def run(self, *, links=None, link_fds=None, plan=None):
        """Begin and, when begin is accepted, run; returns (begin or its error, result)."""
        review = {
            link["dependency"]: link["session_id"]
            for link in self.stack.control.links(self.stack.session)["links"]
        }
        # The caller's lease first: its preflight re-verifies the inner plans, and leasing an
        # inner plan under a `once` grant spends that receipt.
        package_fd = self.lease(self.stack.session, self.plan)
        fds = {name: self.lease(review[name], inner) for name, inner in self.inner.items()}
        params = {
            "run_id": "run-links",
            "run_plan": execution_view(self.plan) if plan is None else plan,
            "authorization": authorization_view(self.plan),
            "input": self.fixtures[0]["input"],
            "links": self.links_params() if links is None else links,
        }
        return await self.drive(
            package_fd, fds if link_fds is None else link_fds(fds), params, close=fds.values()
        )

    async def run_alone(self, name):
        """A linked package's inner plan handed to a runner as if it were a caller's: its own
        archive (read from the file, so that only the runner is asked), its own plan and
        authorization, its own fixture input, no links."""
        inner = self.inner[name]
        fixture = self.fixtures[1 + ("index", "scribe").index(name)]
        params = {
            "run_id": "run-alone",
            "run_plan": execution_view(inner),
            "authorization": authorization_view(inner),
            "input": fixture["input"],
        }
        package_fd = os.open(self.stack.built.archives[name], os.O_RDONLY)
        return await self.drive(package_fd, {}, params)

    async def drive(self, package_fd, fds, params, close=()):
        artifacts = self.tmp_path / "artifacts"
        artifacts.mkdir(mode=0o700, exist_ok=True)
        artifacts_fd = os.open(artifacts, os.O_RDONLY | os.O_DIRECTORY)
        child_pair, parent_pair = duplex()
        host = ReplayHost(self.fixtures)
        host_peer = BridgePeer(
            *parent_pair,
            outbound_methods=execution_protocol.EXECUTION_METHODS,
            inbound_methods=execution_protocol.RUNNER_OUTBOUND_METHODS,
            handler=host,
            prefix="h",
            version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
        )
        session = None

        async def handler(method, params):
            return await session(method, params)

        session = ExecutionSession(
            BridgePeer(
                *child_pair,
                outbound_methods=execution_protocol.RUNNER_OUTBOUND_METHODS,
                inbound_methods=execution_protocol.EXECUTION_METHODS,
                handler=handler,
                prefix="x",
                version=execution_protocol.EXECUTION_PROTOCOL_VERSION,
            ),
            package_fd=package_fd,
            artifacts_fd=artifacts_fd,
            link_fds=fds,
        )
        tasks = [
            asyncio.create_task(session._peer.serve()),
            asyncio.create_task(host_peer.serve()),
        ]
        try:
            try:
                begin = await host_peer.call("execution.begin", params, timeout=30)
            except Exception as error:  # noqa: BLE001 - the refusal is what the test reads
                return error, None, host, artifacts
            result = await host_peer.call("execution.run", {}, timeout=60)
            await host_peer.call("execution.end", {}, timeout=30)
            return begin, result, host, artifacts
        finally:
            await host_peer.close()
            await session._peer.close()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for fd in (package_fd, artifacts_fd, *close):
                try:
                    os.close(fd)
                except OSError:
                    pass
            for session_id, lease_id in self.leases:
                self.stack.control.release_execution_lease(session_id, lease_id)
            self.leases.clear()


def code(error):
    return getattr(error, "code", None) or str(error)


def host_case(case_id):
    """A case of the list's `host` stage: the execution host refuses the plan it was handed."""
    from link_probe import CASES

    cases = json.loads((CASES / "cases.json").read_text())["cases"]
    return next(c for c in cases if c["stage"] == "host" and c["id"] == case_id)


def test_the_planned_composition_runs_through_the_execution_session(tmp_path, keys):
    composition = Composition(tmp_path, keys, "planned-walk")
    begin, result, host, artifacts = asyncio.run(composition.run())
    assert isinstance(begin, dict), begin
    assert result["status"] == "completed", result.get("failure")
    # The host answered one tool call per lookup and one draft: every inner call went through
    # the same bridge, under the inner plan's own binding.
    tools = [params for method, params in host.requests if method == "tool.call"]
    assert [call["tool_id"] for call in tools] == ["lookup", "lookup"]
    assert result["usage"]["links"]["index"]["runs"] == 2
    assert result["usage"]["links"]["scribe"]["model_calls"] == 1
    assert result["usage"]["tool_calls"] == {"index:lookup": 2}
    links = json.loads((artifacts / "links.json").read_text())
    assert [link["decision"] for link in links["links"]] == ["accepted", "accepted"]
    for link in links["links"]:
        # The record's plan is the inner Run Plan the person's decision produced.
        inner = composition.inner[link["dependency"]]
        assert link["plan_hash"] == inner["run_plan_sha256"] == link["plan"]["run_plan_sha256"]
        assert link["plan"]["parent"]["package_digest"] == composition.stack.digest
    assert len(links["runs"]) == 3
    for run in links["runs"]:
        assert (artifacts / f"link-{run['inner_run_id']}.audit.json").is_file()
    audit = json.loads((artifacts / "audit.json").read_text())
    started = [e for e in audit if e["action"] == "link.started"]
    assert {e["inner_plan_hash"] for e in started} == {
        plan["run_plan_sha256"] for plan in composition.inner.values()
    }
    # The session's record verifies as a CLI run's does.
    import importlib.util

    script = Path(__file__).resolve().parents[2] / "scripts" / "verify_link_run.py"
    spec = importlib.util.spec_from_file_location("verify_link_run", script)
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    checked = verifier.verify(
        artifacts, package=composition.stack.archive, links=composition.stack.built.archives
    )
    assert checked["passed"], checked["checks"]


BOUND_FIGURES = (
    "max_hops",
    "max_activations",
    "activations",
    "model_calls",
    "tool_calls",
    "compute_calls",
    "remote_calls",
    "tokens",
    "seconds",
)


def recorded_and_reserved(composition):
    """The network's "at most" as the execution host recorded it at begin (R-24) and as the
    runtime stated it when the node started (R-17)."""
    begin, result, _, artifacts = asyncio.run(composition.run())
    assert isinstance(begin, dict), begin
    assert result["status"] == "completed", result.get("failure")
    audit = json.loads((artifacts / "audit.json").read_text())
    started = [e for e in audit if e["action"] == "network.started"][0]
    recorded = begin["capabilities"]["network"]
    return recorded, {key: recorded["worst_case"][key] for key in BOUND_FIGURES}, started["bound"]


def test_the_execution_host_records_the_bound_the_runtime_reserves(tmp_path, keys):
    """T65 review 1, finding 6: with links, the recorded "at most" is the composed one, the
    same figures as `network.started`'s: each link's worst case inside its role."""
    _, recorded, reserved = recorded_and_reserved(Composition(tmp_path, keys, "planned-walk"))
    assert recorded == reserved
    assert recorded["tool_calls"] == {"index:lookup": 2}
    assert recorded["model_calls"] == 9  # the desk's eight and scribe's one


def test_the_recorded_bound_leaves_out_a_denied_links_role(tmp_path, keys):
    network, recorded, reserved = recorded_and_reserved(
        Composition(tmp_path, keys, "denied-link-excluded", deny=("index",))
    )
    assert recorded == reserved
    assert recorded["activations"]["Lookup"] == 0 and recorded["tool_calls"] == {}
    assert network["role_budgets"]["Lookup"]["activation_bound"] == 0
    assert network["role_budgets"]["Writer"]["activation_bound"] == 1
    # One set of figures: every role's recorded bound is the worst case's, so Desk does not
    # count the edges back from the role that is never activated.
    assert {
        role: budget["activation_bound"] for role, budget in network["role_budgets"].items()
    } == recorded["activations"]
    assert recorded["activations"]["Desk"] == 2


def test_a_denied_link_reaches_the_runner_as_a_decision_without_an_archive(tmp_path, keys):
    composition = Composition(tmp_path, keys, "denied-link-excluded", deny=("index",))
    assert set(composition.inner) == {"scribe"}
    begin, result, host, artifacts = asyncio.run(composition.run())
    assert isinstance(begin, dict), begin
    assert result["status"] == "completed", result.get("failure")
    assert not [1 for method, _ in host.requests if method == "tool.call"]
    links = json.loads((artifacts / "links.json").read_text())
    assert {link["dependency"]: link["decision"] for link in links["links"]} == {
        "index": "denied",
        "scribe": "accepted",
    }
    assert [run["dependency"] for run in links["runs"]] == ["scribe"]


def test_an_inner_plan_that_is_not_the_one_the_callers_plan_names_is_refused(tmp_path, keys):
    """N-34: another parent, another hash, or another package under the dependency's name."""
    assert host_case("inner-plan-replay")["code"] == "link_plan_parent_mismatch"
    composition = Composition(tmp_path, keys)

    def changed(mutate):
        links = composition.links_params()
        mutate(links)
        return links

    for mutate in (
        lambda links: links["index"]["run_plan"]["parent"].update(dependency="scribe"),
        lambda links: links["index"]["run_plan"]["parent"].update(package_digest="0" * 64),
        lambda links: links["index"]["run_plan"].update(run_plan_sha256="0" * 64),
        lambda links: links.update(index=links["scribe"]),
    ):
        begin, result, *_ = asyncio.run(composition.run(links=changed(mutate)))
        assert result is None and code(begin) == "link_plan_parent_mismatch", begin


def test_an_inner_plan_does_not_run_as_a_callers_plan(tmp_path, keys):
    """N-54, L-15's limit case (T65 review 1, finding 2): an inner plan with no caller at all.
    Begun on its own, the linked package would run outside any composition, on a link's card."""
    assert host_case("inner-plan-alone")["code"] == "link_plan_parent_mismatch"
    composition = Composition(tmp_path, keys)
    for name in ("index", "scribe"):
        assert composition.inner[name]["parent"]["dependency"] == name
        begin, result, host, _ = asyncio.run(composition.run_alone(name))
        assert result is None and code(begin) == "link_plan_parent_mismatch", begin
        assert not host.requests


def test_a_linked_package_is_leased_only_beside_its_caller(tmp_path, keys):
    """The control plane's half of the same rule: the bytes of a linked package leave on a
    lease only while its caller holds one, on a plan that names this inner plan."""
    from agentpkg.browser.errors import ControlPlaneError

    composition = Composition(tmp_path, keys)
    control, stack = composition.stack.control, composition.stack
    listed = control.links(stack.session)["links"]
    review = {link["dependency"]: link["session_id"] for link in listed}
    try:
        composition.lease(review["index"], composition.inner["index"])
    except ControlPlaneError as refusal:
        assert refusal.code == "link_lease_without_caller", refusal
    else:
        raise AssertionError("an inner plan was leased with no caller's lease")
    # Beside the caller's lease it is issued; once the caller's is released, no longer.
    os.close(composition.lease(stack.session, composition.plan))
    os.close(composition.lease(review["index"], composition.inner["index"]))
    for session_id, lease_id in composition.leases:
        control.release_execution_lease(session_id, lease_id)
    composition.leases.clear()
    try:
        composition.lease(review["scribe"], composition.inner["scribe"])
    except ControlPlaneError as refusal:
        assert refusal.code == "link_lease_without_caller", refusal
    else:
        raise AssertionError("an inner plan was leased after its caller's lease ended")


def test_releasing_the_callers_lease_releases_its_linked_packages_leases(tmp_path, keys):
    """A linked package's lease lives only beside its caller's (L-15): when the caller's lease
    is released, by the host or because a decision on a link cleared its plan, the leases of its
    linked packages go with it."""
    composition = Composition(tmp_path, keys)
    control, stack = composition.stack.control, composition.stack
    listed = control.links(stack.session)["links"]
    review = {link["dependency"]: link["session_id"] for link in listed}

    def leased():
        os.close(composition.lease(stack.session, composition.plan))
        os.close(composition.lease(review["index"], composition.inner["index"]))
        caller = [lease for session, lease in composition.leases if session == stack.session]
        child = [lease for session, lease in composition.leases if session == review["index"]]
        composition.leases.clear()
        return caller[0], child[0]

    caller_lease, child_lease = leased()
    assert control.release_execution_lease(stack.session, caller_lease)["released"] is True
    # The linked package's lease is gone already: releasing it again finds nothing.
    assert control.release_execution_lease(review["index"], child_lease)["released"] is False


def test_the_runner_verifies_each_linked_archive_itself(tmp_path, keys):
    composition = Composition(tmp_path, keys)
    swapped = lambda fds: {"index": fds["scribe"], "scribe": fds["scribe"]}  # noqa: E731
    begin, result, *_ = asyncio.run(composition.run(link_fds=swapped))
    assert result is None and code(begin) == "execution_artifact_mismatch", begin
    missing = lambda fds: {"scribe": fds["scribe"]}  # noqa: E731
    begin, result, *_ = asyncio.run(composition.run(link_fds=missing))
    assert result is None and code(begin) == "execution_plan_invalid", begin
    begin, result, *_ = asyncio.run(composition.run(links={}))
    assert result is None and code(begin) == "execution_plan_invalid", begin


def test_a_plan_without_its_links_does_not_run(tmp_path, keys):
    composition = Composition(tmp_path, keys)
    bare = execution_view(composition.plan)
    del bare["links"]
    begin, result, *_ = asyncio.run(composition.run(plan=bare))
    assert result is None and code(begin) == "execution_plan_invalid", begin


def test_an_inner_plan_is_a_model_backed_plan_on_its_callers_route(tmp_path, keys):
    """L-14 at the execution host (T65 review 1, nit 7): the inner run is given the caller's
    router, so an inner plan that names another model, or is a tool probe, is refused."""
    composition = Composition(tmp_path, keys)
    links = composition.links_params()
    links["scribe"]["run_plan"]["model_binding"]["host_model_id"] = "host/beta"
    begin, result, *_ = asyncio.run(composition.run(links=links))
    assert result is None and code(begin) == "execution_plan_invalid", begin
    links = composition.links_params()
    links["index"]["run_plan"]["execution"]["mode"] = "tool_probe"
    begin, result, *_ = asyncio.run(composition.run(links=links))
    assert result is None and code(begin) == "execution_plan_invalid", begin


def test_a_once_grant_the_composition_consumes_twice_is_refused_at_begin(tmp_path, keys):
    composition = Composition(tmp_path, keys, once=("index", "desk.read"))
    begin, result, *_ = asyncio.run(composition.run())
    assert result is None and code(begin) == "execution_grant_unsupported", begin


def test_a_callers_grant_does_not_stand_in_for_a_linked_packages_own(tmp_path, keys):
    """The caller holds `model.reasoning`; the linked package's own authorization denies it. The
    execution host refuses to begin: a linked package runs on its own grants or not at all."""
    composition = Composition(tmp_path, keys)
    assert composition.plan["authorization"]["decisions"]["model.reasoning"] == "session"
    links = composition.links_params()
    links["scribe"]["authorization"]["decisions"]["model.reasoning"] = "deny"
    begin, result, *_ = asyncio.run(composition.run(links=links))
    assert result is None and code(begin) == "execution_permission_denied", begin
