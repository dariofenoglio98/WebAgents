"""The host side of one worker: the Node helper process and the in-process runner.

`HostHelper` starts `host_helper.mjs` against one compiled plugin build and
serves the requests the real plugin backend makes back into this process:

    cp.dispatch          the control plane's own route table (BrowserAPI.dispatch)
    provider.complete    the synthetic model provider (what OpenClaw's
                         api.runtime.llm would be)
    net.resolve          the recording DNS stand-in
    net.transport        the recording HTTP stand-in behind the broker's seam
    file.parse           the recording PDF parser behind the broker's seam

and the runner's stdio, carried as notifications (`runner.*`). The runner is
the production `ExecutionSession` behind a production `BridgePeer`, composed
exactly as `agentpkg.execution.session.serve` composes them; only stdio is
replaced by the RPC stream.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
from pathlib import Path

from .paths import HOST_HELPER
from .rpc import RpcError, RpcPeer

# The control plane's HTTP front end bounds responses (server.MAX_RESPONSE_BYTES).
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class RunnerStdout:
    """The runner's stdout: every write becomes one ordered notification."""

    def __init__(self, rpc: RpcPeer, sid: int):
        self._rpc = rpc
        self._sid = sid
        self.closed = False

    def write(self, data: bytes) -> None:
        if self.closed:
            return
        self._rpc.notify("runner.stdout", {"sid": self._sid, "data": data.decode("utf-8")})

    async def drain(self) -> None:
        await self._rpc.drain()

    def close(self) -> None:
        self.closed = True


class InProcessRunners:
    """Production execution sessions, one per spawn the real ChildBridge asks for."""

    def __init__(self, rpc: RpcPeer):
        self.rpc = rpc
        self.readers: dict[int, asyncio.StreamReader] = {}
        self.tasks: dict[int, asyncio.Task] = {}
        self.sessions: dict[int, object] = {}
        self.case = None

    def spawn(self, params: dict) -> None:
        from agentpkg.hostbridge import protocol as bridge_protocol

        sid = int(params["sid"])
        reader = asyncio.StreamReader(limit=bridge_protocol.MAX_FRAME_BYTES)
        self.readers[sid] = reader
        case = self.case
        if case is not None:
            case.record("runner.spawn", sid=sid)
            case.run_dir = params.get("run_dir")
        self.tasks[sid] = asyncio.create_task(
            self._serve(sid, reader, params.get("lease_path"), params.get("run_dir"))
        )

    def stdin(self, params: dict) -> None:
        reader = self.readers.get(int(params["sid"]))
        if reader is not None and not reader.at_eof():
            reader.feed_data(str(params.get("data", "")).encode("utf-8"))

    def stdin_end(self, params: dict) -> None:
        reader = self.readers.get(int(params["sid"]))
        if reader is not None and not reader.at_eof():
            reader.feed_eof()

    def kill(self, params: dict) -> None:
        task = self.tasks.get(int(params["sid"]))
        if self.case is not None:
            self.case.record("runner.kill", sid=params.get("sid"), signal=params.get("signal"))
        if task is not None and not task.done():
            task.cancel()

    async def _serve(self, sid: int, reader, lease_path, run_dir) -> None:
        # The composition of `agentpkg.execution.session.serve`, with stdio
        # replaced. Descriptors are opened here exactly as the real backend
        # opens them before it spawns the child (O_RDONLY|O_NOFOLLOW).
        from agentpkg.execution import protocol
        from agentpkg.execution.session import ExecutionSession
        from agentpkg.hostbridge.errors import BridgeError, ProtocolError
        from agentpkg.hostbridge.peer import BridgePeer

        case = self.case
        writer = RunnerStdout(self.rpc, sid)
        fds: list[int] = []
        code, signal = 0, None
        try:
            if not lease_path or not run_dir:
                raise RuntimeError("runner spawned without a lease or run directory")
            fds.append(os.open(lease_path, os.O_RDONLY | os.O_NOFOLLOW))
            fds.append(os.open(run_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
            if case is not None:
                case.before_runner_reads(lease_path)
            session = None

            async def handler(method: str, params: dict) -> dict:
                try:
                    result = await session(method, params)
                except BridgeError as exc:
                    if case is not None:
                        case.record(
                            "runner.refused",
                            method=method,
                            code=exc.code,
                            detail=_json_safe(exc.detail),
                        )
                    raise
                except BaseException as exc:
                    if case is not None and not isinstance(exc, asyncio.CancelledError):
                        case.record(
                            "runner.crashed",
                            method=method,
                            error=f"{type(exc).__name__}: {exc}"[:500],
                        )
                    raise
                if case is not None:
                    case.runner_result(method, result)
                return result

            peer = BridgePeer(
                reader,
                writer,
                outbound_methods=protocol.RUNNER_OUTBOUND_METHODS,
                inbound_methods=protocol.EXECUTION_METHODS,
                handler=handler,
                prefix="x",
                version=protocol.EXECUTION_PROTOCOL_VERSION,
            )
            session = ExecutionSession(peer, package_fd=fds[0], artifacts_fd=fds[1])
            self.sessions[sid] = session
            if case is not None:
                case.runner_session = session
            serving = asyncio.create_task(peer.serve())
            ended = asyncio.create_task(session.ended.wait())
            try:
                done, _ = await asyncio.wait({serving, ended}, return_when=asyncio.FIRST_COMPLETED)
                if serving in done:
                    serving.result()
            except ProtocolError:
                code = 3
            finally:
                ended.cancel()
                await peer.close(BridgeError("bridge_closed", "The execution session ended"))
                serving.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await serving
        except asyncio.CancelledError:
            code, signal = None, "SIGKILL"
        except Exception as exc:  # noqa: BLE001 - a spawn the harness could not honour
            code = 1
            if case is not None:
                case.record("runner.harness_failure", error=f"{type(exc).__name__}: {exc}"[:500])
        finally:
            writer.close()
            for fd in fds:
                with contextlib.suppress(OSError):
                    os.close(fd)
            with contextlib.suppress(Exception):
                self.rpc.notify("runner.exit", {"sid": sid, "code": code, "signal": signal})
            self.readers.pop(sid, None)

    async def drain(self) -> None:
        for task in list(self.tasks.values()):
            if not task.done():
                task.cancel()
            with contextlib.suppress(BaseException):
                await task
        self.tasks.clear()
        self.sessions.clear()


def _json_safe(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)[:500]


class HostHelper:
    """One Node helper process and the RPC that connects it to the active case."""

    def __init__(self, build_dir: Path, *, log_path: Path):
        self.build_dir = Path(build_dir)
        self.log_path = Path(log_path)
        self.process: asyncio.subprocess.Process | None = None
        self.rpc: RpcPeer | None = None
        self.runners: InProcessRunners | None = None
        self.case = None
        self.hello: dict = {}
        self._serve_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._ready = None

    async def start(self) -> dict:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("node is required for the plugin host half of the experiment")
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/nonexistent"),
            "NODE_OPTIONS": "",
            "NO_COLOR": "1",
        }
        if os.environ.get("TMPDIR"):
            env["TMPDIR"] = os.environ["TMPDIR"]
        # The helper inherits no credential: only these names (recorded for the tests).
        self.child_env_names = sorted(env)
        self.process = await asyncio.create_subprocess_exec(
            node,
            str(HOST_HELPER),
            str(self.build_dir),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=128 * 1024 * 1024,
            env=env,
        )
        self._ready = asyncio.get_running_loop().create_future()
        self.rpc = RpcPeer(
            self.process.stdout,
            self.process.stdin,
            requests={
                "cp.dispatch": self._cp_dispatch,
                "provider.complete": self._provider_complete,
                "net.resolve": self._net_resolve,
                "net.transport": self._net_transport,
                "file.parse": self._file_parse,
            },
            notifications={"helper.ready": self._on_ready},
            prefix="py",
        )
        self.runners = InProcessRunners(self.rpc)
        self.rpc.notifications.update(
            {
                "runner.spawn": self.runners.spawn,
                "runner.stdin": self.runners.stdin,
                "runner.stdin_end": self.runners.stdin_end,
                "runner.kill": self.runners.kill,
                "provider.abort": self._provider_abort,
            }
        )
        self._serve_task = asyncio.create_task(self.rpc.serve())
        self._stderr_task = asyncio.create_task(self._pump_stderr())
        try:
            async with asyncio.timeout(120):
                await self._ready
        except TimeoutError as exc:
            raise RuntimeError(f"the Node host helper did not start; see {self.log_path}") from exc
        self.hello = await self.rpc.call("helper.hello", {})
        return self.hello

    def _on_ready(self, params: dict) -> None:
        if self._ready is not None and not self._ready.done():
            self._ready.set_result(params)

    async def _pump_stderr(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log_path, "ab") as stream:
            while True:
                line = await self.process.stderr.readline()
                if not line:
                    break
                stream.write(line)
                stream.flush()

    async def stop(self) -> None:
        if self.runners is not None:
            await self.runners.drain()
        if self.process is not None and self.process.returncode is None:
            with contextlib.suppress(Exception):
                self.process.stdin.close()
            try:
                async with asyncio.timeout(10):
                    await self.process.wait()
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        for task in (self._serve_task, self._stderr_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task

    # -- binding one case ----------------------------------------------------------
    def bind(self, case) -> None:
        self.case = case
        if self.runners is not None:
            self.runners.case = case

    def unbind(self) -> None:
        self.case = None
        if self.runners is not None:
            self.runners.case = None

    async def call(self, method: str, params: dict | None = None, *, timeout: float | None = 900):
        return await self.rpc.call(method, params or {}, timeout=timeout)

    async def backend(self, method: str, *args, timeout: float | None = 900):
        return await self.call(
            "backend.call", {"method": method, "args": list(args)}, timeout=timeout
        )

    # -- requests from the plugin backend ---------------------------------------------
    def _require_case(self):
        if self.case is None:
            raise RpcError("no_case", "no case is bound to this worker")
        return self.case

    async def _cp_dispatch(self, params: dict) -> dict:
        """What `agentpkg.browser.server._Handler._handle` does after its guards."""
        from agentpkg.browser.errors import ControlPlaneError

        case = self._require_case()
        method = str(params.get("method", "GET"))
        path = str(params.get("path", "")).split("?", 1)[0]
        raw = params.get("body")
        try:
            from agentpkg.browser import server

            # The HTTP front end's own request bound (server._Handler), read from
            # the production module so an ablation of the constant is followed.
            if raw is not None and len(str(raw).encode("utf-8")) > server.MAX_REQUEST_BYTES:
                raise ControlPlaneError(
                    "request_too_large",
                    f"Request bodies are limited to {server.MAX_REQUEST_BYTES} bytes",
                    status=413,
                )
            body = None
            if raw is not None and raw != "":
                try:
                    body = json.loads(raw)
                except ValueError as exc:
                    raise ControlPlaneError(
                        "invalid_request", "Request body must be valid UTF-8 JSON"
                    ) from exc
            if method in {"GET", "DELETE"} and body is not None:
                raise ControlPlaneError(
                    "invalid_request", f"{method} requests must not carry a body"
                )
            status, payload = case.api.dispatch(method, path, body)
            case.control_ok(method, path, status)
        except ControlPlaneError as exc:
            case.control_error(method, path, exc)
            status, payload = exc.status, exc.payload()
        except Exception as exc:  # noqa: BLE001 - the server's own catch-all
            case.control_crash(method, path, exc)
            status = 500
            payload = {"error": {"code": "internal_error", "message": "Unhandled service error"}}
        text = json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2)
        if len(text.encode("utf-8")) > MAX_RESPONSE_BYTES:
            status = 500
            text = json.dumps(
                {"error": {"code": "response_too_large", "message": "Response exceeded limit"}}
            )
        return {"status": status, "body": text}

    async def _provider_complete(self, params: dict) -> dict:
        case = self._require_case()
        return await case.provider.complete(params)

    def _provider_abort(self, params: dict) -> None:
        if self.case is not None:
            self.case.provider.abort(str(params.get("id")))

    async def _net_resolve(self, params: dict) -> dict:
        return self._require_case().services.resolve(str(params.get("hostname", "")))

    async def _net_transport(self, params: dict) -> dict:
        return await self._require_case().services.transport(params)

    async def _file_parse(self, params: dict) -> dict:
        return self._require_case().services.parse_pdf(params)
