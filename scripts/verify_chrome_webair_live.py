"""Live acceptance of WebAir in the Chrome Agent Browser (T5, Demo 3): recompute the checks.

    agentpkg/.venv/bin/python scripts/verify_chrome_webair_live.py \\
        [--report examples/verification/chrome-webair-050-live.json] [--no-network]

`chrome-agent-browser/scripts/e2e-webair-live.mjs` drove the built extension in a real Chrome
against the public WebAir origin and exported every run it made (run.json, run-plan.json,
input.json, the artifacts, and observations.json: the request bodies the execution host recorded
in test mode, D-028). This script reads those files and the harness's report and recomputes the
portable checks of `scripts/verify_webair_live.py` (the OpenClaw live acceptance, D-043):

* each run's own record and hash-chained audit (re-verified with agentpkg), the planned model,
  call counts, decisions and resources resolved;
* privacy: no model request body holds a passenger name, e-mail, payment identifier, resource id
  or label; the identity reaches only `prepare_booking` and the payment identifier only
  `simulate_purchase`; no artifact or record holds a sealed value;
* the demo's properties: the search's hero fares, the quote's redaction, the simulated purchase
  charged $0 under a `once` grant, the replay refused by the page and by the worker, the denied
  purchase that resolved, called and modelled nothing, the cancelled run's chain, the reloaded
  page adopting a run in flight;
* the package and the origin: `dist/webair-<version>.agent.pkg` verifies with the WebAir key and is
  what the public origin serves (`/health`, the bytes), unless `--no-network`. The version is the
  report's `packageVersion` (T9; 0.4.0 for reports recorded before it, which carry none).

The needle values come from `demo/webair/host-resources.json` (the fictional demo set); only class
names and counts reach the report. The report is rewritten in place with `checks`, `runs` and
`verification`; `passed` is false if any check fails. The run directories live under the
git-ignored `examples/my-chrome-live-*`: when any of them is missing (a clean checkout) and the
report is the committed one, the script refuses and writes nothing, so the committed evidence is
never overwritten with a failing report (T5 review 1, nit 8). With an explicit `--report` elsewhere
a partial or failed attempt is verified and the missing phases fail (T5 review 2, nit 7).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "examples/verification/chrome-webair-040-live.json"
# The committed reports, one per version; none is ever overwritten from a clean checkout.
COMMITTED_REPORTS = (
    DEFAULT_REPORT,
    ROOT / "examples/verification/chrome-webair-040-live-hosted.json",
    ROOT / "examples/verification/chrome-webair-050-live.json",
    ROOT / "examples/verification/chrome-webair-050-live-hosted.json",
)
sys.path.insert(0, str(ROOT / "agentpkg" / "src"))

from agentpkg.execution.report import verify_audit_chain  # noqa: E402
from agentpkg.package import load_package  # noqa: E402
from agentpkg.signing import verify_package  # noqa: E402

SITE = "https://webagents-webair-production.up.railway.app"

def archive_for(version: str) -> Path:
    return ROOT / f"dist/webair-{version}.agent.pkg"

KEY = ROOT / "examples/keys/webair-publisher.pub.pem"
FINGERPRINT = "sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b"
HOST_RESOURCES = ROOT / "demo/webair/host-resources.json"
HERO_FARES = [
    ("WA101-20261009-BASIC", 704),
    ("WA101-20261009-STANDARD", 858),
    ("WA105-20261009-BASIC", 749),
]
QUOTE_ID = re.compile(r"^WAQ-[0-9A-F]{16}$")
CARD_LIKE = re.compile(r"(?:\d[ -]?){13,19}")
PROHIBITED_IN_MODEL_INPUT = (
    "passenger_full_name",
    "passenger_email",
    "passenger_given_name_word",
    "passenger_family_name_word",
    "payment_method_id",
    "payment_display",
    "resource_id",
    "resource_label",
)
IDENTITY = (
    "passenger_full_name",
    "passenger_email",
    "passenger_given_name_word",
    "passenger_family_name_word",
)
PAYMENT = ("payment_method_id", "payment_display")
PHASES = ("search", "cancel", "quote", "purchase", "denial")

CHECKS: list[dict] = []


def check(identifier: str, passed: bool, detail=None) -> bool:
    CHECKS.append(
        {
            "id": identifier,
            "passed": bool(passed),
            **({"detail": detail} if detail is not None else {}),
        }
    )
    return bool(passed)


def needles() -> dict[str, list[str]]:
    """The demo set's values by class, from the demo host's own file (never written by hand)."""
    document = json.loads(HOST_RESOURCES.read_text())
    classes: dict[str, list[str]] = {name: [] for name in PROHIBITED_IN_MODEL_INPUT}
    for resource in document["resources"]:
        classes["resource_id"].append(resource["id"])
        classes["resource_label"].append(resource["label"])
        value = resource["value"]
        if resource["type"] == "personal.passenger_identity":
            classes["passenger_email"].append(value["contact_email"])
            classes["passenger_full_name"].append(
                f"{value['given_name']} {value['family_name']}"
            )
            classes["passenger_given_name_word"].append(value["given_name"])
            classes["passenger_family_name_word"].append(value["family_name"])
        if resource["type"] == "wallet.payment_method":
            classes["payment_method_id"].append(value["payment_method_id"])
            classes["payment_display"].append(value["display"])
    return classes


def count(classes: dict[str, list[str]], text: str) -> dict[str, int]:
    """How many values of each class the text holds; `_word` classes match whole words."""
    counts: dict[str, int] = {}
    for name, values in classes.items():
        if name.endswith("_word"):
            counts[name] = sum(
                1
                for value in values
                if re.search(rf"(?<!\w){re.escape(value)}(?!\w)", text)
            )
        else:
            counts[name] = sum(1 for value in values if value in text)
    return counts


def classes_in(counts: dict[str, int]) -> list[str]:
    return sorted(name for name, value in counts.items() if value)


def model_task(body: str) -> str | None:
    """The `## Task` line of the system prompt inside an Ollama / OpenAI / Anthropic request body."""
    try:
        document = json.loads(body)
    except json.JSONDecodeError:
        document = None
    texts: list[str] = []
    if isinstance(document, dict):
        for message in document.get("messages") or []:
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                texts.append(message["content"])
        for field in ("instructions", "system"):
            if isinstance(document.get(field), str):
                texts.append(document[field])
    for text in texts or [body]:
        match = re.search(r"^## Task\n(.+)$", text, re.MULTILINE)
        if match:
            return match.group(1).strip()[:64]
    return None


def run_facts(
    phase: str, directory: Path, classes: dict[str, list[str]], model: str
) -> dict:
    record = json.loads((directory / "run.json").read_text())
    audit = json.loads((directory / "audit.json").read_text())
    plan = json.loads((directory / "run-plan.json").read_text())
    observations = json.loads((directory / "observations.json").read_text())
    lines = observations.get("observations", [])
    chain = verify_audit_chain(audit)
    models = [line for line in lines if line["kind"] == "model"]
    tools = [line for line in lines if line["kind"] == "tool"]
    dispatched = [e for e in audit if e.get("action") == "tool.dispatched"]
    remote = [e for e in dispatched if e.get("remote")]
    settled = [
        e for e in audit if e.get("action") == "tool.settled" and e.get("resource_id")
    ]
    called_tasks = [e.get("task") for e in audit if e.get("action") == "model.called"]
    refused_tools = [
        e.get("tool")
        for e in audit
        if e.get("action") == "tool.failed" and e.get("error") == "PolicyError"
    ]
    evidence_text = "\n".join(
        path.read_text(errors="replace")
        for path in sorted(directory.iterdir())
        if path.is_file() and path.name != "observations.json"
    )
    model_lines = [
        {
            "task": model_task(line["body"]),
            "body_sha256": line["body_sha256"],
            "body_bytes": line["body_bytes"],
            "classes_in_request": classes_in(count(classes, line["body"])),
            "card_like_digits": bool(CARD_LIKE.search(line["body"])),
        }
        for line in models
    ]
    tool_lines = [
        {
            "path": urllib.parse.urlsplit(line["url"]).path,
            "origin": f"{urllib.parse.urlsplit(line['url']).scheme}://{urllib.parse.urlsplit(line['url']).netloc}",
            "body_sha256": line["body_sha256"],
            "body_bytes": line["body_bytes"],
            "classes_in_request": classes_in(count(classes, line["body"])),
        }
        for line in tools
    ]
    facts = {
        "run_id": record["runId"],
        "status": record["status"],
        "error_code": record.get("errorCode"),
        "failed_node": (record.get("failure") or {}).get("nodeId"),
        "package": {
            "id": record["package"]["packageId"],
            "version": record["package"]["version"],
            "digest": record["package"]["digest"],
            "archive_sha256": record["package"]["archiveSha256"],
        },
        "model": {
            **(record.get("model") or {}),
            "selected": (record.get("selectedModel") or {}).get("hostModelId"),
            "local": (record.get("selectedModel") or {}).get("local"),
        },
        "usage": record.get("usage")
        and {
            "tokens": record["usage"]["tokens"],
            "remote_calls": record["usage"]["remoteCalls"],
            "tool_calls": record["usage"]["toolCalls"],
        },
        "cost": record.get("cost"),
        "duration_ms": record.get("durationMs"),
        "decisions": {
            item["permissionId"]: item["decision"]
            for item in record["grants"]["decisions"]
        },
        "resource_grants": [
            {
                "permission": g["permissionId"],
                "type": g["resourceType"],
                "resource_id": g["resourceId"],
                "digest_prefix": g["resourceDigest"][:12],
            }
            for g in record.get("resources", [])
        ],
        "revalidated_before_start": len(record.get("revalidated", [])),
        "run_plan": {
            "id": plan["run_plan_id"],
            "sha256": plan["run_plan_sha256"],
            "profile": (plan["authorization"].get("provenance") or {}).get(
                "profile_id"
            ),
            "denied_tools": plan["execution"]["denied_tool_ids"],
        },
        "audit": {
            "events": len(audit),
            "chain_valid": chain.get("valid") is True,
            "model_tasks": called_tasks,
            "tool_dispatches": [
                {
                    "tool": e.get("tool"),
                    "binding_id": e.get("binding_id"),
                    "endpoint_origin": e.get("endpoint_origin"),
                    "method": e.get("method"),
                }
                for e in dispatched
            ],
            "resources_resolved": [
                {
                    "tool": e.get("tool"),
                    "resource_id": e.get("resource_id"),
                    "permission": e.get("resource_permission"),
                }
                for e in settled
            ],
            "tools_refused": refused_tools,
        },
        "observed_model_inputs": model_lines,
        "observed_webair_requests": tool_lines,
    }
    check(f"{phase}_audit_chain_valid", chain.get("valid") is True, chain)
    check(
        f"{phase}_record_matches_audit",
        (record.get("audit") or {}).get("events") == len(audit)
        and (record.get("audit") or {}).get("chainValid") is True,
        record.get("audit"),
    )
    check(
        f"{phase}_used_the_selected_model_only",
        (record.get("model") or {}).get("planned") == model
        and (
            (record.get("model") or {}).get("allCallsUsedPlannedModel") is True
            or (record.get("model") or {}).get("calls") == 0
        ),
        record.get("model"),
    )
    check(
        f"{phase}_every_model_call_observed",
        len(models) == (record.get("model") or {}).get("calls", 0) == len(called_tasks),
        {
            "observed": len(models),
            "recorded": (record.get("model") or {}).get("calls"),
            "called": len(called_tasks),
        },
    )
    check(
        f"{phase}_every_webair_call_observed",
        len(tools) == len(remote),
        {"observed": len(tools), "dispatched": len(remote)},
    )
    check(
        f"{phase}_webair_calls_went_to_the_public_origin",
        all(e.get("endpoint_origin") == SITE for e in remote)
        and all(line["origin"] == SITE for line in tool_lines),
        {
            "dispatched": sorted({e.get("endpoint_origin") for e in remote}),
            "observed": sorted({line["origin"] for line in tool_lines}),
        },
    )
    for line in model_lines:
        bad = [
            name
            for name in PROHIBITED_IN_MODEL_INPUT
            if name in line["classes_in_request"]
        ]
        check(
            f"{phase}_model_{line['task'] or 'unknown'}_holds_no_host_data",
            not bad and not line["card_like_digits"],
            bad or None,
        )
    leaked = [
        name
        for name in ("passenger_email", "passenger_full_name", "payment_method_id")
        if any(value in evidence_text for value in classes[name])
    ]
    facts["artifacts_hold_no_identity_or_payment_identifier"] = not leaked
    check(
        f"{phase}_artifacts_hold_no_email_name_or_payment_identifier",
        not leaked,
        leaked or None,
    )
    return facts


def phase_checks(
    phase: str, facts: dict, directory: Path, harness: dict, quote: dict | None
) -> dict | None:
    """The demo's properties per phase; returns the facts a later phase needs."""
    tool_paths = [line["path"] for line in facts["observed_webair_requests"]]
    if phase == "search":
        search = json.loads((directory / "search.json").read_text())
        fares = [
            (fare["fare_id"], fare["price_usd"])
            for flight in search.get("flights", [])
            for fare in flight.get("fares", [])
        ]
        check(
            "search_completed_with_the_hero_fares",
            facts["status"] == "completed" and fares == HERO_FARES,
            fares,
        )
        check(
            "search_used_no_identity_or_payment",
            not facts["resource_grants"] and not facts["audit"]["resources_resolved"],
        )
        check(
            "search_called_only_search_and_fare_rules",
            set(tool_paths) <= {"/api/v1/search_flights", "/api/v1/get_fare_rules"}
            and len(tool_paths) == 4,
            tool_paths,
        )
        check(
            "search_requests_carry_no_identity_or_payment",
            not any(
                set(line["classes_in_request"]) & set(IDENTITY + PAYMENT)
                for line in facts["observed_webair_requests"]
            ),
        )
        check(
            "search_model_calls_are_interpret_select_answer",
            facts["audit"]["model_tasks"] == ["interpret", "select", "answer"],
            facts["audit"]["model_tasks"],
        )
        return None
    if phase == "cancel":
        record = json.loads((directory / "run.json").read_text())
        check(
            "cancel_settled_as_cancelled",
            facts["status"] == "cancelled"
            and facts["error_code"] == "cancelled"
            and record.get("cancelRequested") is True,
            {"status": facts["status"], "error_code": facts["error_code"]},
        )
        check(
            "cancel_stopped_within_the_run_deadline",
            (facts["duration_ms"] or 0) < 600_000,
            facts["duration_ms"],
        )
        check(
            "cancel_wrote_its_evidence",
            {"result.json", "audit.json", "usage.json", "provenance.json"}
            <= {p.name for p in directory.iterdir()},
        )
        return None
    if phase == "quote":
        booking = json.loads((directory / "booking.json").read_text())
        quote_id = (booking.get("booking") or {}).get("quote_id")
        check(
            "booking_completed_with_a_quote",
            facts["status"] == "completed"
            and isinstance(quote_id, str)
            and QUOTE_ID.match(quote_id) is not None,
            quote_id,
        )
        # The identity is resolved through the host; the travel profile only when the request leaves the origin unstated (the model's reading), so it is allowed but not required.
        resolved_tools = sorted(r["tool"] for r in facts["audit"]["resources_resolved"])
        check(
            "booking_identity_resolved_through_the_host",
            "personal.passenger_identity" in resolved_tools
            and set(resolved_tools)
            <= {"personal.passenger_identity", "personal.travel_profile"},
            facts["audit"]["resources_resolved"],
        )
        identity_paths = sorted(
            {
                line["path"]
                for line in facts["observed_webair_requests"]
                if set(line["classes_in_request"]) & set(IDENTITY)
            }
        )
        check(
            "booking_identity_reached_only_prepare_booking",
            identity_paths == ["/api/v1/prepare_booking"],
            identity_paths,
        )
        check(
            "booking_requests_carry_no_payment",
            not any(
                set(line["classes_in_request"]) & set(PAYMENT)
                for line in facts["observed_webair_requests"]
            ),
        )
        text = json.dumps(booking.get("booking"))
        check(
            "booking_result_is_redacted",
            "contact_email" not in text and "given_name" not in text,
        )
        return {
            "quote_id": quote_id,
            "fare_id": (booking.get("booking") or {}).get("fare_id"),
            "total_usd": (booking.get("booking") or {}).get("total_usd"),
        }
    if phase == "purchase":
        booking = json.loads((directory / "booking.json").read_text())
        purchase = booking.get("purchase") or {}
        output = json.loads((directory / "result.json").read_text()).get("output") or {}
        check(
            "purchase_completed",
            facts["status"] == "completed"
            and output.get("status") == "purchase_simulated",
            {"status": facts["status"], "output_status": output.get("status")},
        )
        check(
            "purchase_is_simulated_with_no_charge",
            purchase.get("simulated") is True
            and purchase.get("real_transaction") is False
            and purchase.get("amount_charged_usd") == 0,
            {
                k: purchase.get(k)
                for k in ("simulated", "real_transaction", "amount_charged_usd")
            },
        )
        check(
            "purchase_authority_was_once",
            facts["decisions"].get("booking.simulate_purchase") == "once",
            facts["decisions"].get("booking.simulate_purchase"),
        )
        check(
            "purchase_resolved_the_selected_payment_resource",
            [
                r["resource_id"]
                for r in facts["audit"]["resources_resolved"]
                if r["tool"] == "wallet.payment_method"
            ]
            == ["payment_demo_visa"],
            facts["audit"]["resources_resolved"],
        )
        payment_paths = sorted(
            {
                line["path"]
                for line in facts["observed_webair_requests"]
                if "payment_method_id" in line["classes_in_request"]
            }
        )
        check(
            "purchase_payment_id_reached_only_simulate_purchase",
            payment_paths == ["/api/v1/simulate_purchase"],
            payment_paths,
        )
        check(
            "purchase_revalidated_the_exact_quote",
            tool_paths == ["/api/v1/prepare_booking", "/api/v1/simulate_purchase"],
            tool_paths,
        )
        check(
            "purchase_no_payment_display_reached_webair",
            not any(
                "payment_display" in line["classes_in_request"]
                for line in facts["observed_webair_requests"]
            ),
        )
        check(
            "purchase_used_the_quote_the_booking_returned",
            quote is not None and purchase.get("quote_id") == quote["quote_id"],
            {
                "purchase": purchase.get("quote_id"),
                "booking": quote and quote["quote_id"],
            },
        )
        check(
            "purchase_made_one_model_call_only",
            facts["audit"]["model_tasks"] == ["answer"],
            facts["audit"]["model_tasks"],
        )
        replay = (harness.get("steps") or {}).get("replay") or {}
        button = replay.get("runButton") or {}
        check(
            "once_grant_refused_by_the_page",
            button.get("disabled") is True
            and "once" in (button.get("reason") or "").lower()
            and replay.get("newestRun") == facts["run_id"],
            button,
        )
        check(
            "once_grant_refused_by_the_worker",
            isinstance(replay.get("workerRefusal"), str)
            and "run_plan_stale" in replay["workerRefusal"]
            and "once" in replay["workerRefusal"].lower(),
            replay.get("workerRefusal"),
        )
        return None
    if phase == "denial":
        check(
            "denial_failed_with_permission_denied",
            facts["status"] == "failed" and facts["error_code"] == "permission_denied",
            {"status": facts["status"], "error_code": facts["error_code"]},
        )
        check(
            "denial_resolved_no_payment_resource",
            not any(
                r["tool"] == "wallet.payment_method"
                for r in facts["audit"]["resources_resolved"]
            ),
            facts["audit"]["resources_resolved"],
        )
        check(
            "denial_called_no_webair_operation",
            not facts["observed_webair_requests"]
            and not facts["audit"]["tool_dispatches"],
        )
        check(
            "denial_made_no_model_call",
            not facts["observed_model_inputs"] and facts["model"].get("calls", 0) == 0,
        )
        # Chrome refuses the unapproved tool before its permission is checked (D-022); the audit names it.
        check(
            "denial_refused_the_payment_tool",
            "wallet.payment_method" in facts["audit"]["tools_refused"]
            and facts["failed_node"] == "payment",
            {"refused": facts["audit"]["tools_refused"], "node": facts["failed_node"]},
        )
        check(
            "denial_plan_denied_the_purchase_tools",
            {"simulate-purchase", "wallet.payment_method"}
            <= set(facts["run_plan"]["denied_tools"]),
            facts["run_plan"]["denied_tools"],
        )
        return None
    return None


def package_and_origin(network: bool, version: str) -> dict:
    archive = archive_for(version)
    package = load_package(archive)
    verification = verify_package(archive, KEY)
    local = archive.read_bytes()
    facts = {
        "artifact": str(archive.relative_to(ROOT)),
        "version": package.manifest["version"],
        "archive_sha256": hashlib.sha256(local).hexdigest(),
        "package_digest": package.digest,
        "signature_valid": bool(verification.get("valid")),
        "signer_fingerprint": verification.get("key_fingerprint"),
    }
    check(
        "package_signature_valid_for_webair_key",
        facts["signature_valid"] and facts["signer_fingerprint"] == FINGERPRINT,
        facts["signer_fingerprint"],
    )
    tag = version.replace(".", "_")  # 0.4.0 reports keep their check names
    check(f"package_is_{tag}", facts["version"] == version, facts["version"])
    if network:
        with urllib.request.urlopen(f"{SITE}/health", timeout=30) as response:
            health = json.loads(response.read())
        with urllib.request.urlopen(f"{SITE}/agent.pkg", timeout=60) as response:
            served = response.read()
        facts["origin"] = {
            "health": health,
            "served_sha256": hashlib.sha256(served).hexdigest(),
        }
        check(
            f"origin_health_names_the_{tag}_artifact",
            health.get("agent_package_sha256") == facts["archive_sha256"],
            health,
        )
        check(f"origin_serves_the_local_{tag}_bytes", served == local)
    return facts


def generic_code() -> dict:
    """No package-specific code in the Chrome runtime or shell (D-009): the two demo data files and the two UI hints are the whole allowance.

    `demo-documents.json` (T8, D-105) names the demo index and policy by the WebAir deployment's
    hostname, where they are served; it is data the Settings pages fill in, not behaviour (T9).
    """
    pattern = re.compile(
        r"(?i)webair|airline|passenger_demo|payment_demo|profile_demo|alex\.traveler"
    )
    allowed = {"src/extension/data/demo-host-resources.json", "src/extension/data/demo-documents.json"}
    offenders: list[str] = []
    for path in sorted((ROOT / "chrome-agent-browser" / "src").rglob("*")):
        if not path.is_file() or path.suffix not in {".ts", ".json", ".css", ".html"}:
            continue
        relative = str(path.relative_to(ROOT / "chrome-agent-browser"))
        if relative in allowed:
            continue
        for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            stripped = line.strip()
            if stripped.startswith(("//", "*", "/*")):
                continue
            if pattern.search(line):
                offenders.append(f"{relative}:{number}")
    # The two UI strings that name the demo (a hint and a button title) are presentation, not behaviour.
    presentation = [
        o
        for o in offenders
        if o.startswith(
            ("src/extension/sidepanel/sidepanel.ts", "src/extension/ui/vault-page.ts")
        )
    ]
    behaviour = [o for o in offenders if o not in presentation]
    check("no_webair_specific_generic_code", not behaviour, behaviour or None)
    return {
        "scanned": "chrome-agent-browser/src (code lines)",
        "allowed_data_file": sorted(allowed),
        "presentation_mentions": presentation,
        "behaviour_offenders": behaviour,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    parser.add_argument(
        "--no-network", action="store_true", help="skip the public-origin checks"
    )
    args = parser.parse_args()
    report_path = Path(args.report)
    document = json.loads(report_path.read_text())
    harness = document.get("harness") or {
        k: v
        for k, v in document.items()
        if k not in ("checks", "runs_verified", "verification", "passed_verification")
    }
    model = harness["model"]
    missing = [
        phase
        for phase in PHASES
        if not (
            ROOT
            / ((harness.get("runs") or {}).get(phase) or {}).get("directory", "<none>")
            / "run.json"
        ).exists()
    ]
    if missing and report_path.resolve() in {path.resolve() for path in COMMITTED_REPORTS}:
        # The committed evidence is rewritten only from a complete attempt (T5 review 1, nit 8).
        # An explicit --report elsewhere may verify a partial or failed attempt: its missing
        # phases become `<phase>_run_recorded` failures below (T5 review 2, nit 7).
        print(
            json.dumps(
                {
                    "report": str(report_path),
                    "error": "exported run directories are missing; nothing was written",
                    "missing_phases": missing,
                    "hint": "run chrome-agent-browser/scripts/e2e-webair-live.mjs first, or verify on the machine that holds examples/my-chrome-live-*; pass --report <other path> to verify a partial attempt",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
    classes = needles()
    check("harness_passed", harness.get("passed") is True, harness.get("failures"))
    check(
        "harness_recorded_in_test_mode",
        (harness.get("steps") or {}).get("setup", {}).get("testMode") is True,
    )
    check(
        "reconnect_adopted_the_run_in_flight",
        ((harness.get("steps") or {}).get("reconnect") or {}).get("adoptedRunId")
        == ((harness.get("steps") or {}).get("reconnect") or {}).get("runId")
        and bool(((harness.get("steps") or {}).get("reconnect") or {}).get("runId")),
        (harness.get("steps") or {}).get("reconnect"),
    )
    runs: dict = {}
    quote = None
    for phase in PHASES:
        entry = (harness.get("runs") or {}).get(phase)
        if not entry:
            check(f"{phase}_run_recorded", False, "no run exported for this phase")
            continue
        directory = ROOT / entry["directory"]
        if not (directory / "run.json").exists():
            check(
                f"{phase}_run_recorded", False, f"missing {entry['directory']}/run.json"
            )
            continue
        facts = run_facts(phase, directory, classes, model)
        outcome = phase_checks(phase, facts, directory, harness, quote)
        if phase == "quote":
            quote = outcome
        runs[phase] = facts
    if "search" in runs and "purchase" in runs:
        check(
            "purchase_and_search_ran_the_same_package_bytes",
            runs["search"]["package"] == runs["purchase"]["package"],
        )
    version = harness.get("packageVersion") or "0.4.0"
    package = package_and_origin(not args.no_network, version)
    code = generic_code()
    document = {
        # Named after the package version, as the report file is (T9 review 1, nit 8).
        "profile": f"chrome-webair-{version.replace('.', '')}-live-demo-v0",
        "milestone": f"T5: WebAir {version} end to end in the Chrome Agent Browser (Demo 3)"
        + ("" if version == "0.4.0" else "; T9 for 0.5.0"),
        "recorded": harness["recordedAt"][:10],
        "commands": {
            "harness": f"node chrome-agent-browser/scripts/e2e-webair-live.mjs --model {model}"
            + ("" if version == "0.4.0" else f" --version {version}"),
            "verify": "agentpkg/.venv/bin/python scripts/verify_chrome_webair_live.py",
        },
        "statement": f"The built extension, loaded in a real headless Chrome, discovered WebAir {version} on the public origin, verified and trusted it, authorized three profiles, and ran it on the model named here: a search, a cancelled search, a quote with the fictional demo passenger, a simulated purchase under a once grant whose replay the page and the worker both refused, and a purchase denied without the grant. Every run's audit chain re-verifies with agentpkg; no model request carried a sealed or personal value; the identity reached only prepare_booking and the payment identifier only simulate_purchase.",
        "notice": "Fictional data throughout (WebAir does not exist; no payment occurs). The report holds no credential, no host-resource value and no path on the operator's machine; run directories are named relative to the repository.",
        "model": {
            "selected": model,
            "provider": model.split("/")[0],
            "local": runs.get("search", {}).get("model", {}).get("local"),
        },
        "package": package,
        "generic_code": code,
        "harness": harness,
        "runs": runs,
        "checks": CHECKS,
        "passed": all(item["passed"] for item in CHECKS),
    }
    text = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
    report_path.write_text(text)
    print(
        json.dumps(
            {
                "report": str(report_path.relative_to(ROOT))
                if report_path.is_relative_to(ROOT)
                else str(report_path),
                "checks": len(CHECKS),
                "failed": [c["id"] for c in CHECKS if not c["passed"]],
                "passed": document["passed"],
            },
            indent=2,
        )
    )
    if not document["passed"]:
        print(
            "FAILED: " + ", ".join(c["id"] for c in CHECKS if not c["passed"]),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
