# The host tool broker

A downloaded package can now call a tool. This document is about the machinery
that makes that sentence survivable: what the package is allowed to say, what
the host decides, what the person authorizes, and what finally runs.

```text
  signed agent.pkg
       │  declares: "I need a tool called citation-resolver"
       ▼
  host tool registry                      ← what THIS host implements
       │  binds: one exact implementation, with a digest
       ▼
  authorization receipt                   ← what the PERSON allowed
       │  permission grant  +  tool approval, as two separate decisions
       ▼
  immutable run plan                      ← all three, frozen and hashed
       │
       ▼
  Runtime.call_tool()                     ← the package-side authority
       │  role · permission · approval · budget · input schema
       ▼
  agentpkg.toolbridge                     ← a ToolHandler with no I/O
       │  {tool_id, binding_id, binding_sha256, args} over private JSONL
       ▼
  OpenClaw tool broker                    ← the trusted host half
       │  resolve the triple, then dispatch
       ▼
  the one approved implementation         ← json_http, local_builtin or selected_file
       │
       ▼
  result, validated twice                 ← by the host, then by the package
```

> **3B4 update.** All three tools the Literature Review package declares now
> have a host implementation: `citation-resolver` (unchanged), `scholarly-search`
> (one fixed Crossref query, §3a) and `paper-reader` (one PDF the person
> selected for the run, §3b). Adding them added two *entries*, one *adapter* and
> one *category* — the smallest generic extensions, explained where they occur.
> The broker's architecture is otherwise the one below.

## 1. Three objects, three jobs

The vocabulary is load-bearing, because the whole design is about not letting
any one of these stand in for another.

| Object | Says | Written by | Lives in |
|---|---|---|---|
| **tool declaration** | *what capability I need* | the publisher | the signed package |
| **tool binding** | *what I will run for that* | the host | the plugin, as code |
| **tool approval** | *you may use that implementation* | the person | the authorization receipt |

A declaration is a request. It never becomes authority by being signed, being
required, or naming a URL. A binding is the host's answer to that request, and
it exists only because code in this plugin can serve it — configuration can
disable, relabel, retarget or bound one, and cannot invent one. An approval is
consent for *that* implementation of *that* tool, and it is separate from the
permission the tool travels under.

> A permission such as `network.citations = session` says the person allowed a
> class of destination. It does not say they allowed this implementation of
> this tool. Both are required, always, for every tool.

## 2. The package tool declaration

Unchanged from agent.pkg 0.1 (`spec/agent-pkg-v0.md` §5). What changed is how
its `endpoint`, `method` and `domains` are read:

* they are **descriptive metadata and an upper bound**, never network authority;
* a remote host binding must land on a host that is in the package's declared
  `domains` **and** in the linked network permission's `resources` **and** in
  `policy.network.allowed_domains` — all three — at the declared path and
  method, or the binding is `incompatible`;
* a package naming `example.test` cannot thereby reach it, because no binding
  here names it; and a host that would like to reach somewhere else cannot do
  so behind that package's name either.

The control plane derives a **tool contract** from the signed bytes:

```json
{"schema":"agentpkg-tool-contract-v0","tool_id":"citation-resolver",
 "tool_version":"0.1.0","binding":"citation.resolve","execution":"remote",
 "remote":true,"method":"POST","side_effects":"read","approval_required":false,
 "domains":["…"],"permission_ids":["network.citations"],
 "required_permission_ids":["network.citations"],"optional_permission_ids":[],
 "permission_kinds":["network"],"network_resources":["…"],
 "allowed_domains":["…"],"timeout_seconds":45,
 "endpoint_origin":"https://…","endpoint_path":"/resolve",
 "input_schema":"schemas/resolver-input.schema.json",
 "input_schema_sha256":"6ebcf0d3…","output_schema_sha256":"0122dc2a…",
 "max_calls":20,"contract_sha256":"…"}
```

Schema digests are SHA-256 of the RFC 8785 canonical JSON of the declared
schema *document*, so a package that changes a schema no longer matches a
binding pinned to the old one.

**Every declared tool is required.** agent.pkg 0.1 has no optional-tool flag,
and inferring one would be a format change made by guessing. A package that
declares three tools needs three implementations before it can run.

## 3. The host tool binding

`ToolBindingDescriptor`, in `openclaw-agent-browser/src/tool-registry.ts`, and
normalized by `agentpkg/browser/hosttools.py`:

```json
{"id":"openclaw:citation-resolver:1","tool_id":"citation-resolver",
 "binding":"citation.resolve","implementation_kind":"json_http",
 "implementation_id":"openclaw.tool.json_http","implementation_version":"0.1.0",
 "display_name":"Citation Resolver","description":"…",
 "remote":true,"available":true,"availability_reason":null,"enabled":true,
 "endpoint":{"origin":"https://…","path":"/resolve","method":"POST"},
 "contract":{"input_schema_sha256":"…","output_schema_sha256":"…",
             "permission_kinds":["network"],"side_effects":"read"},
 "limits":{"timeout_seconds":45,"max_request_bytes":16384,
           "max_response_bytes":524288,"max_concurrent":4},
 "credentials":{"required":false,"configured":false,"source":null},
 "binding_sha256":"…"}
```

The field set is **closed**. A host may send only what is listed, so no header,
credential value, request template, query parameter, second endpoint or local
command has anywhere to travel; an unknown field is refused with
`unknown_field` rather than dropped.

There are three **implementation kinds**, and they are categories rather than
a service list:

* `json_http` — one exact HTTPS request to one exact configured origin, path and
  method, under the transport policy in §7. *What* that request carries and how
  its answer is read is an **adapter** named by `implementation_id` (§3a);
* `local_builtin` — an implementation that ships with the plugin and performs
  no I/O;
* `selected_file` — a local implementation that reads **only** files the person
  explicitly selected for this run, through opaque host-held capabilities
  (§3b). It can name no path, reach no network and write nothing.

Adding a service adds an *entry*. Adding a way of reaching resources adds a
kind: reading a person's own selected file is a different kind of reach from
calling a service or computing in memory, which is why `selected_file` is the
one kind 3B4 added.

`limits` gained one optional field, `min_interval_ms`: the spacing a service
itself requires between call starts (§7a). It is part of what a binding would
do, so it is part of the binding digest.

### 3a. Adapters: the package controls values, the host controls the shape

A `json_http` binding's request shape is code in `src/tool-adapters.ts`, chosen
by the binding's `implementation_id` — never by anything a package says. Two
adapters exist:

| `implementation_id` | Sends | Believes |
|---|---|---|
| `openclaw.tool.json_http` | the package's arguments as the JSON body of one POST | 200/400/404/422/502 bodies as data for the package's own schema (the Citation Resolver's contract) |
| `openclaw.tool.crossref_works_search` | `GET /works?query.bibliographic=<query>&rows=<limit>&select=<fixed list>&filter=<fixed work types>` | only 200; 429/5xx/401/403 are `tool_unavailable`, anything else `tool_transport_error` |

The Crossref adapter reads exactly two argument names, `query` (1–500
characters of text) and `limit` (1–20), and refuses any other name with
`tool_request_invalid`, so a package cannot add `select=reference`,
`query.author=` or a path. Values are percent-encoded as values; parameter
names, the path, the method, the selected fields, the filter and the headers
are constants.

The filter (`type:journal-article,type:proceedings-article,type:posted-content,
type:book-chapter,type:book,type:monograph,type:report,type:dissertation`,
added in implementation 0.2.0) asks only for works in their own right. Without
it, Crossref's relevance ranking fills a small page with supplementary files
(`component`), reviews *of* other papers (`peer-review`) and datasets — none of
which a review can screen or cite — and a live survey of this milestone's
queries found such records in the top five for most of them. It is a property
of what the host means by "scholarly search", not something a package can
widen or narrow.
The descriptor carries no template: the mapping is identified by
`implementation_id` and `implementation_version`, both in the binding digest,
and a test fingerprints the mapping so it cannot change without a version bump.

The answer is reduced to the declared `search-output` contract — `papers[]`
with `title, doi, arxiv_id, authors, year, venue, abstract, url, source,
provenance`, plus `query`, `source` and `skipped_records` — and nothing else
from Crossref reaches the package. Missing fields are `null`, never invented;
a record without a title is counted in `skipped_records`, not guessed; DOIs are
lowercased, as the Citation Resolver stores them.

Markup (`<jats:p>`, `&amp;`, `&#x2013;`) is rendered to text **exactly as the
Citation Resolver renders the same Crossref fields** — its `clean_text` is
CPython 3.13's `HTMLParser` data path without `close()`, then `html.unescape`,
then whitespace collapse. `src/html-text.ts` ports those steps, with CPython's
WHATWG tables generated verbatim into `src/html-entities.ts`, and is checked
against 141 vectors produced by the resolver's own function (curated edge cases
plus every text field of a real Crossref response). This matters because a
later package step requires evidence quotes to occur verbatim in the resolver's
copy of an abstract: two renderings of one record that differed by one
character would refuse a correct run. CPython's quirks are kept, not fixed —
`"Q&A"` renders as nothing because a trailing reference-shaped `&` is withheld
when `close()` is never called, and the resolver does the same.

### 3b. Selected-file capabilities

`paper-reader` can read a file only if the person selected it, for this package
session, and the run was given it:

```text
 operator selects /abs/path/paper.pdf     files.select-local — inside localFiles.roots only
      │  lstat: regular file, not a symlink; realpath inside a root;
      │  open O_NOFOLLOW; same inode as checked; ≤ 20 MiB; %PDF- magic
      ▼
 immutable private copy                   0400 file in the plugin's 0700 state dir
      │  SHA-256 and size recorded
      ▼
 opaque capability  file_<32 hex>         bound to one session; expires; released with it
      │  named in execution.start's `files`, and bound into the Run Invocation
      ▼
 this run's broker                        refuses every other string before opening anything,
      │                                   re-reads the copy, re-checks size and hash
      ▼
 agentpkg host-pdf-read                   bytes on stdin, JSON on stdout, nothing else
```

A package can only ever put a *string* in `file_id`. `/etc/passwd`, `../x.pdf`,
`~/paper.pdf`, `file://…`, the original path and another session's id all get
the same `tool_request_invalid` before any file is opened, and the refusal never
echoes a path. No path or directory reaches a package, a run plan, an audit, a
report, a model or a result; the Run Invocation records `attachments` as
`{file_id, sha256, bytes, media_type}` only.

The parser is a separate process in a fifth trusted namespace,
`agentpkg.hostfiles`, which `execution`, `toolbridge`, `hostbridge` and
`browser` cannot import. It is given bytes and a minimal environment (no
credential, no proxy setting), refuses a non-pipe stdout, caps its own CPU,
address space (where the kernel allows) and file size (zero), and refuses
encrypted documents, more than 100 pages, more than 64 KiB of text on one page
or 256 KiB in total. It does no OCR, renders nothing, runs no script, follows no
link and extracts no attachment. The broker adds a wall-clock deadline, SIGKILL
on cancellation, an output byte cap, and a check that the parser's answer
describes the exact bytes it was sent. The legacy development CLI's killable
child now calls the same parser function, so there is one parser, not two.

## 4. The binding digest

`binding_sha256` is SHA-256 of the canonical JSON of a security-relevant
subset:

```
schema · binding_id · tool_id · binding · implementation_kind ·
implementation_id · implementation_version · remote · endpoint{origin,path,method} ·
contract{input_schema_sha256,output_schema_sha256,permission_kinds,side_effects} ·
limits{…} · credentials{required,configured,source}
```

It covers **what the binding would do**, and deliberately excludes liveness
(`available`, `enabled`, `availability_reason`) and presentation
(`display_name`, `description`): a binding that is briefly down is the same
binding, and a relabelled one is too. A binding whose origin, path, method,
contract, bounds or implementation version moves is a *different* binding, and
a plan that approved the old one is stale.

**No credential value is an input.** `credentials.configured` is a boolean, so
attaching or removing a secret changes the digest — and therefore invalidates a
prepared plan — without the secret ever being hashed, stored, transmitted or
displayed.

## 5. Compatibility

`hosttools.evaluate_registry(package, registry)` compares each declared tool
with the one binding that claims it. Every check carries its own verdict, so a
UI can explain rather than assert:

| Check | Satisfied when |
|---|---|
| `tool_id` | the binding claims this tool |
| `binding_name` | it implements the abstract capability the package asked for |
| `execution_locality` | remote/local agree |
| `side_effects` | read/write agree |
| `permission_kinds` | the authority classes agree |
| `input_schema` / `output_schema` | digests match; **unknown** if the host declares none |
| `endpoint_domain` | (remote) the origin host is in domains ∩ resources ∩ policy |
| `endpoint_path`, `method` | (remote) they match the declaration |

Six verdicts, kept apart because they are six different problems with six
different fixes:

| Verdict | Meaning |
|---|---|
| `bound` | exactly one compatible, available implementation |
| `unverified` | compatible as far as stated, but the host declared no schema digest |
| `unavailable` | compatible, but disabled or missing a credential |
| `ambiguous` | more than one implementation claims this tool |
| `incompatible` | an implementation exists and does not satisfy the contract |
| `unbound` | this host registers nothing for it |

`unverified` exists for the same reason it does for models: collapsing "the
host did not say" into either boolean would misinform the person deciding.
Browser policy `require_confirmed_tool_contract` (default **true**) makes it a
blocker.

Three further facts are reported beside the verdict and never derived from it:
`approved` (the receipt), `permissions_granted` (the decisions), and `usable`
(bound ∧ approved ∧ every linked permission granted).

## 6. Permission, approval, and a denied optional permission

`Runtime.call_tool` now refuses **any** declared tool that is not in
`approved_tools`, not only `approval_required` or side-effecting ones. The
control plane therefore offers an approval row for every declared tool, and the
receipt records one decision per tool.

A denied permission and a missing approval are different refusals, and a denied
**optional** permission is a third thing again:

* a denied **required** permission blocks the plan — the package cannot run;
* a denied **optional** permission leaves the tool `bound`, `approved` and
  **not usable**. The package itself declared that operating profile, its graph
  is responsible for not reaching the tool (`when`/`otherwise`), and
  `Runtime.call_tool` refuses the call if it does.

The reference review package uses exactly this: `files.pdfs` is optional and
its `paper-reader` steps are conditional.

## 7. The HTTP adapter's policy

`json_http` applies this in order, with no exception path:

1. **syntax** — HTTPS on port 443, no credentials in the URL, no query, no
   fragment, exactly the origin, path and method the binding holds;
2. **resolution** — every resolved address must be publicly routable.
   Loopback, private, CGNAT, link-local, multicast, reserved, unspecified,
   cloud-metadata, IPv4-mapped, 6to4, Teredo and NAT64 destinations are refused
   **by class**, before a socket exists, and the reason names the class rather
   than the address;
3. **connection** — the socket is pinned to a validated address while TLS still
   verifies the original hostname, so a second DNS answer cannot rebind it;
4. **request** — a fixed header set (`accept`, `user-agent`, `connection`, and
   `content-type`/`content-length` for a body) that nothing in `args` can
   influence; a bounded JSON body; no cookie jar, no proxy inheritance, no
   ambient credential;
5. **transfer** — **no redirects** (each hop would need the whole destination
   policy re-applied to somewhere nobody authorized), a declared-length check,
   a byte cap enforced while streaming, a whole-operation deadline, and an
   `AbortSignal` that reaches the socket on cancellation;
6. **response** — `application/json` only, bounded parse, and a status
   contract: 5xx (except 502) and 401/403 are `tool_unavailable`, other
   unexpected statuses are `tool_transport_error`, and 200/400/404/422/502
   bodies are returned as **data** for the package's own output schema to
   accept or reject.

The address classification mirrors `agentpkg.netaddr.public_address_reason`,
because a second transport with a weaker rule would be the hole the first one
closed.

A run cancelled while its destination is still being resolved is refused
before the request is sent, whatever a transport would do with a dead signal.

### 7a. Concurrency and pacing

A binding serves at most `max_concurrent` calls at once and, when its service
states a rate limit, spaces call starts by `min_interval_ms`. A call that
cannot start yet **waits its turn** (first in, first out) instead of being
refused, bounded by cancellation and by the binding's own deadline; a waiter
that gives up holds no slot. The pacer is per binding and per process, because
a service's limits apply to this host rather than to one run. Nothing here
retries a request.

This changed one behaviour: before 3B4 a call arriving while a binding was at
its limit was refused with `tool_unavailable`, which would have failed any run
whose graph legitimately runs more workers than a binding serves at once (three
evidence workers against a two-at-a-time reader). Crossref's public pool
answers every request with `x-concurrency-limit: 1` and one request per second,
and answers 429 to clients that ignore it, so the shipped Crossref binding sets
`max_concurrent: 1, min_interval_ms: 1000`.

## 8. Credentials

A credential belongs to the binding. It is named in host configuration
(`credentialEnv`), read at call time from this process's environment, and
attached as a header. It appears in **no** frame, run plan, receipt, audit
event, report, artifact, log line, error message or UI field — only
`credentials: {required, configured}` does, and `configured` is what makes a
plan stale when a secret is attached or removed.

Nothing shipped uses one. The mechanism exists so that an authenticated tool is
a configuration change rather than a redesign, and so that "no credential
reaches the package" is tested against a binding that actually has one.

## 9. The run plan

A plan now binds tools as well as bytes, signer, trust, consent and model:

```json
"execution": {"mode":"model", "required_tool_ids":["…"], "probe_tool_id":null,
              "tool_binding_count":3, …},
"tool_bindings": [
  {"tool_id":"citation-resolver","binding_name":"citation.resolve",
   "binding_id":"openclaw:citation-resolver:1","binding_sha256":"…",
   "implementation_kind":"json_http","implementation_version":"0.1.0",
   "display_name":"Citation Resolver","remote":true,
   "endpoint_origin":"https://…","endpoint_path":"/resolve","method":"POST",
   "contract_sha256":"…","input_schema_sha256":"…","output_schema_sha256":"…",
   "required_permission_ids":["network.citations"],"usable":true,
   "timeout_seconds":45,"max_calls":20,
   "credentials_required":false,"credentials_configured":false,
   "approved":true,"approval_source":"authorization_receipt",
   "compatibility_status":"bound"}
],
"tool_registry": {"registry_sha256":"…","binding_count":2,
                  "available_binding_count":2,"host":{…}}
```

### Two execution modes

| Mode | Authority | Binds a model | Tools it requires |
|---|---|---|---|
| `model` | run this package's own graph | yes | **every** declared tool bound, approved, required-permissions granted |
| `tool_probe` | **one** mediated call to **one** declared tool | **no** | that one tool only |

They are separate modes rather than one relaxed mode so that neither artifact
can be mistaken for the other. A `tool_probe` plan carries
`model_binding: null` — so no router can be constructed from it at all, and
"no model was called" is a property of the artifact rather than a claim about a
run — names its one tool in `execution.probe_tool_id`, and is refused by
`execution.run`.

This is what lets the Citation Resolver binding be proved against a package
whose other tools this host cannot implement, **without** pretending that
package is runnable here. A `model` plan for the same session is still refused,
by name.

### Fail closed

For a `model` plan, any of these blocks preparation: `tool_registry_missing`,
`tool_not_bound`, `tool_contract_mismatch`, `tool_binding_ambiguous`,
`tool_unavailable`, `tool_contract_unverified`, `tool_not_approved`,
`tool_permission_denied`, `tool_permission_undeclared`. A plan exists only when
it is ready; a plan that becomes unusable *later* is staleness, reported
separately.

### Staleness

`preflight` recomputes on every read and reports, per bound tool:
`tool_binding_removed`, `tool_binding_replaced`, `tool_binding_changed`,
`tool_contract_changed`, `tool_unavailable`, `tool_binding_stale`,
`tool_approval_withdrawn`, plus `tool_registry_unknown` when no current
registry was supplied. A stale plan is never repaired: the person prepares a
new one, which is the only way the new state gets recorded.

## 10. Execution-time revalidation

Before a tool can be called, in this order:

1. the plugin backend re-reads the live registry and re-evaluates it through
   the control plane, then compares **each** binding id, binding digest,
   contract digest, status and approval against the plan (`preflight.ts`);
2. the control plane issues a one-time lease only if the plan is ready now;
3. the runner re-verifies the artifact's archive hash, digest, identity,
   signature and signer against the plan;
4. `check_tools` **re-derives every tool fact from the verified package in the
   runner's own process** — binding name, locality, both schema digests, the
   permission set, and for a remote binding that the origin is one the package
   declares — and compares it with the plan. A plan that described the package
   incorrectly is refused rather than believed;
5. each bound tool must be approved in the receipt and its required
   permissions granted;
6. `Runtime` refuses an approval for a tool the package does not declare, and
   refuses to dispatch any tool that is not approved.

## 11. The private protocol

One method is added to the execution wire contract, in each direction:

```text
  parent → child   execution.tool_probe   {tool_id, args}
  child  → parent  tool.call              {tool_id, binding_id,
                                           binding_sha256, args}
```

`tool.call` is a closed field set. There is **no** URL, method, header, host
method name, command or file path in it, because there is nowhere for one to
go: the child names a tool it already holds a binding for, and the trusted
parent resolves that triple against the bindings *this run* was constructed
with. A binding id or digest that is not the one the plan froze is
`tool_binding_stale`.

A bridge constructed without a broker does not have `tool.call` in its inbound
method set at all, so a child that asked would end the session rather than
receive a refusal it might retry. Everything else — bounded frames, correlation
ids, duplicate refusal, fail-closed framing, `$/cancel`, one child, SIGKILL on
shutdown — is the transport the router bridge already proved.

## 12. The generic Python handler

`agentpkg.toolbridge` is a sibling of `agentpkg.hostbridge` and holds one
`ToolHandler`. It imports nothing but `json`, `time`, `typing` and its own
errors — a test enumerates its imports rather than banning known-bad ones — so
it has no socket, no URL, no environment access and no filesystem. It contains
no provider, service, index or domain vocabulary.

It validates arguments as finite canonical JSON under 64 KiB before a frame is
written, so a pathological document fails locally rather than at someone else's
server; checks the host's envelope as a closed field set whose binding identity
must echo the one it holds; bounds the returned payload; and emits
`tool.dispatched` / `tool.settled` into the runtime's own hash-chained audit.

`Runtime.call_tool` remains the authority. The handler adds defence in depth on
the way out and the way back; it replaces nothing.

## 13. Budgets and accounting

All existing `Runtime` accounting applies unchanged: `max_calls_per_tool` per
tool, `max_remote_calls` globally and per worker, and a conservative count of
*attempted* dispatches. A `remote` binding consumes the remote-call budget even
though the broker itself is local, because the call is remote.

One host limit is added: `execution.maxCallsPerTool`, applied as
`min(package, host)` to **every** declared tool's cap. Like every other host
limit it can only lower a package's own.

## 14. Errors

Stable codes, shared verbatim by `agentpkg.toolbridge.errors`,
`agentpkg.execution.errors` and `tool-broker.ts`, so the word the runner uses
when it refuses to ask is the word the host uses when it refuses to answer:

```
tool_not_declared   tool_not_bound        tool_not_approved
tool_permission_denied                    tool_contract_mismatch
tool_binding_stale  tool_binding_ambiguous
tool_unavailable    tool_timeout          tool_cancelled
tool_request_invalid tool_response_invalid tool_transport_error
tool_broker_unavailable
```

Messages never carry a credential, a header, a provider body or a destination
the caller did not already know.

## 15. Host configuration

```jsonc
"plugins": { "entries": { "agent-browser": { "config": {
  "tools": {
    "enabled": true,
    "bindings": [
      { "toolId": "citation-resolver",
        "origin": "https://…", "path": "/resolve", "method": "POST",
        "timeoutSeconds": 45,
        "credentialEnv": "SOME_TOKEN" }
    ]
  },
  "execution": { "maxCallsPerTool": 32, "maxToolResponseBytes": 524288 }
}}}}
```

Configuration can disable the broker entirely, disable one binding, relabel it,
retarget an origin/path/method, tighten a timeout, or attach a credential by
name. It **cannot** add an implementation for a tool this plugin has no code
for: that is refused with a `binding_unknown` note. An unsafe origin is refused
with `binding_config_rejected` and the built-in is kept.

Four implementations ship:

| Tool | Kind | Implementation | Runs |
|---|---|---|---|
| `test.echo` | `local_builtin` | `openclaw.tool.echo` | returns its input; no I/O at all |
| `citation-resolver` | `json_http` | `openclaw.tool.json_http` | `POST https://webagents-citation-resolver-production.up.railway.app/resolve` |
| `scholarly-search` | `json_http` | `openclaw.tool.crossref_works_search` | `GET https://api.crossref.org/works` with two value parameters and two fixed ones; 1 at a time, ≥ 1 s apart |
| `paper-reader` | `selected_file` | `openclaw.tool.selected_pdf_text` | page text of one selected PDF, via `agentpkg host-pdf-read` |

Each binding states its own schema digests as *this host's* claim about the
contract its code speaks — deliberately not read from any package.
`test_shipped_artifacts.py` asserts, for all three Literature Review tools, that
this independent statement equals the digests of the schemas the shipped
package declares, and that a remote binding's origin, path and method are the
ones the package itself declares. That is how "the host and the package agree"
is established rather than assumed.

`localFiles.roots` names the directories an operator may select PDFs from. It
is empty by default — no file is selectable until an operator names one — and
the workspace is never implied.

## 16. The tool probe

`execution.tool-probe` is the tool boundary's equivalent of the router probe:
the smallest thing that can show a declaration, a binding, an approval, a
permission and a budget converge on one real call.

It takes `sessionId`, `runPlanId`, `runPlanSha256`, a **declared** `toolId` and
one of this host's own `fixtureId`s. It takes no URL, method, header, endpoint
or arguments, because every byte it sends is written in
`src/tool-fixtures.ts`. A tool with no fixture cannot be probed at all: the
alternative would be inventing a request for a service whose contract this host
has not written down.

Two optional fields were added in 3B4, both host-side choices:

* `fileId` — for a file-reading fixture (`selected-pdf`), the opaque id of a
  capability the operator selected in the probing session. The fixture's only
  argument becomes that id; the caller never writes a path or a value;
* `role` — the declared role to attribute the call to, required only when more
  than one role declares the tool (the review package's `ScreeningWorker` and
  `EvidenceWorker` both declare `paper-reader`). The runner checks the role
  declares the tool with approved authority; the report records
  `role_named_by_host`. The probe still never chooses an authority itself.

**What it proves, and what it does not.** No `Workflow` is instantiated, no
graph node executes, no skill text is read and no model router is constructed,
so a model call is impossible rather than merely absent. It does spawn
**exactly one worker context**: `Runtime.call_tool` derives the role tool
allowlist, the per-worker remote-call budget and the audit identity from the
calling context, and only a worker role may hold a tool, so a probe that forged
a context would be bypassing the mechanism it exists to test. The report states
both numbers — `workflow_workers_started: 0` and `runtime_worker_contexts: 1` —
rather than one that reads as the other.

## 17. What is still not implemented

* no local shell or command adapter exists, and none is designed. The one
  filesystem reach is `selected_file`: explicitly selected PDFs, by capability;
* file selection is an operator operation (`files.select-local`) over
  configured roots; a browser upload path is future work for the run surface;
* no agent-kind tool binding, no remote-agent execution, no registry federation
  and no discovery;
* redirects, proxies, cookies and ambient credentials remain unimplemented
  rather than configurable;
* the broker is trusted host code in the Gateway process. It is not an OS
  sandbox, and a hostile implementation added to this plugin would be inside
  the trust boundary, not outside it.

See [the milestone report](tool-broker-report.md) for what was actually run,
and [the threat model](threat-model.md) for this boundary's entry in the
project-wide table.
