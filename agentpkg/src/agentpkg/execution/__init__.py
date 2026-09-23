"""The trusted composition layer where a portable package actually runs.

    agentpkg.browser        opens, verifies, authorizes, plans   — never executes
    agentpkg.hostbridge     binds the planned model              — never executes
    agentpkg.execution      <- this package: composes the two with the interpreter

The boundary between those three is the point of the whole design, so it is
stated in one direction only and tested in both:

    browser      -/->  execution, hostbridge, runtime, workflow
    hostbridge   -/->  execution, runtime, workflow, tools
    execution     -->  package, runtime, workflow, hostbridge, validation

The control plane decides *whether* a run may happen and must stay structurally
unable to be the thing that makes one happen. The bridge can spend money but
holds no interpreter. This package is the only one allowed to hold both, which
is exactly why it is small, why it is domain-neutral, and why everything it
does before dispatching is a check rather than a choice.

It contains no orchestration of its own. A graph provides the behaviour; this
provides a verified package, the person's decisions, the host's limits and the
exact planned model, and then calls `Workflow.run`.
"""

from __future__ import annotations

from .artifact import read_execution_artifact, verify_execution_artifact
from .errors import ExecutionError
from .invocation import RUN_INVOCATION_SCHEMA, build_invocation
from .policy import (
    HostExecutionLimits,
    check_capabilities,
    check_model,
    check_tools,
    effective_budget,
    effective_deadline_seconds,
    normalize_grants,
)
from .protocol import (
    ARTIFACTS_FD,
    EXECUTION_METHODS,
    EXECUTION_PROTOCOL_VERSION,
    PACKAGE_FD,
    TOOL_CALL_METHOD,
)
from .report import audit_summary, cost_summary, model_evidence, verify_audit_chain
from .session import EXECUTION_RESULT_SCHEMA, ExecutionSession, serve
from .toolprobe import TOOL_PROBE_SCHEMA, run_tool_probe

__all__ = [
    "ARTIFACTS_FD",
    "EXECUTION_METHODS",
    "EXECUTION_PROTOCOL_VERSION",
    "EXECUTION_RESULT_SCHEMA",
    "PACKAGE_FD",
    "RUN_INVOCATION_SCHEMA",
    "TOOL_CALL_METHOD",
    "TOOL_PROBE_SCHEMA",
    "ExecutionError",
    "ExecutionSession",
    "HostExecutionLimits",
    "audit_summary",
    "build_invocation",
    "check_capabilities",
    "check_model",
    "check_tools",
    "cost_summary",
    "effective_budget",
    "effective_deadline_seconds",
    "model_evidence",
    "normalize_grants",
    "read_execution_artifact",
    "run_tool_probe",
    "serve",
    "verify_audit_chain",
    "verify_execution_artifact",
]
