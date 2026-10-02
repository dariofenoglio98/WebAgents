"""Offline guards and the observation probe for one worker process.

`PythonGuard` refuses — and counts — every socket connection, DNS lookup,
child process and open of a sensitive path in this process once the worker's
own Node helper is running. A refusal is recorded even if a caller swallows
the exception.

`StateProbe` is observation only: it wraps `Runtime.record` so that, after the
production method has run unchanged, a deep copy of the committed workflow
state is kept for each `state.committed` event. It decides nothing and changes
nothing; `tests/test_ablations.py` checks that a run's audit chain is identical
with and without it.
"""

from __future__ import annotations

import builtins
import copy
import io
import os
import socket
import subprocess


class GuardViolation(RuntimeError):
    """This worker tried to leave the process or touch a sensitive path."""


class PythonGuard:
    def __init__(self, *, sensitive_prefixes=(), sensitive_substrings=()):
        self.refused: list[dict] = []
        self.sensitive_prefixes = [str(p) for p in sensitive_prefixes]
        self.sensitive_substrings = [str(s) for s in sensitive_substrings]
        self._saved: list[tuple[object, str, object]] = []

    def _refuse(self, kind: str):
        def refused(*args, **_kwargs):
            self.refused.append({"kind": kind, "detail": repr(args[:1])[:200]})
            raise GuardViolation(f"contract_enforcement worker refused {kind}")

        return refused

    def _patch(self, owner, name: str, replacement) -> None:
        if hasattr(owner, name):
            self._saved.append((owner, name, getattr(owner, name)))
            setattr(owner, name, replacement)

    def sensitive(self, path) -> bool:
        try:
            text = os.fsdecode(path) if not isinstance(path, int) else ""
        except TypeError:
            return False
        if not text:
            return False
        absolute = os.path.abspath(os.path.expanduser(text)) if not text.startswith("/") else text
        return any(
            absolute.startswith(prefix) or text.startswith(prefix)
            for prefix in self.sensitive_prefixes
        ) or any(needle in text for needle in self.sensitive_substrings)

    def __enter__(self):
        self._patch(socket.socket, "connect", self._refuse("socket.connect"))
        self._patch(socket.socket, "connect_ex", self._refuse("socket.connect_ex"))
        self._patch(socket, "create_connection", self._refuse("socket.create_connection"))
        self._patch(socket, "getaddrinfo", self._refuse("socket.getaddrinfo"))
        self._patch(subprocess, "Popen", self._refuse("subprocess.Popen"))
        for name in ("fork", "forkpty", "posix_spawn", "posix_spawnp", "system", "execv", "execve"):
            self._patch(os, name, self._refuse(f"os.{name}"))
        original_open = builtins.open
        original_os_open = os.open
        original_io_open = io.open
        guard = self

        def guarded_open(file, *args, **kwargs):
            if guard.sensitive(file):
                guard.refused.append({"kind": "open", "detail": str(file)[:200]})
                raise GuardViolation("contract_enforcement worker refused a sensitive open")
            return original_open(file, *args, **kwargs)

        def guarded_os_open(path, *args, **kwargs):
            if guard.sensitive(path):
                guard.refused.append({"kind": "os.open", "detail": str(path)[:200]})
                raise GuardViolation("contract_enforcement worker refused a sensitive open")
            return original_os_open(path, *args, **kwargs)

        def guarded_io_open(file, *args, **kwargs):
            if guard.sensitive(file):
                guard.refused.append({"kind": "io.open", "detail": str(file)[:200]})
                raise GuardViolation("contract_enforcement worker refused a sensitive open")
            return original_io_open(file, *args, **kwargs)

        self._patch(builtins, "open", guarded_open)
        self._patch(os, "open", guarded_os_open)
        self._patch(io, "open", guarded_io_open)
        return self

    def __exit__(self, *_exc):
        while self._saved:
            owner, name, value = self._saved.pop()
            setattr(owner, name, value)
        return False


class StateProbe:
    """Keep a copy of the workflow state each time production commits a wave.

    It also notes, when a map refuses its input, whether the map's declared
    `max_items` bound is what refused it: production reports that refusal and
    an item-schema refusal with the same code, and only the bound is a
    resource limit. The refusal is re-raised unchanged.
    """

    def __init__(self):
        self.sink: list[dict] | None = None
        self.map_sink: list[dict] | None = None
        self._original = None
        self._original_map = None
        self._runtime = None
        self._workflow = None

    def install(self) -> None:
        from agentpkg.runtime import Runtime

        if self._original is not None:
            return
        original = Runtime.__dict__["record"]
        probe = self

        def record(self, action, *, context=None, **metadata):
            result = original(self, action, context=context, **metadata)
            sink = probe.sink
            if sink is not None and action == "state.committed":
                sink.append(
                    {"nodes": list(metadata.get("nodes") or []), "state": copy.deepcopy(self.state)}
                )
            return result

        record.__wrapped__ = original
        Runtime.record = record
        self._original = original
        self._runtime = Runtime

        from agentpkg.errors import ValidationError
        from agentpkg.workflow import Workflow
        from agentpkg.workflow_values import evaluate

        original_map = Workflow.__dict__["_map"]

        async def _map(self, node, view):
            try:
                return await original_map(self, node, view)
            except ValidationError:
                sink = probe.map_sink
                if sink is not None:
                    try:
                        items = evaluate(node["input"], {"state": view})
                    except Exception:  # noqa: BLE001 - observation must never affect a run
                        items = None
                    if isinstance(items, list) and len(items) > node["max_items"]:
                        sink.append(
                            {
                                "node": node["id"],
                                "items": len(items),
                                "max_items": node["max_items"],
                            }
                        )
                raise

        _map.__wrapped__ = original_map
        Workflow._map = _map
        self._original_map = original_map
        self._workflow = Workflow

    def uninstall(self) -> None:
        if self._original is not None:
            self._runtime.record = self._original
            self._original = None
        if self._original_map is not None:
            self._workflow._map = self._original_map
            self._original_map = None
