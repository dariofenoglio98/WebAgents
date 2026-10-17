"""The limits of one compute call (compute.v0 §5, C-30…C-36).

Three figures bound a call: the module's memory in pages, wall time, and fuel where the engine
meters instructions. The host has defaults and maxima; a node may only lower them; the module's
declared memory maximum must fit under the effective page bound, else the run is refused before
it starts (a bound that refuses instead of lowering, as `max_output_tokens_per_call` does).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

#: 64 MiB per call. A module declares its own maximum; this is what a host allows by default.
DEFAULT_MEMORY_PAGES = 1024
#: Seconds of wall time per call: the bound every engine has.
DEFAULT_WALL_SECONDS = 10
#: Fuel per call on a metering engine. Measured on the development Mac (D-242): wasmtime 49
#: charges 5 units per iteration of a counting loop and burns about 6.5 × 10^9 units per
#: second of it on an Apple M3 Max, so this is roughly eight seconds of the simplest code there
#: and more of anything heavier; unlike wall time it is the same figure on every machine, and
#: the wall bound stays beside it.
DEFAULT_FUEL = 50_000_000_000
MAX_MEMORY_PAGES = 65_536
MAX_WALL_SECONDS = 300
MAX_FUEL = 1_000_000_000_000
#: An output longer than this is refused unread (`abi_violation`), whatever the memory allowed.
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
PAGE_BYTES = 65_536

HOST_KEYS = ("compute_memory_pages", "compute_wall_seconds", "compute_fuel")
NODE_KEYS = ("memory_pages", "wall_seconds", "fuel")


@dataclass(frozen=True)
class ComputeLimits:
    memory_pages: int = DEFAULT_MEMORY_PAGES
    wall_seconds: float = DEFAULT_WALL_SECONDS
    fuel: int = DEFAULT_FUEL

    def lowered_by(self, node_limits) -> ComputeLimits:
        """The node's `limits` can only lower; a higher figure is ignored, never applied."""
        node_limits = node_limits or {}
        return ComputeLimits(
            memory_pages=min(self.memory_pages, node_limits.get("memory_pages", self.memory_pages)),
            wall_seconds=min(self.wall_seconds, node_limits.get("wall_seconds", self.wall_seconds)),
            fuel=min(self.fuel, node_limits.get("fuel", self.fuel)),
        )

    def as_json(self) -> dict:
        return {
            "memory_pages": self.memory_pages,
            "wall_seconds": self.wall_seconds,
            "fuel": self.fuel,
        }


def _integer(value, name: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"Host limit {name} must be a positive integer")
    if value > maximum:
        raise ValueError(f"Host limit {name} exceeds the supported maximum of {maximum}")
    return value


def host_limits(raw) -> ComputeLimits:
    """The host's compute bounds from the `limits` keys it may set; defaults for the rest."""
    raw = raw or {}
    unknown = sorted(set(raw) - set(HOST_KEYS))
    if unknown:
        raise ValueError(f"Unsupported host limit: {unknown[0]}")
    limits = ComputeLimits()
    if "compute_memory_pages" in raw:
        pages = _integer(raw["compute_memory_pages"], "compute_memory_pages", MAX_MEMORY_PAGES)
        limits = ComputeLimits(pages, limits.wall_seconds, limits.fuel)
    if "compute_wall_seconds" in raw:
        seconds = raw["compute_wall_seconds"]
        if (
            isinstance(seconds, bool)
            or not isinstance(seconds, (int, float))
            or not math.isfinite(seconds)
            or seconds <= 0
        ):
            raise ValueError("Host limit compute_wall_seconds must be a positive number")
        if seconds > MAX_WALL_SECONDS:
            raise ValueError(
                "Host limit compute_wall_seconds exceeds the supported maximum of "
                f"{MAX_WALL_SECONDS}"
            )
        limits = ComputeLimits(limits.memory_pages, seconds, limits.fuel)
    if "compute_fuel" in raw:
        fuel = _integer(raw["compute_fuel"], "compute_fuel", MAX_FUEL)
        limits = ComputeLimits(limits.memory_pages, limits.wall_seconds, fuel)
    return limits


__all__ = [
    "DEFAULT_FUEL",
    "DEFAULT_MEMORY_PAGES",
    "DEFAULT_WALL_SECONDS",
    "HOST_KEYS",
    "MAX_FUEL",
    "MAX_MEMORY_PAGES",
    "MAX_OUTPUT_BYTES",
    "MAX_WALL_SECONDS",
    "NODE_KEYS",
    "PAGE_BYTES",
    "ComputeLimits",
    "host_limits",
]
