"""What one run holds about memory (§7, §9, §10): the scan set (M-36, M-37, M-62), the grants and
the types the proposals check needs (M-40), the agent document (M-50), and the facts the audit
and the run report carry (M-61).

Built by the host before the run: the CLI from a memory folder (`--memory-dir`, M-63) or from the
package's fixture (M-62). The Chrome core's `MemoryRun` (`src/core/memory/run.ts`) is the same
object; both write the same `memory` section into the run report (D-231).
"""

from __future__ import annotations

import hashlib

from .declarations import AGENT_SCOPE, memory_declarations
from .model import is_record_read_binding
from .proposals import check_proposals, proposed_facts
from .registry import TypeRegistry, custom_type_aliases, starter_types
from .scan import fixture_scan_set


class MemoryRun:
    def __init__(
        self,
        package,
        grants: list[dict],
        decisions: dict,
        *,
        scan: list[dict] | None = None,
        targets: dict | None = None,
        agent_document: dict | None = None,
        agent_discard: str | None = None,
        policy_refuses_proposals: bool = False,
        declarations: dict | None = None,
        commit_agent=None,
    ):
        self.package = package
        self.declarations = declarations or memory_declarations(
            package.manifest, package.policy, package.tools, package.files
        )
        self.types = memory_types(package, self.declarations)
        self.scan = list(scan or [])
        self.grants = [dict(grant) for grant in grants]
        self.granted = {}
        for grant in self.grants:
            type_def = self.types.resolve(grant["resource_type"])
            self.granted[grant["resource_id"]] = (
                type_def["id"] if type_def else grant["resource_type"]
            )
        self.targets = dict(targets or {})
        self.agent_discard = agent_discard
        # The host's write of the agent document (`commit_agent(body, run_id)`), called at the
        # terminal event before `memory.agent.committed` is recorded (M-50); a host that keeps no
        # store leaves it None. `commit_error` is why a write failed.
        self.commit_agent = commit_agent
        self.commit_error: str | None = None
        self.policy_refuses_proposals = policy_refuses_proposals
        write = self.declarations["write"]
        self.write_denied = write is not None and decisions.get(write["permission_id"], "deny") == (
            "deny"
        )
        agent = self.declarations["agent"]
        granted_agent = (
            agent is not None
            and decisions.get(agent["permission_id"], "deny") != "deny"
            and package.policy["memory"]["scope"] == AGENT_SCOPE
        )
        self.agent = (
            {
                "package_id": package.manifest["package_id"],
                "stored": None if agent_discard else agent_document,
                "staged": None,
            }
            if granted_agent
            else None
        )

    @property
    def proposes(self) -> bool:
        return self.declarations["write"] is not None

    def check_proposals(self, value) -> dict:
        """M-40 over the export's value; raises `ProposalRefusal`; returns the `memory.proposed`
        facts."""
        write = self.declarations["write"]
        document = check_proposals(
            value,
            declared=set(write["types"] if write else []),
            granted=self.granted,
            targets=self.targets,
            types=self.types,
            scan=self.scan,
            aliases=self.types.aliases,
        )
        return proposed_facts(
            document,
            write_denied=self.write_denied,
            policy_refuses=self.policy_refuses_proposals,
        )

    def agent_outcome(self, status: str, run_id: str | None = None) -> dict | None:
        """M-50: what happens to a staged body at the terminal event. A completed run's body is
        written by the host's `commit_agent` first, so the Run Record never claims a commit that
        did not happen: a failed write is a discard, reason `store_failed` (D-234)."""
        if self.agent is None:
            return None
        staged = self.agent["staged"]
        if staged is None:
            return {"committed": None, "discarded": None}
        if status != "completed":
            return {
                "committed": None,
                "discarded": "cancelled" if status == "cancelled" else "run_failed",
            }
        if self.agent_discard:
            return {"committed": None, "discarded": self.agent_discard}
        if self.commit_agent is not None:
            try:
                self.commit_agent(staged["body"], run_id)
            except Exception as error:  # the host's write: a folder, a file system
                self.commit_error = f"{type(error).__name__}: {error}"
                return {"committed": None, "discarded": "store_failed"}
        return {
            "committed": {
                "package_id": self.agent["package_id"],
                "bytes": staged["bytes"],
                "body_sha256": hashlib.sha256(staged["body"].encode("utf-8")).hexdigest(),
            },
            "discarded": None,
        }

    def staged_body(self) -> str | None:
        staged = (self.agent or {}).get("staged")
        return staged["body"] if staged else None


def memory_types(package, declarations: dict) -> TypeRegistry:
    """The types a run of `package` sees: the starter taxonomy, its custom types, and their
    local ids as aliases (D-228)."""
    custom = declarations["custom_types"]
    return TypeRegistry(
        [*starter_types(), *custom],
        aliases=custom_type_aliases(package.manifest["package_id"], custom),
    )


def fixture_memory(package, fixture: dict, grants: dict, *, types: TypeRegistry | None = None):
    """M-62 for a fixture run without a store: the scan set from the replayed answers, and the
    run's memory grants from the replayed `memory.read` views (D-230): a view's `id` is the
    record the package was granted, under the one permission its tool links, unless denied."""
    types = types or TypeRegistry()
    answers = []
    memory_grants = []
    for tool_id, cases in (fixture.get("tools") or {}).items():
        tool = package.tools.get(tool_id)
        if tool is None or not isinstance(cases, list):
            continue
        binding = tool["binding"] or ""
        legacy_sealed: list[str] = []
        allowed = (
            len(tool["permissions"]) == 1 and grants.get(tool["permissions"][0], "deny") != "deny"
        )
        if binding.startswith("host.resource."):
            legacy_id = binding[len("host.resource.") :]
            legacy_sealed = types.legacy_sealed(legacy_id)
            # A replayed legacy answer carries no record id: the run holds it as the record
            # `fixture:<binding>`, granted under the tool's permission (D-230), so that its
            # sealed values may go where that permission is linked and nowhere else (M-36).
            grant = {
                "permission_id": tool["permissions"][0] if tool["permissions"] else "",
                "resource_type": legacy_id,
                "resource_id": f"fixture:{binding}",
            }
            if allowed and cases and grant not in memory_grants:
                memory_grants.append(grant)
        for case in cases:
            output = case.get("output")
            answers.append((binding, output, legacy_sealed))
            if (
                is_record_read_binding(binding)
                and isinstance(output, dict)
                and isinstance(output.get("id"), str)
                and allowed
            ):
                grant = {
                    "permission_id": tool["permissions"][0],
                    "resource_type": binding[len("host.memory.") :],
                    "resource_id": output["id"],
                }
                if grant not in memory_grants:
                    memory_grants.append(grant)
    return fixture_scan_set(answers), memory_grants


def report_section(proposals=None, refused=None, agent=None) -> dict:
    """The run report's `memory` section (D-231): the proposals offered, a refusal of M-40, and
    the agent document's fate."""
    return {"proposals": proposals, "refused": refused, "agent": agent}
