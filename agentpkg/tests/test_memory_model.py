"""The memory.v0 record format in agentpkg against the specification: the contracts are the spec's
files, the worked examples round-trip byte for byte, and the model agrees with the spec's
reference reader and writer (`scripts/check_memory_spec.py`) on every example."""

from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path

import pytest

from agentpkg.memory import model
from agentpkg.memory.folder import MemoryFolder, read_or_create_key
from agentpkg.memory.registry import TypeRegistry, record_view_schema, schema_sha256
from agentpkg.package import canonical_json

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "spec" / "memory-v0"
COPY = ROOT / "agentpkg" / "src" / "agentpkg" / "schemas" / "memory"
SCHEMAS = ROOT / "agentpkg" / "src" / "agentpkg" / "schemas"
EXAMPLES = SPEC / "examples"
FOLDERS = [
    EXAMPLES / "webair-0.6.0" / "memory",
    EXAMPLES / "webair-0.6.0" / "memory-export-omitted",
    EXAMPLES / "literature-review-0.2.8" / "memory",
]


def reference():
    spec = importlib.util.spec_from_file_location(
        "check_memory_spec", ROOT / "scripts" / "check_memory_spec.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("path", sorted(COPY.iterdir()), ids=lambda p: p.name)
def test_the_contracts_are_the_specification_s_files(path):
    assert path.read_bytes() == (SPEC / path.name).read_bytes()


@pytest.mark.parametrize("name", ["policy", "workflow"])
def test_the_schema_patches_are_applied(name):
    ref = reference()
    schema = json.loads((SCHEMAS / f"{name}.schema.json").read_text())
    patch = json.loads((SPEC / f"{name}.schema.patch.json").read_text())
    assert ref.apply_patch(schema, patch) == schema


def _records(folder: Path, mem: MemoryFolder):
    return [mem.records[rid] for rid in sorted(mem.records)]


@pytest.mark.parametrize("folder", FOLDERS, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_every_example_file_is_its_record_written_back(folder, tmp_path):
    copy = tmp_path / "memory"
    shutil.copytree(folder, copy)
    mem = MemoryFolder(copy)
    omitted = folder.name == "memory-export-omitted"
    if omitted:
        # The omitted export is written from the store it came from (M-56).
        store = MemoryFolder(_copy(EXAMPLES / "webair-0.6.0" / "memory", tmp_path / "store"))
        records = list(store.records.values())
    else:
        records = list(mem.records.values())
    stems = model.stems_for(records)
    titles = {r["id"]: r["title"] for r in records}
    registry = TypeRegistry()
    for record_id, path in mem.paths.items():
        record = (store if omitted else mem).records[record_id]
        text = model.record_to_document(
            record,
            registry.get(record["type"]),
            export=True,
            stems=stems,
            titles=titles,
            omit_sealed=omitted,
        )
        assert text == path.read_text(encoding="utf-8"), path.name
        assert stems[record_id] == path.stem


def _copy(source: Path, target: Path) -> Path:
    shutil.copytree(source, target)
    return target


@pytest.mark.parametrize("folder", FOLDERS[::2], ids=lambda p: p.parent.name)
def test_the_model_reads_every_example_as_the_reference_does(folder, tmp_path):
    ref = reference()
    mem = MemoryFolder(_copy(folder, tmp_path / "m"))
    _, records = ref.check_memory_folder(ref.Contracts(), folder, label="test")
    assert {r["id"]: r for r in records} == mem.records


def test_omitted_values_are_restored_by_id_and_reproduce_the_digest(tmp_path):
    store = MemoryFolder(_copy(EXAMPLES / "webair-0.6.0" / "memory", tmp_path / "store"))
    _copy(EXAMPLES / "webair-0.6.0" / "memory-export-omitted", tmp_path / "omitted")
    shutil.copy(tmp_path / "store" / "memory.key", tmp_path / "omitted" / "memory.key")
    omitted = MemoryFolder(tmp_path / "omitted")
    assert sorted(omitted.incomplete) == [
        "mem_0a1b2c3d4e5f60718293a4b5c6d7e8f9",
        "mem_4e5f60718293a4b5c6d7e8f90a1b2c3d",
    ]
    for record_id, record in omitted.records.items():
        stored = store.records[record_id]
        # The reader removed every placeholder (M-56); the store restores the values by id.
        restored = json.loads(json.dumps(record))
        for pointer, value in model.sealed_values_of(stored):
            model.pointer_set(restored["fields"], pointer, value)
        assert store.digest(restored) == store.digest(stored)


def test_views_hide_links_to_records_the_run_was_not_granted():
    ref = reference()
    bodies = [
        "Pack as in [[mem_8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a|Packing list]].",
        f"[[mem_{'a' * 32}|self]] and [[mem_{'b' * 32}]]",
        "\\[[Escaped]] [[Plain text]] [[self|Me]] [[mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|A|B]]",
    ]
    for body in bodies:
        for granted in (set(), {"self"}, {"mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}):
            ours = model.view_body(body, granted)
            assert ours[0] == ref.view_body(body, granted)[0]
            restored, carried = model.restore_view_links(ours[0], ours[1])
            assert restored == body
            assert carried == []


@pytest.mark.parametrize(
    "titles",
    [
        {"self": "Me", "mem_" + "1" * 32: "Trip", "mem_" + "2" * 32: "Trip"},
        {"mem_" + "3" * 32: "self", "mem_" + "4" * 32: "...", "mem_" + "5" * 32: "Trip (33333333)"},
        {"mem_" + "6" * 32: "字" * 100, "mem_" + "7" * 32: "a/b:c*d?e"},
    ],
)
def test_stems_agree_with_the_reference(titles):
    ref = reference()
    records = [{"id": rid, "title": title, "links": []} for rid, title in titles.items()]
    assert model.stems_for(records) == ref.stems_for(records)
    for name in model.stems_for(records).values():
        assert len((name + ".md").encode()) <= 255


def test_the_yaml_subset_reads_what_it_writes():
    value = {
        "id": "mem_" + "a" * 32,
        "empty": {},
        "list": [],
        "items": [{}, {"a": 1, "b": [True, None, 'x"y']}],
        "nested": {"deep": {"n": -1.5, "s": "a: b # c"}},
    }
    text = model.write_frontmatter(value)
    assert model.parse_frontmatter(text) == value
    ref = reference()
    assert ref.write_frontmatter(value) == text
    with pytest.raises(model.FrontmatterError, match="line 1"):
        model.parse_frontmatter("key: 'single quotes'")


def test_the_view_schema_construction_is_the_example_s():
    registry = TypeRegistry()
    shipped = json.loads(
        (
            EXAMPLES / "webair-0.6.0" / "schemas" / "host" / "travel.profile.view.schema.json"
        ).read_text()
    )
    assert canonical_json(record_view_schema(registry.get("travel.profile"))) == canonical_json(
        shipped
    )
    assert len(schema_sha256(shipped)) == 64


def test_the_key_file_is_private_and_stable(tmp_path):
    key = read_or_create_key(tmp_path)
    assert (tmp_path / "memory.key").stat().st_mode & 0o777 == 0o600
    assert read_or_create_key(tmp_path) == key
    (tmp_path / "memory.key").chmod(0o644)
    with pytest.raises(Exception, match="0600"):
        read_or_create_key(tmp_path)


def test_a_digest_moves_with_content_and_not_with_metadata(tmp_path):
    mem = MemoryFolder(_copy(EXAMPLES / "webair-0.6.0" / "memory", tmp_path / "m"))
    record = mem.record("mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60")
    before = mem.digest(record)
    assert mem.digest({**record, "updated": "2030-01-01T00:00:00Z", "demo": True}) == before
    assert mem.digest({**record, "title": "Other"}) != before
    other = MemoryFolder(_copy(EXAMPLES / "webair-0.6.0" / "memory", tmp_path / "n"))
    assert other.digest(record) != before  # another key, another host (M-12)
