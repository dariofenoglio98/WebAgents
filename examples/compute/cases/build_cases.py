"""Hand-assembled WebAssembly modules for compute.v0's enforcement cases and tests.

Standard library only, no toolchain: each module is a few bytes written against the core binary
format, so a reader can check every byte, and a runtime can be shown refusing exactly one thing
per module. `python3 build_cases.py` rewrites `modules/*.wasm` and prints their SHA-256; the test
suite regenerates them and asserts the committed bytes are these (the generator is the
reproducibility statement for these binaries).

ABI (compute.v0 §3): `memory` exported, `alloc: (i32) -> (i32)`, `run: (i32, i32) -> (i64)`
returning `out_ptr << 32 | out_len`.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULES = HERE / "modules"

I32, I64 = 0x7F, 0x7E
FUNC, MEMORY = 0x00, 0x02


def u32(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def s_leb(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        done = (value == 0 and not byte & 0x40) or (value == -1 and byte & 0x40)
        out.append(byte if done else byte | 0x80)
        if done:
            return bytes(out)


def vec(items) -> bytes:
    return u32(len(items)) + b"".join(items)


def section(section_id: int, payload: bytes) -> bytes:
    return bytes([section_id]) + u32(len(payload)) + payload


def name(text: str) -> bytes:
    raw = text.encode("utf-8")
    return u32(len(raw)) + raw


def functype(params, results) -> bytes:
    return b"\x60" + vec([bytes([p]) for p in params]) + vec([bytes([r]) for r in results])


def limits(minimum: int, maximum: int | None, flag: int | None = None) -> bytes:
    if flag is None:
        flag = 0x00 if maximum is None else 0x01
    return bytes([flag]) + u32(minimum) + (u32(maximum) if maximum is not None else b"")


def i32_const(value: int) -> bytes:
    return b"\x41" + s_leb(value)


def i64_const(value: int) -> bytes:
    return b"\x42" + s_leb(value)


def packed(ptr: int, length: int) -> int:
    """The i64 a function returns: `out_ptr << 32 | out_len`, as a signed 64-bit integer."""
    value = (ptr << 32) | length
    return value - (1 << 64) if value >= 1 << 63 else value


def body(locals_: list[tuple[int, int]], code: bytes) -> bytes:
    inner = vec([u32(count) + bytes([kind]) for count, kind in locals_]) + code + b"\x0b"
    return u32(len(inner)) + inner


def module(
    *,
    types,
    funcs,
    exports,
    memories=((1, 16),),
    memory_flags=None,
    imports=(),
    start=None,
    data=(),
    custom=(),
) -> bytes:
    """Assemble one module. `funcs` are (type index, locals, code) in index order after the
    imports; `exports` are (name, kind, index); `data` are (offset, bytes) active segments."""
    out = bytearray(b"\x00asm\x01\x00\x00\x00")
    out += section(1, vec([functype(p, r) for p, r in types]))
    if imports:
        out += section(
            2,
            vec([name(m) + name(n) + bytes([FUNC]) + u32(t) for m, n, t in imports]),
        )
    out += section(3, vec([u32(t) for t, _, _ in funcs]))
    if memories:
        out += section(
            5,
            vec(
                [
                    limits(lo, hi, None if memory_flags is None else memory_flags[i])
                    for i, (lo, hi) in enumerate(memories)
                ]
            ),
        )
    out += section(7, vec([name(n) + bytes([k]) + u32(i) for n, k, i in exports]))
    if start is not None:
        out += section(8, u32(start))
    out += section(10, vec([body(locals_, code) for _, locals_, code in funcs]))
    if data:
        out += section(
            11, vec([b"\x00" + i32_const(offset) + b"\x0b" + vec_bytes(raw) for offset, raw in data])
        )
    for custom_name, raw in custom:
        out += section(0, name(custom_name) + raw)
    return bytes(out)


def vec_bytes(raw: bytes) -> bytes:
    return u32(len(raw)) + raw


ALLOC_T, RUN_T, VOID_T, BAD_RUN_T = ([I32], [I32]), ([I32, I32], [I64]), ([], []), ([I32], [I32])
ABI_TYPES = [ALLOC_T, RUN_T]
#: `alloc` answers a fixed offset: the inputs these modules see are small.
ALLOC_AT_1024 = i32_const(1024)
ECHO = (
    b"\x20\x00"  # local.get 0 (ptr)
    b"\xad"  # i64.extend_i32_u
    b"\x42\x20\x86"  # i64.const 32; i64.shl
    b"\x20\x01\xad\x84"  # local.get 1; i64.extend_i32_u; i64.or
)
ABI_EXPORTS = [("memory", MEMORY, 0), ("alloc", FUNC, 0), ("run", FUNC, 1)]


def returns(ptr: int, length: int) -> bytes:
    return i64_const(packed(ptr, length))


def with_output(raw: bytes, offset: int = 2048):
    """A `run` that answers the fixed bytes `raw` placed at `offset`."""
    return returns(offset, len(raw)), [(offset, raw)]


LOOP = b"\x03\x40\x0c\x00\x0b" + i64_const(0)
GROW_UNTIL_REFUSED = (
    b"\x03\x40"  # loop
    + i32_const(1)
    + b"\x40\x00"  # memory.grow 0
    + i32_const(-1)
    + b"\x46"  # i32.eq
    + b"\x04\x40\x00\x0b"  # if unreachable end
    + b"\x0c\x00\x0b"  # br 0; end
    + i64_const(0)
)
SCHEMA_MISS, SCHEMA_MISS_DATA = with_output(json.dumps({"total": "x"}).encode())
BAD_JSON, BAD_JSON_DATA = with_output(b"{")
BAD_UTF8, BAD_UTF8_DATA = with_output(b'"\xff"')


def cases() -> dict[str, bytes]:
    abi = dict(types=ABI_TYPES, exports=ABI_EXPORTS)

    def run(code: bytes, **extra) -> bytes:
        options = {**abi, **extra}
        return module(funcs=[(0, [], ALLOC_AT_1024), (1, [], code)], **options)

    return {
        # Accepted: the smallest conforming module. Its output is its input.
        "echo": run(ECHO),
        # Accepted at validation, refused at run time.
        "loop-forever": run(LOOP),
        "grow-until-refused": run(GROW_UNTIL_REFUSED, memories=((1, 64),)),
        "trap-unreachable": run(b"\x00"),
        "stack-overflow": run(b"\x20\x00\x20\x01\x10\x01"),
        "bad-json-output": run(BAD_JSON, data=BAD_JSON_DATA),
        "bad-utf8-output": run(BAD_UTF8, data=BAD_UTF8_DATA),
        "schema-miss-output": run(SCHEMA_MISS, data=SCHEMA_MISS_DATA),
        "zero-length-output": run(returns(1024, 0)),
        "out-of-range-output": run(returns(0xFFFFFF00, 100)),
        "alloc-returns-zero": module(
            funcs=[(0, [], i32_const(0)), (1, [], ECHO)], **abi
        ),
        "alloc-out-of-range": module(
            funcs=[(0, [], i32_const(0x7FFFFFFF)), (1, [], ECHO)], **abi
        ),
        "memory-over-host-cap": run(ECHO, memories=((1, 2048),)),
        # Refused at validation: the structural requirements.
        "with-import": module(
            types=ABI_TYPES + [VOID_T],
            imports=[("env", "abort", 2)],
            funcs=[(0, [], ALLOC_AT_1024), (1, [], ECHO)],
            exports=[("memory", MEMORY, 0), ("alloc", FUNC, 1), ("run", FUNC, 2)],
        ),
        "no-memory-maximum": run(ECHO, memories=((1, None),)),
        "two-memories": run(ECHO, memories=((1, 16), (1, 16))),
        "memory-not-exported": run(ECHO, exports=[("alloc", FUNC, 0), ("run", FUNC, 1)]),
        "missing-alloc": run(ECHO, exports=[("memory", MEMORY, 0), ("run", FUNC, 1)]),
        "bad-run-signature": module(
            types=[ALLOC_T, BAD_RUN_T],
            funcs=[(0, [], ALLOC_AT_1024), (1, [], b"\x20\x00")],
            exports=ABI_EXPORTS,
        ),
        # Refused at validation: the feature gate.
        "shared-memory": run(ECHO, memory_flags=[0x03]),
        "simd-opcode": run(b"\xfd\x0c" + bytes(16) + b"\x1a" + i64_const(0)),
        "tail-call": run(b"\x20\x00\x20\x01\x12\x01"),
        "threads-opcode": run(b"\xfe\x03\x00" + i64_const(0)),
        # Accepted: a start function initializes the module's own state (as AssemblyScript's does).
        "with-start": module(
            types=ABI_TYPES + [VOID_T],
            funcs=[(0, [], ALLOC_AT_1024), (1, [], ECHO), (2, [], b"\x01")],
            exports=ABI_EXPORTS,
            start=2,
        ),
    }


def oversized() -> bytes:
    """One byte over the 4 MiB module cap, in a custom section; built on demand, never committed."""
    filler = bytes(4 * 1024 * 1024)
    return module(
        funcs=[(0, [], ALLOC_AT_1024), (1, [], ECHO)],
        types=ABI_TYPES,
        exports=ABI_EXPORTS,
        custom=[("padding", filler)],
    )


def main(argv) -> int:
    MODULES.mkdir(parents=True, exist_ok=True)
    report = {}
    for stem, data in cases().items():
        path = MODULES / f"{stem}.wasm"
        if "--check" in argv:
            if not path.exists() or path.read_bytes() != data:
                print(f"{path} differs from the generator", file=sys.stderr)
                return 1
        else:
            path.write_bytes(data)
        report[stem] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
