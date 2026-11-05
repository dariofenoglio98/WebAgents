"""The campaign CA (PROTOCOL.md §2.1's host mapping): a throwaway CA and one leaf certificate for
the public hostnames the signed packages declare and for the sink, valid two days, written to a run
directory and never committed. Only the drivers trust it; no production configuration can."""

from __future__ import annotations

import datetime
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

WEBAIR_HOST = "webagents-webair-production.up.railway.app"
RESOLVER_HOST = "webagents-citation-resolver-production.up.railway.app"
SINK_HOST = "sink.invalid"
HOSTS = (WEBAIR_HOST, RESOLVER_HOST, SINK_HOST)


def _name(common: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common)])


def make(directory: Path, hosts: tuple[str, ...] = HOSTS) -> dict[str, Path]:
    """Write `ca.pem`, `leaf.pem` and `leaf.key` into `directory`; return their paths."""
    directory.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.UTC)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca = (
        x509.CertificateBuilder()
        .subject_name(_name("WebAgents campaign CA (throwaway)"))
        .issuer_name(_name("WebAgents campaign CA (throwaway)"))
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder()
        .subject_name(_name(hosts[0]))
        .issuer_name(ca.subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName(h) for h in hosts]), critical=False
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(leaf_key.public_key()), critical=False
        )
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    paths = {
        "ca": directory / "ca.pem",
        "leaf": directory / "leaf.pem",
        "key": directory / "leaf.key",
    }
    paths["ca"].write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    paths["leaf"].write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    paths["key"].write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    paths["key"].chmod(0o600)
    return paths
