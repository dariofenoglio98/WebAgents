"""What a framework port takes from the signed package (PROTOCOL.md §2.5 rules 1 and 3, D-350).

- **Tools** (rule 1): one function tool per declared tool, with the declared input schema as its
  parameters (non-strict, so the schema reaches the model as declared) and the declared
  description. The function-tool name is the tool id with `.` replaced by `_` (the chat APIs accept
  `[A-Za-z0-9_-]` only); the record keeps the tool id, so the oracle reads the same names on every
  side.
- **Instructions** (rule 3): the package's skills concatenated in graph order (each skill once, at
  its first use; the YAML front matter dropped), followed by the committed host paragraph
  (`baseline/HOST-<port>.md`), identical across tasks.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from agentpkg.memory.model import is_memory_binding

from campaigns.driver import py_driver

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
PROGENT_REPOSITORY = "https://github.com/sunblaze-ucb/progent"
PROGENT_COMMIT = "b02783b896d4bf01a2adf24738015e258db8d35b"

# The ported packages: the signed artifact and the publisher's key, as on our side (the same table
# and the same verified load as `Py`'s, review 1 nit 19).
PACKAGES = {name: py_driver.PACKAGES[name] for name in ("webair", "travel-network")}
PORTS = tuple(PACKAGES)
STRIPPED_ROOT_KEYS = ("$schema", "$id", "title")


def load(port: str):
    if port not in PACKAGES:
        raise KeyError(port)
    return py_driver.verified(port)


def tool_name(tool_id: str) -> str:
    return tool_id.replace(".", "_")


def function_tool_specs(package) -> list[dict]:
    """Every declared tool as a function-tool spec, in tool-id order."""
    specs = []
    for tool_id, tool in sorted(package.tools.items()):
        schema = dict(package.json(tool["input_schema"]))
        for key in STRIPPED_ROOT_KEYS:
            schema.pop(key, None)
        binding = tool["binding"]
        specs.append(
            {
                "name": tool_name(tool_id),
                "tool_id": tool_id,
                "binding": binding,
                "description": tool["description"],
                "schema": schema,
                "input_schema": tool["input_schema"],
                "kind": "memory" if is_memory_binding(binding) else "http",
                "endpoint": tool.get("endpoint"),
                "method": tool.get("method"),
                "timeout_seconds": tool.get("timeout_seconds"),
                "side_effects": tool.get("side_effects"),
            }
        )
    return specs


def _skill_body(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            text = text[end + 5 :]
    return text.strip()


def skills_in_graph_order(package) -> list[str]:
    """The skills of the `llm` nodes' workers in node order, then those of a network's roles in
    declaration order (a network role runs as the worker of the same id)."""
    workers = {w["id"]: w for w in package.graph["workers"]}
    users = [node["worker"] for node in package.graph["nodes"] if node["type"] == "llm"]
    users += list((package.graph.get("network") or {}).get("roles") or {})
    seen: list[str] = []
    for worker in users:
        for skill in (workers.get(worker) or {}).get("skills") or []:
            if skill not in seen:
                seen.append(skill)
    return seen


def host_paragraph_path(port: str) -> Path:
    return HERE / f"HOST-{port}.md"


def instructions(port: str, package) -> str:
    parts = []
    for skill in skills_in_graph_order(package):
        parts.append(_skill_body(package.files[f"skills/{skill}/SKILL.md"].decode("utf-8")))
    parts.append(host_paragraph_path(port).read_text().strip())
    return "\n\n".join(parts) + "\n"


def instructions_sha256(port: str) -> str:
    return hashlib.sha256(instructions(port, load(port)).encode()).hexdigest()


def answer_schema(name: str = "answer") -> dict:
    path = ROOT / "experiments" / "campaigns" / "tasks" / f"{name}.schema.json"
    return json.loads(path.read_text())
