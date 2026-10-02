"""Package variants, derived from the exact shipped artifacts.

Three kinds of derivation, each built from production primitives
(`agentpkg.package.archive_bytes`, `integrity_statement`, `canonical_json`,
`agentpkg.signing.DOMAIN`, `fingerprint`) so that a variant differs from a
legitimate artifact only in the property a case is about:

* **re-signed**: a payload (possibly edited) rebuilt and signed by an experiment
  key, exactly as `agentpkg sign` would sign it (`signature_for` mirrors
  `agentpkg.signing.sign_package`; a test checks byte equality);
* **tampered**: a payload edited after signing, with the integrity statement
  and signature either left as they were or updated in a stated way;
* **structural**: a raw ZIP written member by member (`zip_bytes`), for the
  container policy itself — prefixes, comments, extra fields, compression,
  modes, duplicate or unsafe names.

No private key is ever written to disk.
"""

from __future__ import annotations

import base64
import io
import json
import stat
import struct
import zipfile
import zlib
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

INTEGRITY = "integrity.json"
SIGNATURE = "signatures/publisher.json"


def read_members(archive: bytes) -> dict[str, bytes]:
    """Every member of a canonical archive, envelope included, as stored."""
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        return {info.filename: handle.read(info) for info in handle.infolist()}


def payload_of(archive: bytes) -> dict[str, bytes]:
    members = read_members(archive)
    return {name: data for name, data in members.items() if name not in (INTEGRITY, SIGNATURE)}


def canonical(name: str, data: bytes) -> bytes:
    """How `agentpkg build` normalizes a member: JCS for JSON, exact bytes otherwise."""
    from agentpkg.package import canonical_json
    from agentpkg.validation import parse_json

    if name.endswith(".json") or name == "MANIFEST.agent":
        return canonical_json(parse_json(data, name))
    return data


def signature_for(files: dict[str, bytes], key: Ed25519PrivateKey) -> dict:
    """`agentpkg.signing.sign_package`'s envelope for these payload files."""
    from agentpkg.package import canonical_json, integrity_statement, sha256
    from agentpkg.signing import DOMAIN, fingerprint

    statement = integrity_statement(files)
    public = key.public_key()
    return {
        "format": "agent.pkg-signature-v0.1",
        "algorithm": "Ed25519",
        "key_fingerprint": fingerprint(public),
        "public_key": base64.b64encode(
            public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        ).decode("ascii"),
        "signature": base64.b64encode(key.sign(DOMAIN + canonical_json(statement))).decode("ascii"),
        "digest": sha256(canonical_json(statement)),
    }


def build(
    files: dict[str, bytes], key: Ed25519PrivateKey | None = None, *, normalize=True
) -> bytes:
    """A legitimate artifact for these payload files: built, then (optionally) signed."""
    from agentpkg.package import archive_bytes

    payload = {name: canonical(name, data) if normalize else data for name, data in files.items()}
    return archive_bytes(payload, signature_for(payload, key) if key is not None else None)


def resign(archive: bytes, key: Ed25519PrivateKey) -> bytes:
    return build(payload_of(archive), key, normalize=False)


def fingerprint_of(key: Ed25519PrivateKey) -> str:
    from agentpkg.signing import fingerprint

    return fingerprint(key.public_key())


def public_pem(key: Ed25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def write_members(members: dict[str, bytes], order: list[str] | None = None) -> bytes:
    """Members written with exactly the ZipInfo conventions `archive_bytes` uses."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as handle:
        for name in order or sorted(members):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_STORED
            handle.writestr(info, members[name])
    return buffer.getvalue()


def tamper(
    archive: bytes,
    edits: dict[str, bytes | None],
    *,
    integrity: str = "keep",
    signature: str = "keep",
) -> bytes:
    """Edit payload members of a signed artifact after signing.

    `edits` maps a member name to new bytes, or to None to delete it.
    `integrity`: "keep" leaves integrity.json as signed; "update" recomputes it
    over the edited payload (what an attacker who cannot sign can still do).
    `signature`: "keep" leaves the envelope; "update_digest" rewrites only its
    `digest` field to the new statement's digest (the Ed25519 bytes stay).
    """
    from agentpkg.package import canonical_json, integrity_statement, sha256

    members = read_members(archive)
    for name, data in edits.items():
        if data is None:
            members.pop(name, None)
        else:
            members[name] = data
    payload = {n: d for n, d in members.items() if n not in (INTEGRITY, SIGNATURE)}
    if integrity == "update":
        members[INTEGRITY] = canonical_json(integrity_statement(payload))
    if signature == "update_digest" and SIGNATURE in members:
        envelope = json.loads(members[SIGNATURE])
        envelope["digest"] = sha256(canonical_json(json.loads(members[INTEGRITY])))
        members[SIGNATURE] = canonical_json(envelope)
    elif signature == "remove":
        members.pop(SIGNATURE, None)
    return write_members(members)


# -- raw ZIP construction for the container policy ------------------------------------
@dataclass
class Member:
    name: str
    data: bytes
    method: int = 0  # 0 stored, 8 deflated
    mode: int = stat.S_IFREG | 0o644
    flags: int = 0
    extra: bytes = b""
    comment: bytes = b""
    descriptor: bool = False


DOS_TIME, DOS_DATE = 0, (0 << 9) | (1 << 5) | 1  # 1980-01-01 00:00:00


def zip_bytes(
    members: list[Member], *, prefix: bytes = b"", suffix: bytes = b"", comment: bytes = b""
) -> bytes:
    """One ZIP archive, member by member, with nothing normalized."""
    out = io.BytesIO()
    out.write(prefix)
    base = len(prefix)
    central = []
    for member in members:
        name = member.name.encode("utf-8")
        payload = zlib.compress(member.data)[2:-4] if member.method == 8 else member.data
        crc = zlib.crc32(member.data) & 0xFFFFFFFF
        utf8 = 0 if member.name.isascii() else 0x800
        flags = member.flags | (0x08 if member.descriptor else 0) | utf8
        offset = out.tell() - base
        out.write(
            struct.pack(
                "<4s5H3L2H",
                b"PK\x03\x04",
                20,
                flags,
                member.method,
                DOS_TIME,
                DOS_DATE,
                0 if member.descriptor else crc,
                0 if member.descriptor else len(payload),
                0 if member.descriptor else len(member.data),
                len(name),
                len(member.extra),
            )
        )
        out.write(name)
        out.write(member.extra)
        out.write(payload)
        if member.descriptor:
            out.write(struct.pack("<4s3L", b"PK\x07\x08", crc, len(payload), len(member.data)))
        central.append((member, name, crc, len(payload), offset, flags))
    start = out.tell() - base
    for member, name, crc, size, offset, flags in central:
        out.write(
            struct.pack(
                "<4s6H3L5H2L",
                b"PK\x01\x02",
                (3 << 8) | 20,
                20,
                flags,
                member.method,
                DOS_TIME,
                DOS_DATE,
                crc,
                size,
                len(member.data),
                len(name),
                len(member.extra),
                len(member.comment),
                0,
                0,
                member.mode << 16,
                offset,
            )
        )
        out.write(name)
        out.write(member.extra)
        out.write(member.comment)
    size = out.tell() - base - start
    out.write(
        struct.pack(
            "<4s4H2LH", b"PK\x05\x06", 0, 0, len(members), len(members), size, start, len(comment)
        )
    )
    out.write(comment)
    out.write(suffix)
    return out.getvalue()


def canonical_members(archive: bytes) -> list[Member]:
    """The members of a canonical archive, in archive order, as `Member`s."""
    with zipfile.ZipFile(io.BytesIO(archive)) as handle:
        return [Member(info.filename, handle.read(info)) for info in handle.infolist()]


def generic_zip_accepts(archive: bytes) -> bool:
    """Whether Python's general-purpose zipfile reads every member without error."""
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as handle:
            return handle.testzip() is None
    except Exception:  # noqa: BLE001 - any failure means "not generically readable"
        return False
