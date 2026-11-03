#!/usr/bin/env python3
"""Vectors for the weights digest (D-447), made with hashlib so the TypeScript is checked against an
independent implementation: `sha256:` + hex(SHA-256(join(sorted(file_sha256_hex), "\\n") + "\\n")).

    agentpkg/.venv/bin/python chrome-agent-browser/scripts/make-weights-digest-vectors.py
"""
import hashlib
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "test" / "fixtures" / "weights-digest-vectors.json"


def digest(files: list[str]) -> str:
    text = "\n".join(sorted(files)) + "\n"
    return "sha256:" + hashlib.sha256(text.encode("ascii")).hexdigest()


def h(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


VECTORS = [
    {"name": "one file", "files": [h("part-1")]},
    {"name": "two files out of order", "files": [h("part-2"), h("part-1")]},
    {"name": "three files, a split model", "files": [h("00003-of-00003"), h("00001-of-00003"), h("00002-of-00003")]},
    {"name": "the spike's Qwen3-0.6B Q4_0 (Hugging Face's LFS digest)", "files": ["da2572f16c061335" + h("spike")[16:]]},
    {"name": "all zero and all f sort bytewise", "files": ["f" * 64, "0" * 64]},
]
for vector in VECTORS:
    vector["digest"] = digest(vector["files"])
OUT.write_text(json.dumps({"schema": "weights-digest-vectors-v0", "rule": "sha256: + hex(SHA-256(join(sorted(file_sha256_hex), '\\n') + '\\n'))", "vectors": VECTORS}, indent=2) + "\n")
print(OUT)
