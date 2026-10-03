# The agent browser control plane

This is the trusted local boundary that the future OpenClaw Agent Browser will
sit on top of. It answers one question completely — *may this package run, and
with what authority?* — and deliberately stops before running anything.

```text
   OpenClaw Agent Browser UI            (built next: openclaw-agent-browser/)
            │  loopback HTTP + bearer token
            ▼
   agentpkg browser control plane       (this document)
   package acquisition · immutable snapshot · layered validation ·
   signature check · publisher trust · inspection · authorization receipt
            │  receipt bound to exact bytes
            ▼
   agentpkg runtime                     (later milestone; never imported here)
```

A UI should not implement cryptography, archive parsing, trust semantics or
permission validation. Putting that boundary in one testable service first is
the point of this milestone.

Status: research prototype. It is not an OpenClaw, NANDA or industry standard,
and it is not a substitute for the future infrastructure it stands in for.

## 1. Lifecycle

```text
 package source (local .agent.pkg | HTTPS URL, typed or advertised by a website — §3a)
        │
        ▼  bytes captured exactly once
 immutable snapshot  →  archive_sha256, private 0600 file in the service cache
        │
        ▼  container_status
 structural/integrity validation  →  integrity_status
        │
        ▼  schema_status, runtime_status
 signature verification  →  signature_status ∈ valid | invalid | absent
        │
        ▼
 publisher trust evaluation  →  trust_status ∈ trusted | unknown | mismatch
        │
        ▼
 package inspection  →  bounded generic browser summary
        │
        ▼
 requested-permission inspection  →  every decision defaults to deny
        │
        ▼
 explicit authorization decision  →  digest-bound receipt, runnable true/false
        │
        ✕  STOP. This service executes nothing.
```

The control plane never gains an execution path. A ready run plan is handed to a
[separate trusted namespace](model-router-bridge.md) that the control plane
cannot import, and which is the only place a model can be reached.

## 2. Immutable snapshot semantics

`open-file` and `open-url` both end in the same private operation:

1. the bytes are read or downloaded **once** into memory, under the configured
   size bound;
2. `archive_sha256` is computed from those bytes;
3. they are written to `<cache>/session-<id>/package.agent.pkg` with exclusive
   creation, `O_NOFOLLOW` and mode `0600`, inside a `0700` directory the
   service owns;
4. the file is read back and rehashed; a mismatch aborts the open;
5. every later answer for that session comes from the `Package` object loaded
   from that snapshot.

Consequences that matter:

* the original path or URL is **metadata only** after step 2. Replacing the
  file on disk, or re-serving different bytes from the same URL, cannot change
  what a session says or what a receipt authorizes;
* there is no verify-then-reload window, which is the classic way a signature
  check gets detached from the bytes that later run;
* the package is never extracted. A session directory contains exactly the
  snapshot and a marker file. Opening a package touches no other path.

Only built `.agent.pkg` artifacts are accepted. A source directory is a
build-time concept and is refused with `source_rejected`.

## 3. URL fetching and the SSRF threat model

The future UI will accept arbitrary package URLs from arbitrary people, so URL
fetching is treated as the most dangerous input in this service. **A package
URL must not become a way to reach the host machine or its private network.**

Policy, applied in this order with no exception path:

| Stage | Rule |
|---|---|
| Scheme | `https://` only. `http`, `file`, `ftp`, `gopher` and everything else are refused. |
| Credentials | No userinfo; any `@` in the authority is refused. |
| Port | 443 only. |
| Syntax | No fragment, no whitespace or control bytes, at most 2048 characters, host required. |
| Resolution | Every resolved address must pass `agentpkg.netaddr.public_address_reason`. |
| Rebinding | The socket is pinned to the validated address while TLS still verifies the original hostname, so a second DNS answer cannot redirect the connection. |
| Redirects | Refused. A hop would need the whole policy re-applied; disabling them is simpler to trust. |
| Size | Declared `Content-Length` and streamed bytes are both capped. |
| Time | One wall-clock deadline covers DNS, connect, TLS and read. |

Refused destination classes, each reported with its own stable reason:
`loopback_address`, `private_address`, `link_local_address`,
`multicast_address`, `reserved_address`, `unspecified_address`,
`cloud_metadata_address` (including 169.254.169.254, 169.254.170.2,
100.100.100.200, 192.0.0.192, fd00:ec2::254), `ipv4_mapped_address`,
`sixtofour_address`, `teredo_address`, `nat64_address`, `non_global_address`.

Two of these are easy to miss and are handled explicitly: Python reports
multicast and the NAT64 prefix `64:ff9b::/96` as *global*, so `is_global` alone
would have allowed `224.0.0.1` and `64:ff9b::7f00:1` (NAT64 for 127.0.0.1).
`agentpkg.netaddr` is now shared with the existing tool transport in
`tools.request_json`, which closes the same gap there.

Resolution, connection and transfer run inside a **killable child process**
(the pattern already used by the bundled PDF reader), so a hostile or slow
origin cannot hold a request thread, a socket, or a blocking resolver call
open past the deadline. The parent terminates, kills and reaps the child.

Local files are a **separate operator operation**. There is no way to reach a
local path through the URL endpoint, and no dev flag that relaxes the scheme
or destination rules.

### Known limits

TLS pinning is exercised against real hosts only; tests drive the same policy
function with stubbed resolver/connector mechanics. Certificate validation uses
the system trust store. There is no proxy support, no revocation checking, no
Tor/onion handling, and no allowlist of package registries yet.

## 3a. Website discovery

A person may give the browser an ordinary website address instead of a package
URL. `POST /v0/websites/discover {"url": "https://…"}` reads that one page and
reports every `<link rel="agent-package">` in its head as an **untrusted
candidate** (`agentpkg.browser.discovery`):

```text
 website URL, e.g. https://webair.example/
      │  the package URL policy, in a killable child; same-origin redirects only
      ▼
 one HTML page: bounded, tokenized, never rendered
      │  document head only; no script runs, nothing it references is fetched
      ▼
 rel="agent-package" links, resolved against the page's final URL
      │  same-origin profile: anything else is reported and never fetched
      ▼
 untrusted candidate(s): a location and nothing more
      │  a person chooses Inspect
      ▼
 open-url → snapshot → validation → signature → trust → permissions → authorization
```

`rel="agent-package"` and `application/vnd.webagents.agent-package` are an
**experimental WebAgents convention**. Neither is a registered link relation or
media type, and nothing here is a web standard.

**An advertisement conveys a location, and nothing else.** Not identity — the
page's metadata is never shown as the package's name, publisher or version;
not integrity or a valid signature; not publisher trust, which stays a key the
operator pinned; not permission, authorization or a tool binding; and not
execution. Discovery creates no session, writes nothing to the cache or the
trust store, and does not fetch the candidate. Inspecting one is
`POST /v0/packages/open-url` with its `resolved_url`: the same operation,
policy and verdicts as a typed package URL, including its refusal of
redirects. A package opened that way can still be invalid, unsigned, signed
by an unknown key, or an impersonation, and is reported exactly so.

### Network policy

| | Package download (`open-url`) | Website discovery |
|---|---|---|
| Syntax | HTTPS, port 443, no credentials, no fragment, ≤ 2048 characters | The same function. A fragment is dropped rather than refused, since it is never sent |
| Resolution | Every answer must be public (`agentpkg.netaddr`) | The same, again for every redirect hop, so a second answer cannot carry a later hop somewhere private |
| Connection | Pinned to the validated address, TLS bound to the hostname | The same connector |
| Redirects | Refused | Followed only within one origin (scheme, host, effective port), at most 5, each hop validated, resolved and classified again. Any other target is refused (`discovery_redirect_refused`) and reported, never contacted |
| Response | `200`, any bytes, ≤ 32 MiB | `200` with an HTML Content-Type (`text/html`, `application/xhtml+xml`); identity, gzip or deflate content, at most 1 MiB read and decompressed under the same cap |
| Request | No cookie, credential or proxy | `Accept` HTML, `Accept-Encoding: identity`, the browser's User-Agent; no `Cookie`, `Authorization`, `Referer` or `Origin`; `Set-Cookie` is ignored |
| Time | 60 s | 20 s for the whole discovery, every hop included |
| Process | Killable child | The same helper (`run_in_killable_child`), which also runs the parse |

Never followed or fetched: `<meta http-equiv="refresh">`, scripts, styles,
images, frames, preload or icon links, and the advertised package itself.

### Which links count

* **Only the document head**, by the HTML tree builder's rules: the head ends
  at the first start tag that cannot be in it, the first non-whitespace text,
  or `</body>`, `</html>` or `</br>`; a link between `</head>` and the body
  still belongs to it. A link relation that is not body-ok is conforming only
  in the head, and the rule keeps text a site's visitors can post into its body
  out of discovery. Reading stops where the head ends; a page whose head does
  not end within 1 MiB is refused (`discovery_too_large`) rather than judged
  on part of it.
* Ignored, as a browser would: links inside comments, inside `script`, `style`,
  `title`, `noframes` and other text-only elements (`<script/>` still opens a
  script, since HTML ignores the slash), and inside `<template>` contents. Of
  duplicated attributes the first wins.
* `rel` is a set of ASCII-whitespace-separated tokens compared ASCII
  case-insensitively, so `rel="stylesheet agent-package"` counts and
  `rel="agent-packages"` does not.
* A `type` attribute, when present, must name the media type above
  (parameters and case ignored). It is a hint about the link, never evidence
  about the bytes; the package path judges those.
* Encoding: a byte-order mark, then the HTTP charset, then a `<meta>`
  declaration in the first 1024 bytes. Markup and every URL this profile
  accepts are ASCII, which every ASCII-compatible encoding writes the same
  way, so those pages are read as UTF-8 with replacement characters; UTF-16 is
  decoded as UTF-16; ISO-2022-JP and the WHATWG "replacement" encodings are
  refused. Malformed bytes never fail a page.
* The tokenizer is the standard library's `html.parser`; no regular expression
  reads HTML. Text-only elements and templates are tracked by discovery itself,
  so the result is the same on every supported Python version.

### Resolution and the same-origin profile

A candidate's `href` is resolved against the page's final URL after redirects,
by RFC 3986 reference resolution (`urljoin`), which agrees with browsers on
every href this profile accepts. `<base href>` is deliberately not used (the
result says when one was present): page markup cannot re-anchor where its
advertisements point. An href that a browser and this resolver could read
differently is refused before resolution: internal whitespace or control
characters, a backslash, non-ASCII characters, or more than 2048 characters.

For `https://airline.example/travel/`, `/agent.pkg` is
`https://airline.example/agent.pkg` and `agents/current.agent.pkg` is
`https://airline.example/travel/agents/current.agent.pkg`.

A candidate is accepted only as an `https:` URL without credentials, on the
page's **own origin** — same scheme, host and effective port (`example.com.`
and `example.com` are different hosts, as in browsers) — without a fragment,
not the page itself, and passing the package URL policy. Each rejection has a
stable reason: `href_missing`, `href_empty`, `href_malformed`,
`fragment_only`, `unsupported_scheme`, `credentials_not_allowed`,
`cross_origin`, `fragment_not_allowed`, `points_to_page`, `url_rejected`,
`unsupported_type`, `duplicate`. Untrusted text in a rejected href is shown
with non-printable characters escaped, so it cannot hide behind control or
bidirectional-override characters.

A cross-origin advertisement is reported (`cross_origin`, naming what
differs) and never resolved, contacted or fetched. Letting one origin
delegate its package to another would need an explicit, verifiable delegation
mechanism; that is possible future work and not part of this prototype.

Several acceptable candidates are all listed (`multiple_candidates`) and none
is chosen: HTML defines no priority among them, and this profile invents none.
The same URL advertised twice is listed once (`duplicate`).

### Result

```json
{
  "schema": "agentpkg-website-discovery-v0",
  "requested_url": "https://webair.example/",
  "final_url": "https://webair.example/",
  "page_origin": "https://webair.example",
  "redirects": [],
  "discovery_status": "candidate",
  "candidates": [{
    "index": 0, "href": "/agent.pkg",
    "type_hint": "application/vnd.webagents.agent-package",
    "resolved_url": "https://webair.example/agent.pkg", "same_origin": true,
    "accepted": true, "rejection_reason": null, "rejection_message": null
  }],
  "accepted_count": 1, "rejected_count": 0, "links_not_listed": 0,
  "page": {"content_type": "text/html", "declared_charset": "utf-8", "decoded_as": "utf-8",
           "encoding_source": "http", "content_coding": "identity", "bytes_read": 3862,
           "truncated": false, "head_ended": true, "html_sha256": "…",
           "base_element_ignored": false},
  "profile": {"name": "same-origin-v0", "rel": "agent-package", "…": "…"},
  "trust": {"conveys": "location_only", "package_verified": false,
            "publisher_trusted": false, "permissions_granted": false, "note": "…"},
  "execution": {"performed": false, "package_fetched": false, "note": "…"},
  "discovered_at": "…"
}
```

`discovery_status` is `candidate`, `multiple_candidates`, `no_candidate` or
`candidates_rejected`. The page itself is not kept: no HTML, cookie or
response header is returned, only a SHA-256 of the bytes read. A page that
cannot be read is a typed error: `url_rejected`, `url_unresolvable`,
`url_destination_denied`, `discovery_redirect_refused`,
`discovery_http_status`, `discovery_not_html`,
`discovery_encoding_unsupported`, `discovery_too_large`, `discovery_timeout`
or `discovery_failed`.

**Audit.** The control plane has no event log for pre-execution actions: its
records are sessions and receipts, and the hash-linked audit belongs to runs.
Discovery creates neither a session nor an execution, so it is not written
into any audit chain. Its typed result carries what an audit would — the
requested URL, final origin, redirects, every candidate with its verdict and
reason — and the Agent Browser backend writes one structured Gateway log line
when a discovery starts and one when it finishes or is refused.

**Tests.** `agentpkg/tests/test_browser_discovery.py` drives the production
path with only DNS and sockets replaced (`agentpkg/tests/web_fixtures.py`),
against WebAir's own pages (`examples/webair-site.json`, generated by
`demo/webair/publisher`) and its real signed package, a second unrelated
origin, and hostile pages. The offline acceptance record is
[`webair-010-discovery.json`](../examples/verification/webair-010-discovery.json),
written by `scripts/verify_webair_discovery.py`.

## 4. Validation layers are reported separately

A single `valid: true` would hide exactly the distinctions a user needs. The
control plane reports four independent layers plus two publisher fields:

| Field | Values | Meaning |
|---|---|---|
| `container_status` | valid, invalid | Strict standalone ZIP, portable paths, resource bounds, UTF-8 data-only payload. |
| `integrity_status` | valid, invalid, not_evaluated | Every payload member hashes to its entry in `integrity.json`. |
| `schema_status` | valid, invalid, not_evaluated | Manifest, graph, policy, tools, schemas, evals and all cross-references. |
| `runtime_status` | compatible, incompatible, not_evaluated | An installed execution profile can run it (`workflow.v0` today). |
| `signature_status` | valid, invalid, absent | See below. |
| `trust_status` | trusted, unknown, mismatch | See below. |

`not_evaluated` is honest: values read out of a payload that failed integrity
would mean nothing, so the later layers are not attempted.

Container, integrity or schema failure means **no session is created**; the
error carries the layered report so a UI can explain the rejection. An
unsupported execution profile is different — the package is still fully
inspectable, so a session *is* created and `runnable` will be false.

To separate container from integrity cleanly, `agentpkg.errors` gained a narrow
`IntegrityError(ValidationError)`, raised at the one place `package.py` compares
payload hashes. Every existing caller that catches `ValidationError` is
unaffected.

## 5. Signature valid ≠ publisher trusted

This distinction is the heart of the trust model.

An artifact carries its own public key and fingerprint. Checking a signature
with that embedded key answers only: *is this envelope internally consistent?*
It says nothing about who the publisher is. Anyone can generate a key, sign a
package, and claim any `publisher.id` string in the manifest.

* `signature_status: valid` — the embedded key matches its stated fingerprint,
  the signed digest equals the package's own integrity digest, and the
  domain-separated Ed25519 transcript verifies.
* `trust_status: trusted` — **the operator independently pinned that exact key**
  in the local trust store, and the pin's constraints hold.

So a self-consistent signature from an unknown key stays `unknown`, and the
browser summary carries a `publisher_unknown` warning. An invalid or absent
signature can never become trusted; `trust_reason` is then `no_valid_signature`.

`mismatch` is a third, louder state. It fires when:

* the signer's key is pinned, but bound to a different `publisher_id`
  (`pinned_key_bound_to_other_publisher`);
* the signer's key is pinned, but the package ID falls outside the pin's
  allowed prefix (`package_id_outside_pinned_prefix`);
* the claimed publisher is pinned to *other* keys and this signer is not among
  them (`claimed_publisher_pinned_to_other_key`) — the impersonation case.

The third rule is why the lookup is two-sided rather than a simple fingerprint
search: without it, a package claiming a publisher you already know, signed by
a key you have never seen, would be reported as merely `unknown`.

## 6. Trust store format

A small operator-controlled JSON file, by default
`${XDG_CONFIG_HOME:-~/.config}/agentpkg/trust.json`, overridable with
`--trust-store` or `AGENTPKG_TRUST_STORE`. It is written atomically at mode
`0600`, and is refused if it is a symlink, group/world writable, oversized, or
internally inconsistent.

```json
{
  "format": "agentpkg-trust-store-v0",
  "updated_at": "2026-09-21T20:51:42.986353+00:00",
  "publishers": [
    {
      "fingerprint": "sha256:c7549e614dac7070e6b5b5355e7c2407e1185f831d7fff15670981229dd85a70",
      "public_key": "HOnGZWXq8RFj7a409vCakK4MtdpDhgMcPdK3Y775ens=",
      "display_name": "WebAgents development key",
      "publisher_id": "webagents-research",
      "package_id_prefix": "org.webagents.",
      "notes": "milestone demo pin",
      "added_at": "2026-09-21T20:51:42.986353+00:00"
    }
  ]
}
```

Rules:

* the **fingerprint is the identity**; `publisher_id` and `package_id_prefix`
  are optional narrowing constraints, not the key's name;
* every entry is re-derived and re-checked on read — an entry whose fingerprint
  does not match its key fails the whole store closed;
* only public keys. A PEM containing `PRIVATE KEY` is refused with
  `trust_private_key_refused`, and no private key is ever read, stored or served;
* the store lives **outside every package**, and no package operation writes to
  it. Opening, inspecting and authorizing a package leave the file byte-identical
  (tested). Mutation requires the authenticated trust API or the CLI;
* a receipt records the store's `state_sha256`, entry count and path, so a later
  run can tell whether trust changed after consent was given.

### Pinning the key of an open session

`POST /v0/packages/{id}/trust-publisher` exists so a user interface can offer
"trust this publisher" without ever handling key material. It takes the session,
the `signer_fingerprint` the caller displayed, and a `scope`:

* `package` (the default and narrowest): pins `publisher_id` **and**
  `package_id_prefix` set to this exact package ID;
* `publisher`: pins `publisher_id` only.

The key comes from that session's own verified signature envelope, so a caller
cannot pin a key belonging to a different artifact, and a package can never
introduce one. The request is refused when the signature is not `valid`, or when
the echoed fingerprint differs from the session's signer — the same
anti-confusion rule `authorize` applies to digests.

A trust change re-evaluates every open session immediately, so a package opened
before the pin reports `trusted` without being reopened. **Already issued
receipts are left alone**: each one records the trust state at the moment
consent was given, and a caller that wants the new state must authorize again.

This is a deliberate placeholder for NANDA resolution, certificate authorities,
attestation services, key rotation, revocation and transparency logs. None of
those exist here.

## 7. Authorization semantics

The package **requests** authority. The browser **grants** it. A package can
never authorize itself, and there is no path by which package content
influences a decision.

* every declared permission starts at `deny`, required or not;
* supported decisions are `deny`, `once` and `session`;
* `always` is **refused**, with an explanation. The runtime accepts the word,
  but such a grant lives only for the lifetime of one `Runtime` object. Until a
  genuine persistent host authorization store exists, offering "always" in a
  browser would tell the user something false. This discrepancy is intentional
  and documented rather than papered over;
* decisions omitted from an authorize call stay denied — silence is never
  consent;
* **every** declared tool appears as a separate `tool_approvals` row, also
  defaulting to false — not only those declaring `approval_required` or a
  non-read side effect, which now describe how consequential a yes is rather
  than whether one is needed. A permission grant says a class of authority is
  allowed; an approval names one host implementation of one declared tool, and
  [the runtime refuses any tool that lacks one](tool-broker.md). They are
  recorded in the receipt and gate a run plan, not `runnable`: a package can be
  authorized and still have no implementation on this host;
* `authorize` **requires** the caller to echo `package_digest`. A UI must send
  back the digest it showed the user, so a stale view or a reused session id
  cannot silently authorize different bytes. A mismatch is `409 digest_mismatch`.

`runnable` is true only when, under the configured browser policy, all layers
are valid, the profile is supported, the signature is valid, the publisher is
trusted, and every required permission was granted. Each failure appears in
`blocking_reasons` with a stable `code` and a machine-readable `subject`.

`--allow-unsigned` and `--allow-untrusted-publisher` lower the last two
requirements for research use. The receipt still records the real
`signature_status` and `trust_status`, so a relaxed policy is visible rather
than hidden.

**`once` means one run.** The runtime consumes a `once` grant at its first use
inside a run, and refuses one the graph could use more than once. Across runs,
the first execution lease issued under a receipt that grants anything `once`
spends that receipt: every plan under it is then stale
(`authorization_once_spent`) until the person authorizes again. A one-time
purchase authority therefore cannot be replayed by pressing Run twice.

### Host-owned resources

A package can request a *type* of resource the person's host holds — a
`personal.read` permission whose scope names the type (see the
[spec](../spec/agent-pkg-v0.md#5-tools-and-permissions)) — and can never name a
resource. Three objects meet here, as for tools:

    permission resource scope   what the package asks for       (signed, in the pkg)
    host resource registry      what this host holds            (host-owned, no values)
    resource grant              which one the person chose      (receipt, then run plan)

The host sends a **resource registry**: types (id, display name, permission
kind, digest of the value schema) and resources (opaque id, type, display-safe
label, keyed digest of the value). It never carries a value.
`POST /v0/packages/{id}/resources/evaluate` reports which permissions request an
offered type and what the person may choose from, each with a status:
`offered`, `empty` (the host holds none), `ambiguous` (two type scopes) or
`kind_mismatch` (a package may not relabel personal data as a milder kind).

`authorize` then takes the registry and the picks
(`resource_selections: {permission_id: resource_id}`) in the same call and
freezes each as a **grant** — `{permission_id, resource_type, resource_id,
resource_digest}` — into the receipt's `resource_grants` (covered by
`receipt_sha256`). Every mistake is refused by name: a granted
resource-bearing permission without a pick (`resource_selection_required`), a
pick for a denied permission (`resource_selection_denied`), for a permission
that requests no offered type (`resource_not_requested`), or of an id that is
not one of that permission's options (`resource_unknown`, one answer for an
unknown id and for a resource of another type). The run plan copies the
receipt's grants and a reference to the registry, and its readiness and every
`preflight` compare them with the registry the host supplied last: a resource
that changed (`resource_changed`), disappeared (`resource_removed`) or changed
type is stale, never silently re-resolved. A plan that binds a host-resource
tool whose granted permission carries no grant is refused at preparation
(`resource_not_selected`).

### Receipt

```json
{
  "schema": "agentpkg-authorization-receipt-v0",
  "receipt_id": "82c1d279-…",
  "issued_at": "…", "expires_at": "…",
  "session_id": "…",
  "control_plane": {"service": "…", "api_version": "v0", "instance_id": "…"},
  "source": {"kind": "file", "display": "…", "opened_at": "…"},
  "package": {"package_id": "…", "name": "…", "version": "…",
              "digest": "…", "archive_sha256": "…",
              "entrypoint": "workflow.v0", "execution_profile": "workflow.v0"},
  "publisher": {"claimed_id": "…", "claimed_name": "…", "signer_fingerprint": "…",
                "signature_status": "valid", "trust_status": "trusted",
                "trust_reason": "operator_pinned_key"},
  "trust_store": {"path": "…", "entry_count": 1, "state_sha256": "…"},
  "validation": {…four layers…},
  "browser_policy": {…},
  "decisions": {"memory.session": "session", "files.pdfs": "deny"},
  "tool_approvals": {},
  "granted_permission_ids": [...],
  "resource_grants": [{"permission_id": "identity.passenger",
                       "resource_type": "personal.passenger_identity",
                       "resource_id": "…", "resource_digest": "…"}],
  "resource_registry": {"registry_sha256": "…", "type_count": 3, "resource_count": 6},
  "runnable": true,
  "blocking_reasons": [],
  "execution": {"performed": false, "note": "…"},
  "receipt_sha256": "…"
}
```

The receipt binds the package digest, the archive hash of the exact snapshot,
the signer fingerprint, the trust-store state, the decisions, the session and
the timestamp. Two packages with the same ID and version but different bytes
produce different digests, different archive hashes and different receipts, so
a receipt for package A can never authorize package B. `receipt_sha256` is the
SHA-256 of the canonical (RFC 8785) receipt without that field.

Re-authorizing a session replaces its receipt with a new `receipt_id`.

## 8. API

Loopback HTTP, JSON in and out, versioned under `/v0`. Everything except
`/v0/health` requires `Authorization: Bearer <token>`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/v0/health` | Liveness, versions, `execution: "disabled"`. Unauthenticated. |
| GET | `/v0/status` | Instance, limits, cache, trust-store state, capabilities. |
| POST | `/v0/packages/open-file` | `{"path": "…"}` — trusted operator's local artifact. |
| POST | `/v0/packages/open-url` | `{"url": "https://…"}` — SSRF-hardened download. |
| POST | `/v0/websites/discover` | `{"url": "https://…"}` — read one web page and report the agent packages its head advertises (§3a). Opens nothing; `200`. |
| GET | `/v0/packages` | Open sessions with identity, trust and authorization state. |
| GET | `/v0/packages/{id}` | Full browser summary. |
| GET | `/v0/packages/{id}/permissions` | Authorization request, all decisions defaulting to deny. |
| POST | `/v0/packages/{id}/authorize` | `{"package_digest", "decisions", "tool_approvals", "resource_registry?", "resource_selections?"}` → receipt. |
| GET | `/v0/packages/{id}/authorization` | The current receipt, or 404. |
| GET | `/v0/packages/{id}/models` | Normalized model requirements and run-mode permission IDs. |
| POST | `/v0/packages/{id}/models/evaluate` | `{"package_digest", "catalog"}` → tri-state compatibility. |
| GET | `/v0/packages/{id}/tools` | What this package asks a host to implement, host-neutrally. |
| POST | `/v0/packages/{id}/tools/evaluate` | `{"package_digest", "tool_registry"}` → per-tool binding verdicts. |
| POST | `/v0/packages/{id}/resources/evaluate` | `{"package_digest", "resource_registry"}` → which permissions request a host resource, the options, and the current pick. |
| POST | `/v0/packages/{id}/run-plan` | `{"package_digest", "receipt_id", "model_id", "catalog", "tool_registry", "resource_registry", "probe_tool_id", "execution_mode", …}` → plan + preflight. |
| GET | `/v0/packages/{id}/run-plan` | The prepared plan plus a recomputed preflight, or 404. |
| DELETE | `/v0/packages/{id}/run-plan` | Discard the prepared run plan. |
| POST | `/v0/packages/{id}/execution-lease` | `{"package_digest", "run_plan_id", "run_plan_sha256"}` → one **private, one-time copy** of this session's immutable snapshot, issued only while the plan is ready. The response carries a local path and therefore never leaves the authenticated host caller. |
| DELETE | `/v0/packages/{id}/execution-lease/{lease_id}` | Delete that copy. Idempotent. |
| DELETE | `/v0/packages/{id}` | Close the session and delete its snapshot. |
| GET | `/v0/trust` | List pinned publishers. |
| POST | `/v0/trust` | Pin `{"public_key_pem", "display_name", …}`. |
| POST | `/v0/packages/{id}/trust-publisher` | Pin the key that signed this session, at the chosen scope. |
| DELETE | `/v0/trust/{fingerprint}` | Remove a pin. |

Errors are always `{"error": {"code", "message", "details?"}}`. Stable codes
include `unauthorized`, `not_found`, `method_not_allowed`, `invalid_request`,
`unknown_field`, `request_too_large`, `source_rejected`, `package_rejected`,
`package_too_large`, `url_rejected`, `url_unresolvable`,
`url_destination_denied`, `download_redirect_denied`, `download_too_large`,
`download_timeout`, `download_failed`, `discovery_redirect_refused`,
`discovery_http_status`, `discovery_not_html`, `discovery_encoding_unsupported`,
`discovery_too_large`, `discovery_timeout`, `discovery_failed`, `session_unknown`,
`session_limit_reached`, `cache_limit_reached`, `digest_mismatch`,
`unknown_permission`, `invalid_decision`, `unsupported_decision`,
`trust_entry_exists`, `trust_entry_unknown`, `trust_private_key_refused`,
`bind_rejected`, `browser_request_refused`, `host_header_rejected`,
`model_unknown`, `receipt_mismatch`, `run_plan_refused`, `run_plan_absent`,
`unsupported_execution_mode`, `unsupported_binding_strategy`,
`resource_registry_missing`, `resource_not_requested`, `resource_selection_denied`,
`resource_unknown`, `resource_selection_required`.

Unknown request fields are **refused**, never ignored, so a future field cannot
silently change security behavior against an older service.

### Transport hardening

* **Loopback only.** `--host` accepts loopback literals; `0.0.0.0`, `::`, a LAN
  address or a hostname are refused with `bind_rejected`. There is no
  public-binding mode in v0, not even behind a flag.
* **Bearer token.** Random 256-bit `secrets.token_urlsafe(32)` per process
  unless one is supplied, compared with `compare_digest`. `--token-file` writes
  it at mode `0600`. `--quiet` omits the token from stdout entirely and
  suppresses per-request logging, so a supervising host can read the token from
  that file without it ever reaching a log; it also prints the startup line as
  compact single-line JSON for readiness detection, and requires `--token-file`
  or an explicit `--token`.
* **Browser clients are refused, including Node's fetch.** Node's global `fetch`
  sends `sec-fetch-mode: cors`, so it is refused like a browser page. A host
  integration should send an explicit minimal header set (`node:http` rather
  than `fetch`); the OpenClaw plugin does exactly that rather than asking for
  this rule to be relaxed.
* **No browser page can drive it.** Requests carrying `Origin`, `Sec-Fetch-Site`
  or `Sec-Fetch-Mode` are refused, the `Host` header must be a loopback name
  (which blocks DNS rebinding against the port), and no CORS header is ever
  sent.
* **Bounded.** 256 KiB request bodies, 8 MiB responses, 16 concurrent requests,
  no chunked bodies, no bodies on GET/DELETE. The body limit is larger than the
  earlier 64 KiB because a host model catalog *is* a request body; every field
  inside a model descriptor is still separately length-limited, and a catalog
  carries at most 256 of them.
* **Quiet.** Responses never contain tracebacks, internal paths from unexpected
  errors, or any private key.

The implementation is `http.server.ThreadingHTTPServer`. No web framework was
added: this package's runtime dependency list is small and auditable, and that
is worth more here than routing sugar.

## 9. Lifetime and cleanup

* sessions expire (`--session-ttl`, default 900 s) and are purged on any access;
* `DELETE` closes a session immediately; its snapshot directory is removed and
  its receipt goes with it — receipts are **not** persisted in this milestone;
* at most `--max-sessions` (default 8) sessions and `max_cache_bytes` (default
  128 MiB) of snapshots; exceeding either is a `429`, never a silent eviction of
  something the user is looking at;
* on startup the service sweeps its cache directory and removes leftover
  `session-*` directories carrying its own marker file. Nothing else in that
  directory is touched;
* `SIGTERM` and `Ctrl-C` purge all snapshots; a hard kill is covered by the next
  start's sweep;
* the cache directory must be owned by the current user, is created `0700`, and
  is refused if it is a symlink.

Without `--cache-dir` the cache is `agentpkg-browser-cache` under Python's temporary
directory. On macOS that directory is private to the user. On most Linux systems it is
the shared `/tmp`, where another local user could create that name first and so stop the
service from starting (`cache_unsafe`). On a multi-user Linux host, pass a private
`--cache-dir`. The Agent Browser plugin always passes one inside its own state directory.

## 10. The non-execution boundary

The control plane **must not** instantiate `Workflow`, invoke a `ModelRouter` or
`ToolHandler`, contact Citation Resolver or scholarly providers, create workers,
or execute package skills. Package download and website discovery (one HTML
page per request, §3a) are the only network activity in the whole service, and
both run under the same URL and address policy. Evaluating model compatibility and preparing a run
plan are arithmetic and set membership over declared data: `hostmodels.py` and
`runplan.py` contact nothing, and a test asserts neither module so much as
mentions `complete(`, `count_tokens`, `ModelRouter`, `router.`, `http` or
`socket`.

This is enforced structurally, not by convention. No module under
`agentpkg/browser/` imports `workflow`, `workflow_assertions`, `runtime`,
`tools`, `models`, `fixtures`, `network`, `dev` or `openclaw` — at module level
or inside a function — and none of them uses `importlib`, `__import__`, `eval`,
`exec` or `subprocess`. Two tests hold this line:

* an AST scan of every browser module's imports;
* a fresh interpreter that opens, inspects, authorizes, evaluates a model catalog
  for and prepares a run plan for both shipped packages, then proves no execution
  module is present in `sys.modules`.

`workflow_validation` and `workflow_values` are reached, and that is correct:
they validate graph structure and declarative data constructors, depend only on
`errors`/`validation`/`package`, and dispatch nothing. Refusing them would mean
refusing to check the graph the user is being asked to authorize.

## 11. Relationship to the OpenClaw adapter

Both paths remain supported, for different purposes:

| | `stage_openclaw` (`agentpkg install-openclaw`) | Browser control plane (`agentpkg browser-serve`) |
|---|---|---|
| Role | **Legacy/current compatibility bridge** | **Path toward a native Agent Browser** |
| Mechanism | Verifies one artifact and writes a workspace of `SKILL.md` wrappers OpenClaw can discover | Serves bounded JSON over authenticated loopback for a host plugin to consume |
| Trust input | One PEM passed on the command line | Operator trust store with fingerprint pins and two-sided evaluation |
| Output | A staged read-only workspace and an install receipt | A session, a browser summary and a digest-bound authorization receipt |
| Enforcement claim | None; explicitly not native OpenClaw enforcement | None yet; it authorizes, it does not run |

`stage_openclaw` is not being removed or extended. Wrapper-SKILL staging is not
the browser architecture; it is a useful prototyping path that predates it.

## 12. The OpenClaw feature plugin

The inspected host is **OpenClaw 2026.9.5 (`ec9c1a1`)**. Its installed docs
describe the surface the next milestone should pin to:

* `openclaw plugins init <id> --type feature` scaffolds a feature plugin;
* `openclaw/plugin-sdk/feature-contract` declares typed queries/actions with
  TypeBox schemas; `feature-plugin` implements them in `setup(api, events)`;
  `control-ui` registers native pages. Queries need `operator.read`, actions
  need `operator.write`;
* "Backend inputs, outputs, and events are validated as bounded JSON" — which is
  why every response here is bounded and stable;
* native Control UI requires **Settings → Labs → Custom plugin UI** and HTTPS or
  a browser-trusted loopback origin such as `http://127.0.0.1:18789/`;
* `plugin.approval.*` is the host's own per-call approval flow and is the
  natural surface for rendering this service's authorization request.

That plugin now exists: see [the Agent Browser plugin](openclaw-agent-browser.md)
and `openclaw-agent-browser/`. Its Node backend supervises this service, holds
the bearer token in memory, and calls the API above; its Control UI page renders
the summaries and the authorization request. It reimplements no verification,
trust or permission semantics, and it cannot execute a package.

## 13. What is enforced now, and what is not

**Enforced now:** loopback-only binding; bearer authentication; browser-origin
and Host-header refusal; bounded requests/responses/concurrency; one-shot
immutable snapshots with hash confirmation; strict archive, integrity, schema
and reference validation; separate layer reporting; Ed25519 self-consistency
checking; operator-pinned publisher trust with two-sided mismatch detection;
deny-by-default permissions; digest-bound receipts; session TTLs, counts, byte
caps and startup cleanup; HTTPS-only SSRF-hardened downloads with destination
classification, pinned connections, no redirects and a killable child;
website discovery under the same policy, with same-origin redirects only,
head-only parsing that runs nothing and fetches nothing else, and same-origin
candidates that are reported as locations, never opened; and a statically
tested non-execution boundary.

**Not implemented here (future OpenClaw/runtime work):** executing an authorized
package; a persistent host authorization store (hence no `always`); NANDA
resolution, certificate chains, revocation, transparency logs or third-party
attestation verification; AgentRank or reputation; package registries and
search; the OpenClaw UI and its plugin; model routing, budgets and audit at run
time (those live in the runtime and are covered by
[workflow.v0](../spec/workflow-v0.md)); persistent memory capsules; payment or
escrow; and OS-level sandboxing. The bearer token is the security boundary
against other local processes; this service does not defend against a process
already running as the same user, which can read the token file and the cache.

See also: [threat model](threat-model.md), [container
spec](../spec/agent-pkg-v0.md), [execution profile](../spec/workflow-v0.md),
[model selection and the run plan](model-selection-and-run-plan.md),
[package execution](package-execution.md),
[OpenClaw staging adapter](openclaw-integration.md), [milestone
report](browser-report.md).
