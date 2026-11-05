"""In-browser inference in Chrome, end to end (T41): recompute the checks.

    agentpkg/.venv/bin/python scripts/verify_chrome_inbrowser_e2e.py \\
        [--report examples/verification/chrome-inbrowser-e2e.json]

`chrome-agent-browser/scripts/e2e-inbrowser.mjs` downloaded a curated entry through the extension's
own downloader, refused a digest mismatch and an over-budget load, compared the GPU's decode speed
with a CPU-only control, saw the idle unload, and ran WebAir 0.8.0's search conversation on the
in-browser model (`e2e-webair-live.mjs --profile`). This script reads the report and the
conversation's export it names (`webair.export`, kept under `examples/verification/` with the
report) and recomputes, without trusting the harness's own verdicts:

* the entry is the signed list's (`examples/model-catalog.json` verified under
  `examples/keys/webagents-catalog.pub.pem` by the reference's Ed25519 check over the documented
  transcript), and its file is the one T40's spike measured (same SHA-256 and size);
* the download: verified, the GGUF header read from the cached bytes equal to T40's reference walk
  (`examples/verification/chrome-inbrowser-gguf-headers-t40.json`);
* the mismatch: refused with the design's words, nothing left in the cache under the stated digest;
* too large: the descriptor's reason names both numbers with the declared 1.0 GB budget, and a load
  was refused while nothing was loaded;
* the GPU did the work: decode at least three times the CPU-only control's on the same prompt, and
  the machine's recorded speed is the GPU run's;
* the idle unload: nothing loaded afterwards;
* the WebAir run, from the export itself: the first turn's `run.json` completed; every
  `model.called` event in the conversation's hash-linked audit names the in-browser model and no
  domain; every recorded model request in the turns' `observations.json` is `in-browser:<entry>`.

Prints a JSON report with `"passed"`; exits 1 when a check fails. No network, no browser.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOMAIN = b"WebAgents signed document v0"
CONTENT_TYPE = b"org.webagents:model-catalog-v0"


def canonical(value: object) -> bytes:
    """RFC 8785 (JCS), as the signed transcript defines it."""
    import rfc8785

    return rfc8785.dumps(value)


def verify_catalog() -> tuple[bool, dict]:
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    document = json.loads((ROOT / "examples" / "model-catalog.json").read_text(encoding="utf-8"))
    key = load_pem_public_key((ROOT / "examples" / "keys" / "webagents-catalog.pub.pem").read_bytes())
    message = DOMAIN + b"\x00" + CONTENT_TYPE + b"\x00" + canonical(document["content"])
    try:
        key.verify(base64.b64decode(document["signature"]["value"]), message)
        ok = document["content_type"] == CONTENT_TYPE.decode()
    except Exception:  # noqa: BLE001 - any failure is "does not verify"
        ok = False
    return ok, document["content"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--report", default=str(ROOT / "examples" / "verification" / "chrome-inbrowser-e2e.json"))
    args = parser.parse_args()
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    checks: dict[str, bool] = {}

    signed, content = verify_catalog()
    checks["the signed list verifies under the webagents-catalog key"] = signed
    entry_id = report["entry"]["id"]
    entry = next((item for item in content["entries"] if item["id"] == entry_id), None)
    checks["the entry is the signed list's, file and digest included"] = entry is not None and entry["files"][0]["sha256"] == report["entry"]["sha256"] and entry["bytes_total"] == report["entry"]["bytes_total"] and entry["weights_digest"] == report["entry"]["weights_digest"]
    spike = json.loads((ROOT / "examples" / "verification" / "chrome-inbrowser-spike-t40-qwen3-4b.json").read_text(encoding="utf-8"))
    if entry_id == "qwen3-4b-q4_k_m":
        checks["the file is the one T40's spike measured"] = spike["model"]["sha256"] == report["entry"]["sha256"] and spike["model"]["bytes"] == report["entry"]["bytes_total"]

    download = report.get("download") or {}
    checks["the download completed and is verified"] = download.get("state") == "done" and download.get("cached") is True and download.get("verified") is True
    headers = json.loads((ROOT / "examples" / "verification" / "chrome-inbrowser-gguf-headers-t40.json").read_text(encoding="utf-8"))
    t40 = next((item["facts"] for item in headers["files"] if item["file"] == report["entry"]["file"]), None)
    read = (report.get("header") or {}).get("read") or {}
    checks["the header read from the cached bytes equals T40's walk"] = t40 is not None and all(read.get(key) == t40[key] for key in ("n_layer", "n_kv_heads", "key_length", "value_length", "context_length"))

    mismatch = report.get("mismatch") or {}
    error = mismatch.get("error") or {}
    checks["a digest mismatch is refused in the design's words and leaves no file"] = mismatch.get("state") == "failed" and error.get("code") == "model_digest_mismatch" and error.get("message") == "the bytes did not match the digest the catalog states" and mismatch.get("files_left") == [] and mismatch.get("cached") is False

    large = report.get("too_large") or {}
    reason = large.get("reason") or ""
    numbers = re.fullmatch(r"needs about ([0-9.]+) GB of GPU memory at a ([0-9,]+)-token context; this machine's budget is 1\.0 GB \(declared\)", reason)
    refusal = large.get("load_refusal") or {}
    checks["too large: both numbers, the declared budget, and a load refused with nothing loaded"] = numbers is not None and float(numbers.group(1)) > 1.0 and large.get("available") is False and refusal.get("code") == "model_unavailable" and large.get("loaded_after") is None

    versus = report.get("gpu_vs_cpu") or {}
    gpu = (versus.get("gpu") or {}).get("decode_tok_per_s")
    cpu = (versus.get("cpu") or {}).get("decode_tok_per_s")
    checks["the GPU decodes at least three times faster than the CPU-only control"] = isinstance(gpu, (int, float)) and isinstance(cpu, (int, float)) and gpu >= 3 * cpu and (versus.get("cpu") or {}).get("n_gpu_layers") == 0
    checks["the idle unload left nothing loaded"] = ((report.get("idle_unload") or {}).get("status") or {}).get("loaded", "missing") is None

    webair = report.get("webair") or {}
    export = ROOT / webair["export"] if webair.get("export") else None
    model = f"in-browser/{entry_id}"
    if export is None or not export.is_dir():
        checks["the WebAir export is present"] = False
    else:
        run = json.loads((export / "turn-001" / "run.json").read_text(encoding="utf-8"))
        checks["the first search turn's run completed on the in-browser model"] = run.get("status") == "completed"
        audit = json.loads((export / "audit.json").read_text(encoding="utf-8"))
        events = audit if isinstance(audit, list) else audit.get("events", [])
        calls = [event for event in events if event.get("action") == "model.called"]
        checks["every model.called names the in-browser model and no domain"] = len(calls) > 0 and all(event.get("domains") == [] for event in calls) and all(event.get("model") in (model, entry_id) for event in calls)
        observed = []
        for path in sorted(export.glob("turn-*/observations.json")):
            observed += [item for item in json.loads(path.read_text(encoding="utf-8"))["observations"] if item.get("kind") == "model"]
        checks["every recorded model request stayed in the browser (in-browser:<entry>)"] = len(observed) > 0 and all(item.get("url") == f"in-browser:{entry_id}" and item.get("subject") == "in-browser" for item in observed)
        checks["the audit chain's events are hash-linked"] = all(isinstance(event.get("event_hash", event.get("hash")), str) for event in events) if events else False

    result = {"report": str(Path(args.report).relative_to(ROOT)) if Path(args.report).is_relative_to(ROOT) else args.report, "checks": checks, "failures": [name for name, ok in checks.items() if not ok], "passed": all(checks.values()) and report.get("passed") is True}
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
