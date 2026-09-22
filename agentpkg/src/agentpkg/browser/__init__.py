"""Agent browser control plane: the trusted local boundary in front of agentpkg.

    OpenClaw Agent Browser UI  (future milestone)
            |
            v
    agentpkg browser control plane   <- this package
            |
            v
    agentpkg runtime                 (separate milestone; never imported here)

The control plane owns package acquisition, immutable snapshots, layered
validation, signature checking, publisher trust, inspection and authorization
receipts. It deliberately imports no execution module, so a UI can rely on the
fact that opening or inspecting a package cannot run one.
"""

from __future__ import annotations

from .authorization import BrowserPolicy
from .control import (
    API_VERSION,
    SERVICE,
    ControlPlane,
    ControlPlaneConfig,
    default_cache_dir,
    default_trust_store,
)
from .errors import ControlPlaneError
from .hostmodels import evaluate_catalog, normalize_catalog, requirement_set
from .runplan import BINDING_STRATEGIES, EXECUTION_MODES, build_run_plan, preflight
from .server import BrowserService
from .trust import TrustStore

__all__ = [
    "API_VERSION",
    "BINDING_STRATEGIES",
    "EXECUTION_MODES",
    "SERVICE",
    "BrowserPolicy",
    "BrowserService",
    "ControlPlane",
    "ControlPlaneConfig",
    "ControlPlaneError",
    "TrustStore",
    "build_run_plan",
    "default_cache_dir",
    "default_trust_store",
    "evaluate_catalog",
    "normalize_catalog",
    "preflight",
    "requirement_set",
]
