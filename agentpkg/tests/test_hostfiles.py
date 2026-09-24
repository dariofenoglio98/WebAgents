"""The trusted PDF parser: what it reads, what it refuses, and what it cannot do.

`agentpkg.hostfiles` is given bytes and answers with page text. It must never
be able to open a file, reach a network or write anything, and a hostile or
broken document must end in a stable refusal rather than a crash. These tests
exercise the parsing function directly and the spawned `agentpkg
host-pdf-read` process exactly as the Agent Browser's broker spawns it: bytes
on stdin, a pipe on stdout, a minimal environment.
"""

from __future__ import annotations

import ast
import hashlib
import io
import json
import os
import subprocess
from pathlib import Path

import pytest
from pdf_fixtures import make_pdf

from agentpkg.hostfiles import DEFAULT_LIMITS, PdfLimits, PdfRefused, extract_text

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "agentpkg/src/agentpkg"
HOSTFILES = SRC / "hostfiles"
AGENTPKG = ROOT / "agentpkg/.venv/bin/agentpkg"


def refused(data: bytes, limits: PdfLimits = DEFAULT_LIMITS) -> str:
    with pytest.raises(PdfRefused) as caught:
        extract_text(data, limits)
    return caught.value.code


def test_it_returns_every_page_in_order_with_the_hash_of_the_exact_bytes():
    data = make_pdf([["First page, line one.", "Line two."], "Second page."])
    result = extract_text(data)
    assert set(result) == {"pages", "sha256", "source"}
    assert result["source"] == "user_pdf"
    assert result["sha256"] == hashlib.sha256(data).hexdigest()
    assert [page["page"] for page in result["pages"]] == [1, 2]
    assert result["pages"][0]["text"] == "First page, line one.\nLine two.\n"
    assert result["pages"][1]["text"] == "Second page.\n"


def test_it_refuses_what_is_not_a_bounded_pdf():
    assert refused(b"") == "empty"
    assert refused(b"GIF89a not a pdf") == "not_a_pdf"
    assert refused(b"   %PDF-1.4 leading whitespace") == "not_a_pdf"
    assert refused(b"%PDF-1.4\nnot really a pdf at all\n%%EOF") == "malformed_pdf"
    data = make_pdf(["small"])
    assert refused(data, PdfLimits(max_bytes=len(data) - 1)) == "too_large"


def test_it_refuses_too_many_pages_and_too_much_text():
    data = make_pdf(["one", "two", "three"])
    assert refused(data, PdfLimits(max_pages=2)) == "too_many_pages"
    long_page = make_pdf(["x" * 200])
    assert refused(long_page, PdfLimits(max_page_text_bytes=100)) == "page_text_too_large"
    many = make_pdf(["y" * 90, "z" * 90, "w" * 90])
    assert (
        refused(many, PdfLimits(max_page_text_bytes=100, max_total_text_bytes=200))
        == "text_too_large"
    )


def test_it_refuses_an_encrypted_document():
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    for page in PdfReader(io.BytesIO(make_pdf(["secret"]))).pages:
        writer.add_page(page)
    writer.encrypt("user-password")
    buffer = io.BytesIO()
    writer.write(buffer)
    assert refused(buffer.getvalue()) == "encrypted"


def test_the_default_limits_fit_one_bounded_tool_answer():
    # The answer crosses one bounded frame into a package whose tool output is
    # capped at 512 KiB; the text limit leaves room for its JSON escaping.
    assert DEFAULT_LIMITS.max_total_text_bytes <= 256 * 1024
    assert DEFAULT_LIMITS.max_page_text_bytes <= DEFAULT_LIMITS.max_total_text_bytes
    assert DEFAULT_LIMITS.max_bytes == 20 * 1024 * 1024
    assert DEFAULT_LIMITS.max_pages == 100


# -- the spawned process ------------------------------------------------------
def spawn(data: bytes, *, cwd: Path, stdout=subprocess.PIPE) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(AGENTPKG), "host-pdf-read"],
        input=data,
        stdout=stdout,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1"},
        timeout=60,
        check=False,
    )


@pytest.mark.skipif(not AGENTPKG.exists(), reason="agentpkg console script not installed")
def test_the_process_answers_on_stdout_and_writes_nothing(tmp_path):
    data = make_pdf(["Quoted sentence one.", "Quoted sentence two."])
    done = spawn(data, cwd=tmp_path)
    assert done.returncode == 0, done.stderr
    answer = json.loads(done.stdout)
    assert answer == extract_text(data)
    # It was run in an empty directory and left it empty.
    assert list(tmp_path.iterdir()) == []


@pytest.mark.skipif(not AGENTPKG.exists(), reason="agentpkg console script not installed")
def test_the_process_refuses_with_a_stable_reason_and_no_content(tmp_path):
    for data, reason in (
        (b"PK\x03\x04 a zip, not a pdf", "not_a_pdf"),
        (b"%PDF-1.7\ngarbage that mentions SECRET-CONTENT\n", "malformed_pdf"),
    ):
        done = spawn(data, cwd=tmp_path)
        assert done.returncode == 3
        assert json.loads(done.stdout) == {"error": reason}
        assert b"SECRET-CONTENT" not in done.stdout


@pytest.mark.skipif(not AGENTPKG.exists(), reason="agentpkg console script not installed")
def test_the_process_refuses_to_answer_into_a_file(tmp_path):
    target = tmp_path / "out.json"
    with target.open("wb") as handle:
        done = spawn(make_pdf(["x"]), cwd=tmp_path, stdout=handle)
    assert done.returncode == 2
    assert b"must be a pipe" in done.stderr
    assert target.read_bytes() == b""


# -- the boundary -------------------------------------------------------------
def _imports(path: Path) -> tuple[set[str], set[str]]:
    tree = ast.parse(path.read_text(), filename=str(path))
    local, outside = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            outside.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                local.add((node.module or "").split(".")[0])
            else:
                outside.add((node.module or "").split(".")[0])
    return local, outside


def test_the_parser_imports_nothing_that_could_open_reach_or_run():
    """An allowlist, not a ban list: anything else would be a new way out."""
    permitted = {
        "__future__",
        "dataclasses",
        "hashlib",
        "io",
        "json",
        "os",
        "pypdf",
        "resource",
        "signal",
        "stat",
        "sys",
    }
    for module in sorted(HOSTFILES.glob("*.py")):
        local, outside = _imports(module)
        assert local <= {"pdf"}, f"{module.name} reaches {sorted(local - {'pdf'})}"
        assert outside <= permitted, f"{module.name} imports {sorted(outside - permitted)}"
        code = module.read_text()
        for banned in ("open(", "socket", "subprocess", "urllib", "http", "eval(", "exec("):
            assert banned not in code, f"{module.name} contains {banned!r}"


def test_no_other_trusted_namespace_can_reach_the_parser():
    """The runner, the tool bridge, the model bridge and the control plane
    cannot import it: parsing a person's file is the broker's to ask for."""
    for namespace in ("execution", "toolbridge", "hostbridge", "browser"):
        for module in sorted((SRC / namespace).glob("*.py")):
            text = module.read_text()
            assert "hostfiles" not in text, f"{namespace}/{module.name} mentions hostfiles"
