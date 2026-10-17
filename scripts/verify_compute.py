"""compute.v0 (agentpkg 0.5.0): offline checks of the contracts, the example modules and the
enforcement cases, printing JSON with `"passed"`.

    agentpkg/.venv/bin/python scripts/verify_compute.py

Checks: the live schemas carry the spec's RFC 6902 patches (applying a patch again changes
nothing); every committed case module equals its generator's bytes and its listed SHA-256; the
reader accepts and refuses the modules `cases.json` says; and every enforcement case ends at the
stage with the code the list expects, on the reference runtime.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "spec" / "compute-v0"
SCHEMAS = ROOT / "agentpkg" / "src" / "agentpkg" / "schemas"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _pointer(document, path: str, *, create_parent=False):
    """The parent container and the final token of a JSON Pointer."""
    tokens = [t.replace("~1", "/").replace("~0", "~") for t in path.split("/")[1:]]
    current = document
    for token in tokens[:-1]:
        current = current[int(token)] if isinstance(current, list) else current[token]
    return current, tokens[-1]


def apply_patch(document, patch: list[dict]):
    """RFC 6902: add, replace, remove and test, which is all the contracts use."""
    result = copy.deepcopy(document)
    for operation in patch:
        parent, token = _pointer(result, operation["path"])
        op = operation["op"]
        if op == "add":
            if isinstance(parent, list):
                if token == "-":
                    parent.append(copy.deepcopy(operation["value"]))
                else:
                    parent.insert(int(token), copy.deepcopy(operation["value"]))
            else:
                parent[token] = copy.deepcopy(operation["value"])
        elif op == "replace":
            if isinstance(parent, list):
                parent[int(token)] = copy.deepcopy(operation["value"])
            else:
                parent[token] = copy.deepcopy(operation["value"])
        elif op == "remove":
            if isinstance(parent, list):
                del parent[int(token)]
            else:
                del parent[token]
        elif op == "test":
            actual = parent[int(token)] if isinstance(parent, list) else parent[token]
            if actual != operation["value"]:
                raise ValueError(f"patch test failed at {operation['path']}")
        else:
            raise ValueError(f"unsupported patch operation {op!r}")
    return result


def apply_idempotent(document, patch: list[dict]):
    """Apply a patch that may already be applied: an `add` of a value that is already there is
    skipped (an enum member, a property), so the same patch file describes the step and checks
    the result."""
    result = copy.deepcopy(document)
    for operation in patch:
        parent, token = _pointer(result, operation["path"])
        if operation["op"] == "add":
            if isinstance(parent, list):
                if token == "-" and operation["value"] in parent:
                    continue
            elif token in parent and parent[token] == operation["value"]:
                continue
        result = apply_patch(result, [operation])
    return result


def _check(report, name, passed, detail=None):
    report["checks"].append({"name": name, "passed": bool(passed), **({"detail": detail} if detail else {})})
    if not passed:
        report["passed"] = False


def main() -> int:
    import hashlib
    import importlib.util
    import subprocess
    import sys
    import tempfile

    report = {"schema": "webagents-verify-compute-v0", "checks": [], "passed": True}
    # 1. The live schemas carry the spec's patches (applying one again changes nothing).
    for schema, patch in (
        ("workflow", "workflow.schema.patch.json"),
        ("policy", "policy.schema.patch.json"),
        ("audit-event", "audit-event.schema.patch.json"),
    ):
        live = load_json(SCHEMAS / f"{schema}.schema.json")
        _check(report, f"schema {schema} carries {patch}", apply_idempotent(live, load_json(CONTRACTS / patch)) == live)
    kinds = load_json(SCHEMAS / "policy.schema.json")["properties"]["permissions"]["items"]["properties"]["kind"]["enum"]
    _check(report, "policy kinds include compute", "compute" in kinds)
    codes = load_json(SCHEMAS / "audit-event.schema.json")["properties"]["error_code"]["enum"]
    _check(report, "audit error codes include compute_error", "compute_error" in codes)
    # 2. The committed case modules are their generator's bytes and the listed hashes.
    cases_dir = ROOT / "examples" / "compute" / "cases"
    spec = importlib.util.spec_from_file_location("build_cases", cases_dir / "build_cases.py")
    build_cases = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build_cases)
    listed = load_json(cases_dir / "cases.json")
    generated = build_cases.cases()
    for stem, data in sorted(generated.items()):
        path = cases_dir / "modules" / f"{stem}.wasm"
        same = path.exists() and path.read_bytes() == data
        _check(report, f"module {stem} equals its generator", same)
        _check(report, f"module {stem} hash listed", listed["modules"].get(stem) == hashlib.sha256(data).hexdigest())
    _check(report, "every listed module is generated", set(listed["modules"]) == set(generated))
    # 3. The example modules built by real toolchains pass the reader and their recorded hashes.
    sys.path.insert(0, str(ROOT / "agentpkg" / "src"))
    from agentpkg.compute.module import check_module

    readme = (ROOT / "examples" / "compute" / "README.md").read_text(encoding="utf-8")
    for path in sorted((ROOT / "examples" / "compute").glob("*/dist/*.wasm")):
        facts = check_module(path.read_bytes(), functions=("run",) if path.stem == "fares" else ("assign_ids", "match_quotes"))
        _check(report, f"example module {path.parent.parent.name}/{path.name} is a tier-1 module", True, facts.as_json())
        _check(report, f"example module {path.name} hash recorded in examples/compute/README.md", facts.sha256 in readme, facts.sha256)
    # 4. Every enforcement case ends where the list says, on the reference (the pytest module).
    with tempfile.TemporaryDirectory() as scratch:
        run = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-o", "addopts=", "-p", "no:cacheprovider",
             "--basetemp", scratch, str(ROOT / "agentpkg" / "tests" / "test_compute_cases.py")],
            capture_output=True, text=True, cwd=ROOT,
        )
    summary = run.stdout.strip().splitlines()[-1] if run.stdout.strip() else run.stderr[-300:]
    _check(report, "every enforcement case asserted on the reference", run.returncode == 0, summary)
    report["cases"] = len(listed["cases"])
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
