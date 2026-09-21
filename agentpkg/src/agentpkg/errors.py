"""Errors intended to be actionable at package and runtime boundaries."""


class AgentPkgError(Exception):
    """Base error for invalid or unauthorized package operations."""


class ValidationError(AgentPkgError):
    """Invalid format, archive, schema, or semantic reference."""


class SignatureError(AgentPkgError):
    """Missing, invalid, or untrusted publisher signature."""


class PolicyError(AgentPkgError):
    """Host policy denied an operation."""


class BudgetError(PolicyError):
    """An operation would exceed a declared budget."""
