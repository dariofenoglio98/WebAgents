"""F1 — package verification: is the executed package exactly what the pinned publisher signed?"""

from __future__ import annotations

import json
import random

from harness import artifacts

from . import boundaries as B
from .base import Env, Template, base_plan, payload, resigned_plan

BOTH = ("meeting-agenda", "literature-review")

# Schema documents whose canonical digest the host's tool bindings pin: editing
# one changes a tool contract, not just an annotation, so content edits avoid them.
CONTRACT_PINNED = {
    "schemas/search-input.schema.json",
    "schemas/search-output.schema.json",
    "schemas/resolver-input.schema.json",
    "schemas/resolver-output.schema.json",
    "schemas/reader-input.schema.json",
    "schemas/reader-output.schema.json",
}
NEUTRAL_KEYS = ("description", "title")
SENTENCES = (
    "Keep every answer within the declared schema.",
    "Prefer short, specific statements.",
    "Report what the data supports and nothing more.",
    "Name the source of each statement.",
    "Do not repeat the input back verbatim.",
)


def _string_sites(value, path=()):
    """(json path, current string) for every neutral annotation string."""
    if isinstance(value, dict):
        for key in sorted(value):
            child = value[key]
            if key in NEUTRAL_KEYS and isinstance(child, str):
                yield (*path, key), child
            yield from _string_sites(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _string_sites(child, (*path, index))


def _number_sites(graph):
    for index, node in enumerate(graph["nodes"]):
        yield ("nodes", index, "timeout_seconds"), node["timeout_seconds"]


def neutral_edit_space(files: dict[str, bytes]) -> list[dict]:
    """Every semantically neutral, integrity-covered edit, in a stable order."""
    space = []
    for name in sorted(files):
        data = files[name]
        if name.endswith(".md"):
            lines = data.decode("utf-8").split("\n")
            for index in range(0, len(lines), max(1, len(lines) // 6)):
                space.append({"file": name, "kind": "md_insert", "line": index})
            words = [w for w in data.decode("utf-8").split() if w.isalpha() and len(w) > 6]
            for word in sorted(set(words))[:6]:
                space.append({"file": name, "kind": "md_replace", "word": word})
            space.append({"file": name, "kind": "md_append"})
        elif name.endswith(".json") or name == "MANIFEST.agent":
            if name in CONTRACT_PINNED:
                continue
            document = json.loads(data)
            for path, _ in _string_sites(document):
                space.append({"file": name, "kind": "json_string", "path": list(path)})
            if name == "graph.json":
                for path, _ in _number_sites(document):
                    space.append({"file": name, "kind": "json_number", "path": list(path)})
    return space


def apply_edit(files: dict[str, bytes], edit: dict, salt: str) -> dict[str, bytes]:
    """The edited payload; JSON members keep their (canonical) formatting."""
    files = dict(files)
    name = edit["file"]
    sentence = SENTENCES[int(artifacts_hash(salt), 16) % len(SENTENCES)]
    if edit["kind"].startswith("md_"):
        text = files[name].decode("utf-8")
        if edit["kind"] == "md_insert":
            lines = text.split("\n")
            lines.insert(min(edit["line"], len(lines)), sentence)
            text = "\n".join(lines)
        elif edit["kind"] == "md_replace":
            text = text.replace(edit["word"], edit["word"].upper(), 1)
        else:
            text = text.rstrip("\n") + f"\n\n{sentence}\n"
        files[name] = text.encode("utf-8")
        return files
    document = json.loads(files[name])
    node = document
    for part in edit["path"][:-1]:
        node = node[part]
    last = edit["path"][-1]
    if edit["kind"] == "json_string":
        node[last] = f"{node[last]} {sentence}".strip()
    else:
        node[last] = int(node[last]) + 1
    files[name] = json.dumps(
        document, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    return files


def artifacts_hash(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode()).hexdigest()


class PayloadEdit(Template):
    """Shared generator for the three content-tampering templates."""

    def variants(self, package, env: Env, rng: random.Random, budget: int):
        space = neutral_edit_space(payload(env, package))
        rng.shuffle(space)
        chosen, seen = [], set()
        for edit in space:
            key = json.dumps(edit, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            chosen.append(edit)
            if len(chosen) >= budget:
                break
        out = []
        for edit in chosen:
            vid = f"{edit['kind']}-{artifacts_hash(json.dumps(edit, sort_keys=True))[:10]}"
            where = edit["file"] + (
                f" at {'/'.join(map(str, edit['path']))}" if "path" in edit else ""
            )
            out.append(
                self.variant(
                    package,
                    vid,
                    {"edit": edit},
                    f"{edit['kind']} in {where}; {self.perturbation}",
                    control_params={"edit": edit},
                    control_description=(
                        f"the same {edit['kind']} in {where}, rebuilt and re-signed "
                        "by a pinned (trusted) key"
                    ),
                )
            )
        return out

    def plan(self, variant, kind, env: Env):
        files = apply_edit(
            payload(env, variant.package), variant.params["edit"], variant.variant_id
        )
        if kind == "control":
            return resigned_plan(env, variant.package, files), B.prepared_or_executed
        edits = {
            name: data
            for name, data in files.items()
            if data != payload(env, variant.package).get(name)
        }
        archive = artifacts.tamper(env.archive(variant.package), edits, **self.tamper_mode())
        return base_plan(env, variant.package, archive=archive), B.prepared_or_executed

    def tamper_mode(self) -> dict:
        raise NotImplementedError


class EditUnsigned(PayloadEdit):
    def tamper_mode(self):
        return {"integrity": "keep", "signature": "keep"}


class EditRestated(PayloadEdit):
    def tamper_mode(self):
        return {"integrity": "update", "signature": "keep"}


class EditRedigested(PayloadEdit):
    def tamper_mode(self):
        return {"integrity": "update", "signature": "update_digest"}


EDIT_UNSIGNED = EditUnsigned(
    "F1.payload_edit_integrity",
    "F1",
    "Signed payload edited, integrity statement left as signed",
    "One integrity-covered member (skill text, schema annotation, manifest or graph value) "
    "is changed after signing; integrity.json and the signature are untouched.",
    "The payload bytes are the bytes the publisher's integrity statement describes.",
    "verification",
    "verify",
    ("package_rejected", "integrity_invalid"),
    "The edited package reaches a ready Run Plan, a lease or execution.",
    "The same edit, rebuilt and signed by an operator-pinned key.",
    "parametric",
    BOTH,
    "minus_verification",
    "content integrity",
    "signed content modified",
)
EDIT_RESTATED = EditRestated(
    "F1.payload_edit_restated",
    "F1",
    "Signed payload edited, integrity statement recomputed",
    "The member is changed and integrity.json is recomputed over the edited payload, which "
    "any party can do; the publisher's signature is left as it was.",
    "The integrity statement is the one the publisher signed.",
    "verification",
    "verify",
    ("signature_not_valid",),
    "The edited package reaches a ready Run Plan, a lease or execution.",
    "The same edit, rebuilt and signed by an operator-pinned key.",
    "parametric",
    BOTH,
    "minus_verification",
    "publisher signature",
    "integrity re-stated without re-signing",
)
EDIT_REDIGESTED = EditRedigested(
    "F1.payload_edit_redigested",
    "F1",
    "Signed payload edited, statement and signed digest rewritten",
    "As above, and the signature envelope's `digest` field is rewritten to the new statement, "
    "so only the Ed25519 signature bytes still belong to the old content.",
    "The Ed25519 signature verifies over the integrity statement.",
    "verification",
    "verify",
    ("signature_not_valid",),
    "The edited package reaches a ready Run Plan, a lease or execution.",
    "The same edit, rebuilt and signed by an operator-pinned key.",
    "parametric",
    BOTH,
    "minus_verification",
    "Ed25519 signature",
    "signed digest rewritten",
)


class MemberAdded(Template):
    KINDS = (
        ("notes", ".md"),
        ("data", ".json"),
        ("docs", ".txt"),
        ("refs", ".bib"),
        ("tables", ".csv"),
    )

    def variants(self, package, env, rng, budget):
        out = []
        for index in range(budget):
            directory, suffix = self.KINDS[
                (index + rng.randrange(len(self.KINDS))) % len(self.KINDS)
            ]
            name = f"{directory}/added-{index}-{rng.randrange(10**6):06d}{suffix}"
            out.append(
                self.variant(
                    package,
                    f"add-{index}",
                    {"name": name},
                    f"member {name} added after signing (not in integrity.json)",
                    control_params={"name": name},
                    control_description=f"{name} added, rebuilt and signed by a pinned key",
                )
            )
        return out

    @staticmethod
    def content(name: str) -> bytes:
        if name.endswith(".json"):
            return json.dumps({"note": "added member"}).encode()
        if name.endswith(".csv"):
            return b"column\nvalue\n"
        if name.endswith(".bib"):
            return b"@misc{added, title={Added member}}\n"
        return b"An added member.\n"

    def plan(self, variant, kind, env):
        name = variant.params["name"]
        if kind == "control":
            files = {**payload(env, variant.package), name: self.content(name)}
            return resigned_plan(env, variant.package, files), B.prepared_or_executed
        archive = artifacts.tamper(env.archive(variant.package), {name: self.content(name)})
        return base_plan(env, variant.package, archive=archive), B.prepared_or_executed


MEMBER_ADDED = MemberAdded(
    "F1.member_added",
    "F1",
    "Member added after signing",
    "A new data member is inserted into the signed archive; the integrity statement does not list "
    "it.",
    "The archive holds exactly the members the integrity statement covers.",
    "verification",
    "verify",
    ("package_rejected", "integrity_invalid"),
    "The extended package reaches a ready Run Plan, a lease or execution.",
    "The same member added, rebuilt and signed by an operator-pinned key.",
    "parametric",
    BOTH,
    "minus_verification",
    "content integrity",
    "unlisted member added",
)


class MemberRemoved(Template):
    def candidates(self, package, env):
        names = sorted(payload(env, package))
        picks = [
            "README.md",
            "MANIFEST.agent",
            "graph.json",
            "policy/policy.json",
            "fixtures/workflow.json",
        ]
        picks += [n for n in names if n.startswith("skills/")][:2]
        picks += [n for n in names if n.startswith("schemas/")][:2]
        picks += [n for n in names if n.startswith("tools/")][:1]
        return [n for n in picks if n in names]

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package, f"rm-{index}", {"name": name}, f"member {name} deleted after signing"
            )
            for index, name in enumerate(self.candidates(package, env))
        ]

    def plan(self, variant, kind, env):
        if kind == "control":
            return base_plan(env, variant.package), B.prepared_or_executed
        archive = artifacts.tamper(env.archive(variant.package), {variant.params["name"]: None})
        return base_plan(env, variant.package, archive=archive), B.prepared_or_executed


MEMBER_REMOVED = MemberRemoved(
    "F1.member_removed",
    "F1",
    "Signed member deleted",
    "One integrity-covered member is removed from the signed archive.",
    "Every member the integrity statement covers is present.",
    "verification",
    "verify",
    ("package_rejected", "integrity_invalid"),
    "The truncated package reaches a ready Run Plan, a lease or execution.",
    "The unmodified signed artifact.",
    "finite",
    BOTH,
    "minus_verification",
    "content integrity",
    "covered member deleted",
)


class DuplicateMember(Template):
    TARGETS = (
        "MANIFEST.agent",
        "graph.json",
        "policy/policy.json",
        "integrity.json",
        "signatures/publisher.json",
    )

    def variants(self, package, env, rng, budget):
        names = [n for n in self.TARGETS] + [
            sorted(n for n in payload(env, package) if n.endswith(".md"))[0]
        ]
        out = []
        for index, name in enumerate(names):
            for position in ("after", "before"):
                out.append(
                    self.variant(
                        package,
                        f"dup-{index}-{position}",
                        {"name": name, "position": position},
                        f"second, different entry named {name} placed {position} the original",
                    )
                )
        return out

    def plan(self, variant, kind, env):
        if kind == "control":
            return base_plan(env, variant.package), B.prepared_or_executed
        name, position = variant.params["name"], variant.params["position"]
        members = artifacts.canonical_members(env.archive(variant.package))
        original = next(m for m in members if m.name == name)
        if name.endswith(".json") or name == "MANIFEST.agent":
            document = json.loads(original.data)
            document["description"] = "a second, different copy"
            data = json.dumps(document, separators=(",", ":")).encode()
        else:
            data = original.data + b"\nA second, different copy.\n"
        duplicate = artifacts.Member(name, data)
        if position == "after":
            members.append(duplicate)
        else:
            members.insert(members.index(original), duplicate)
        return base_plan(
            env, variant.package, archive=artifacts.zip_bytes(members)
        ), B.prepared_or_executed


DUPLICATE_MEMBER = DuplicateMember(
    "F1.duplicate_member",
    "F1",
    "Ambiguous archive: duplicate member names",
    "A second entry with an authoritative member's name and different content is added. "
    "General-purpose ZIP readers accept this (Python's keeps the last one).",
    "Each member name denotes exactly one byte sequence.",
    "verification",
    "verify",
    ("package_rejected", "container_invalid"),
    "The ambiguous package reaches a ready Run Plan, a lease or execution.",
    "The unmodified signed artifact.",
    "finite",
    BOTH,
    "minus_verification",
    "canonical container",
    "duplicate authoritative entry",
    ablation_removes_guard=False,
)


class ContainerLayout(Template):
    LAYOUTS = (
        "prefix",
        "suffix",
        "archive_comment",
        "extra_field",
        "entry_comment",
        "data_descriptor",
        "deflated",
        "executable_mode",
        "symlink_mode",
        "directory_entry",
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                layout,
                {"layout": layout},
                f"canonical archive with {layout.replace('_', ' ')}",
            )
            for layout in self.LAYOUTS
        ]

    @classmethod
    def build(cls, archive: bytes, layout: str) -> bytes:
        import stat

        members = artifacts.canonical_members(archive)
        target = next(m for m in members if m.name.endswith(".md"))
        kwargs = {}
        if layout == "prefix":
            kwargs["prefix"] = b"#!/bin/sh\n# prepended data\n"
        elif layout == "suffix":
            kwargs["suffix"] = b"\nappended trailer\n"
        elif layout == "archive_comment":
            kwargs["comment"] = b"archive comment"
        elif layout == "extra_field":
            target.extra = b"\xfe\xca\x04\x00abcd"
        elif layout == "entry_comment":
            target.comment = b"entry comment"
        elif layout == "data_descriptor":
            target.descriptor = True
        elif layout == "deflated":
            target.method = 8
        elif layout == "executable_mode":
            target.mode = stat.S_IFREG | 0o755
        elif layout == "symlink_mode":
            target.mode = stat.S_IFLNK | 0o777
        elif layout == "directory_entry":
            members.insert(0, artifacts.Member("skills/", b"", mode=stat.S_IFDIR | 0o755))
        return artifacts.zip_bytes(members, **kwargs)

    def plan(self, variant, kind, env):
        if kind == "control":
            return base_plan(env, variant.package), B.prepared_or_executed
        archive = self.build(env.archive(variant.package), variant.params["layout"])
        return base_plan(env, variant.package, archive=archive), B.prepared_or_executed


CONTAINER_LAYOUT = ContainerLayout(
    "F1.container_layout",
    "F1",
    "Non-canonical container layout",
    "The signed members are kept, but the ZIP container carries a prefix, suffix, comment, "
    "extra field, data descriptor, compression, an executable or symlink mode, or a "
    "directory entry. Most general-purpose ZIP readers accept these.",
    "The artifact is one canonical, data-only ZIP_STORED container.",
    "verification",
    "verify",
    ("package_rejected", "container_invalid"),
    "The non-canonical package reaches a ready Run Plan, a lease or execution.",
    "The unmodified signed artifact.",
    "finite",
    BOTH,
    "minus_verification",
    "canonical container",
    "non-canonical ZIP layout",
    ablation_removes_guard=False,
)


class MemberName(Template):
    NAMES = (
        ("traversal", "../escape.md"),
        ("absolute", "/absolute.md"),
        ("dot_segment", "notes/../escape.md"),
        ("backslash", "notes\\back.md"),
        ("windows_reserved", "notes/CON.md"),
        ("vendored_dir", "node_modules/x.md"),
        ("executable_suffix", "notes/helper.py"),
        ("script_suffix", "notes/run.sh"),
        ("credential_name", "notes/private-key.md"),
        ("case_collision", "SKILLS/collision.md"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                label,
                {"label": label, "name": name},
                f"member named {name!r}, signed by a pinned key",
                control_params={"name": f"notes/{label}.md"},
                control_description=f"the same content as notes/{label}.md, signed by a pinned key",
            )
            for label, name in self.NAMES
        ]

    def plan(self, variant, kind, env):
        files = payload(env, variant.package)
        if kind == "control":
            name = variant.control_params["name"]
        else:
            name = variant.params["name"]
        files = {**files, name: b"A member a publisher added.\n"}
        return resigned_plan(env, variant.package, files, normalize=False), B.prepared_or_executed


MEMBER_NAME = MemberName(
    "F1.member_name",
    "F1",
    "Unsafe or executable member name in a trusted package",
    "A member with a traversal, absolute, reserved, executable, credential-like or "
    "case-colliding name — signed by an operator-pinned key, so signature and trust hold.",
    "Package members are portable, data-only relative names.",
    "verification",
    "verify",
    ("package_rejected", "container_invalid"),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The same content under a safe relative name, signed by the same pinned key.",
    "finite",
    BOTH,
    "minus_verification",
    "portable data-only names",
    "path-invalid member name",
    ablation_removes_guard=False,
)


class StrictJson(Template):
    CASES = (
        ("duplicate_manifest_version", "MANIFEST.agent"),
        ("duplicate_graph_deadline", "graph.json"),
        ("duplicate_policy_budget", "policy/policy.json"),
        ("nan_literal", "policy/policy.json"),
        ("invalid_utf8", "README.md"),
        ("nul_byte", "README.md"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                label,
                {"label": label, "file": name},
                f"{label.replace('_', ' ')} in {name}, signed by a pinned key",
                control_params={"label": label, "file": name, "control": True},
                control_description=(
                    f"{name} with the single, unambiguous value, signed by the same key"
                ),
            )
            for label, name in self.CASES
        ]

    @staticmethod
    def broken(label: str, data: bytes) -> bytes:
        text = data.decode("utf-8")
        if label == "duplicate_manifest_version":
            return text.replace('"version":', '"version":"9.9.9","version":', 1).encode()
        if label == "duplicate_graph_deadline":
            return text.replace(
                '"deadline_seconds":', '"deadline_seconds":1,"deadline_seconds":', 1
            ).encode()
        if label == "duplicate_policy_budget":
            return text.replace(
                '"hard_tokens":', '"hard_tokens":999999999,"hard_tokens":', 1
            ).encode()
        if label == "nan_literal":
            return text.replace('"estimated_cost_usd":null', '"estimated_cost_usd":NaN', 1).encode()
        if label == "invalid_utf8":
            return data + b"\n\xff\xfe invalid\n"
        if label == "nul_byte":
            return data + b"\nnul\x00byte\n"
        raise ValueError(label)

    def plan(self, variant, kind, env):
        files = dict(payload(env, variant.package))
        name, label = variant.params["file"], variant.params["label"]
        if kind == "violation":
            files[name] = self.broken(label, files[name])
            if files[name] == payload(env, variant.package)[name]:
                raise RuntimeError(f"{label}: edit did not apply")
        return resigned_plan(env, variant.package, files, normalize=False), B.prepared_or_executed


STRICT_JSON = StrictJson(
    "F1.strict_json",
    "F1",
    "Ambiguous or invalid document in a trusted package",
    "A JSON member with a duplicated key (different values), a non-JSON NaN literal, or a "
    "text member that is not UTF-8 or contains NUL — signed by an operator-pinned key. "
    "Python's own json module accepts duplicate keys (last wins) and NaN.",
    "Every package document has exactly one unambiguous meaning.",
    "verification",
    "verify",
    ("package_rejected", "container_invalid"),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The same member with one unambiguous value, signed by the same pinned key.",
    "finite",
    BOTH,
    "minus_verification",
    "strict JSON / UTF-8",
    "duplicate JSON key",
    ablation_removes_guard=False,
)

TEMPLATES = (
    EDIT_UNSIGNED,
    EDIT_RESTATED,
    EDIT_REDIGESTED,
    MEMBER_ADDED,
    MEMBER_REMOVED,
    DUPLICATE_MEMBER,
    CONTAINER_LAYOUT,
    MEMBER_NAME,
    STRICT_JSON,
)
