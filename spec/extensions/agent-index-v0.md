# Agent index v0 (`org.webagents:agent-index-v0`)

Status: experimental. Schema: [`agent-index-v0.schema.json`](agent-index-v0.schema.json). Travels
as the content of a [signed document](signed-document-v0.md). Example:
[`examples/agent-index.json`](../../examples/agent-index.json) (the WebAgents demo index, signed
with a development key). Implemented by the Chrome Agent Browser's `StaticIndexResolver` (T8).

## 1. Purpose

Agents may not have public hyperlinks (deck §19). An agent index is a publisher's signed list of
agent packages: what each is said to be, who is said to publish it, and where its package is. A
browser that the person told to use an index searches it from the address bar and shows the
results as agent cards.

**Everything in an index is metadata, never authority** (paper §VI-a). Opening a result is the
ordinary open-and-verify of the package at its URL: the bytes are downloaded under the browser's
URL rules, the container, integrity, schema and signature are checked, the publisher's key is
evaluated against the person's own trust store, and authorization starts from nothing. What the
index claimed (a digest, a signer) is only compared with what the bytes prove, and a difference is
shown, not obeyed. An index's signature says who listed the agents, nothing about the agents.

**Properties.** This specification implements P-2 and P-18 (a signed document is metadata or delegated trust; it grants nothing by itself) of [the security and privacy model](../../docs/security-and-privacy-model.md#3-properties); a change to one of them is a new version of both documents (D-336).

## 2. Content

```json
{
  "index_id": "org.webagents.demo-index",
  "version": "1.0.0",
  "title": "WebAgents demo index",
  "description": "…",
  "publisher": {"name": "WebAgents research prototype (development key)"},
  "issued_at": "2026-10-08T00:00:00Z",
  "expires_at": "2027-12-31T23:59:59Z",
  "entries": [
    {
      "package_id": "org.webagents.literature-review",
      "name": "Literature Review Agent",
      "version": "0.2.5",
      "description": "…",
      "publisher": {"id": "webagents-research", "name": "WebAgents Research Prototype"},
      "package_url": "https://…/packages/literature-review-0.2.5.agent.pkg",
      "digest": "<package digest, 64 hex>",
      "archive_sha256": "<archive SHA-256, 64 hex>",
      "signer_fingerprint": "sha256:<64 hex>",
      "locators": ["literature-review@webagents.example"],
      "tags": ["research", "literature"],
      "homepage": "https://…"
    }
  ]
}
```

All objects are closed. `digest`, `archive_sha256`, `signer_fingerprint`, `locators`, `tags` and
`homepage` are optional. Texts are one line (the [profiles](profiles-v0.md) rule: no control,
line or paragraph separator character), lengths count Unicode code points. `version` is dotted
numeric (`1`, `1.2`, `1.2.3`). A **locator** is an agent name in the deck's form `name@host`
(lowercase); `.example` hosts are reserved for illustration.

## 3. Searching

A host matches **free text** when every word of the query occurs in an entry's name, description,
package id, publisher, tags or locators (case-folded, NFKC), and a **locator** when it equals one of
the entry's locators. Results keep the index's own order; a host may rank them by the trust status
of the signer each entry *claims* (trusted first), and by nothing else: no popularity, no
reputation, no paid placement.

## 4. Rules beyond the schema

1. `expires_at` is after `issued_at`; a host uses an index only inside that window (a few minutes of
   clock skew allowed at the start).
2. No two entries list the same `package_id@version`, and no two the same `package_url`.
3. An entry whose `package_url` (or `homepage`) the host's URL rules refuse is left out, with a note
   naming its position; the rest of the index stays usable.

## 5. Host behaviour

- **Added by the person, with a key.** An index is fetched only after the person adds it by URL and
  pins its publisher's key. It is never fetched in the background: only when added, refreshed, or
  searched while its copy is older than an hour.
- **Versions.** A refresh that returns a lower `version` is refused (`document_rollback`), and one
  that returns the same version with different content is refused (`document_version_reused`); the
  held copy stays in use and the failure is shown.
- **Fetching.** Index URLs follow the package rules: HTTPS on port 443 to a DNS name, one request, no
  redirect, no credentials, no referrer, bounded size.
- **Opening a result** is `package.open` of its `package_url`; the host may remember which index it
  came from to compare that index's claims with the opened bytes.

## 6. Other resolvers: NANDA

The NANDA index (arXiv 2507.14263) resolves an agent name through a lean index to a signed
**AgentAddr** (`agent_id`, `agent_name`, `primary_facts_url`, `private_facts_url`,
`adaptive_resolver_url`, `ttl`, `signature`) and from there to an **AgentFacts** document (`label`,
`description`, `version`, `provider`, `endpoints`, `skills`, `evaluations`, `certification`, …).
AgentFacts describes an agent; it has no member naming an agent *program*. The mapping this project
defines reads one extension member of AgentFacts:

```json
"org.webagents:agent-package-v0": {
  "package_url": "https://…/x.agent.pkg", "package_id": "org.example.x", "version": "1.2.1",
  "digest": "…", "archive_sha256": "…", "signer_fingerprint": "sha256:…", "publisher_id": "…"
}
```

| Candidate field | From |
|---|---|
| `package_url`, `package_id`, `version`, `digest`, `archive_sha256`, `signer_fingerprint`, `publisher.id` | the extension member |
| `name` | AgentFacts `label` (AgentCard `name`) |
| `description` | AgentFacts `description` |
| `publisher.name` | AgentFacts `provider.name` |
| `locators` | AgentAddr `agent_name` |
| `homepage` | AgentFacts `documentationUrl` |
| displayed claims | `certification`, `evaluations`, `jurisdiction`: shown as the registry's claims, never checked, never authority |

A NANDA result enters the same open-and-verify pipeline as an index result. The Chrome Agent
Browser ships this mapping (`src/core/resolve/nanda.ts`) as a stub: no registry endpoint is
configured, and AgentAddr signatures and AgentFacts credentials are not verified yet, so it returns
no candidate. A real adapter must verify both before it maps anything.
