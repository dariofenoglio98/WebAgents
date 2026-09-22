# Agent browser control-plane milestone report

The acceptance criterion is met: **a loopback-only authenticated service opens
both shipped packages through one generic path, reports container, integrity,
schema, runtime, signature and publisher-trust state separately, defaults every
permission to deny, and turns explicit decisions into a digest-bound
authorization receipt — without executing anything.** This is an incremental
addition; no existing container, signature, validation or runtime behavior
changed.

Reference documentation: [the control plane](browser-control-plane.md).

## What was added

`agentpkg.browser` is the trusted control-plane boundary between the future
OpenClaw Agent Browser UI and the existing runtime:

```text
 package source ──▶ immutable snapshot ──▶ container/integrity/schema/runtime
        ▲                                            │
   file or HTTPS                                     ▼
                                     signature self-consistency
                                                     │
                                                     ▼
                                        publisher trust (operator pins)
                                                     │
                                                     ▼
                              generic summary ──▶ permission request (all deny)
                                                     │
                                                     ▼
                                    digest-bound authorization receipt  ──╳ no execution
```

| Module | Responsibility |
|---|---|
| `browser/control.py` | Transport-free control plane: sessions, snapshots, capacity, TTL, cleanup |
| `browser/evaluation.py` | Layered validation and signature self-consistency |
| `browser/trust.py` | Operator-controlled publisher trust store and two-sided trust evaluation |
| `browser/summary.py` | Bounded, domain-independent browser summary and warnings |
| `browser/authorization.py` | Permission request, decision normalization, blocking reasons, receipts |
| `browser/fetch.py` | SSRF-hardened HTTPS acquisition in a killable child |
| `browser/server.py` | Loopback HTTP transport, bearer auth, strict JSON routing |
| `browser/errors.py` | Stable error codes with HTTP status mapping |
| `netaddr.py` | Destination-address policy shared with the existing tool transport |

## Files created and changed

**Created:** `agentpkg/src/agentpkg/browser/{__init__,control,evaluation,trust,summary,authorization,fetch,server,errors}.py`,
`agentpkg/src/agentpkg/netaddr.py`,
`agentpkg/tests/test_browser_{control,trust,fetch,service,boundary}.py`,
`scripts/verify_browser.py`, `docs/browser-control-plane.md`, this report,
`examples/verification/browser-verification.json`,
`examples/verification/browser-agentpkg-tests.{txt,xml}`.

**Changed, minimally and backward compatibly:**

| File | Change | Why |
|---|---|---|
| `errors.py` | Added `IntegrityError(ValidationError)` | Lets the control plane say "the archive parsed but its hashes disagree" instead of collapsing container and integrity into one failure. Every existing `except ValidationError` still catches it. |
| `package.py` | Raise `IntegrityError` at the one hash-comparison site; add public `read_archive()` and `read_regular_bytes()` | Exposes the container/integrity layer on its own and shares the bounded no-follow read instead of duplicating it. |
| `signing.py` | Factored `embedded_public_key()` and `check_signature()` out of `verify_package()` | The control plane needs self-consistency checking without a pinned key. `verify_package` behavior and error messages are unchanged. |
| `openclaw.py` | `_read_regular` delegates to `package.read_regular_bytes` | Removes the duplicate. `stage_openclaw` is otherwise untouched. |
| `tools.py` | `request_json` uses `netaddr.public_address_reason` | Strengthens an existing control: `ipaddress.is_global` alone accepted multicast and the NAT64 prefix. Same error message, strictly stricter. |
| `cli.py` | `browser-serve` and `trust` subcommands; flushed JSON output; SIGTERM cleanup | Operator entry points. |
| `spec/agent-pkg-v0.md`, `docs/threat-model.md`, `docs/openclaw-integration.md`, both READMEs | Documentation | URL acquisition, the trust/signature distinction, the `always` refusal, and the staging-vs-control-plane split. |

## Service command

```sh
agentpkg browser-serve --host 127.0.0.1 --port 8765 \
  --trust-store ~/.config/agentpkg/trust.json \
  --cache-dir /tmp/agentpkg-browser-cache \
  --token-file /tmp/agentpkg.token \
  --session-ttl 900 --max-sessions 8
```

It prints one JSON line with the URL and bearer token. `--host` accepts loopback
literals only; `0.0.0.0`, `::` and LAN addresses are refused with
`bind_rejected`, and there is no public-binding mode. Trust pins are managed
separately with `agentpkg trust list|add|remove`.

## API

`/v0/health` (unauthenticated), `/v0/status`, `POST /v0/packages/open-file`,
`POST /v0/packages/open-url`, `GET /v0/packages`, `GET /v0/packages/{id}`,
`GET /v0/packages/{id}/permissions`, `POST /v0/packages/{id}/authorize`,
`GET /v0/packages/{id}/authorization`, `DELETE /v0/packages/{id}`,
`GET|POST /v0/trust`, `DELETE /v0/trust/{fingerprint}`. Full table, error codes
and transport hardening: [control plane §8](browser-control-plane.md#8-api).

## Trust-store design

A JSON file of explicit key pins whose identity is the **fingerprint**, with
optional `publisher_id` and `package_id_prefix` constraints. It lives outside
every package, is written atomically at `0600`, refuses private keys, is
re-derived and re-checked on every read, and is mutated only through the
authenticated API or the CLI. Trust evaluation is two-sided, so a package whose
claimed publisher is pinned to other keys is reported as `mismatch` rather than
merely `unknown`. Format and rules: [§6](browser-control-plane.md#6-trust-store-format).

## Snapshot strategy

Bytes are captured once, hashed, written to a private `0600` file in a `0700`
service-owned directory with exclusive creation and `O_NOFOLLOW`, re-read and
re-hashed, and every later answer comes from that snapshot. The source path or
URL becomes metadata. The package is never extracted: a session directory holds
exactly the snapshot and a marker file. Replacing the source file after opening
provably changes nothing (tested).

## SSRF defenses

HTTPS on port 443 only; no credentials, fragments, control characters or
non-default ports; every resolved address classified and refused unless
publicly routable; the socket pinned to the validated address with TLS still
bound to the hostname; redirects refused; declared and streamed size caps; one
wall-clock deadline over DNS, connect, TLS and read — all inside a killable
child process. Refused classes carry their own reason: `loopback_address`,
`private_address`, `link_local_address`, `multicast_address`,
`reserved_address`, `unspecified_address`, `cloud_metadata_address`,
`ipv4_mapped_address`, `sixtofour_address`, `teredo_address`, `nat64_address`,
`non_global_address`. Local files are a separate operator operation with no path
through the URL endpoint.

Two classes are worth calling out because `ipaddress.is_global` reports them as
global: multicast (`224.0.0.1`, `ff02::1`) and the NAT64 prefix
(`64:ff9b::7f00:1` encodes 127.0.0.1). The shared `netaddr` module now handles
both, in the control plane **and** in the pre-existing `tools.request_json`
transport.

## Signature and trust semantics

| State | Meaning |
|---|---|
| `signature_status: valid` | The embedded key matches its fingerprint, the signed digest equals the package's integrity digest, and the domain-separated Ed25519 transcript verifies. **Says nothing about who the publisher is.** |
| `signature_status: invalid` / `absent` | Broken/mismatched signature, or none at all. Can never become trusted. |
| `trust_status: trusted` | The operator pinned that exact key, and the pin's `publisher_id`/`package_id_prefix` constraints hold. |
| `trust_status: unknown` | Nobody pinned this key. A cryptographically perfect signature from an unknown key stays here. |
| `trust_status: mismatch` | The key is pinned to another publisher, the package ID is outside the pin's prefix, or the claimed publisher is pinned to different keys (impersonation signal). |

## Authorization receipt

Bound to the package digest, the archive SHA-256 of the exact snapshot, the
signer fingerprint, the trust-store state hash, the decisions, the session and
the timestamp, plus a `receipt_sha256` over its canonical form. `runnable` is
true only when every layer is valid, the profile is supported, the signature is
valid, the publisher is trusted and every required permission was granted;
otherwise `blocking_reasons` lists stable codes with a machine-readable
`subject`. Decisions are `deny` (default), `once` and `session`. **`always` is
refused with an explanation**, because the runtime's `always` is not persistent
and no host authorization store exists — the discrepancy is surfaced rather than
hidden. Shape: [§7](browser-control-plane.md#7-authorization-semantics).

## Tests and results

| Suite | Result |
|---|---|
| Full `agentpkg` suite | **342 passed, 1 skipped** (baseline 231 passed, 1 skipped) |
| New control-plane tests | **111** across five files |
| Citation Resolver suite | **132 passed** (untouched) |
| Opt-in installed-OpenClaw discovery | **8 passed** with `AGENTPKG_TEST_OPENCLAW=1` |
| `ruff check` / `ruff format --check` on `agentpkg` and `scripts` | passed |
| `scripts/verify_workflow.py` | passed, both packages, legacy signature preserved |
| `scripts/verify_browser.py` | passed |
| Existing fixture demos | byte-identical exports to `examples/workflow-review/` and `examples/workflow-agenda/` |

New test files:

| File | Tests | Covers |
|---|---:|---|
| `test_browser_control.py` | 33 | Both shipped packages through one path; layered validation; summaries differing only by declaration; snapshot immutability; malformed/corrupted/tampered/unsigned/unsupported-profile packages; deny-by-default; `once`; `always` refusal; digest binding; receipt non-transferability; oversized packages; TTL, session/cache caps, close, startup sweep; concurrent-open capacity |
| `test_browser_fetch.py` | 48 | 11 refused URL syntaxes; 23 refused destination classes; DNS rebinding; unresolvable hosts; redirect, 404, streamed-oversize and lying `Content-Length` against a controlled origin; end-to-end URL open; policy applied before any injected transport |
| `test_browser_service.py` | 14 | Loopback-only binding; health open, everything else authenticated; wrong/basic tokens; per-process tokens; browser-origin and Host-header refusal; no CORS; body size, strict fields, unknown routes/methods; full open→pin→authorize→deny→close flow; trust mutation requires the token; private keys refused |
| `test_browser_trust.py` | 11 | Fingerprint identity; add/list/remove/replace; private-key refusal; unknown key; publisher pinned to another key; key bound to another publisher; prefix scoping; unsigned can never be trusted; **package operations never touch the store**; trust-state changes visible in receipts; corrupted store fails closed |
| `test_browser_boundary.py` | 5 | AST import scan of every browser module; no dynamic execution hooks; fresh-interpreter `sys.modules` proof after a full cycle on both packages; no execution entry point; receipts state nothing ran |

Saved evidence: [`browser-verification.json`](../examples/verification/browser-verification.json),
[`browser-agentpkg-tests.txt`](../examples/verification/browser-agentpkg-tests.txt).

## Manual verification

```sh
# Start the service (prints its URL and bearer token).
agentpkg/.venv/bin/agentpkg browser-serve --port 8765 \
  --trust-store /tmp/demo/trust.json --cache-dir /tmp/demo/cache \
  --token-file /tmp/demo/token
export TOKEN=$(cat /tmp/demo/token) B=http://127.0.0.1:8765

# A. health (no token required)
curl -sS $B/v0/health

# B/C. open both packages locally
curl -sS -X POST $B/v0/packages/open-file -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"path\": \"$PWD/dist/literature-review.agent.pkg\"}"
curl -sS -X POST $B/v0/packages/open-file -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"path\": \"$PWD/dist/meeting-agenda.agent.pkg\"}"
# → signature_status "valid", trust_status "unknown"

# D. pin the development publisher key
python3 -c 'import json;print(json.dumps({
  "public_key_pem": open("examples/keys/workflow-publisher.pub.pem").read(),
  "display_name": "WebAgents development key",
  "publisher_id": "webagents-research",
  "package_id_prefix": "org.webagents."}))' > /tmp/demo/pin.json
curl -sS -X POST $B/v0/trust -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data-binary @/tmp/demo/pin.json

# E. reopen: trust_status is now "trusted"
curl -sS -X POST $B/v0/packages/open-file -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"path\": \"$PWD/dist/literature-review.agent.pkg\"}"
export SID=<session id from that response> DIG=<package.digest from that response>

# F. requested permissions, all denied by default
curl -sS -H "Authorization: Bearer $TOKEN" $B/v0/packages/$SID/permissions

# G/H. grant and receive runnable: true
curl -sS -X POST $B/v0/packages/$SID/authorize -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"package_digest\":\"$DIG\",\"decisions\":{
    \"network.scholarly\":\"session\",\"network.citations\":\"session\",
    \"memory.session\":\"session\",\"model.reasoning\":\"session\",\"files.pdfs\":\"deny\"}}"

# I. deny a required permission -> runnable: false
curl -sS -X POST $B/v0/packages/$SID/authorize -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"package_digest\":\"$DIG\",\"decisions\":{
    \"network.scholarly\":\"session\",\"network.citations\":\"deny\",
    \"memory.session\":\"session\"}}"
```

Observed results: `runnable: true` with `blocking_reasons: []` in step H, and in
step I `runnable: false` with
`{"code": "required_permission_denied", "subject": "network.citations"}`. A wrong
digest returns `409 digest_mismatch`; an unauthenticated call returns `401`; a
request carrying `Origin` returns `403 browser_request_refused`.

URL policy over the same service (these run the real killable-child path):

```sh
for U in http://packages.example/a.agent.pkg https://127.0.0.1/a.agent.pkg \
         file:///etc/passwd https://localhost/a.agent.pkg; do
  curl -sS -X POST $B/v0/packages/open-url -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "{\"url\":\"$U\"}"
done
# → url_rejected (scheme), url_destination_denied (loopback_address),
#   url_rejected (scheme), url_destination_denied (loopback_address)
```

A successful URL open is demonstrated against a local mock origin in
`test_browser_fetch.py::test_open_url_snapshots_a_hosted_package` and in
`scripts/verify_browser.py`; no real HTTPS-hosted `.agent.pkg` exists yet, and
no Railway deployment was performed.

Cleanup, observed manually: `SIGTERM` leaves an empty cache directory; after
`SIGKILL` the stale `session-*` directory survives and the next start reports
`removed_stale_snapshots_at_startup: 1` and removes it.

## OpenClaw

Installed host: **OpenClaw 2026.9.5 (`ec9c1a1`)**. Its feature-plugin
documentation was read read-only at
`/opt/homebrew/lib/node_modules/openclaw/docs/plugins/{feature-plugins,plugin-permission-requests}.md`.
Relevant to the next milestone: `openclaw plugins init <id> --type feature`;
the `feature-contract` / `feature-plugin` / `control-ui` SDK entry points;
TypeBox-typed operations where queries need `operator.read` and actions
`operator.write`; "backend inputs, outputs, and events are validated as bounded
JSON"; native Control UI gated behind **Settings → Labs → Custom plugin UI** and
requiring HTTPS or a browser-trusted loopback origin; and `plugin.approval.*` as
the host's per-call approval surface. **Nothing in the OpenClaw installation was
modified.**

## Known limitations

* The bearer token is the boundary against other local processes. A process
  already running as the same user can read the token file and the snapshot
  cache; this service does not defend against that, consistent with the rest of
  the prototype.
* One service per cache directory. A second service started on the same
  `--cache-dir` removes the first's snapshots at startup; pass a distinct
  directory to run two.
* Authorization receipts live and die with their session. Nothing is persisted,
  which is also why `always` is refused.
* TLS certificate pinning, proxies, revocation checking and registry allowlists
  do not exist. Certificate validation uses the system trust store, and the
  pinned-TLS connector is exercised only against real hosts; tests drive the
  same policy function with stubbed transport mechanics.
* The trust store is a placeholder for NANDA/CA/attestation infrastructure. It
  has no rotation, revocation, expiry, transparency log or delegation.
* Attestations and evals are summarized, never verified. `verified_by_host` is
  explicitly `false` in the summary.
* A package whose declared graph is huge can make validation slow; JSON Schema
  validation remains in-process and is not CPU-isolated, as documented
  elsewhere in this prototype.
* The service is single-instance and in-memory; there is no clustering,
  persistence or metrics endpoint.

## Before building the OpenClaw UI

1. **Decide where consent lives.** Session-scoped receipts are correct for a
   research prototype but mean re-authorizing after every restart. A persistent
   host authorization store is the prerequisite for ever offering `always`, and
   it needs its own revocation and review surface.
2. **Decide who owns the token.** The plugin backend must obtain the bearer
   token without putting it in Control UI browser code. A plugin-managed service
   lifecycle (spawn, hold the token server-side, expose typed operations) is
   cleaner than asking an operator to paste a token.
3. **Render the distinction, not a padlock.** `signature_status` and
   `trust_status` must remain visibly separate in the UI. Collapsing them into
   one "verified" badge would undo the central property of this milestone.
4. **Warnings are data.** Each has a stable `code` and `severity`; the UI should
   map codes, never parse messages. The same applies to `blocking_reasons` and
   their `subject`.
5. **The run milestone must re-verify.** A receipt is evidence of consent, not a
   capability. Before executing, the runner must re-open the snapshot, confirm
   the digest and archive hash still match, confirm the trust state, and map
   decisions onto runtime grants. Tool approvals are already recorded for that
   step.
6. **Nothing here proves runtime enforcement.** Budgets, delegation limits, state
   isolation and audit live in the runtime and are covered by
   [workflow.v0](../spec/workflow-v0.md). An authorization receipt says a package
   *may* run; it does not say the host will hold it to its policy.
