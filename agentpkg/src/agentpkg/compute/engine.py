"""Running one compute call under wasmtime, the reference engine (compute.v0 §4, §5).

One call is one fresh `Store` and `Instance`: data segments and globals start from the module's
own bytes every time, so nothing survives between calls and two calls of one module cannot
observe each other. The store carries the call's bounds: a memory limit the engine refuses
growth beyond, a fuel budget the engine counts down, and an epoch deadline a ticker thread
advances. The engine config disables every proposal the feature gate refuses and canonicalizes
NaNs, so what this engine computes is what the specification promises.

The engine never raises for a module's own failure: a trap, exhausted fuel, a passed deadline or
an ABI violation come back as a `ComputeOutcome` with a reason, and the runtime records it. It
raises only when the host is at fault: no engine installed, a module that does not compile, or
anything else that goes wrong inside the engine during a call (`EngineFault`, C-40's
`worker_error`). An outcome carries only the specification's words, never the engine's own text.
"""

from __future__ import annotations

import asyncio
import math
import threading
import time
from dataclasses import dataclass

from .limits import MAX_OUTPUT_BYTES, PAGE_BYTES, ComputeLimits
from .module import ModuleError

#: How often the epoch advances while a call runs; a deadline is counted in these ticks.
TICK_SECONDS = 0.01
ENGINE_UNAVAILABLE = "compute_engine_unavailable"
ENGINE_ERROR = "engine_error"
#: The failure reasons a call can end with, shared by both runtimes (C-41).
REASONS = (
    "trap",
    "fuel_exhausted",
    "deadline",
    "abi_violation",
    "instantiation_failed",
)
#: The trap vocabulary (C-42); an engine maps its own names onto these, `other` for the rest.
TRAP_CODES = (
    "unreachable",
    "memory_out_of_bounds",
    "stack_overflow",
    "integer_division_by_zero",
    "integer_overflow",
    "bad_conversion_to_integer",
    "indirect_call_to_null",
    "bad_signature",
    "table_out_of_bounds",
    "null_reference",
    "other",
)


class EngineUnavailable(RuntimeError):
    """This host has no WebAssembly engine: `pip install 'agentpkg[compute]'`."""

    code = ENGINE_UNAVAILABLE


class EngineFault(RuntimeError):
    """The engine failed during a call for a reason that is not the module's (C-40): the host's
    fault, recorded as `engine_error`, never as the module's `compute_error`."""

    code = ENGINE_ERROR


@dataclass(frozen=True)
class ComputeOutcome:
    """What one call came to; `output` is set exactly when `reason` is None."""

    output: bytes | None
    reason: str | None
    trap_code: str | None
    detail: str | None
    memory_pages: int | None
    elapsed_ms: int
    fuel_consumed: int | None

    @property
    def ok(self) -> bool:
        return self.reason is None


def available() -> bool:
    try:
        import wasmtime  # noqa: F401
    except ImportError:
        return False
    return True


class _Ticker:
    """One daemon thread that advances the engine's epoch while any call is running."""

    def __init__(self, engine):
        self._engine = engine
        self._active = 0
        self._condition = threading.Condition()
        self._thread = None

    def enter(self) -> None:
        with self._condition:
            self._active += 1
            if self._thread is None:
                self._thread = threading.Thread(
                    target=self._run, name="agentpkg-compute-epoch", daemon=True
                )
                self._thread.start()
            self._condition.notify()

    def leave(self) -> None:
        with self._condition:
            self._active -= 1

    def _run(self) -> None:
        while True:
            with self._condition:
                while self._active == 0:
                    self._condition.wait()
                next_tick = time.monotonic() + TICK_SECONDS
            # A fixed-rate schedule: a late tick does not delay the next, so a deadline of n
            # ticks is close to n × TICK_SECONDS of wall time, not n sleeps plus their slack.
            while True:
                delay = next_tick - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                self._engine.increment_epoch()
                next_tick += TICK_SECONDS
                with self._condition:
                    if self._active == 0:
                        break


class WasmtimeEngine:
    """The reference engine. One per process is enough; modules compile once per SHA-256."""

    meters_fuel = True

    def __init__(self):
        try:
            import wasmtime
        except ImportError as exc:
            raise EngineUnavailable(
                "this host has no WebAssembly engine; install agentpkg[compute]"
            ) from exc
        from importlib.metadata import version

        self._wasmtime = wasmtime
        self.id = f"wasmtime-py/{version('wasmtime')}"
        config = wasmtime.Config()
        config.consume_fuel = True
        config.epoch_interruption = True
        config.cranelift_nan_canonicalization = True
        # The feature gate (C-19), repeated at the engine so that a module the reader accepted
        # and this engine compiles are the same set; everything here is also refused by name
        # before the engine sees a module.
        config.wasm_bulk_memory = True
        config.wasm_multi_value = True
        config.wasm_reference_types = True
        config.wasm_simd = False
        config.wasm_relaxed_simd = False
        config.wasm_threads = False
        config.wasm_memory64 = False
        config.wasm_multi_memory = False
        config.wasm_tail_call = False
        config.wasm_function_references = False
        config.wasm_gc = False
        config.wasm_exceptions = False
        config.wasm_component_model = False
        self._engine = wasmtime.Engine(config)
        self._modules: dict[str, object] = {}
        # A module the engine refused, by SHA-256: the refusal is kept so that a second attempt
        # (the preflight after `precompile`) raises it at once instead of compiling again.
        self._refused: dict[str, ModuleError] = {}
        self._lock = threading.Lock()
        self._ticker = _Ticker(self._engine)
        # Interpreter teardown finalizes module globals in no particular order; closing the
        # compiled modules and the engine first keeps wasmtime's own finalizers from running
        # after its library bindings are gone.
        import atexit

        atexit.register(self.close)

    def close(self) -> None:
        with self._lock:
            modules, self._modules = self._modules, {}
            self._refused = {}
        for module in modules.values():
            try:
                module.close()
            except Exception:  # noqa: BLE001 - best effort at exit
                pass
        try:
            self._engine.close()
        except Exception:  # noqa: BLE001
            pass

    def compile(self, sha256: str, data: bytes) -> None:
        """Compile once per module; a module the engine refuses is `module_invalid`, and the
        refusal is kept so the module is never compiled twice. Compiling happens **outside** the
        lock (it takes time in proportion to the module's size, and one module's compile must not
        block another call's lookup); the result is inserted under it, and a compile that lost a
        race to a concurrent one of the same bytes is dropped."""
        with self._lock:
            if sha256 in self._modules:
                return
            refused = self._refused.get(sha256)
        if refused is not None:
            raise refused
        try:
            module = self._wasmtime.Module(self._engine, data)
        except self._wasmtime.WasmtimeError as exc:
            first = str(exc).splitlines()[0] if str(exc) else "invalid module"
            error = ModuleError("module_invalid", f"the engine refused the module: {first}")
            with self._lock:
                self._refused[sha256] = error
            raise error from exc
        with self._lock:
            if sha256 in self._modules:
                module.close()
            else:
                self._modules[sha256] = module

    async def call(self, sha256: str, function: str, data: bytes, limits: ComputeLimits):
        """Run one call on a worker thread, so a wave's other nodes proceed meanwhile."""
        try:
            return await asyncio.to_thread(self._call, sha256, function, data, limits)
        except Exception as exc:
            raise EngineFault("the engine failed during the call") from exc

    def _call(self, sha256: str, function: str, data: bytes, limits: ComputeLimits):
        wasmtime = self._wasmtime
        with self._lock:
            module = self._modules.get(sha256)
        if module is None:
            raise ModuleError("module_invalid", "the module was not compiled before the call")
        store = wasmtime.Store(self._engine)
        store.set_limits(memory_size=limits.memory_pages * PAGE_BYTES, memories=1, instances=1)
        store.set_fuel(limits.fuel)
        store.set_epoch_deadline(math.ceil(limits.wall_seconds / TICK_SECONDS) + 1)
        memory = None
        started = time.perf_counter()

        def outcome(output=None, reason=None, trap_code=None, detail=None):
            try:
                remaining = store.get_fuel()
            except wasmtime.WasmtimeError:
                remaining = None
            if reason == "deadline":
                # The engine flushes its fuel counter on a fuel trap and on return, not on an
                # epoch interrupt: the figure it would report here is stale, so none is.
                remaining = None
            return ComputeOutcome(
                output=output,
                reason=reason,
                trap_code=trap_code,
                detail=detail,
                memory_pages=memory.size(store) if memory is not None else None,
                elapsed_ms=round((time.perf_counter() - started) * 1000),
                fuel_consumed=None if remaining is None else limits.fuel - remaining,
            )

        self._ticker.enter()
        try:
            try:
                instance = wasmtime.Instance(store, module, [])
                exports = instance.exports(store)
                memory = exports["memory"]
                alloc = exports["alloc"]
                run = exports[function]
            except wasmtime.Trap as trap:
                return outcome(**_classify(wasmtime, trap))
            except wasmtime.WasmtimeError:
                # The engine's own words differ between engines and versions: C-41 records the
                # reason alone.
                return outcome(reason="instantiation_failed")
            try:
                pointer = alloc(store, len(data))
                if not isinstance(pointer, int):
                    return outcome(reason="abi_violation", detail="alloc")
                # An i32 comes back signed; the ABI's pointers are unsigned (a memory above
                # 32,768 pages has valid addresses at and above 2 GiB).
                pointer &= 0xFFFFFFFF
                size = memory.data_len(store)
                if pointer == 0 or pointer + len(data) > size:
                    return outcome(reason="abi_violation", detail="alloc")
                memory.write(store, data, pointer)
                raw = run(store, pointer, len(data))
                if not isinstance(raw, int):
                    return outcome(reason="abi_violation", detail="result")
                value = raw & 0xFFFFFFFFFFFFFFFF
                out_ptr, out_len = value >> 32, value & 0xFFFFFFFF
                size = memory.data_len(store)
                if out_len == 0 or out_ptr + out_len > size:
                    return outcome(reason="abi_violation", detail="output_range")
                if out_len > MAX_OUTPUT_BYTES:
                    return outcome(reason="abi_violation", detail="output_too_large")
                return outcome(output=bytes(memory.read(store, out_ptr, out_ptr + out_len)))
            except wasmtime.Trap as trap:
                return outcome(**_classify(wasmtime, trap))
        finally:
            self._ticker.leave()


def _classify(wasmtime, trap) -> dict:
    code = trap.trap_code
    if code == wasmtime.TrapCode.OUT_OF_FUEL:
        return {"reason": "fuel_exhausted"}
    if code == wasmtime.TrapCode.INTERRUPT:
        return {"reason": "deadline"}
    name = code.name.lower() if code is not None else "other"
    return {"reason": "trap", "trap_code": name if name in TRAP_CODES else "other"}


_default = None
_default_lock = threading.Lock()


def default_engine() -> WasmtimeEngine:
    """The process's one engine (compiled modules are kept by SHA-256)."""
    global _default
    with _default_lock:
        if _default is None:
            _default = WasmtimeEngine()
        return _default


def precompile(package) -> None:
    """Compile a package's declared modules into the process's engine ahead of its run, so that a
    host serving other requests can do it off its event loop (compiling takes time in proportion
    to a module's size). The runtime's preflight then finds them compiled; whatever fails here
    is left for that preflight to refuse with its code."""
    modules = package.graph.get("modules", [])
    if not modules or not available():
        return
    engine = default_engine()
    for module in modules:
        try:
            engine.compile(module["sha256"], package.files[module["path"]])
        except ModuleError:
            continue


__all__ = [
    "ENGINE_ERROR",
    "ENGINE_UNAVAILABLE",
    "REASONS",
    "TICK_SECONDS",
    "TRAP_CODES",
    "ComputeOutcome",
    "EngineFault",
    "EngineUnavailable",
    "WasmtimeEngine",
    "available",
    "default_engine",
    "precompile",
]
