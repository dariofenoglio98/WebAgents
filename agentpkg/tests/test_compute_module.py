"""compute.v0: reading a module without running it (the structural requirements and the feature
gate), over the hand-assembled case modules and byte surgery on the smallest conforming one."""

import hashlib
import json
from pathlib import Path

import pytest
from compute_probe import CASES, MODULES, builder, case_module

from agentpkg.compute.module import (
    ALLOWED_FEATURES,
    MAX_MODULE_BYTES,
    ModuleError,
    check_module,
    read_module,
)

CASE_LIST = json.loads((CASES / "cases.json").read_text())
VALIDATION_BY_MODULE = {
    c["module"]: c
    for c in CASE_LIST["cases"]
    if c["stage"] == "validation" and c["module"] and "variant" not in c and "node_limits" not in c
}


def test_the_generator_reproduces_every_committed_module():
    generated = builder().cases()
    committed = {path.stem: path.read_bytes() for path in MODULES.glob("*.wasm")}
    assert set(generated) == set(committed)
    for stem, data in generated.items():
        assert committed[stem] == data, stem
        assert CASE_LIST["modules"][stem] == hashlib.sha256(data).hexdigest(), stem
    assert set(CASE_LIST["modules"]) == set(generated)


@pytest.mark.parametrize("stem", sorted(json.loads((CASES / "cases.json").read_text())["modules"]))
def test_each_case_module_is_accepted_or_refused_as_listed(stem):
    data = case_module(stem)
    expected = VALIDATION_BY_MODULE.get(stem)
    if expected is None:
        facts = check_module(data, functions=("run",))
        assert facts.sha256 == hashlib.sha256(data).hexdigest()
        assert facts.functions == ("run",)
        assert {"memory", "alloc", "run"} <= set(facts.exports)
        assert facts.memory_max_pages >= facts.memory_min_pages >= 1
        return
    with pytest.raises(ModuleError) as caught:
        check_module(data, functions=("run",))
    assert caught.value.code == expected["code"]
    if "feature" in expected:
        assert f"uses the {expected['feature']} proposal" in str(caught.value)
        assert ", ".join(ALLOWED_FEATURES) in str(caught.value)


def test_the_reader_describes_a_module_without_an_engine():
    info = read_module(case_module("with-start"))
    assert info.start == 2
    assert info.imports == ()
    assert info.memories == ((1, 16),)
    assert [e.name for e in info.exports] == ["memory", "alloc", "run"]
    assert [str(t) for t in info.types] == [
        "(i32) -> (i32)",
        "(i32, i32) -> (i64)",
        "() -> ()",
    ]
    facts = check_module(case_module("with-start"), functions=("run",))
    assert facts.as_json() == {
        "sha256": facts.sha256,
        "size": len(case_module("with-start")),
        "memory_min_pages": 1,
        "memory_max_pages": 16,
        "functions": ["run"],
        "exports": ["memory", "alloc", "run"],
    }


def test_the_functions_a_graph_names_must_exist_with_the_abi_signature():
    data = case_module("echo")
    with pytest.raises(ModuleError, match="module_export_missing: the module does not export 'go'"):
        check_module(data, functions=("go",))
    with pytest.raises(ModuleError, match="module_export_missing: no function"):
        check_module(data, functions=())
    with pytest.raises(ModuleError, match="module_export_signature: 'alloc' is the allocator"):
        check_module(data, functions=("alloc",))
    with pytest.raises(ModuleError, match="module_export_kind: export 'memory' is a memory"):
        check_module(data, functions=("memory",))


@pytest.mark.parametrize(
    "surgery,match",
    [
        (lambda d: d[:4] + b"\x02\x00\x00\x00" + d[8:], "magic number and version 1"),
        (lambda d: b"\x00asn" + d[4:], "magic number and version 1"),
        (lambda d: d[:-1], "unexpected end|exceeds the module|not terminated"),
        (lambda d: d + b"\x0b", "unexpected end|unknown section"),
        (lambda d: d + b"\x63\x00", "unknown section id 99"),
        (lambda d: d + b"\x01\x00", "out of order or repeated"),
        (lambda d: b"", "magic number"),
    ],
)
def test_malformed_bytes_are_refused_as_malformed(surgery, match):
    with pytest.raises(ModuleError, match=f"^module_malformed: .*(?:{match})") as caught:
        read_module(surgery(case_module("echo")))
    assert caught.value.code == "module_malformed"


def test_a_module_over_the_size_cap_is_refused_by_size_first():
    data = builder().oversized()
    assert len(data) > MAX_MODULE_BYTES
    with pytest.raises(ModuleError) as caught:
        check_module(data)
    assert caught.value.code == "module_too_large"
    # The reader itself has no size opinion: the same bytes read fine.
    assert read_module(data).custom_sections == ("padding",)


def test_the_feature_gate_decodes_block_types_and_constant_expressions():
    b = builder()
    base = dict(types=b.ABI_TYPES, exports=b.ABI_EXPORTS)
    # A multi-value block type (a type index as an s33) is decoded and accepted.
    multi = b.module(funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\x02\x01\x0b" + b.ECHO)], **base)
    assert check_module(multi).functions == ("run",)
    # A v128 block type is SIMD.
    simd = b.module(funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\x02\x7b\x0b" + b.ECHO)], **base)
    with pytest.raises(ModuleError, match="simd proposal"):
        check_module(simd)
    # A GC reference block type.
    gc = b.module(funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\x02\x6e\x0b" + b.ECHO)], **base)
    with pytest.raises(ModuleError, match="gc proposal"):
        check_module(gc)
    # An exception-handling opcode.
    eh = b.module(funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\x06\x40\x0b" + b.ECHO)], **base)
    with pytest.raises(ModuleError, match="exception-handling proposal"):
        check_module(eh)
    # A reference-types `select t*` and `ref.null` are admitted; `ref.eq` (GC) is not.
    refs = b.module(
        funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\xd0\x70\x1a\x1c\x01\x7f" + b.ECHO)], **base
    )
    assert check_module(refs).functions == ("run",)
    ref_eq = b.module(funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\xd3" + b.ECHO)], **base)
    with pytest.raises(ModuleError, match="gc proposal"):
        check_module(ref_eq)
    # An unknown opcode is malformed, not a feature.
    unknown = b.module(funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\x27" + b.ECHO)], **base)
    with pytest.raises(ModuleError, match="module_malformed: function 1: unknown opcode 0x27"):
        check_module(unknown)


def test_memory64_and_multi_memory_are_refused_by_name():
    b = builder()
    base = dict(types=b.ABI_TYPES, exports=b.ABI_EXPORTS)
    memory64 = b.module(
        funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b.ECHO)], memory_flags=[0x05], **base
    )
    with pytest.raises(ModuleError, match="memory64 proposal"):
        check_module(memory64)
    # memory.size with a nonzero memory index.
    multi = b.module(funcs=[(0, [], b.ALLOC_AT_1024), (1, [], b"\x3f\x01\x1a" + b.ECHO)], **base)
    with pytest.raises(ModuleError, match="multi-memory proposal"):
        check_module(multi)


def test_the_example_modules_pass_the_reader():
    """Every module under examples/compute built by a real toolchain is a tier-1 module."""
    functions = {"fares": ("run",), "bookkeeping": ("assign_ids", "match_quotes")}
    built = sorted(Path(CASES.parent).glob("*/dist/*.wasm"))
    assert {path.stem for path in built} == set(functions)
    for path in built:
        facts = check_module(path.read_bytes(), functions=functions[path.stem])
        assert facts.memory_max_pages >= 1, path
        assert facts.functions == functions[path.stem]


def test_a_truncated_table_section_is_malformed_not_a_crash():
    """The reader's every look at a byte is bounded: a table entry cut before its first byte."""
    for data in (b"\x00asm\x01\x00\x00\x00\x04\x01\x01", b"\x00asm\x01\x00\x00\x00\x04\x00"):
        with pytest.raises(ModuleError) as caught:
            read_module(data)
        assert caught.value.code == "module_malformed"


def _read_or_refuse(data: bytes) -> None:
    try:
        check_module(data, functions=("run",))
    except ModuleError:
        pass


def test_damaged_modules_are_read_or_refused_never_crash():
    """Any byte string either reads or is refused with a code: every prefix and many one-byte
    changes of the case modules, and a fixed sample of both over the toolchain-built modules."""
    import random

    for stem in sorted(CASE_LIST["modules"]):
        data = case_module(stem)
        for cut in range(len(data)):
            _read_or_refuse(data[:cut])
        for at in range(8, len(data)):
            for value in (0x00, 0x01, 0x40, 0x7F, 0x80, 0xFF, data[at] ^ 0x01):
                _read_or_refuse(data[:at] + bytes([value]) + data[at + 1 :])
    rng = random.Random(21)
    for path, samples in (
        (CASES.parent / "fares-as" / "dist" / "fares.wasm", 300),
        (CASES.parent / "bookkeeping-rs" / "dist" / "bookkeeping.wasm", 40),
    ):
        data = path.read_bytes()
        for _ in range(samples):
            _read_or_refuse(data[: rng.randrange(len(data))])
            at = rng.randrange(8, len(data))
            _read_or_refuse(data[:at] + bytes([rng.randrange(256)]) + data[at + 1 :])
