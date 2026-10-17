"""Reading a WebAssembly core module without running it (compute.v0 §3, C-10…C-19).

Two things are decided here, and both runtimes decide them from the same bytes with no engine:
the **structural requirements** of a tier-1 module (no imports, no start function, one memory with
a declared maximum, the ABI exports with their exact signatures) and the **feature gate** (every
function body and constant expression is decoded, and only the deterministic instruction set the
specification lists is admitted). An engine validates types and control flow when it compiles the
module; this reader does not repeat that work, and it never executes anything.

The binary format is the WebAssembly core specification's: a header, then sections in a fixed
order, each a vector of entries with LEB128 integers. Anything outside that format, or inside a
proposal the gate refuses, is a `ModuleError` whose `code` the specification names
(`module_malformed`, `module_feature_refused`, `module_import`, ...).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

PAGE_BYTES = 65536
#: The format's own bound on a 32-bit memory, in pages (4 GiB).
MAX_PAGES = 65536
#: C-10: a module member is at most 4 MiB.
MAX_MODULE_BYTES = 4 * 1024 * 1024
#: C-19: the instruction set a tier-1 module may use. Everything else is refused by name.
ALLOWED_FEATURES = (
    "mvp",
    "sign-extension",
    "nontrapping-float-to-int",
    "bulk-memory",
    "multi-value",
    "reference-types",
    "mutable-globals",
)
#: Locals an engine would refuse anyway (wasmtime's own bound); refused here so a reader never
#: spends time on an absurd declaration.
MAX_LOCALS = 50_000

_HEADER = b"\x00asm\x01\x00\x00\x00"
_I32, _I64, _F32, _F64, _V128, _FUNCREF, _EXTERNREF = 0x7F, 0x7E, 0x7D, 0x7C, 0x7B, 0x70, 0x6F
_VALUE_TYPES = {_I32: "i32", _I64: "i64", _F32: "f32", _F64: "f64"}
_REF_TYPES = {_FUNCREF: "funcref", _EXTERNREF: "externref"}
_GC_TYPES = {0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x71, 0x72}
_GC_TYPES.add(0x73)
# The order sections must appear in (custom sections may appear anywhere; 13 is the tag section).
_SECTION_ORDER = {1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 13: 6, 6: 7, 7: 8, 8: 9, 9: 10, 12: 11, 10: 12}
_SECTION_ORDER[11] = 13
_EXPORT_KINDS = {0: "function", 1: "table", 2: "memory", 3: "global"}
_MEMARG_OPCODES = set(range(0x28, 0x3F))
_PLAIN_OPCODES = {0x00, 0x01, 0x05, 0x0F, 0x1A, 0x1B, 0xD1} | set(range(0x45, 0xC5))
_U32_OPCODES = {0x0C, 0x0D, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xD2}
_FEATURE_OPCODES = {
    **{op: "exception-handling" for op in (0x06, 0x07, 0x08, 0x09, 0x0A, 0x18, 0x19, 0x1F)},
    0x12: "tail-call",
    0x13: "tail-call",
    0x14: "function-references",
    0x15: "function-references",
    0xD3: "gc",
    0xD4: "function-references",
    0xD5: "function-references",
    0xD6: "function-references",
    0xFB: "gc",
    0xFD: "simd",
    0xFE: "threads",
}
_EXTENDED_CONST = {0x6A, 0x6B, 0x6C, 0x7C, 0x7D, 0x7E}


class ModuleError(ValueError):
    """A module that is not a tier-1 compute module; `code` is the specification's."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


@dataclass(frozen=True)
class FuncType:
    params: tuple[str, ...]
    results: tuple[str, ...]

    def __str__(self) -> str:
        return f"({', '.join(self.params)}) -> ({', '.join(self.results)})"


@dataclass(frozen=True)
class Import:
    module: str
    name: str
    kind: str


@dataclass(frozen=True)
class Export:
    name: str
    kind: str
    index: int


@dataclass(frozen=True)
class ModuleInfo:
    """What the reader saw: enough to decide the requirements and to describe the module."""

    size: int
    types: tuple[FuncType, ...]
    imports: tuple[Import, ...]
    functions: tuple[int, ...]
    tables: int
    memories: tuple[tuple[int, int | None], ...]
    globals: int
    exports: tuple[Export, ...]
    start: int | None
    element_segments: int
    data_segments: int
    custom_sections: tuple[str, ...]


@dataclass(frozen=True)
class ModuleFacts:
    """An accepted module, as validation records it and as the agent page may show it."""

    sha256: str
    size: int
    memory_min_pages: int
    memory_max_pages: int
    functions: tuple[str, ...]
    exports: tuple[str, ...]

    def as_json(self) -> dict:
        return {
            "sha256": self.sha256,
            "size": self.size,
            "memory_min_pages": self.memory_min_pages,
            "memory_max_pages": self.memory_max_pages,
            "functions": list(self.functions),
            "exports": list(self.exports),
        }


def _malformed(message: str) -> ModuleError:
    return ModuleError("module_malformed", message)


def _feature(name: str, where: str) -> ModuleError:
    return ModuleError(
        "module_feature_refused",
        f"{where} uses the {name} proposal, which tier-1 modules may not "
        f"(allowed: {', '.join(ALLOWED_FEATURES)})",
    )


class _Reader:
    def __init__(self, data: bytes, pos: int = 0, end: int | None = None):
        self.data = data
        self.pos = pos
        self.end = len(data) if end is None else end

    @property
    def remaining(self) -> int:
        return self.end - self.pos

    def byte(self) -> int:
        if self.pos >= self.end:
            raise _malformed("unexpected end of module")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def take(self, count: int) -> bytes:
        if count < 0 or self.pos + count > self.end:
            raise _malformed("unexpected end of module")
        value = self.data[self.pos : self.pos + count]
        self.pos += count
        return value

    def u32(self) -> int:
        result = shift = 0
        for _ in range(5):
            byte = self.byte()
            result |= (byte & 0x7F) << shift
            if not byte & 0x80:
                if result >= 1 << 32:
                    raise _malformed("integer too large")
                return result
            shift += 7
        raise _malformed("integer representation too long")

    def _signed(self, bits: int) -> int:
        """Signed LEB128 of at most `bits` bits: the sign bit of the last byte extends over
        everything above what was read, and the result must fit the width (so a last byte whose
        unused bits are not the sign's is refused as the specification requires)."""
        result = shift = 0
        limit = (bits + 6) // 7
        for _ in range(limit):
            byte = self.byte()
            result |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                if byte & 0x40:
                    result -= 1 << shift
                if not -(1 << (bits - 1)) <= result < 1 << (bits - 1):
                    raise _malformed("integer too large")
                return result
        raise _malformed("integer representation too long")

    def s32(self) -> int:
        return self._signed(32)

    def s33(self) -> int:
        return self._signed(33)

    def s64(self) -> int:
        return self._signed(64)

    def name(self) -> str:
        raw = self.take(self.u32())
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise _malformed("a name is not UTF-8") from exc

    def value_type(self, where: str) -> str:
        code = self.byte()
        if code in _VALUE_TYPES:
            return _VALUE_TYPES[code]
        if code in _REF_TYPES:
            return _REF_TYPES[code]
        if code == _V128:
            raise _feature("simd", where)
        if code in _GC_TYPES:
            raise _feature("gc", where)
        raise _malformed(f"{where}: unknown value type 0x{code:02x}")

    def ref_type(self, where: str) -> str:
        code = self.byte()
        if code in _REF_TYPES:
            return _REF_TYPES[code]
        if code in _GC_TYPES:
            raise _feature("gc", where)
        raise _malformed(f"{where}: unknown reference type 0x{code:02x}")

    def limits(self, where: str) -> tuple[int, int | None]:
        flag = self.byte()
        if flag in (0x00, 0x01):
            minimum = self.u32()
            maximum = self.u32() if flag == 0x01 else None
            if maximum is not None and maximum < minimum:
                raise _malformed(f"{where}: limits maximum below minimum")
            return minimum, maximum
        if flag in (0x02, 0x03):
            raise _feature("threads", where)
        if flag in (0x04, 0x05, 0x06, 0x07):
            raise _feature("memory64", where)
        if flag & 0x08:
            raise _feature("custom-page-sizes", where)
        raise _malformed(f"{where}: unknown limits flag 0x{flag:02x}")

    def block_type(self, types: int) -> None:
        first = self.data[self.pos] if self.pos < self.end else None
        if first is None:
            raise _malformed("unexpected end of module")
        if first < 0x80:
            self.pos += 1
            if first == 0x40 or first in _VALUE_TYPES or first in _REF_TYPES:
                return
            if first < 0x40:
                if first >= types:
                    raise _malformed("block type names an undefined type")
                return
            if first == _V128:
                raise _feature("simd", "a block type")
            if first in _GC_TYPES:
                raise _feature("gc", "a block type")
            raise _malformed(f"unknown block type 0x{first:02x}")
        index = self.s33()
        if index < 0 or index >= types:
            raise _malformed("block type names an undefined type")

    def const_expr(self, where: str) -> None:
        """A constant expression: the constants and references the core format allows."""
        while True:
            op = self.byte()
            if op == 0x0B:
                return
            if op == 0x41:
                self.s32()
            elif op == 0x42:
                self.s64()
            elif op == 0x43:
                self.take(4)
            elif op == 0x44:
                self.take(8)
            elif op in (0x23, 0xD2):
                self.u32()
            elif op == 0xD0:
                self.ref_type(where)
            elif op in _EXTENDED_CONST:
                raise _feature("extended-const", where)
            elif op in _FEATURE_OPCODES:
                raise _feature(_FEATURE_OPCODES[op], where)
            else:
                raise _malformed(f"{where}: opcode 0x{op:02x} is not constant")

    def instructions(self, types: int, where: str) -> None:
        """Decode one function body: immediates skipped, structure tracked, features gated."""
        depth = 0
        while self.pos < self.end:
            op = self.byte()
            if op in _PLAIN_OPCODES:
                continue
            if op in (0x02, 0x03, 0x04):
                self.block_type(types)
                depth += 1
            elif op == 0x0B:
                if depth == 0:
                    return
                depth -= 1
            elif op in _U32_OPCODES:
                self.u32()
            elif op == 0x0E:
                for _ in range(self.u32()):
                    self.u32()
                self.u32()
            elif op == 0x11:
                self.u32()
                self.u32()
            elif op == 0x1C:
                for _ in range(self.u32()):
                    self.value_type(where)
            elif op in _MEMARG_OPCODES:
                align = self.u32()
                if align & 0x40:
                    raise _feature("multi-memory", where)
                self.u32()
            elif op in (0x3F, 0x40):
                if self.byte() != 0x00:
                    raise _feature("multi-memory", where)
            elif op == 0x41:
                self.s32()
            elif op == 0x42:
                self.s64()
            elif op == 0x43:
                self.take(4)
            elif op == 0x44:
                self.take(8)
            elif op == 0xD0:
                self.ref_type(where)
            elif op == 0xFC:
                self._prefixed_fc(where)
            elif op in _FEATURE_OPCODES:
                raise _feature(_FEATURE_OPCODES[op], where)
            else:
                raise _malformed(f"{where}: unknown opcode 0x{op:02x}")
        raise _malformed(f"{where}: function body is not terminated")

    def _prefixed_fc(self, where: str) -> None:
        sub = self.u32()
        if sub <= 7:
            return  # saturating float-to-int conversions
        if sub == 8:
            self.u32()
            if self.byte() != 0x00:
                raise _feature("multi-memory", where)
        elif sub in (9, 13):
            self.u32()
        elif sub == 10:
            if self.byte() != 0x00 or self.byte() != 0x00:
                raise _feature("multi-memory", where)
        elif sub == 11:
            if self.byte() != 0x00:
                raise _feature("multi-memory", where)
        elif sub in (12, 14):
            self.u32()
            self.u32()
        elif sub in (15, 16, 17):
            self.u32()
        elif sub == 18:
            raise _feature("memory-control", where)
        else:
            raise _malformed(f"{where}: unknown 0xfc sub-opcode {sub}")


def read_module(data: bytes) -> ModuleInfo:
    """Read every section of a core module; raise `ModuleError` for anything outside tier 1's
    format or feature set. Nothing is executed and no engine is involved."""
    if not isinstance(data, (bytes, bytearray)):
        raise _malformed("module bytes expected")
    data = bytes(data)
    if len(data) < len(_HEADER) or data[: len(_HEADER)] != _HEADER:
        raise _malformed("not a WebAssembly core module (magic number and version 1)")
    reader = _Reader(data, len(_HEADER))
    types: list[FuncType] = []
    imports: list[Import] = []
    functions: list[int] = []
    tables = 0
    memories: list[tuple[int, int | None]] = []
    globals_count = 0
    exports: list[Export] = []
    start = None
    elements = 0
    data_count = None
    data_segments = 0
    code_entries = None
    custom: list[str] = []
    last_order = 0
    while reader.pos < reader.end:
        section_id = reader.byte()
        size = reader.u32()
        if reader.pos + size > reader.end:
            raise _malformed(f"section {section_id} exceeds the module")
        section = _Reader(data, reader.pos, reader.pos + size)
        reader.pos += size
        if section_id == 0:
            custom.append(section.name())
            continue
        if section_id == 13:
            raise _feature("exception-handling", "the tag section")
        order = _SECTION_ORDER.get(section_id)
        if order is None:
            raise _malformed(f"unknown section id {section_id}")
        if order <= last_order:
            raise _malformed(f"section {section_id} is out of order or repeated")
        last_order = order
        if section_id == 1:
            for index in range(section.u32()):
                form = section.byte()
                if form != 0x60:
                    if form in (0x4E, 0x4F, 0x50, 0x5E, 0x5F):
                        raise _feature("gc", f"type {index}")
                    raise _malformed(f"type {index}: unknown form 0x{form:02x}")
                params = tuple(section.value_type(f"type {index}") for _ in range(section.u32()))
                results = tuple(section.value_type(f"type {index}") for _ in range(section.u32()))
                types.append(FuncType(params, results))
        elif section_id == 2:
            for index in range(section.u32()):
                module, name = section.name(), section.name()
                kind = section.byte()
                where = f"import {index}"
                if kind == 0:
                    section.u32()
                    imports.append(Import(module, name, "function"))
                elif kind == 1:
                    section.ref_type(where)
                    section.limits(where)
                    imports.append(Import(module, name, "table"))
                elif kind == 2:
                    section.limits(where)
                    imports.append(Import(module, name, "memory"))
                elif kind == 3:
                    section.value_type(where)
                    section.byte()
                    imports.append(Import(module, name, "global"))
                elif kind == 4:
                    raise _feature("exception-handling", where)
                else:
                    raise _malformed(f"{where}: unknown import kind {kind}")
        elif section_id == 3:
            for index in range(section.u32()):
                type_index = section.u32()
                if type_index >= len(types):
                    raise _malformed(f"function {index} names an undefined type")
                functions.append(type_index)
        elif section_id == 4:
            for index in range(section.u32()):
                where = f"table {index}"
                if section.data[section.pos] == 0x40:
                    raise _feature("function-references", where)
                section.ref_type(where)
                section.limits(where)
                tables += 1
        elif section_id == 5:
            for index in range(section.u32()):
                minimum, maximum = section.limits(f"memory {index}")
                if minimum > MAX_PAGES or (maximum is not None and maximum > MAX_PAGES):
                    raise _malformed(f"memory {index} exceeds {MAX_PAGES} pages")
                memories.append((minimum, maximum))
        elif section_id == 6:
            for index in range(section.u32()):
                where = f"global {index}"
                section.value_type(where)
                if section.byte() not in (0, 1):
                    raise _malformed(f"{where}: unknown mutability")
                section.const_expr(where)
                globals_count += 1
        elif section_id == 7:
            seen = set()
            for index in range(section.u32()):
                name = section.name()
                kind = section.byte()
                if kind == 4:
                    raise _feature("exception-handling", f"export {name!r}")
                if kind not in _EXPORT_KINDS:
                    raise _malformed(f"export {name!r}: unknown kind {kind}")
                if name in seen:
                    raise _malformed(f"export {name!r} is declared twice")
                seen.add(name)
                exports.append(Export(name, _EXPORT_KINDS[kind], section.u32()))
        elif section_id == 8:
            start = section.u32()
        elif section_id == 9:
            for index in range(section.u32()):
                where = f"element segment {index}"
                flags = section.u32()
                if flags > 7:
                    raise _malformed(f"{where}: unknown flags {flags}")
                if flags in (2, 6):
                    section.u32()
                if flags in (0, 2, 4, 6):
                    section.const_expr(where)
                if flags in (1, 2, 3):
                    if section.byte() != 0x00:
                        raise _malformed(f"{where}: unknown element kind")
                if flags in (5, 6, 7):
                    section.ref_type(where)
                count = section.u32()
                for _ in range(count):
                    if flags < 4:
                        section.u32()
                    else:
                        section.const_expr(where)
                elements += 1
        elif section_id == 12:
            data_count = section.u32()
        elif section_id == 10:
            code_entries = section.u32()
            if code_entries != len(functions):
                raise _malformed("code and function sections disagree")
            for index in range(code_entries):
                where = f"function {index}"
                size = section.u32()
                body = _Reader(data, section.pos, section.pos + size)
                if body.end > section.end:
                    raise _malformed(f"{where}: body exceeds the code section")
                section.pos = body.end
                locals_count = 0
                for _ in range(body.u32()):
                    locals_count += body.u32()
                    body.value_type(where)
                    if locals_count > MAX_LOCALS:
                        raise _malformed(f"{where}: more than {MAX_LOCALS} locals")
                body.instructions(len(types), where)
                if body.pos != body.end:
                    raise _malformed(f"{where}: bytes after the function body")
        elif section_id == 11:
            for index in range(section.u32()):
                where = f"data segment {index}"
                flags = section.u32()
                if flags == 2:
                    if section.u32() != 0:
                        raise _feature("multi-memory", where)
                if flags in (0, 2):
                    section.const_expr(where)
                elif flags != 1:
                    raise _malformed(f"{where}: unknown flags {flags}")
                section.take(section.u32())
                data_segments += 1
        if section.pos != section.end:
            raise _malformed(f"section {section_id} has trailing bytes")
    if functions and code_entries is None:
        raise _malformed("function section without a code section")
    if data_count is not None and data_count != data_segments:
        raise _malformed("data count and data sections disagree")
    return ModuleInfo(
        size=len(data),
        types=tuple(types),
        imports=tuple(imports),
        functions=tuple(functions),
        tables=tables,
        memories=tuple(memories),
        globals=globals_count,
        exports=tuple(exports),
        start=start,
        element_segments=elements,
        data_segments=data_segments,
        custom_sections=tuple(custom),
    )


_ALLOC = FuncType(("i32",), ("i32",))
_RUN = FuncType(("i32", "i32"), ("i64",))


def check_module(data: bytes, *, functions=("run",)) -> ModuleFacts:
    """The tier-1 requirements over one module's bytes (C-11…C-18): a core module at most 4 MiB,
    no imports, one memory with a declared maximum exported as `memory`, `alloc: (i32) -> (i32)`,
    and each named function `(i32, i32) -> (i64)`. Other exports are allowed and never called; a
    start function is allowed and runs at instantiation, inside the call's limits (toolchains
    emit one to initialize their runtime). Returns the facts validation records."""
    if not isinstance(data, (bytes, bytearray)):
        raise _malformed("module bytes expected")
    if len(data) > MAX_MODULE_BYTES:
        raise ModuleError(
            "module_too_large", f"{len(data)} bytes; a module is at most {MAX_MODULE_BYTES}"
        )
    info = read_module(data)
    if info.imports:
        first = info.imports[0]
        raise ModuleError(
            "module_import",
            f"the module imports {first.module}.{first.name} ({first.kind}); tier-1 modules "
            "import nothing",
        )
    if len(info.memories) != 1:
        raise ModuleError(
            "module_memory_count",
            f"the module defines {len(info.memories)} memories; exactly one is required",
        )
    minimum, maximum = info.memories[0]
    if maximum is None:
        raise ModuleError(
            "module_memory_undeclared_maximum",
            "the module's memory declares no maximum; the maximum is its memory bound",
        )
    exports = {export.name: export for export in info.exports}

    def required(name: str, kind: str) -> Export:
        export = exports.get(name)
        if export is None:
            raise ModuleError("module_export_missing", f"the module does not export {name!r}")
        if export.kind != kind:
            raise ModuleError(
                "module_export_kind", f"export {name!r} is a {export.kind}, not a {kind}"
            )
        return export

    def signature(name: str, expected: FuncType) -> None:
        export = required(name, "function")
        if export.index >= len(info.functions):
            raise _malformed(f"export {name!r} names an undefined function")
        actual = info.types[info.functions[export.index]]
        if actual != expected:
            raise ModuleError(
                "module_export_signature",
                f"export {name!r} has the signature {actual}; {expected} is required",
            )

    memory = required("memory", "memory")
    if memory.index != 0:
        raise _malformed("export 'memory' names an undefined memory")
    signature("alloc", _ALLOC)
    names = tuple(dict.fromkeys(functions))
    if not names:
        raise ModuleError("module_export_missing", "no function of the module is named by a node")
    for name in names:
        if name == "alloc":
            raise ModuleError(
                "module_export_signature", "'alloc' is the allocator, not a function a node calls"
            )
        signature(name, _RUN)
    return ModuleFacts(
        sha256=hashlib.sha256(data).hexdigest(),
        size=len(data),
        memory_min_pages=minimum,
        memory_max_pages=maximum,
        functions=names,
        exports=tuple(export.name for export in info.exports),
    )


__all__ = [
    "ALLOWED_FEATURES",
    "MAX_LOCALS",
    "MAX_MODULE_BYTES",
    "MAX_PAGES",
    "PAGE_BYTES",
    "Export",
    "FuncType",
    "Import",
    "ModuleError",
    "ModuleFacts",
    "ModuleInfo",
    "check_module",
    "read_module",
]
