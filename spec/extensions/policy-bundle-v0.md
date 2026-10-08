# Policy bundle v0 (`org.webagents:policy-bundle-v0`)

Status: experimental. Schema: [`policy-bundle-v0.schema.json`](policy-bundle-v0.schema.json).
Travels as the content of a [signed document](signed-document-v0.md). Example:
[`examples/policies/webagents-research.json`](../../examples/policies/webagents-research.json) (the
"WebAgents research policy", signed with a development key). Implemented by the Chrome Agent
Browser (T8): `src/core/policies/`.

## 1. Purpose

Deciding every permission for every agent is precise and long. Publisher [profiles](profiles-v0.md)
group what one package asks for, and host presets supply the person's defaults. A **policy bundle**
is the third mechanism: an institution (a lab, a school, an employer) publishes a signed policy, a
person subscribes to it, and from then on it decides for them which publishers to trust, what to
allow by default, how far a run may go, and which models and services to use. Every decision it
makes says so (`decided_by: policy <id>@<version>`), and the person can override any of them.

**A policy pre-decides; it never grants more** than the package declares, than the selected profile
contains, or than the person's own preset allows (§5.3). It conveys no authority by being fetched:
only a subscription the person made, verified against a key the person pinned, applies.

## 2. Content

| Field | Type | Meaning |
|---|---|---|
| `policy_id` | identifier | The policy's name, stable across versions. |
| `version` | dotted numeric | Increases with every change (§5.7). |
| `title`, `description` | one line | For the person. |
| `issuer` | `{name, url?}` | Who publishes it. |
| `issued_at`, `expires_at` | date-time | The validity window; outside it the policy decides nothing. |
| `trust_anchors` | array, ≤ 64 | `publisher_key` and `issuer` anchors (§5.2). |
| `decisions` | object | A default decision (`deny`, `once`, `session`) per permission kind (`network`, `files.read`, `files.write`, `model`, `memory`, `shell`, `payment`, `personal.read`). `always` does not exist. A kind it does not name is left to the profile or preset. |
| `budget_caps` | object, optional | Ceilings on the host run limits: `total_tokens`, `max_remote_calls`, `max_parallel_workers`, `max_output_tokens_per_call`, `run_timeout_seconds`, `max_calls_per_tool`, `model_call_timeout_seconds`. |
| `models` | object, optional | `local_only` (boolean) and `max_cost_usd_per_run` (number or null). |
| `bindings` | object, optional | `allow`: the host implementations tools may be approved for by default, as `{kind, origins?}` with `kind` one of `json_http`, `local_builtin`, `selected_file`, `host_resource` and, for `json_http`, the HTTPS origins it may reach. Absent: no restriction. |

A `publisher_key` anchor is `{kind, public_key (raw base64), fingerprint, display_name,
publisher_id, package_id_prefix}`: both scopes are required. An `issuer` anchor is `{kind,
public_key, fingerprint, display_name, scope: {package_id_prefix, publisher_id?}}`.

## 3. Rules beyond the schema

1. `expires_at` is after `issued_at`.
2. Every anchor's `fingerprint` is the fingerprint of its `public_key`.
3. No key is anchored twice.

A bundle that breaks a rule is refused as a whole; a host never applies part of a policy.

## 4. Subscribing

A person subscribes by URL and pins the issuer's key (in v0 the key is pasted or filled in from a
known demo value; the fingerprint is shown). The host fetches the document under the package URL
rules (HTTPS on 443 to a DNS name, no redirect, no credentials), verifies it, and refuses a bundle
outside its validity window. **One policy at a time** in v0: subscribing to another replaces the
current one only when the person confirms. Refreshing happens when the person asks; nothing is
fetched in the background.

## 5. What a subscribed policy does

### 5.1 Trust
A `publisher_key` anchor makes its key trusted for its scope, exactly as an operator pin with the
same `publisher_id` and `package_id_prefix` would (the two-sided rule of the trust store applies:
an anchored key outside its prefix, or a publisher anchored to other keys, is `mismatch`). **The
person's own trust store decides first**: a key they pinned, or a publisher they pinned to another
key, is decided by their pin, whatever the policy says. The trust reason is `policy_anchor`, and the
host says the publisher is trusted *through the policy*.

**Issuer anchors are declared, not applied, in v0.** They name who may vouch for publisher keys
through credentials, and no credential format exists yet (BACKLOG B-20). A host shows them and
confers no trust from them.

### 5.2 Decisions
For each permission the package declares whose kind the policy names, the policy's decision applies,
**lowered to the person's ceiling**: the duration the person's preset gives that kind (a `payment`
is never more than `once`; under a privacy-first preset personal data is `once`). Inside a selected
profile, only the profile's members are decided by the policy; everything outside it stays denied by
the profile. Tool approvals follow: a tool is approved by default when every permission it links is
granted and the binding allowlist (if any) admits the host implementation it would be bound to; a
tool the allowlist does not admit, or whose permission the policy denied, is not approved. **A policy
never picks a personal record**: resource selections stay the person's. Each item the policy decided
records `policy`, and the receipt names the policy (`provenance.policy: {policy_id, version, title,
content_sha256, signer_fingerprint}`).

### 5.3 The invariant
For every declared permission, the decision is at most the preset's duration for its kind, and
`deny` outside the selected profile; every approved tool is declared, inside the selected profile,
admitted by the allowlist, and has every linked permission granted. The policy never creates a
permission, a tool, or a duration the person could not have chosen themselves. (The Chrome core
checks this over random bundles: `test/core/policies.test.ts`.)

### 5.4 Overrides
The person can change any decision a policy made in the detailed view; the changed item is recorded
as `user`. A host recomputes every claim of `policy` against the policy in force, so a view cannot
pass its own choice off as the policy's.

### 5.5 Caps and models
While subscribed, a run is held to the lower of the person's run limits and the policy's caps (a cap
never raises a limit). `local_only` refuses a plan on a model not reported as local
(`model_not_local`). A cost cap admits only models whose cost the host can bound; with no prices in
the host catalog that means free (local) models only (`model_cost_unbounded`): an unknown price is
not zero. Caps and model constraints apply as long as the subscription does; v0 has no per-agent
override for them.

### 5.6 Revoking
Unsubscribing withdraws the policy's trust anchors and its decisions at once. A run plan prepared
under the policy becomes stale (`policy_withdrawn`); one prepared under an earlier version becomes
stale when another version is in force (`policy_changed`). An expired policy decides nothing and
stales the plans made under it in the same way.

### 5.7 Versions
A refresh that returns a lower `version` is refused (`document_rollback`); the same version with
different content is refused (`document_version_reused`). The held copy stays in force and the
failure is shown.

## 6. What a policy cannot do
It cannot grant a permission, a tool or a resource the package does not declare, grant outside a
selected profile, exceed the person's preset durations, offer `always`, pick a personal record,
raise a run limit, make the runtime call anything outside the decisions recorded in the receipt, or
replace any check of signature, compatibility, binding or resource. It is a set of defaults with
provenance, under limits the person keeps.
