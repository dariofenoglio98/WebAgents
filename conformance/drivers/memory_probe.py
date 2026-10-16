"""Write the memory.v0 probe package, or one variant of it, as a source tree (T20, M-64).

    python conformance/drivers/memory_probe.py <out-dir> <variant>
    python conformance/drivers/memory_probe.py --signed-archive <source> <out.agent.pkg> <key.pem>

The probe is agentpkg's own test package (`agentpkg/tests/memory_probe.py`): a generic workflow.v0
package that uses every memory.v0 permission (a `memory.read` record view, a `personal.read`
legacy identity, the agent document's two tools, one model step that proposes and writes notes,
a local tool that receives the identity's e-mail, the `memory.proposal` export). Each variant
changes one thing, so that both runtimes face the same negative case of spec/memory-v0.md §10.
The runner builds and signs the tree with its throwaway key; nothing here runs a package.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agentpkg" / "tests"))

import memory_probe as probe  # noqa: E402


def answer(files, proposals=None, notes=None):
    case = files["fixtures/workflow.json"]["models"]["remember"][0]
    if proposals is not None:
        case["output"]["proposals"] = proposals
    if notes is not None:
        case["output"]["notes"] = notes


def first(**changes):
    return [{**probe.proposals()[0], **changes}]


def n2_sealed_field(files):
    files["policy/policy.json"]["permissions"][4]["resources"].append("person.identity")
    answer(
        files,
        first(
            type="person.identity",
            title="Alex",
            fields={
                "given_name": "Alex",
                "family_name": "T",
                "email": "someone@else.example",
            },
        ),
    )


def n4_over_cap(files):
    files["fixtures/workflow.json"]["models"]["remember"][0]["output"]["notes"] = (
        "x" * 32769
    )
    files["graph.json"]["nodes"][3]["max_output_tokens"] = 16000
    files["graph.json"]["workers"][2]["budget"]["tokens"] = 60000
    files["policy/policy.json"]["budget"]["hard_tokens"] = 120000


def n7_two_writes(files):
    nodes = files["graph.json"]["nodes"]
    second = json.loads(json.dumps(nodes[4]))
    second["id"] = "notes-write-again"
    second["writes"] = {"/echoed": {"from": "result", "path": ""}}
    second["depends_on"] = ["notes-write"]
    nodes.insert(5, second)
    nodes[6]["writes"] = {}
    nodes[7]["depends_on"] = ["notes-write-again", "echo"]


def n11_model(files):
    remember = files["graph.json"]["nodes"][3]
    remember["input"]["object"]["email"] = probe.state("/identity/contact_email")
    files["fixtures/workflow.json"]["models"]["remember"][0]["input"]["email"] = (
        probe.EMAIL
    )


def m36_egress(files):
    files["policy/policy.json"]["permissions"].append(
        {
            "id": "probe.send",
            "kind": "files.write",
            "description": "Probe destination.",
            "required": False,
            "resources": ["probe"],
        }
    )
    files["tools/echo.tool.json"]["permissions"] = ["probe.send"]
    probe.send_email(files)


def custom(files, schema, local="loyalty.card"):
    files["policy/policy.json"]["memory_types"] = [
        {
            "id": local,
            "display_name": "Loyalty card",
            "description": "A loyalty programme membership.",
            "schema": "schemas/custom.schema.json",
        }
    ]
    files["MANIFEST.agent"]["schemas"].append(
        {"id": "custom", "path": "schemas/custom.schema.json"}
    )
    files["schemas/custom.schema.json"] = schema


CLOSED = {
    "type": "object",
    "properties": {"programme": {"type": "string"}, "member": {"type": "string"}},
    "required": ["programme"],
    "additionalProperties": False,
}
STRANGER = "mem_" + "a" * 32

VARIANTS = {
    "fixture": lambda files: None,
    "n1-type-undeclared": lambda files: answer(
        files,
        first(type="contact", fields={"given_name": "Sam", "family_name": "Traveler"}),
    ),
    "n2-sealed-field": n2_sealed_field,
    "n4-agent-write-over-cap": n4_over_cap,
    "n5-newer-runtime": lambda files: files["MANIFEST.agent"]["runtime"].update(
        minimum_version="0.5.0"
    ),
    "n6-view-mismatch": lambda files: files["schemas/travel.profile.view.schema.json"][
        "properties"
    ]["body"].update(maxLength=99),
    "n7-two-agent-writes": n7_two_writes,
    "n8-update-not-granted": lambda files: answer(
        files, [{**probe.proposals()[1], "target": "mem_" + "9" * 32}]
    ),
    "n9-link-to-no-proposal": lambda files: answer(
        files,
        [
            probe.proposals()[0],
            {**probe.proposals()[1], "links": [{"to": "#9", "rel": "prefers"}]},
        ],
    ),
    "n10-publisher-scoped": lambda files: files["policy/policy.json"]["memory"].update(
        scope="publisher-scoped"
    ),
    "n11-sealed-value-to-a-model": n11_model,
    "n12-write-without-export": lambda files: files["graph.json"].update(exports=[]),
    "n13-sealed-value-in-a-proposal": lambda files: answer(
        files, first(fields={"kind": "other", "value": probe.EMAIL})
    ),
    "n14-link-not-granted": lambda files: answer(
        files, first(links=[{"to": STRANGER, "rel": "related"}])
    ),
    "n14-body-link-not-granted": lambda files: answer(
        files, first(body=f"See [[{STRANGER}|Trip]].")
    ),
    "n15-supersedes-link": lambda files: answer(
        files, first(links=[{"to": "self", "rel": "supersedes"}])
    ),
    "n16-custom-type-shadows-sealed": lambda files: custom(
        files,
        {
            **CLOSED,
            "properties": {
                **CLOSED["properties"],
                "holder": {
                    "type": "object",
                    "properties": {"email": {"type": "string"}},
                    "additionalProperties": False,
                },
            },
        },
    ),
    "n17-custom-type-reserved": lambda files: custom(files, CLOSED, local="contact"),
    "n19-lower-index-first": lambda files: answer(
        files,
        [
            {
                **probe.proposals()[0],
                "links": [{"to": "mem_" + "b" * 32, "rel": "related"}],
            },
            {**probe.proposals()[0], "type": "contact"},
        ],
    ),
    "n21-custom-type-open": lambda files: custom(files, {**CLOSED, "anyOf": [{}]}),
    "n22-marker-line": lambda files: answer(
        files, first(body="Text\n<!-- memory.v0 links -->\n## Links")
    ),
    "m36-sealed-value-to-a-tool": m36_egress,
    "m36-granted-sealed-value": probe.send_email,
    # T20 review 1: every sealed value in a tool's arguments is checked, not the first (M-36); a
    # package's own custom type proposed and read by its local id (M-18, D-228).
    "m36-two-sealed-values": probe.two_sealed_values,
    "custom-type-proposal": probe.custom_type_proposal,
    "custom-type-read": probe.custom_type_read,
    # T20 review 2: a memory.read of an `agent.` type, whose binding would be a reserved agent
    # tool's name, is refused at validation (M-38, D-235).
    "agent-family-read": lambda files: files["policy/policy.json"]["permissions"].append(
        probe.permission("notes.typed", "memory.read", ["agent.notes"])
    ),
}
# Permissions a variant adds, granted for the session like the probe's own.
EXTRA_GRANTS = {
    "m36-sealed-value-to-a-tool": {"probe.send": "session"},
    "m36-two-sealed-values": {"card.read": "session"},
    "custom-type-read": {"memory.card": "session"},
}


def signed_archive(source: Path, output: Path, private_key: Path) -> None:
    """A signed archive of `source` without validating it, for a variant both CLIs must refuse at
    validation (`agentpkg build` refuses to build one). The archive and the signature are written
    exactly as `agentpkg build` and `agentpkg sign` write them (agentpkg's own writer, the same
    canonical JSON, the domain-separated transcript over the integrity statement)."""
    import base64

    from cryptography.hazmat.primitives import serialization

    from agentpkg.package import (
        archive_bytes,
        canonical_json,
        integrity_statement,
        sha256,
    )
    from agentpkg.signing import DOMAIN, _read_key, fingerprint
    from agentpkg.validation import parse_json

    files = {}
    for path in sorted(source.rglob("*")):
        if path.is_file():
            name = path.relative_to(source).as_posix()
            data = path.read_bytes()
            json_like = name.endswith(".json") or name == "MANIFEST.agent"
            files[name] = canonical_json(parse_json(data, name)) if json_like else data
    integrity = integrity_statement(files)
    key = _read_key(private_key, private=True)
    public = key.public_key()
    signature = {
        "format": "agent.pkg-signature-v0.1",
        "algorithm": "Ed25519",
        "key_fingerprint": fingerprint(public),
        "public_key": base64.b64encode(
            public.public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ).decode("ascii"),
        "signature": base64.b64encode(
            key.sign(DOMAIN + canonical_json(integrity))
        ).decode(),
        "digest": sha256(canonical_json(integrity)),
    }
    output.write_bytes(archive_bytes(files, signature))


def main(argv: list[str]) -> int:
    if argv[1] == "--signed-archive":
        signed_archive(Path(argv[2]), Path(argv[3]), Path(argv[4]))
        return 0
    out, name = Path(argv[1]), argv[2]
    change = VARIANTS[name]

    def apply(files):
        files["MANIFEST.agent"]["package_id"] = (
            f"org.webagents.conformance.memory-{name}"
        )
        change(files)

    probe.write_probe(out, apply)
    grants = Path(f"{out}.grants.json")
    grants.write_text(json.dumps(probe.grants(**EXTRA_GRANTS.get(name, {}))))
    manifest = json.loads((out / "MANIFEST.agent").read_text())
    tools = [entry["id"] for entry in manifest["tools"]]
    print(json.dumps({"source": str(out), "grants": str(grants), "tools": tools}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
