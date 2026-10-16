"""Agent Package v0: portable declarations, host-controlled authority."""

__version__ = "0.4.0"

from .errors import AgentPkgError, ValidationError
from .package import Package, build_package, load_package, permissions_summary

__all__ = [
    "AgentPkgError",
    "ValidationError",
    "Package",
    "build_package",
    "load_package",
    "permissions_summary",
]
