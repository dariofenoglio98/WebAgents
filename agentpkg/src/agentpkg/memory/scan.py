"""The scan set (M-36, M-37, M-40 step 7) and its one scanner.

The scan set of a run is fixed when the run starts: the sealed values, by record id and pointer, of
every record of the store when the run is opened with the store (a `--memory-dir` in the CLI), and
otherwise empty; in fixture mode without a store, the values at the sealed pointers of the
replayed memory-read and host-resource answers (M-62). It is an exact-value check over values the
host holds, case-insensitive, anywhere in a document, keys included, with no depth cut-off; a
document holding more strings than the scanner reads is refused unread.
"""

from __future__ import annotations

from .model import SEALED_PLACEHOLDER, pointer_get, sealed_values_of

MAX_SCANNED_STRINGS = 1 << 20
INCOMPLETE = "incomplete"


def scan_strings(value, limit: int = MAX_SCANNED_STRINGS) -> list[str] | None:
    """Every string of a JSON value, keys included, lower-cased; None past `limit`."""
    found: list[str] = []
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            if len(found) >= limit:
                return None
            found.append(current.lower())
        elif isinstance(current, list):
            stack.extend(current)
        elif isinstance(current, dict):
            for key, item in current.items():
                if len(found) >= limit:
                    return None
                found.append(key.lower())
                stack.append(item)
    return found


def scan_set_of(records) -> list[dict]:
    """The scan set of a run opened with these records, sorted by record id then pointer."""
    out = [
        {"record_id": record["id"], "pointer": pointer, "value": value}
        for record in records
        for pointer, value in sealed_values_of(record)
    ]
    return sorted(out, key=lambda entry: (entry["record_id"], entry["pointer"]))


def find_all_sealed(value, scan: list[dict]):
    """Every scan-set entry found anywhere in `value`, in scan-set order, as `{record_id,
    pointer}`; `INCOMPLETE` when the document holds more strings than the scanner reads. The tool
    scan needs them all: one granted value must not hide another (M-36)."""
    if not scan:
        return []
    strings = scan_strings(value)
    if strings is None:
        return INCOMPLETE
    return [
        {"record_id": entry["record_id"], "pointer": entry["pointer"]}
        for entry in scan
        if any(entry["value"].lower() in text for text in strings)
    ]


def find_sealed(value, scan: list[dict]):
    """The first scan-set entry found anywhere in `value` as `{record_id, pointer}`, None, or
    `INCOMPLETE`: enough for a scan that refuses on any hit (M-37, M-40 step 7)."""
    hits = find_all_sealed(value, scan)
    if hits == INCOMPLETE:
        return INCOMPLETE
    return hits[0] if hits else None


def fixture_scan_set(answers) -> list[dict]:
    """M-62 without a store: `answers` are `(binding, output, legacy_sealed)` of every replayed
    answer; a memory view contributes the values at its `sealed` pointers, a legacy host-resource
    answer the values at its legacy type's sealed pointers."""
    out: list[dict] = []
    for binding, output, legacy_sealed in answers:
        if not isinstance(output, dict):
            continue
        if binding.startswith("host.memory.") and not binding.startswith("host.memory.agent."):
            sealed = [item for item in output.get("sealed") or [] if isinstance(item, str)]
            record_id = output["id"] if isinstance(output.get("id"), str) else "fixture"
            for pointer in sealed:
                value = pointer_get(output.get("fields"), pointer)
                if isinstance(value, str) and value != SEALED_PLACEHOLDER:
                    out.append({"record_id": record_id, "pointer": pointer, "value": value})
        elif binding.startswith("host.resource."):
            for pointer in legacy_sealed:
                value = pointer_get(output, pointer)
                if isinstance(value, str):
                    out.append(
                        {"record_id": f"fixture:{binding}", "pointer": pointer, "value": value}
                    )
    return out
