"""Operator-controlled publisher trust store.

This is the temporary local stand-in for future NANDA/CA/attestation
infrastructure. Three rules define it:

* the cryptographic identity of an entry is its **key fingerprint**, never a
  publisher string from a manifest;
* the store lives outside every package and is mutated only through the
  authenticated operator API/CLI, so no package operation can add itself;
* a key embedded in an artifact is evidence of self-consistency only. Trust
  requires that the operator independently pinned that exact key here.
"""

from __future__ import annotations

import base64
import json
import os
import stat
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ..package import canonical_json, sha256
from ..signing import fingerprint
from ..validation import parse_json
from .errors import ControlPlaneError

FORMAT = "agentpkg-trust-store-v0"
MAX_ENTRIES = 256
MAX_STORE_BYTES = 512 * 1024
MAX_KEY_BYTES = 16 * 1024
MAX_TEXT = 200
IDENTIFIER_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")


@dataclass(frozen=True)
class TrustEntry:
    fingerprint: str
    public_key: str
    display_name: str
    publisher_id: str | None = None
    package_id_prefix: str | None = None
    notes: str | None = None
    added_at: str = ""

    def as_json(self) -> dict:
        return {
            "fingerprint": self.fingerprint,
            "public_key": self.public_key,
            "display_name": self.display_name,
            "publisher_id": self.publisher_id,
            "package_id_prefix": self.package_id_prefix,
            "notes": self.notes,
            "added_at": self.added_at,
        }

    def key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(base64.b64decode(self.public_key, validate=True))


def _invalid(message: str, *, code: str = "trust_invalid", status: int = 400):
    return ControlPlaneError(code, message, status=status)


def _text(value, field: str, *, required: bool = False) -> str | None:
    if value is None:
        if required:
            raise _invalid(f"{field} is required")
        return None
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise _invalid(f"{field} must be a string of at most {MAX_TEXT} characters")
    value = value.strip()
    if not value:
        if required:
            raise _invalid(f"{field} is required")
        return None
    if any(ord(character) < 32 for character in value):
        raise _invalid(f"{field} must not contain control characters")
    return value


def _identifier(value, field: str) -> str | None:
    value = _text(value, field)
    if value is not None and not set(value) <= IDENTIFIER_CHARS:
        raise _invalid(f"{field} may use only letters, digits and _.:- characters")
    return value


def public_key_from_pem(pem: bytes | str) -> Ed25519PublicKey:
    """Accept only an Ed25519 SubjectPublicKeyInfo PEM. Private keys are refused."""
    data = pem.encode("utf-8") if isinstance(pem, str) else pem
    if len(data) > MAX_KEY_BYTES:
        raise _invalid(f"Public key PEM exceeds {MAX_KEY_BYTES} bytes")
    if b"PRIVATE KEY" in data:
        raise _invalid(
            "Refusing a private key: the trust store holds public verification keys only",
            code="trust_private_key_refused",
        )
    try:
        key = serialization.load_pem_public_key(data)
    except (ValueError, TypeError) as exc:
        raise _invalid(f"Cannot read Ed25519 public key PEM: {type(exc).__name__}") from exc
    if not isinstance(key, Ed25519PublicKey):
        raise _invalid("Only Ed25519 publisher keys are supported")
    return key


def read_public_key_file(path: str | Path) -> Ed25519PublicKey:
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise _invalid(f"Public key must be a regular, nonsymlink file: {path}")
    if path.stat().st_size > MAX_KEY_BYTES:
        raise _invalid(f"Public key file exceeds {MAX_KEY_BYTES} bytes")
    return public_key_from_pem(path.read_bytes())


def raw_base64(key: Ed25519PublicKey) -> str:
    raw = key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode("ascii")


class TrustStore:
    """A small JSON file of explicit key pins, owned by the operator."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    # -- persistence ---------------------------------------------------------
    def _read_document(self) -> dict:
        if self.path.is_symlink():
            raise _invalid(f"Trust store must not be a symlink: {self.path}", status=500)
        if not self.path.exists():
            return {"format": FORMAT, "publishers": []}
        info = self.path.stat()
        if not stat.S_ISREG(info.st_mode):
            raise _invalid(f"Trust store must be a regular file: {self.path}", status=500)
        if info.st_size > MAX_STORE_BYTES:
            raise _invalid("Trust store exceeds its size limit", status=500)
        if info.st_mode & 0o022:
            raise _invalid(
                f"Trust store is group/world writable; run chmod 600 {self.path}", status=500
            )
        document = parse_json(self.path.read_bytes(), str(self.path))
        if not isinstance(document, dict) or document.get("format") != FORMAT:
            raise _invalid(f"Trust store must declare format {FORMAT}", status=500)
        if not isinstance(document.get("publishers"), list):
            raise _invalid("Trust store publishers must be a list", status=500)
        return document

    def entries(self) -> list[TrustEntry]:
        entries: list[TrustEntry] = []
        seen: set[str] = set()
        for record in self._read_document()["publishers"]:
            if not isinstance(record, dict):
                raise _invalid("Trust store entries must be objects", status=500)
            unknown = set(record) - set(TrustEntry.__dataclass_fields__)
            if unknown:
                raise _invalid(f"Unknown trust store fields: {sorted(unknown)}", status=500)
            entry = self._entry_from(record)
            if entry.fingerprint in seen:
                raise _invalid("Trust store contains duplicate fingerprints", status=500)
            seen.add(entry.fingerprint)
            entries.append(entry)
        if len(entries) > MAX_ENTRIES:
            raise _invalid(f"Trust store exceeds {MAX_ENTRIES} entries", status=500)
        return entries

    def _entry_from(self, record: dict) -> TrustEntry:
        key = None
        try:
            raw = base64.b64decode(str(record.get("public_key", "")), validate=True)
            key = Ed25519PublicKey.from_public_bytes(raw)
        except (ValueError, TypeError) as exc:
            raise _invalid(f"Trust entry key is not a raw Ed25519 key: {exc}", status=500) from exc
        if record.get("fingerprint") != fingerprint(key):
            raise _invalid("Trust entry fingerprint does not match its key", status=500)
        return TrustEntry(
            fingerprint=record["fingerprint"],
            public_key=record["public_key"],
            display_name=_text(record.get("display_name"), "display_name") or "",
            publisher_id=_identifier(record.get("publisher_id"), "publisher_id"),
            package_id_prefix=_identifier(record.get("package_id_prefix"), "package_id_prefix"),
            notes=_text(record.get("notes"), "notes"),
            added_at=str(record.get("added_at", "")),
        )

    def _write(self, entries: list[TrustEntry]) -> None:
        document = {
            "format": FORMAT,
            "updated_at": datetime.now(UTC).isoformat(),
            "publishers": [entry.as_json() for entry in sorted(entries, key=lambda e: e.added_at)],
        }
        data = (json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
        if len(data) > MAX_STORE_BYTES:
            raise _invalid("Trust store update exceeds its size limit")
        parent = self.path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".agentpkg-trust-", dir=parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    # -- operator operations -------------------------------------------------
    def add(
        self,
        key: Ed25519PublicKey,
        *,
        display_name: str,
        publisher_id: str | None = None,
        package_id_prefix: str | None = None,
        notes: str | None = None,
        replace: bool = False,
    ) -> TrustEntry:
        entry = TrustEntry(
            fingerprint=fingerprint(key),
            public_key=raw_base64(key),
            display_name=_text(display_name, "display_name", required=True) or "",
            publisher_id=_identifier(publisher_id, "publisher_id"),
            package_id_prefix=_identifier(package_id_prefix, "package_id_prefix"),
            notes=_text(notes, "notes"),
            added_at=datetime.now(UTC).isoformat(),
        )
        entries = self.entries()
        existing = [item for item in entries if item.fingerprint == entry.fingerprint]
        if existing and not replace:
            raise ControlPlaneError(
                "trust_entry_exists",
                f"{entry.fingerprint} is already pinned; remove it first or pass replace",
                status=409,
            )
        if len(entries) - len(existing) + 1 > MAX_ENTRIES:
            raise _invalid(f"Trust store is limited to {MAX_ENTRIES} entries", status=409)
        remaining = [item for item in entries if item.fingerprint != entry.fingerprint]
        self._write([*remaining, entry])
        return entry

    def remove(self, key_fingerprint: str) -> TrustEntry:
        entries = self.entries()
        match = [item for item in entries if item.fingerprint == key_fingerprint]
        if not match:
            raise ControlPlaneError(
                "trust_entry_unknown", f"No trust entry for {key_fingerprint}", status=404
            )
        self._write([item for item in entries if item.fingerprint != key_fingerprint])
        return match[0]

    # -- evaluation ----------------------------------------------------------
    def state(self) -> dict:
        """A stable fingerprint of the exact trust state a receipt was issued under."""
        entries = self.entries()
        canonical = canonical_json(
            [
                {
                    "fingerprint": entry.fingerprint,
                    "publisher_id": entry.publisher_id,
                    "package_id_prefix": entry.package_id_prefix,
                }
                for entry in sorted(entries, key=lambda item: item.fingerprint)
            ]
        )
        return {
            "path": str(self.path),
            "entry_count": len(entries),
            "state_sha256": sha256(canonical),
        }

    def evaluate(self, *, signer_fingerprint, claimed_publisher_id, package_id) -> dict:
        """Decide trusted / unknown / mismatch for one signer.

        The lookup is two-sided on purpose. A cryptographically valid signature
        from an unknown key stays `unknown`, and a package whose claimed
        publisher is pinned to *different* keys is `mismatch` rather than
        merely unknown, because that is an impersonation signal.
        """
        entries = self.entries()
        if signer_fingerprint is None:
            return {
                "trust_status": "unknown",
                "trust_reason": "no_valid_signature",
                "trust_entry": None,
            }
        pinned = next((e for e in entries if e.fingerprint == signer_fingerprint), None)
        for_publisher = [
            e for e in entries if claimed_publisher_id and e.publisher_id == claimed_publisher_id
        ]
        if pinned is not None:
            if pinned.publisher_id is not None and pinned.publisher_id != claimed_publisher_id:
                return {
                    "trust_status": "mismatch",
                    "trust_reason": "pinned_key_bound_to_other_publisher",
                    "trust_entry": pinned.as_json(),
                }
            if pinned.package_id_prefix and not str(package_id).startswith(
                pinned.package_id_prefix
            ):
                return {
                    "trust_status": "mismatch",
                    "trust_reason": "package_id_outside_pinned_prefix",
                    "trust_entry": pinned.as_json(),
                }
            return {
                "trust_status": "trusted",
                "trust_reason": "operator_pinned_key",
                "trust_entry": pinned.as_json(),
            }
        if for_publisher:
            return {
                "trust_status": "mismatch",
                "trust_reason": "claimed_publisher_pinned_to_other_key",
                "trust_entry": None,
                "pinned_fingerprints_for_claimed_publisher": [
                    entry.fingerprint for entry in for_publisher
                ],
            }
        return {
            "trust_status": "unknown",
            "trust_reason": "signer_key_not_pinned",
            "trust_entry": None,
        }
