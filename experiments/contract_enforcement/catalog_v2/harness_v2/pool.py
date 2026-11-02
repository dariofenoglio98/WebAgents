"""Worker processes: one per (runtime, profile) shard, fed one case per line (D-302).

A Python worker runs `driver_py.py` with its profile's private agentpkg first on `PYTHONPATH`;
a Node worker runs its profile's bundled `driver.js`. Each starts with a `hello` that names the
build it actually loaded, which must be the build the parent built for that profile. A case that
does not answer within its time limit kills the worker (the case becomes a harness error) and a
new worker is started for the next case, so no state crosses from one case into another beyond
what a process that ran earlier cases holds (a test checks that a case's record does not depend on
what ran before it).
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from .paths import HERE

# Above the longest deadline a probe declares (120 s), so that a run held to its deadline ends by
# the runtime's own refusal, not by the harness.
CASE_TIMEOUT_SECONDS = 300


class WorkerError(RuntimeError):
    pass


def worker_command(runtime: str, build_dir: Path) -> tuple[list[str], dict]:
    home = tempfile.mkdtemp(prefix="cv2-home-")
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": home,
        "TMPDIR": tempfile.gettempdir(),
        "LANG": "C.UTF-8",
    }
    if runtime == "py":
        env.update(
            PYTHONPATH=str(build_dir / "src"),
            PYTHONHASHSEED="0",
            PYTHONDONTWRITEBYTECODE="1",
        )
        return [sys.executable, str(HERE / "driver_py.py"), str(build_dir / "src")], env
    if runtime == "ts":
        return ["node", str(build_dir / "driver" / "driver.js")], env
    raise ValueError(runtime)


class Worker:
    def __init__(self, runtime: str, build_dir: Path, build_key: str, log: Path | None = None):
        self.runtime, self.build_dir, self.build_key = runtime, build_dir, build_key
        self.log = log
        self.process = None
        self._lines: queue.Queue = queue.Queue()
        self.restarts = 0

    def start(self) -> dict:
        command, env = worker_command(self.runtime, self.build_dir)
        stderr = open(self.log, "ab") if self.log else subprocess.DEVNULL  # noqa: SIM115
        self._home = env["HOME"]
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            env=env,
            cwd=str(self.build_dir),
            text=True,
            bufsize=1,
        )
        self._lines = queue.Queue()
        reader = threading.Thread(target=self._read, args=(self.process, self._lines), daemon=True)
        reader.start()
        hello = self._ask({"op": "hello"}, 120)
        if hello is None or hello.get("op") != "hello":
            raise WorkerError(f"{self.runtime} worker did not start: {hello}")
        if hello["build"].get("key") != self.build_key:
            raise WorkerError(
                f"{self.runtime} worker loaded build {hello['build'].get('key')}, "
                f"expected {self.build_key}"
            )
        return hello

    @staticmethod
    def _read(process, lines):
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    def _ask(self, message: dict, timeout: float):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        try:
            line = self._lines.get(timeout=timeout)
        except queue.Empty:
            return None
        return None if line is None else json.loads(line)

    def run(self, case_input: dict, timeout: float = CASE_TIMEOUT_SECONDS) -> dict:
        if self.process is None or self.process.poll() is not None:
            self.start()
        try:
            answer = self._ask(case_input, timeout)
        except (BrokenPipeError, OSError) as exc:
            answer = None
            reason = f"worker pipe failed: {exc}"
        else:
            reason = "worker did not answer within the case time limit"
        if answer is None:
            self.stop()
            self.restarts += 1
            return {
                "id": case_input["id"],
                "runtime": self.runtime,
                "harness_error": reason,
                "timed_out": True,
            }
        return answer

    def stop(self) -> None:
        if self.process is not None:
            try:
                self.process.kill()
                self.process.wait(timeout=10)
            except Exception:  # noqa: BLE001
                pass
            self.process = None
        import shutil

        shutil.rmtree(getattr(self, "_home", ""), ignore_errors=True)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *_exc):
        if self.process is not None and self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=30)
            except Exception:  # noqa: BLE001
                self.process.kill()
        self.stop()
        return False
