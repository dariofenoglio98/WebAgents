"""A dependency's bytes, verified and checked against its record (link.v0 §3, L-10…L-12).

Resolution is preparation: the bytes are read, verified and described; nothing of a linked
package runs here, and nothing here imports the interpreter. The bytes come from the record's
locator under the package-URL policy (`browser/fetch.py`, unchanged) or from an archive the
person supplied, accepted only by its digest. Refusals are `LinkRefusal`s whose text starts with
the specification's code.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from ..errors import AgentPkgError
from ..package import Package, load_package_bytes, sha256
from .analysis import composed_requirement, link_operations, package_worst_case


class LinkRefusal(AgentPkgError):
    """A link the host refuses before the run: the code first, then the reason."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class ResolvedLink:
    """One linked package as preparation found it: verified bytes, the record it answers, its
    publisher's key with the person's trust in it, and its own worst case (L-18)."""

    dependency: str
    record: dict
    package: Package
    archive_sha256: str
    signer: str
    trust: str
    worst_case: dict

    def facts(self) -> dict:
        manifest = self.package.manifest
        return {
            "package_id": manifest["package_id"],
            "name": manifest["name"],
            "version": manifest["version"],
            "digest": self.package.digest,
            "archive_sha256": self.archive_sha256,
            "signer": self.signer,
            "trust": self.trust,
        }


def verify_linked(data: bytes, label: str) -> tuple[Package, str, str]:
    """L-10: the bytes verified as any package's (container, integrity, schemas), with a valid
    signature, which a link always requires. Returns the package, the archive's SHA-256 and the
    signer's fingerprint."""
    from ..browser.evaluation import signature_report

    try:
        package = load_package_bytes(data)
    except AgentPkgError as exc:
        raise LinkRefusal("link_package_invalid", f"{label}: {exc}") from exc
    report = signature_report(package)
    if report["signature_status"] != "valid":
        raise LinkRefusal(
            "link_signature_invalid",
            f"{label}: a linked package carries a valid publisher signature "
            f"({report['signature_status']}: {report['signature_reason']})",
        )
    return package, sha256(data), report["signer_fingerprint"]


def nested_reason(package: Package) -> str | None:
    """Depth one (L-11, LK-5): why a package cannot be linked, or None. It declares a dependency,
    or its graph holds a `link` step of either form, so its run could start a further run."""
    if package.manifest.get("dependencies"):
        return "it declares dependencies of its own"
    if next(link_operations(package.graph), None) is not None:
        return "its graph holds a link step"
    return None


def check_profile(package: Package, label: str) -> None:
    """L-11's two profile checks, shared by a dependency and a join candidate."""
    if (
        package.manifest["entrypoint"] != "workflow.v0"
        or package.graph.get("conversation") is not None
    ):
        raise LinkRefusal(
            "link_target_conversational",
            f"{label}: a linked package is a one-shot workflow.v0 package, not a conversation",
        )
    reason = nested_reason(package)
    if reason is not None:
        raise LinkRefusal("link_nested", f"{label}: {reason}; v0 links one level deep")


def check_record(record: dict, package: Package, signer: str) -> None:
    """L-11, in its order: identity, digest, declared signer, then the profile."""
    label = f"dependency {record['id']!r}"
    manifest = package.manifest
    if manifest["package_id"] != record["package_id"] or manifest["version"] != record["version"]:
        raise LinkRefusal(
            "link_identity_mismatch",
            f"{label}: the archive is {manifest['package_id']} {manifest['version']}, the "
            f"record names {record['package_id']} {record['version']}",
        )
    if package.digest != record["digest"]:
        raise LinkRefusal(
            "link_digest_mismatch",
            f"{label}: the archive's package digest is not the pinned one",
        )
    if "signer" in record and record["signer"] != signer:
        raise LinkRefusal(
            "link_signer_mismatch",
            f"{label}: signed by {signer}, the record expects {record['signer']}",
        )
    check_profile(package, label)


def fetch_dependency(record: dict, *, limits=None, transport=None) -> bytes:
    """The bytes at a record's locator, under the package-URL policy unchanged (HTTPS, a public
    address, a pinned connection, no redirect, a byte cap)."""
    from ..browser.fetch import FetchLimits, download_to_file

    handle, staging = tempfile.mkstemp(prefix="agentpkg-link-", suffix=".part")
    os.close(handle)
    os.unlink(staging)
    try:
        download_to_file(
            record["locator"], Path(staging), limits=limits or FetchLimits(), transport=transport
        )
        return Path(staging).read_bytes()
    except AgentPkgError as exc:
        raise LinkRefusal("link_fetch_failed", f"dependency {record['id']!r}: {exc}") from exc
    finally:
        if os.path.exists(staging):
            os.unlink(staging)


def resolve_links(caller: Package, sources: dict, *, trust, fetch=None) -> dict:
    """Every dependency of the caller resolved (L-10…L-12), in declaration order: `sources`
    holds the archives the person supplied by dependency id; a dependency without one is
    fetched by `fetch(record)` (`fetch_dependency` by default). `trust(signer, package)` is the
    person's own evaluation of a publisher key, as if the package were opened directly; the
    caller's trust plays no part. Returns `{id: ResolvedLink}`."""
    unknown = sorted(set(sources) - {r.get("id") for r in caller.manifest["dependencies"]})
    if unknown:
        raise LinkRefusal(
            "link_dependency_unknown",
            f"an archive was supplied for {unknown[0]!r}, which is not a declared dependency",
        )
    resolved = {}
    for record in caller.manifest["dependencies"]:
        data = sources.get(record["id"])
        if data is None:
            data = (fetch or fetch_dependency)(record)
        package, archive_sha256, signer = verify_linked(data, f"dependency {record['id']!r}")
        check_record(record, package, signer)
        resolved[record["id"]] = ResolvedLink(
            dependency=record["id"],
            record=dict(record),
            package=package,
            archive_sha256=archive_sha256,
            signer=signer,
            trust=trust(signer, package),
            worst_case=package_worst_case(package.graph, package.policy),
        )
    return resolved


def check_composition(caller: Package, worst_cases: dict) -> None:
    """L-20: the composed relaxation within the caller's own budget. `worst_cases` maps each
    dependency id to its worst case, or to None for a denied link (left out, L-22)."""
    excess = composed_requirement(caller.graph, caller.policy, worst_cases)
    if excess is not None:
        name, needed, cap = excess
        raise LinkRefusal(
            "link_bound_exceeds_budget",
            f"with its links the package's worst case is {needed} {name.replace('_', ' ')}, "
            f"above its own budget of {cap}",
        )


def check_model(link: ResolvedLink, router) -> None:
    """L-14: the linked package runs on the caller's model route, which must meet its model
    requirements as it must meet the caller's."""
    requirements = link.package.manifest["model_requirements"]
    label = f"dependency {link.dependency!r}"
    if not requirements["tasks"]:
        return
    if router is None:
        raise LinkRefusal("link_model_incompatible", f"{label}: no model route is configured")
    if requirements.get("privacy") == "local-only" and getattr(router, "remote", False):
        raise LinkRefusal(
            "link_model_incompatible", f"{label}: it requires a local-only model route"
        )
    capabilities = set(getattr(router, "capabilities", ()))
    for task in requirements["tasks"]:
        missing = sorted(set(task["capabilities"]) - capabilities)
        if missing:
            raise LinkRefusal(
                "link_model_incompatible",
                f"{label}: task {task['id']!r} needs {missing[0]!r}, which the route lacks",
            )
        if router.context_window < task["context_window"]:
            raise LinkRefusal(
                "link_model_incompatible",
                f"{label}: task {task['id']!r} needs a context window of "
                f"{task['context_window']}, the route has {router.context_window}",
            )


__all__ = [
    "LinkRefusal",
    "ResolvedLink",
    "check_composition",
    "check_model",
    "check_profile",
    "check_record",
    "fetch_dependency",
    "nested_reason",
    "resolve_links",
    "verify_linked",
]
