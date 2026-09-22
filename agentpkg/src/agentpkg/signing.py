"""Publisher integrity signatures. Trust requires a separately pinned Ed25519 key."""

from __future__ import annotations

import base64
import os
import tempfile
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from .errors import SignatureError
from .package import archive_bytes, canonical_json, load_package, sha256, write_new

DOMAIN = b"Agent Package v0.1 publisher signature\x00"


def fingerprint(key: Ed25519PublicKey) -> str:
    raw = key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return "sha256:" + sha256(raw)


def _read_key(path, private=False):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise SignatureError(f"key must be a regular, nonsymlink file: {path}")
    if private and path.stat().st_mode & 0o077:
        raise SignatureError(
            f"private key must be readable only by its owner; run chmod 600 {path}"
        )
    if path.stat().st_size > 8192:
        raise SignatureError("key file exceeds 8 KiB limit")
    try:
        data = path.read_bytes()
        key = (
            serialization.load_pem_private_key(data, password=None)
            if private
            else serialization.load_pem_public_key(data)
        )
    except (ValueError, TypeError) as exc:
        raise SignatureError(f"cannot read Ed25519 PEM key {path}: {exc}") from exc
    if not isinstance(key, Ed25519PrivateKey if private else Ed25519PublicKey):
        raise SignatureError("only Ed25519 keys are supported")
    return key


def keygen(private_path: str | Path, public_path: str | Path) -> dict:
    private_path, public_path = Path(private_path), Path(public_path)
    if private_path.absolute() == public_path.absolute():
        raise SignatureError("private and public key paths must be different")
    for path in (private_path, public_path):
        if path.exists() or path.is_symlink():
            raise SignatureError(f"refusing to overwrite existing key: {path}")
        if not path.parent.is_dir():
            raise SignatureError(f"key directory does not exist: {path.parent}")
    key = Ed25519PrivateKey.generate()
    private_data = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    public_data = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    write_new(private_path, private_data, mode=0o600)
    try:
        write_new(public_path, public_data)
    except Exception:
        private_path.unlink()
        raise
    return {
        "private_key": str(private_path),
        "public_key": str(public_path),
        "key_fingerprint": fingerprint(key.public_key()),
    }


def sign_package(
    path: str | Path, private_key: str | Path, output: str | Path | None = None
) -> Path:
    package = load_package(path)
    if not package.is_archive:
        raise SignatureError("sign expects a built .agent.pkg artifact")
    key = _read_key(private_key, private=True)
    public = key.public_key()
    signature = {
        "format": "agent.pkg-signature-v0.1",
        "algorithm": "Ed25519",
        "key_fingerprint": fingerprint(public),
        "public_key": base64.b64encode(
            public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        ).decode("ascii"),
        "signature": base64.b64encode(key.sign(DOMAIN + canonical_json(package.integrity))).decode(
            "ascii"
        ),
        "digest": package.digest,
    }
    data = archive_bytes(package.files, signature)
    if output is not None:
        return write_new(output, data)
    path = Path(path)
    # Explicit sign updates only this artifact; replace prevents partial archives.
    fd, temporary = tempfile.mkstemp(prefix=".agentpkg-sign-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def embedded_public_key(signature: dict) -> Ed25519PublicKey:
    """Decode the key carried inside an artifact. This is NEVER a trust anchor.

    It answers only "is this envelope internally consistent?". Deciding that a
    key belongs to an accepted publisher is a separate host trust operation.
    """
    try:
        raw = base64.b64decode(signature["public_key"], validate=True)
        key = Ed25519PublicKey.from_public_bytes(raw)
    except (ValueError, TypeError) as exc:
        raise SignatureError("embedded publisher key is not a raw Ed25519 public key") from exc
    if signature["key_fingerprint"] != fingerprint(key):
        raise SignatureError("embedded key fingerprint does not match the embedded key")
    return key


def check_signature(package, public_key: Ed25519PublicKey) -> None:
    """Check digest binding and the domain-separated transcript against one key."""
    signature = package.signature
    if signature is None:
        raise SignatureError("publisher signature missing; build and sign the artifact first")
    if signature["digest"] != package.digest:
        raise SignatureError("signed digest differs from package integrity statement")
    try:
        public_key.verify(
            base64.b64decode(signature["signature"], validate=True),
            DOMAIN + canonical_json(package.integrity),
        )
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise SignatureError("invalid Ed25519 publisher signature") from exc


def verify_package(path: str | Path, trusted_key: str | Path) -> dict:
    package = load_package(path)
    if not package.is_archive or package.signature is None:
        raise SignatureError("publisher signature missing; build and sign the artifact first")
    signature = package.signature
    public = _read_key(trusted_key)
    expected = fingerprint(public)
    embedded = base64.b64decode(signature["public_key"], validate=True)
    trusted = public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    if signature["key_fingerprint"] != expected or embedded != trusted:
        raise SignatureError("publisher key is not the host-pinned trusted key")
    check_signature(package, public)
    return {
        "valid": True,
        "digest": package.digest,
        "package_id": package.manifest["package_id"],
        "version": package.manifest["version"],
        "publisher": package.manifest["publisher"],
        "key_fingerprint": expected,
        "trust_scope": "exact externally supplied publisher key",
    }
