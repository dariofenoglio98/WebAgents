"""F2 — publisher trust: a valid signature is not a trusted publisher."""

from __future__ import annotations

from harness import artifacts
from harness.paths import PACKAGES

from . import boundaries as B
from .base import Env, Template, base_plan, key_pin, payload, publisher_pin, resigned_plan

BOTH = ("meeting-agenda", "literature-review")
OTHER = {"meeting-agenda": "literature-review", "literature-review": "meeting-agenda"}


class SignerNotPinned(Template):
    STATES = (
        ("shipped_unpinned", "the shipped artifact; the trust store pins nothing"),
        (
            "unknown_key_empty_store",
            "re-signed by an unknown experiment key; the trust store is empty",
        ),
        (
            "unknown_key_publisher_pinned",
            "re-signed by an unknown key that claims the same publisher, whose real key is pinned",
        ),
        (
            "unknown_key_other_pins",
            "re-signed by an unknown key; the store pins two unrelated keys",
        ),
    )

    def variants(self, package, env, rng, budget):
        out = []
        for state, description in self.STATES:
            control = "pin_session_signer" if state == "unknown_key_other_pins" else "pin_signer"
            out.append(
                self.variant(
                    package,
                    state,
                    {"state": state},
                    description,
                    control_params={"state": state, "control": control},
                    control_description=(
                        "the same bytes, with the signer pinned through the page's own Trust action"
                        if control == "pin_session_signer"
                        else "the same bytes, with the signer pinned at package scope"
                    ),
                )
            )
        return out

    def plan(self, variant, kind, env: Env):
        state, package = variant.params["state"], variant.package
        if state == "shipped_unpinned":
            plan = base_plan(env, package, pins=[])
            signer_pin = publisher_pin(env, package)
        else:
            key = env.key("unknown-publisher")
            plan = base_plan(
                env, package, archive=artifacts.resign(env.archive(package), key), pins=[]
            )
            signer_pin = key_pin(key, package)
            if state == "unknown_key_publisher_pinned":
                plan.pins = [publisher_pin(env, package)]
            elif state == "unknown_key_other_pins":
                plan.pins = [
                    key_pin(
                        env.key("other-publisher"),
                        package,
                        publisher_id="another-publisher",
                        prefix=None,
                    ),
                    publisher_pin(env, OTHER[package]),
                ]
        if kind == "control":
            if variant.control_params.get("control") == "pin_session_signer":
                plan.pin_session_signer = "package"
            else:
                plan.pins = [*plan.pins, signer_pin]
        return plan, B.prepared_or_executed


SIGNER_NOT_PINNED = SignerNotPinned(
    "F2.signer_not_pinned",
    "F2",
    "Valid signature from a key the host has not pinned",
    "The package is structurally valid and its Ed25519 signature verifies, but the signing "
    "key is not in the operator's trust store (or the claimed publisher is pinned to a "
    "different key).",
    "Execution requires an operator-pinned publisher key, not merely a valid signature.",
    "trust",
    "trust",
    ("publisher_not_trusted",),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The same bytes after the signer is pinned (by the operator, or by the page's Trust action).",
    "finite",
    BOTH,
    "minus_trust",
    "trust pin",
    "unknown valid signer",
)


class PinScopeMismatch(Template):
    SCOPES = (
        ("bound_to_other_publisher", "the signer is pinned, but bound to a different publisher id"),
        ("other_package_prefix", "the signer is pinned, but only for the other package's id"),
    )

    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                scope,
                {"scope": scope},
                description,
                control_params={"scope": "correct"},
                control_description=(
                    "the signer pinned with the package's own publisher id and package scope"
                ),
            )
            for scope, description in self.SCOPES
        ]

    def plan(self, variant, kind, env):
        package = variant.package
        key = env.key("trusted-publisher")
        plan = resigned_plan(env, package, payload(env, package))
        if kind == "control":
            return plan, B.prepared_or_executed
        if variant.params["scope"] == "bound_to_other_publisher":
            pin = key_pin(key, package, publisher_id="another-publisher")
        else:
            pin = key_pin(key, package, prefix=PACKAGES[OTHER[package]]["package_id"])
        plan.pins = [publisher_pin(env, package), pin]
        return plan, B.prepared_or_executed


PIN_SCOPE_MISMATCH = PinScopeMismatch(
    "F2.pin_scope_mismatch",
    "F2",
    "Signer pinned, but for a different publisher or package",
    "The signing key is pinned, but the pin is bound to another publisher id or to another "
    "package id prefix, which the trust store reports as a mismatch (an impersonation signal).",
    "A pin authorizes exactly the publisher and package scope it names.",
    "trust",
    "trust",
    ("publisher_not_trusted",),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The same key pinned for the package's own publisher id and package scope.",
    "finite",
    BOTH,
    "minus_trust",
    "trust pin scope",
    "pin bound to another publisher",
)


class Unsigned(Template):
    def variants(self, package, env, rng, budget):
        return [
            self.variant(
                package,
                "signature_removed",
                {"mode": "signature_removed"},
                "integrity-valid payload with the signature member removed",
                control_params={"mode": "signed_by_pinned_key"},
                control_description="the same payload signed by a pinned key",
            )
        ]

    def plan(self, variant, kind, env):
        package = variant.package
        if kind == "control":
            return resigned_plan(env, package, payload(env, package)), B.prepared_or_executed
        archive = artifacts.build(payload(env, package), None, normalize=False)
        return base_plan(env, package, archive=archive), B.prepared_or_executed


UNSIGNED = Unsigned(
    "F2.unsigned",
    "F2",
    "Unsigned package",
    "The payload and integrity statement are valid, but the artifact carries no publisher "
    "signature at all, so no publisher identity exists to trust.",
    "Only a signed package can be attributed to a publisher the host trusts.",
    "verification",
    "verify",
    ("signature_not_valid", "publisher_not_trusted"),
    "The package reaches a ready Run Plan, a lease or execution.",
    "The same payload signed by an operator-pinned key.",
    "finite",
    BOTH,
    "minus_verification",
    "signature required",
    "signature removed",
)

TEMPLATES = (SIGNER_NOT_PINNED, PIN_SCOPE_MISMATCH, UNSIGNED)
