"""Catalog v2's Python driver (T30, D-302): the reference runtime composed in process.

A one-shot case is composed as the production execution runner admits a run
(`agentpkg.execution.session.ExecutionSession._begin`: the capability check, the person's
decisions and the required permissions) and then as `agentpkg run --mode fixture` executes it
(`cli._dispatch`: the fixture adapters, the run's memory from `cli_memory`, `run_workflow` under
the host limits). The production runner has no fixture mode and talks to its host over a bridge
and inherited descriptors, so its admission is asked of the same functions in the same order; the
Chrome core's `ExecutionSession` does both in one object, which the Node driver composes as
`cli-run.ts` does. A conversation is composed as `agentpkg converse` composes it (`cli._converse`).

Observation-only wrappers sit at the four seams: the fixture router, the fixture tool handlers,
the compute engine (`agentpkg.compute.engine.default_engine`, which the runtime asks for its
engine) and the consent host. Each records what crossed the seam and returns or raises exactly what
the wrapped object did.

Run as a worker: `python driver_py.py <expected agentpkg root>`; one JSON case per stdin line, one
JSON record per stdout line. The worker refuses to start unless `agentpkg` resolves to the private
copy it was given, and every socket, name lookup and child process is refused (v1's guard).
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOLATILE = {
    "timestamp",
    "ts",
    "at",
    "time",
    "sequence",
    "seq",
    "hash",
    "prev_hash",
    "previous_hash",
    "event_hash",
    "run_id",
    "conversation_id",
}
FIXED_FILES = {"result.json", "audit.json", "usage.json", "provenance.json", "run.json"}


def _taints(value, taints) -> list[str]:
    if not taints:
        return []
    text = json.dumps(value, ensure_ascii=False, default=str)
    return [taint for taint in taints if taint in text]


class RecordingRouter:
    """The fixture router, observed: every `complete` is recorded with its task and input."""

    def __init__(self, inner, seams, taints, turn):
        self._inner, self._seams, self._taints, self._turn = inner, seams, taints, turn

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def count_tokens(self, request):
        return await self._inner.count_tokens(request)

    async def complete(self, request, *, max_output_tokens):
        entry = {
            "turn": self._turn,
            "task": request.get("task"),
            "input": request.get("data"),
            "taints": _taints(request, self._taints),
            "max_output_tokens": max_output_tokens,
        }
        self._seams["model"].append(entry)
        try:
            result = await self._inner.complete(request, max_output_tokens=max_output_tokens)
        except BaseException:
            entry["outcome"] = "threw"
            raise
        entry["outcome"] = "answered"
        entry["answer"] = result.get("output") if isinstance(result, dict) else None
        return result


def recording_handlers(package, handlers, seams, taints, turn):
    tool_of = {tool["binding"]: tool_id for tool_id, tool in package.tools.items()}
    wrapped = {}
    for binding, handler in handlers.items():

        async def handle(ctx, payload, binding=binding, handler=handler):
            entry = {
                "turn": turn,
                "tool": tool_of.get(binding),
                "binding": binding,
                "role": getattr(ctx, "role", None),
                "payload": payload,
                "taints": _taints(payload, taints),
            }
            seams["tool"].append(entry)
            try:
                answer = await handler(ctx, payload)
            except BaseException:
                entry["outcome"] = "threw"
                raise
            entry["outcome"] = "answered"
            return answer

        wrapped[binding] = handle
    return wrapped


def _outcome_facts(outcome) -> dict:
    output, output_json = None, False
    if outcome.output is not None:
        try:
            output = json.loads(outcome.output.decode("utf-8"))
            output_json = True
        except (UnicodeDecodeError, ValueError):
            output = None
    return {
        "ok": outcome.reason is None and outcome.output is not None,
        "reason": outcome.reason,
        "trap_code": outcome.trap_code,
        "detail": outcome.detail,
        "memory_pages": outcome.memory_pages,
        "elapsed_ms": outcome.elapsed_ms,
        "output_bytes": None if outcome.output is None else len(outcome.output),
        "output_json": output_json,
        "output": output,
    }


class RecordingEngine:
    """The compute engine, observed: every call with its effective limits and its outcome."""

    def __init__(self, inner, seams, turn=None):
        self._inner, self._seams, self.turn = inner, seams, turn

    def __getattr__(self, name):
        return getattr(self._inner, name)

    async def call(self, sha256, function, data, limits):
        entry = {
            "turn": self.turn,
            "module_sha256": sha256,
            "function": function,
            "input_bytes": len(data),
            "limits": {
                "memory_pages": limits.memory_pages,
                "wall_seconds": limits.wall_seconds,
                "fuel": limits.fuel,
            },
        }
        self._seams["compute"].append(entry)
        try:
            outcome = await self._inner.call(sha256, function, data, limits)
        except BaseException:
            entry["outcome"] = {"ok": False, "threw": True}
            raise
        entry["outcome"] = _outcome_facts(outcome)
        return outcome


class RecordingConsent:
    def __init__(self, inner, seams):
        self._inner, self._seams = inner, seams

    @property
    def used(self):
        return self._inner.used

    async def decide(self, request):
        entry = {
            "turn": request.turn,
            "step": request.step,
            "permissions": list(request.permissions),
            "text": request.text,
            "facts": request.facts,
        }
        self._seams["consent"].append(entry)
        answer = await self._inner.decide(request)
        entry["answer"] = answer
        return answer


class SilentConsent:
    """A host whose person never answers (examples/conversation/cases: `silent`)."""

    def __init__(self):
        self.used = set()

    async def decide(self, request):
        await asyncio.sleep(3600)


class InvalidConsent:
    """A host that answers outside the decision contract (`invalid`)."""

    def __init__(self):
        self.used = set()

    async def decide(self, request):
        return {"accepted": "yes", "decided_by": "nobody"}


def _code(exc) -> str | None:
    import re

    own = getattr(exc, "code", None)
    if isinstance(own, str) and re.fullmatch(r"[a-z][a-z0-9_]*", own):
        return own
    message = str(exc)
    match = re.match(r"workflow\.v0 ([a-z][a-z0-9_]*)", message) or re.match(
        r"([a-z][a-z0-9_]*): ", message
    )
    return match.group(1) if match else None


def _refusal(phase, exc) -> dict:
    from agentpkg.errors import AgentPkgError

    return {
        "phase": phase,
        "code": _code(exc),
        "error_class": type(exc).__name__,
        "agentpkg_error": isinstance(exc, AgentPkgError) or hasattr(exc, "code"),
        "message": str(exc)[:400],
    }


def _compact(audit) -> list[dict]:
    return [{k: v for k, v in event.items() if k not in VOLATILE} for event in audit]


def _exports(records) -> dict:
    exports = {}
    for name, data in records:
        if name in FIXED_FILES:
            continue
        try:
            exports[name] = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            exports[name] = data.decode("utf-8", errors="replace")
    return exports


class Driver:
    def __init__(self):
        from agentpkg.compute import engine as compute_engine

        self._engine_module = compute_engine
        self._production_default_engine = compute_engine.default_engine
        self.seams = None
        self._engine_turn = None
        self._engine_available = True
        self.observe = True

        def default_engine():
            # The runtime asks here for its engine (`Runtime._prepare_compute`). A host without
            # an engine is a host configuration the case states (`engine: false`).
            if not self._engine_available:
                raise compute_engine.EngineUnavailable("no engine on this host")
            engine = self._production_default_engine()
            if not self.observe:
                return engine
            return RecordingEngine(engine, self.seams, self._engine_turn)

        compute_engine.default_engine = default_engine

    def _router(self, router, taints, turn):
        return RecordingRouter(router, self.seams, taints, turn) if self.observe else router

    def _handlers(self, package, handlers, taints, turn):
        if not self.observe:
            return handlers
        return recording_handlers(package, handlers, self.seams, taints, turn)

    async def run_case(self, case: dict) -> dict:
        self.seams = {"model": [], "tool": [], "compute": [], "consent": []}
        self._engine_available = bool(case.get("engine", True))
        # `observe: false` runs the same composition with the raw objects (driver identity).
        self.observe = case.get("observe", True) is not False
        self._engine_turn = None
        record = {
            "id": case["id"],
            "runtime": "py",
            "refusal": None,
            "result": None,
            "audit": [],
            "exports": {},
            "seams": self.seams,
            "guard": [],
            "harness_error": None,
        }
        phase = "load"
        try:
            from agentpkg.errors import AgentPkgError
            from agentpkg.package import load_package
            from agentpkg.signing import verify_package

            package = load_package(case["archive"])
            phase = "cli"
            if package.manifest["entrypoint"] != "workflow.v0":
                raise AgentPkgError(
                    "Generic execution requires workflow.v0; use agentpkg-legacy for the "
                    "archived development profile"
                )
            conversational = package.graph.get("conversation") is not None
            if case["mode"] == "converse":
                if not conversational:
                    raise AgentPkgError(
                        "conversation_profile_required: this package declares no conversation; "
                        "use agentpkg run"
                    )
                phase = "verify"
                verified = verify_package(case["archive"], trusted_key=case["trust_key"])
                if verified["digest"] != package.digest:
                    raise AgentPkgError(
                        "Package changed between loading and signature verification"
                    )
                return await self._converse(package, case, record)
            if conversational and case["mode"] == "run":
                raise AgentPkgError(
                    "conversation_profile: this package declares a conversation and runs turn by "
                    "turn; use agentpkg converse"
                )
            phase = "verify"
            verified = verify_package(case["archive"], trusted_key=case["trust_key"])
            if verified["digest"] != package.digest:
                raise AgentPkgError("Package changed between loading and signature verification")
            phase = "admission"
            from agentpkg.execution.policy import HostExecutionLimits, effective_deadline_seconds

            host_limits = HostExecutionLimits.normalize(case.get("limits"))
            self._admit(package, case, host_limits)
            phase = "start"
            from agentpkg.fixtures import fixture_adapters
            from agentpkg.memory.host import cli_memory

            router, handlers, input_value = fixture_adapters(package)
            approved = sorted(set(case.get("approve") or ()))
            unknown = sorted(set(approved) - set(package.tools))
            if unknown:
                raise AgentPkgError(
                    f"--approve-tool names tools this package does not declare: {unknown}"
                )
            memory_run, _folder, _memory_handlers = cli_memory(
                package, mode="fixture", decisions=case["grants"]
            )
            phase = "run"
            from agentpkg.artifacts import artifact_records
            from agentpkg.workflow import run_workflow

            try:
                result = await run_workflow(
                    package,
                    input_value,
                    grants=case["grants"],
                    handlers=self._handlers(package, handlers, case.get("taints", []), None),
                    router=self._router(router, case.get("taints", []), None),
                    approved_tools=approved,
                    memory=memory_run,
                    # As the production runner hands them to the interpreter
                    # (`ExecutionSession._run`): the keys `Runtime` accepts, and this host's
                    # effective deadline.
                    limits=host_limits.runtime_limits(),
                    deadline_seconds=effective_deadline_seconds(package, host_limits),
                )
            except Exception as exc:
                report = getattr(exc, "execution_report", None)
                if report is None:
                    raise
                record["result"] = {
                    "status": report["status"],
                    "error_code": report.get("error_code"),
                    "failed_node": getattr(exc, "node_id", None),
                }
                record["audit"] = _compact(report["audit"])
                record["memory"] = report.get("memory")
                return record
            record["result"] = {
                "status": result["status"],
                "error_code": result.get("error_code"),
                "failed_node": None,
            }
            record["audit"] = _compact(result["audit"])
            record["exports"] = _exports(artifact_records(result, package))
            record["memory"] = result.get("memory")
        except Exception as exc:  # a refusal before or outside the interpreter's own report
            record["refusal"] = _refusal(phase, exc)
        return record

    @staticmethod
    def _admit(package, case, limits) -> None:
        """`ExecutionSession._begin` steps 2 and 3 for a fixture plan: what this host can run
        (every declared tool is either approved, standing in for its fixture binding, or denied),
        then the person's decisions and the required (model) permissions."""
        from agentpkg.browser.runplan import mode_permission_ids
        from agentpkg.execution.errors import ExecutionError
        from agentpkg.execution.policy import check_capabilities, normalize_grants

        approved = sorted(set(case.get("approve") or ()) & set(package.tools))
        denied = sorted(set(package.tools) - set(approved))
        check_capabilities(
            package,
            limits,
            tool_bindings=[{"tool_id": tool_id} for tool_id in approved],
            denied_tools=denied,
        )
        grants = normalize_grants(package, case["grants"])
        for permission_id in mode_permission_ids(package, "model"):
            if grants.get(permission_id, "deny") == "deny":
                raise ExecutionError(
                    "execution_permission_denied",
                    f"A model-backed run requires permission {permission_id!r}, which is denied.",
                    detail={"permission": permission_id},
                )

    async def _converse(self, package, case, record) -> dict:
        from agentpkg.artifacts import artifact_records
        from agentpkg.conversation import Conversation
        from agentpkg.conversation.host import TranscriptConsent
        from agentpkg.conversation.transcript import check_transcript, read_input_transcript
        from agentpkg.fixtures import fixture_adapters
        from agentpkg.memory.host import cli_memory

        phase = "start"
        try:
            if case.get("transcript") is not None:
                import tempfile

                with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
                    json.dump(case["transcript"], handle)
                transcript = read_input_transcript(handle.name)
                Path(handle.name).unlink()
            else:
                transcript = package.json(package.graph["conversation"]["fixture"])
            grants = case["grants"]
            approved = sorted(set(case.get("approve") or ()))
            check_transcript(transcript, package, grants)
            router, handlers, _ = fixture_adapters(package)
            taints = case.get("taints", [])
            turn_files = {}
            engine_owner = self

            def adapters(turn):
                engine_owner._engine_turn = turn
                memory_run, _folder, _handlers = cli_memory(
                    package, mode="fixture", decisions=grants
                )
                return {
                    "router": self._router(router, taints, turn),
                    "handlers": self._handlers(package, handlers, taints, turn),
                    "memory": memory_run,
                }

            hosts = {"silent": SilentConsent, "invalid": InvalidConsent}

            def consent(turn, decisions):
                inner = (
                    hosts[case["consent_host"]]()
                    if case.get("consent_host")
                    else TranscriptConsent(decisions)
                )
                return RecordingConsent(inner, self.seams) if self.observe else inner

            def on_turn(index, report, status):
                records = artifact_records(report, package if status == "completed" else None)
                turn_files[str(index)] = _exports(records)

            conversation = Conversation(
                package,
                grants=grants,
                approved_tools=approved,
                adapters=adapters,
                limits=case.get("limits"),
                consent=consent,
                on_turn=on_turn,
            )
            phase = "run"
            result = await conversation.run(transcript)
            turns = [
                {
                    "turn": t.get("turn"),
                    "status": t.get("status"),
                    "refusal": t.get("refusal"),
                    "error_code": t.get("error_code"),
                    "decisions": t.get("decisions", []),
                }
                for t in result["transcript"]["turns"]
            ]
            failed = next((t for t in turns if t["status"] == "failed"), None)
            record["result"] = {
                "status": result["status"],
                "error_code": failed["error_code"] if failed else None,
                "failed_node": None,
                "turns": turns,
                "ended": result["ended"],
                "state": result["state"],
            }
            record["audit"] = _compact(result["audit"])
            record["exports"] = turn_files
        except Exception as exc:
            record["refusal"] = _refusal(phase, exc)
        return record


def _check_import(expected_root: str) -> str:
    import agentpkg

    location = str(Path(agentpkg.__file__).resolve())
    if not location.startswith(str(Path(expected_root).resolve()) + "/"):
        raise SystemExit(
            f"catalog v2 worker imported agentpkg from {location}, not {expected_root}"
        )
    return location


def main(argv: list[str]) -> int:
    expected_root = argv[1]
    _check_import(expected_root)
    build = json.loads((Path(expected_root).parent / "build.json").read_text())
    sys.path.insert(0, str(HERE.parent.parent))  # v1's `harness` (the offline guard)
    from harness.guards import PythonGuard

    driver = Driver()
    guard = PythonGuard()
    loop = asyncio.new_event_loop()
    out = sys.stdout
    with guard:
        for line in sys.stdin:
            if not line.strip():
                continue
            message = json.loads(line)
            if message.get("op") == "hello":
                answer = {"op": "hello", "runtime": "py", "build": build}
            else:
                before = len(guard.refused)
                started = time.perf_counter()
                try:
                    answer = loop.run_until_complete(driver.run_case(message))
                except BaseException as exc:  # noqa: BLE001 - a harness failure, recorded
                    answer = {
                        "id": message.get("id"),
                        "runtime": "py",
                        "harness_error": f"{type(exc).__name__}: {exc}"[:400],
                    }
                answer["guard"] = guard.refused[before:]
                answer["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
            out.write(json.dumps(answer, ensure_ascii=False, default=str) + "\n")
            out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
