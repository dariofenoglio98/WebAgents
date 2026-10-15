# memory.v0: a user-owned memory of Markdown records

Status: experimental, normative for agentpkg **0.4.0** and the Chrome core **0.2.0** (D-183, D-184,
D-188, D-210…D-219). The enclosing agent.pkg format stays 0.1 and `workflow.v0` stays the execution
profile: this document adds a host-owned store, three permission uses and one export format. Machine
contracts live beside it in [`spec/memory-v0/`](memory-v0/): `memory-record.schema.json`,
`memory-type.schema.json`, `memory-proposals.schema.json`, `memory-record-view.template.json`, the
four schemas of the agent-document tools (`memory-empty-input.schema.json`,
`memory-agent-read.output.schema.json`, `memory-agent-write.input.schema.json`,
`memory-agent-write.output.schema.json`), the starter taxonomy `taxonomy.json`, and RFC 6902 patches
for `policy.schema.json`, `workflow.schema.json` and the policy-bundle schema.
`scripts/check_memory_spec.py` validates every example in this document and the two worked examples
under `memory-v0/examples/` against those contracts, and refuses the negative cases of §10 with the
codes given there. Rules are numbered **M-n** so that a test can cite one; the table in §13 maps
every rule of D-184 to its number. **Every size limit in this document counts Unicode code points**,
as JSON Schema's `maxLength` does, so the schema is the check; byte counts appear only in audit
fields, where they are informational.

Vocabulary, kept apart as everywhere in this project: a **record** is what the person's memory holds;
a **type** is its schema with its sealed fields; a **recall** is the host offering records of a
requested type; a **grant** is the one record the person chose for one run, frozen by id and
digest; a **proposal** is what a run asks to remember, which becomes a record only when the person
accepts it; the **agent document** is one package's private notes. Nothing a package carries is ever
authority (D-005): a package declares the types it needs and may propose, the person grants, both
runtimes enforce the intersection (D-180).

## 1. Purpose and what v0 refuses

A person's memory is a **graph of Markdown records** that lives in the browser, grows from accepted
proposals and the person's own edits, is recalled before the person is asked, and is exported as a
folder any editor reads (D-183). It replaces the per-type personal vault ("Your data") with no loss of
enforcement: sealed values are encrypted at rest under the store's key (D-181, D-191), never reach a
model, and never leave a tool whose permissions do not link the grant (D-184).

Three things a package may do with it, each a permission use the agent page states in words:

| Use | Permission | What the package gets | What the person decides |
|---|---|---|---|
| read by type | `memory.read` (alias `personal.read`) | the one record the person chose, as a record view | which record, or none |
| propose | `memory.write` | nothing during the run; its proposals are reviewed after it | accept, edit or reject each |
| its own notes | `memory` with scope `agent-scoped` | its own document, read at start and written at the end | whether notes persist; read and clear in Settings |

M-1. **Refused in v0:** the memory scopes `publisher-scoped`, `user-global` and
`enterprise-governed`; any package-initiated search over memory (B-182); a proposal that carries a
sealed value; an update of a record the run was not granted; a proposal of a type the package did not
declare; a record written by a run without the person's acceptance; `always` grants (D-005); vector
embeddings (B-184). A runtime that implements this specification refuses each of these before the
forbidden boundary, with the codes given in the relevant section.

## 2. The record document

M-2. A record is **one Markdown document**: a YAML frontmatter block in the subset of §2.3, then a
prose body. The store, the export folder and the Python reference's memory directory all hold records
in exactly this form; the host's secret store additionally encrypts sealed values at rest (§2.5).

### 2.1 Frontmatter fields

| Key | Required | Form | Meaning |
|---|---|---|---|
| `id` | yes | `self`, `mem_` + 32 lowercase hex, or `agent_` + 16 lowercase hex | Opaque identity. `self` is the hub (§5.2). `mem_` ids are 16 random bytes. `agent_` ids are §7.4's. Never shown as the main name of a record. |
| `type` | yes | a type id (§4.1) | The record's type; its schema validates the fields. |
| `title` | yes | 1–200 characters, one line, no control characters | The name people and the graph show. |
| `scope` | yes | `user` or `agent` | `user`: the person's own record, recallable by type. `agent`: one package's document (§7.4), never recallable. |
| `created`, `updated` | yes | `YYYY-MM-DDTHH:MM:SS[.mmm]Z` (UTC) | Set by the host. `updated` moves on every accepted change of title, fields, body, links or tags. |
| `valid_until` | no | `YYYY-MM-DD` | After this date the record is **expired**: still held, demoted in recall, listed in Tidy up (D-219). |
| `source` | yes | §2.2 | Provenance: who wrote the record and from which run. |
| the type's fields | per type | top-level keys (Q8) | Every key that is not reserved (§2.4) is a field, validated by the type's schema. |
| `sealed` | no | JSON Pointers into the fields, each naming a string member the type schema declares at every step of its path (M-24) | The fields whose values are sealed for this record. **Always lists every sealed pointer of the type**, whether or not the field holds a value, plus the pointers the person added; the person may add pointers, never remove the type's (M-24). Omitted only for a type with no sealed fields and no additions. |
| `links` | no | `[{to: <id>, rel: <relation>}]`, ≤ 64 | Typed edges to other records (§5). In an export they are written per relation (§8.2). Omitted when empty. |
| `tags` | no | `^[a-z0-9][a-z0-9_/-]{0,47}$`, ≤ 32, unique | Free classification, lowercased on write. Omitted when empty. |
| `demo` | no | boolean | Part of the labelled fictional demo set (D-051). Omitted when false. |

M-3. The **body** is UTF-8 Markdown, NFC-normalized, LF line endings, no trailing whitespace at its
end (the writer adds one final newline), at most 16,384 characters for a `scope: user` record and
32,768 for an agent document (`scope: agent`, M-51; the record schema caps each scope, so a body the
agent write tool accepts is always committable). A `scope: user` body never holds a line that is
exactly `<!-- memory.v0 links -->`, the marker of an export's generated mirror (M-57): a write that
would store one is refused `body_reserved_marker` (M-24) and the proposals schema refuses it in a
proposal (N22; the string inside a longer line is ordinary text in both), so that an import can
never cut a body at a marker a person or a package put there (M-59); an agent document's body may
hold it, because it is never mirrored or stripped. A
`[[<id>|<alias>]]` wikilink in the body of a
`scope: user` record, with a well-formed record id as its target, is an edge of relation `related`
(§5.1); the alias is a cached title, never authoritative. A wikilink immediately preceded by a
backslash (`\[[…]]`) is **escaped**: it is text, never resolved and never an edge. **Wikilinks are
resolved when a body is written from an edit or an accepted proposal** (M-24, M-42): every unescaped
`[[<text>]]` or `[[<text>|<alias>]]` whose target is not an id and equals the title of exactly one
record of the store (NFC, case-insensitive) is rewritten to `[[<id>|<text>]]` (the alias kept when
given), and every bare `[[<id>]]` whose record exists is rewritten to `[[<id>|<alias of its
title>]]`, so that a stored id link always carries an alias (a bare `[[<id>]]` survives only for a
dangling id, which has no title to cache). The **alias of a title** is the title with `[`, `]` and
`|` replaced by `-`, so that the link stays one wikilink whatever the title holds. A wikilink that
matches no record, or more than one, is kept as written, is **not** an edge, and is reported as
dangling text (M-27). Creating, renaming or deleting a record never rewrites another record's body:
a plain link that a later record would match stays text until the person edits that body. An
export marks every plain-text link as escaped and reverses the rewrite of the edges (M-57); an
import removes that mark and resolves only what the export wrote from an edge (M-59), so an export
then import of the same store changes no body and creates no edge. **An agent document's body
(`scope: agent`, §7.4) is never rewritten**: it is stored, exported and imported exactly as the
package wrote it, its wikilinks are text and never edges (M-49), so that a package can never learn
through its own notes which titles or ids the store holds.

M-4. **Sealed values live only in fields.** A title, a tag or a body that contains a sealed value of
the same record (case-insensitive, anywhere) is refused `sealed_value_in_text`. A sealed value is a
string of at least 6 characters (D-051); a sealed pointer that resolves to a value of any other kind
is refused `sealed_field_invalid`. A sealed pointer may resolve to nothing: the field is optional in
the type and absent from the record (a contact without a phone), and the pointer is still listed in
`sealed`.

An example, as stored (fields flat, links in the stored form):

```md memory.record
---
id: "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60"
type: "travel.profile"
title: "Home travel profile"
scope: "user"
created: "2026-10-14T09:12:00Z"
updated: "2026-10-14T09:12:00Z"
tags:
  - "home"
home_airport: "BOS"
preferred_cabin: "economy"
prefer_nonstop: true
preferred_currency: "USD"
links:
  - to: "self"
    rel: "about"
source:
  kind: "migration"
  from_type: "personal.travel_profile"
  migrated: "2026-10-14T09:12:00Z"
---

Used for most trips. Business only when someone else pays.
```
### 2.2 Provenance (`source`)

M-5. `source` is an object with a `kind` and the keys of exactly one row:

| `kind` | Keys | When |
|---|---|---|
| `person` | — | typed or edited by the person in the Memory page |
| `package` | `package_id`, `package_version`, `run_id`, `proposal` (index in the run's proposals, ≥ 0), `accepted` (timestamp) | an accepted proposal; `package_id` and `run_id` are the run's own |
| `agent` | `package_id`, `package_version`, `run_id` | an agent document written by that run (§7.4) |
| `import` | `from` (the file name, ≤ 255 chars), `imported` (timestamp) | an imported file whose frontmatter carried no `source` |
| `migration` | `from_type` (the vault type id), `migrated` (timestamp) | the one-time vault migration (§11.3) |

M-6. Editing a record in the Memory page keeps its `source`: provenance says where a record came
from, not who touched it last. The usage log (§5.5) records the touches. A proposal's edit before
acceptance is still `package` provenance: the proposing run is what the person is told about.

### 2.3 The YAML subset

M-7. Frontmatter is the YAML subset below, and nothing else. A writer emits only this subset; a
reader accepts only this subset and refuses the file (`frontmatter_invalid`, with the line) otherwise.
It is small enough to implement without a library in both runtimes and covers what Obsidian writes
for properties.

- The block starts with a line `---` as the first line of the file and ends with the next line
  `---`. Both are exact; no byte-order mark.
- A **mapping** is `key: value` lines. Keys match `^[a-z][a-z0-9_]{0,63}$` and are unique. A value is
  a scalar on the same line, a nested mapping (the value empty and the next lines indented by two more
  spaces), or a sequence. An empty mapping is `{}`, the subset's one flow mapping, as a value or as
  a sequence item (`- {}`).
- A **sequence** is either a block sequence (lines `- ` under the key, at the key's indentation or
  two spaces deeper, each item a scalar or a mapping whose first key follows the dash) or a flow
  sequence `[a, "b", 3]` of scalars on one line. An empty sequence is `[]`.
- A **scalar** is a double-quoted string with JSON escapes, or a plain token matching
  `^[^"'\[\]{}#&*!|>%@,\s][^#]*$` with trailing spaces trimmed. A plain token that is exactly `true`,
  `false`, `null` or a JSON number is that JSON value; any other plain token is a string. The writer
  always double-quotes strings and writes numbers, booleans and `null` as canonical JSON text.
- No comments, anchors, aliases, tags, multi-line scalars, flow mappings other than the empty `{}`,
  single quotes, tabs or documents after the first. Indentation is spaces, two per level.
- The reader returns one JSON object. A reserved key (§2.4) is read as that field; every other
  top-level key is moved under `fields` in document order.

### 2.4 Reserved keys and canonical order

M-8. These keys are reserved and refused as a field name in any type schema (`reserved_field_name`):
`id`, `type`, `title`, `scope`, `created`, `updated`, `valid_until`, `source`, `sealed`, `links`,
`tags`, `demo`, `body`, `memory`, the seven relation names (`about`, `prefers`, `pays_with`,
`belongs_to`, `supersedes`, `derived_from`, `related`) and Obsidian's `aliases` and `cssclasses`.

M-9. The **canonical document** (what both runtimes write, so that stores and exports are byte-equal
for equal records): keys in the order `id`, `type`, `title`, `scope`, `created`, `updated`,
`valid_until`, `demo`, `tags`, the fields in the order of the type schema's `properties` (extra
properties, where a schema allows them, sorted by code point after the declared ones), `sealed`,
`links` **in canonical order** (sorted by relation in the vocabulary order of §5.1, then by `to` by
code point, duplicate `{to, rel}` pairs dropped; every write sorts, M-24, so the stored order, which
the digest covers, is the same in both runtimes and in an export) or the per-relation properties of
§8.2 in an export, in that same order, then `source`; omitted when empty or false as §2.1 says;
nested objects as nested mappings in the same rule (declared order, then sorted);
arrays as block sequences, `[]` when empty; strings double-quoted; then the closing `---`, an empty
line, the body, one final newline.

### 2.5 Sealed values at rest

M-10. The host stores every record with its sealed field values **replaced** by ciphertext under
the store's master key (D-191: AES-256-GCM, a fresh IV, AAD `memory|<record id>|<pointer>`), and
everything else in clear in the memory store. **A locked store is read-only:** it shows titles,
unsealed fields, bodies, tags, links and the graph, masks every sealed value, and refuses every write
(`store_locked`): an edit, a new record, a deletion, the acceptance of a proposal, an import, the
migration and the commit of an agent document all need the unlocked store, because the digest (M-11)
and the sealed-value checks of M-24 need the values and the memory key in clear. A proposal review
that arrives while the store is locked waits ("Unlock to review"); the proposals file stays in the
Run Record meanwhile. Reveal, grant and the export of a sealed value need the unlocked store as well.
A record whose sealed field cannot be decrypted (a changed key, a tampered entry) is shown with that
field as **unreadable**, is never granted, and is listed in Tidy up. The Python reference's memory
directory holds its key file `memory.key` inside it (M-63) and is never locked.

## 3. Canonical form and digest

M-11. The **digest** of a record is HMAC-SHA256, under the host's 32-byte memory key, of the
canonical JSON (RFC 8785) of

```json
{"schema": "memory-v0-record-digest", "id": "<id>", "type": "<type id>",
 "type_schema_sha256": "<sha256 of the canonical JSON of the type's fields schema>",
 "title": "<title>", "fields": {…}, "body": "<body>", "links": [{"to": "…", "rel": "…"}, …],
 "tags": ["…"]}
```

with `links` in canonical order (M-9) and `tags` in stored order, sealed values in clear (the digest
is computed in the unlocked store and kept beside the record), and nothing else: timestamps,
`source`, `scope`, `demo` and `valid_until` are metadata and do not move the digest. The key is the
vault's HMAC key in the Chrome host (`vault_key`, D-191) and the key file `memory.key` the Python
reference generates in its memory directory (M-63; T20); it is never exported. A digest is an
equality-comparable reference that says nothing to a reader of a receipt, plan or audit (D-051).

M-12. A run plan binds a granted record exactly as it binds a host resource today: `{permission_id,
resource_type, resource_id, resource_digest}`, with `resource_id` the record id and
`resource_digest` the digest. A record whose digest moved is a different record: the plan is stale
(`resource_changed`) before execution and the read is refused at call time (§7.1). Export then import
on the same host reproduces every digest (M-60); on another host the digests differ, by design.

## 4. Types

### 4.1 The type definition

M-13. A type is the JSON object of `memory-type.schema.json`:

| Key | Form | Meaning |
|---|---|---|
| `id` | a well-known id `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` (one or more dot-separated segments) or a package-qualified custom id `<package_id>:<well-known form>` | Identity of the type. The starter taxonomy's ids are well-known; a package's custom type is qualified by the package id that declared it (§4.4), so two packages can never share a custom type by naming the same local id. |
| `display_name` | 1–128 chars | What the person sees ("Travel profile"). |
| `description` | ≤ 4,096 chars or null | One or two sentences for the person. |
| `schema` | a JSON Schema (draft 2020-12) for the **fields**: `type: object` with top-level `properties`; no `$ref`, `$id`, `$dynamicRef` or remote reference; `$schema` optional; no reserved key (§2.4) among `properties` | Validates `fields`. The same guarded validator packages' schemas pass through (D-051). |
| `sealed_fields` | ≤ 16 JSON Pointers into the fields, each resolving to a string of the schema | The values that identify a person or an instrument: masked, encrypted at rest, scanned for at egress, never indexed, never in a proposal. |
| `identity` | ≤ 8 JSON Pointers, optional | The fields that say two records describe **the same thing** (D-219, §7.3): a preference's domain and key, a card's identifier, a contact's name. Absent: records of the type are never offered as replacements for each other. |
| `default_links` | `[{to, rel}]`, ≤ 8, optional | Links every new record of the type starts with (the person may remove them). The taxonomy uses `{to: "self", rel: "about"}` for the types that describe the person. |
| `display` | `{title_from: pointer or null, summary: [pointers ≤ 4]}` | A pointer whose value becomes the default title when the person leaves it empty, and the fields the record card shows first. |
| `declared_by` | `{kind: "spec" or "person" or "package", package_id?}` | Who defined the type. |
| `legacy` | `[{id, schema, projection}]`, ≤ 4, optional | Legacy type ids this type answers for under `personal.read` (§4.3). |

M-14. A type's `schema_sha256` is the SHA-256 of the canonical JSON of its `schema`. Replacing a
type's schema re-digests every record of the type (M-11 includes `type_schema_sha256`), which makes
every plan that named one stale, exactly as in the vault (D-051). A type with records cannot be
deleted (`type_in_use`).

### 4.2 The record view a package reads

M-15. A `memory.read` tool returns the **record view** of the granted record:

```json
{"id": "<record id>", "type": "<type id>", "title": "<title>", "fields": {…},
 "body": "<body>", "tags": ["…"], "sealed": ["/email", …]}
```

with the sealed values present in `fields` (the run was granted the record; where the values may go
from there is §7.1's egress rule), `body` the **view body**, `tags` as stored, and `sealed` the
record's sealed pointers as stored (the type's and the person's additions), so that a package knows
which values it may send only to the tools linking the grant and must leave out of a proposal
(M-40). The **view body** is the stored body in which every unescaped id wikilink whose target is
not a record granted to this run (by the plan's grants of records, a legacy `personal.read` grant
included, since it grants a record by id as well, M-17; `self` only when a `person.self` record is
granted) is **hidden**, rendered without its id: `[[<id>|<alias>]]` becomes `[[<alias>]]`, the
text of the body as the person sees it, or the escaped `\[[<alias>]]` when the alias is itself a
well-formed record id (the cached title of a record titled `self` or like an id, M-55), so that the
view never reads as a link by id; a bare dangling `[[<id>]]` becomes `[[missing record]]`; a link
to a granted record, a plain-text link and an escaped link are as stored. The **link occurrences**
of a view are its wikilinks in order, escaped ones included, each with the stored text it stands
for (the hidden link, or itself); M-42 reverses the rendering over them by position. The view
therefore carries a record id only for a record the run was granted, and what it withholds is the
store's resolution (which id a text names, and which record), not text the person wrote into the
granted record; the one thing a rendering says beyond the text is that a `[[missing record]]`
stood for a link to nothing (a bare id is stored only when dangling, M-3), a fact about the
granted record alone. A package that sends a view body back in an `update` passes M-40's step 6,
and acceptance restores the hidden links (M-42). Timestamps, provenance and links are not handed
to a run: a package learns what the person chose, not how they organise it.

M-16. The **record view schema** of a type is built from the type by this construction, and nothing
else; both runtimes and `check_memory_spec.py` produce the same bytes:

```json
{"$schema": "https://json-schema.org/draft/2020-12/schema",
 "type": "object",
 "properties": {
   "id": {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$"},
   "type": {"const": "<type id>"},
   "title": {"type": "string", "minLength": 1, "maxLength": 200},
   "fields": <the type's schema, verbatim, with any top-level "$schema" removed>,
   "body": {"type": "string", "maxLength": 16384},
   "tags": {"type": "array", "items": {"type": "string", "pattern": "^[a-z0-9][a-z0-9_/-]{0,47}$"}, "maxItems": 32, "uniqueItems": true},
   "sealed": {"type": "array", "items": {"type": "string", "minLength": 2, "maxLength": 256, "pattern": "^(/[^/]+)+$"}, "maxItems": 16, "uniqueItems": true}
 },
 "required": ["id", "type", "title", "fields", "body", "tags", "sealed"],
 "additionalProperties": false}
```

The file `memory-record-view.template.json` is this construction with the placeholder left in. A
package ships the view of each type it reads as its tool's output schema; the host binds the tool only
when the canonical JSON of that output schema equals the view it builds from its own type
(`binding_schema_mismatch` otherwise, before any run). The host resource registry
(`agentpkg-host-resource-registry-v0`) lists a memory type with `permission_kind: "memory.read"` and
`schema_sha256` = SHA-256 of the canonical JSON of the **view**; `RESOURCE_PERMISSION_KINDS` becomes
`["personal.read", "memory.read"]` in both runtimes.

### 4.3 The `personal.read` alias and legacy type ids

M-17. `personal.read` stays accepted (D-184) with **its own output contract unchanged**: a tool
linking a `personal.read` permission returns the fields alone, validated against the legacy schema,
and the registry lists the legacy id with `permission_kind: "personal.read"` and `schema_sha256` over
that legacy schema, as the vault does today. A host answers a legacy id from the type whose `legacy`
list names it: the person is offered that type's records, the grant is frozen under the **legacy**
`resource_type` (so the plan's shape is unchanged), and the tool's answer is the `projection` of the
record's fields (legacy pointer → record pointer; a sealed record pointer makes the legacy pointer
sealed). The starter taxonomy carries three such aliases (§11.3), so WebAir 0.5.0 runs unchanged on
a migrated host. A new package uses `memory.read` and the view.

### 4.4 Custom types declared by a package

M-18. A package may declare custom types in its policy under `memory_types` (the policy patch):
`[{id, display_name, description, schema: <package-relative path>, identity?}]`, ≤ 8, each `id` in
the well-known form, the schema a package schema file covered by the signature and bound by §4.1's
schema rules. The host qualifies the id with the package id (`org.example.shop:loyalty.card`); the
package's own permissions name the local id and the host resolves it. A custom type can declare **no
`sealed_fields`** (M-19); it is shown to the person at first use (display name, description, the
schema's properties) and is approved per `(package_id, type id, schema_sha256)`; a changed schema is a
new approval. Custom types are `declared_by: {kind: "package", package_id}`.

M-19. **Sealed fields come from the well-known list or from the person, never from a package.** A
custom type cannot declare sealed fields: `memory_types` admits no `sealed_fields` property, so a
declaration that carries one fails the policy schema (`schema_validation` at validation, before any
rule of this section runs); the person may seal fields of their own records of that type (M-24). A
custom type may not hold, unsealed, what a starter type seals: a custom type with a property, **at
any depth** of its schema (the object's `properties`, nested objects, array items), whose name is a
sealed field name of any starter type (today `email`, `phone`, `date_of_birth`, `payment_method_id`;
the list is computed from the taxonomy, never written into a runtime) is refused
`custom_type_shadows_sealed_type`, whatever its other properties, so that leaving one field out or
nesting it cannot evade the check; a package that needs such a value reads `person.identity`,
`contact` or `payment.card` by grant. The check is by property name over the schema as declared,
before any approval, and is complete only over a **closed** schema, which a custom type's must be:
every subschema declares `type` (or is a `const` or an `enum` whose values are scalars: strings,
numbers, booleans or null, never an object or an array), every object lists its `properties`
with `additionalProperties: false`, every array has an `items` schema, and none of `allOf`, `anyOf`,
`oneOf`, `not`, `if`, `then`, `else`, `patternProperties`, `propertyNames`, `dependentSchemas`,
`unevaluatedProperties`, `unevaluatedItems`, `prefixItems` or `contains` appears; otherwise the type
is refused `custom_type_schema_open` (checked after the name rule), so that no property name an
instance can hold escapes the rule. The rule is a guard against a careless schema, not a hostile
one: a field renamed (`e_mail`) passes it, and the review of proposals (M-42) is the control for what
such a field holds. A custom local id equal to any well-known id
(`contact`, `travel.profile`, …) or in a reserved family (`person.`, `payment.`, `agent.`,
`memory.`) is refused `custom_type_reserved`, so that `memory.write resources: ["contact"]` can never
be ambiguous.

## 5. The graph

M-20. **The graph is the data model, not a view** (D-183 as amended): nodes are records, edges are
the typed `links` of the frontmatter plus body wikilinks read as `related`. Everything else the Memory
page shows is derived from records, provenance and the usage log and is never stored as a record.

### 5.1 Relations

| `rel` | From → to | Means | In recall (§6.3) | Shown as (inverse) |
|---|---|---|---|---|
| `about` | a record → the person (`self`) or another record | the record describes its target | a record linked `about → self` ranks first among its type | "about" / "described by" |
| `prefers` | a profile or `self` → a preference | the target is a standing preference of the source | a preference linked from a selected record ranks up | "prefers" / "preferred by" |
| `pays_with` | `self` or a profile → a `payment.card` | the target is the instrument the source uses | same | "pays with" / "used by" |
| `belongs_to` | a record → a profile, a collection or `self` | the record is part of its target | a record linked to a selected record ranks up | "belongs to" / "contains" |
| `supersedes` | a newer record → the record it replaces | the target is obsolete; its head is the source | the target is hidden from recall; the head stands in for it | "replaces" / "replaced by" |
| `derived_from` | a record → the record it was computed from | provenance inside memory (a review from a profile, a proposal from the record it refined) | no effect | "derived from" / "source of" |
| `related` | any → any | untyped; every body wikilink | small effect | "related" |

M-21. Edges are directed and typed; the same `{to, rel}` pair appears at most once per record; a
record never links to itself. Links to `self` carry the id `self`. A `derived_from` or `supersedes`
edge is kept when its target is deleted (it becomes dangling and says so, M-27).

### 5.2 The hub `self`

M-22. The first time the memory store is opened (and after "Forget everything") the host creates
**exactly one** record of type `person.self` with the reserved id `self`, title "Me" until the person
renames it, `source {kind: "person"}`, no links. It cannot be deleted, superseded or proposed, has no
sealed field, and is the default target of `default_links`. A store with zero or two `self` records
is invalid and is repaired by the host (the first `person.self` record by `created` keeps the id
`self`; others are retyped `document.note` and listed in Tidy up).

### 5.3 Derived layers

M-23. Two layers the Memory page may draw and never stores:
- **Type hubs**: one node per type that has records, with an edge to each record of the type.
- **Package nodes**: one node per `package_id` that appears in any record's `source` or in the usage
  log, with display-only edges `proposed` (to records it proposed, from `source`), `read` (from usage
  entries `read`) and `wrote` (to its agent document). These names are not relations and never appear
  in a record.

### 5.4 Integrity

M-24. On every write (create, edit, accept, import, migrate) the host, with the store unlocked
(M-10), checks: the frontmatter against `memory-record.schema.json`; the fields against the type
schema; `sealed` a superset of the type's sealed pointers, every listed pointer naming a string
member the type schema declares at every step of its path, decided from the path against the
schema and never from the values the record holds today (a pointer through an array, into an
undeclared member or to a member of another kind is `sealed_field_invalid`, even while the field
is absent, never silently unsealed), and resolving to a string of at least 6 characters or to
nothing (M-4); the title, tags and body free of the record's sealed values (M-4); the body of a
`scope: user` record free of the mirror marker line (`body_reserved_marker`, M-3); the body's wikilinks resolved as M-3 says when the write is an edit or an
acceptance (an import resolves by M-59 instead; an agent body is never resolved); the caps of §2 and D-212 (the body at most
16,384 characters, or 32,768 for an agent document, M-3; the canonical JSON of `fields` at most
16,384 characters; `memory_record_too_large`); `supersedes` acyclic over the whole store
(`supersedes_cycle`) and at most one superseder per record (`superseded_twice`); link targets
well-formed ids; `links` sorted into canonical order with duplicate pairs dropped (M-9: a write
normalizes the order rather than refusing it). A write that fails any check changes nothing.

M-25. **Deletion.** Deleting a record removes it and its sealed values. Links to it in other records
stay as they are and are reported dangling (M-27); a record it superseded becomes a head again. `self`
cannot be deleted. Deleting a type's last record does not delete the type.

M-26. **Chains.** The **head** of a record is the record that is not superseded, reached by following
`supersedes` edges backwards (a record R is superseded when some record links `supersedes → R`).
Recall offers heads only (§6.3); the graph view hides superseded records by default and shows them
on request; Tidy up lists them with "delete the old versions".

M-27. **Dangling links are kept and flagged, never dropped.** The graph index lists every link whose
target id is not in the store; the record card shows such a link as "missing record"; an export
writes it **in id form** (`"[[<id>]]"` as a property item, a body link unchanged with its alias,
M-57) and lists it under `## Missing` in the index with the last known title when a body alias
caches one (M-58); an import keeps a well-formed id that resolves to no record as a dangling edge of
the same relation, and keeps a plain-text wikilink that names no record as body text (M-59), so that
an export then import loses no edge (M-60). Nothing silently repairs or removes a link.

### 5.5 The graph index and the usage log

M-28. The **graph index** (out-links, in-links, degree, chain heads, dangling links, the derived
layers, the local subgraph at depth n around a record) is computed from the records and is **never
authoritative**: it is rebuilt from the records when the store opens and after every write, and a host
may cache it but must not export it or trust a cache that predates a write.

M-29. The **usage log** is a bounded list the host keeps beside the records (never inside one, so
that use does not move a digest): `{record_id, use, package_id, package_version, run_id, at}` with
`use` one of `read` (a run read the record), `proposed` (a run proposed it; the record is the one
created at acceptance, and `at` is the instant of the run's `memory.proposed` audit event, so the
entry is written at acceptance but dated at the proposal), `accepted` (`at` = the acceptance),
`agent_read`, `agent_write` (`at` = the tool call). The log's **canonical order**, in the host and
in `memory-usage.json`, is by `at` as an instant (never as text), then `record_id` by code point,
then `use` in the order of the list above, so both runtimes write the same bytes. At most 65,536
entries; the oldest are dropped first. It feeds recall ranking, "where used" on the record card and the package layer; it
is exported as `memory-usage.json` (§8.1) and imported when present.

## 6. Retrieval

### 6.1 Filters

M-30. Retrieval is by exact type id (a legacy id resolves to its type), by exact tag, and by text
(§6.2); every retrieval excludes `scope: agent` records, and recall additionally excludes superseded
records (M-26). There is no retrieval API for packages: §6 is the host's own, for the Memory page and
for recall.

### 6.2 The text index (D-211)

M-31. The text index is **BM25** (k1 = 1.2, b = 0.75) over four fields with weights: `title` 3,
`tags` 2, the string values of `fields` (nested ones included; numbers as their canonical JSON text)
1.5, `body` 1; a document's score is the sum of its field scores. Tokens are the maximal runs of
Unicode letters and digits of the NFKC-lowercased text; no stemming, no stop list. **Sealed values are
removed before tokenization** and a query that equals a sealed value matches nothing. The index is
derived state (M-28 applies) and is never exported. Embeddings are B-184.

### 6.3 Recall ranking

M-32. For a `memory.read` (or `personal.read`) request of type T, the host computes the candidate
list as a **pure function** of the store, the usage log, the plan under preparation and one instant,
**the recall instant**: the host's clock when it computes the candidates for the plan under
preparation (before any receipt exists; a test passes it explicitly; it is not recorded in the plan),
"today" below being that instant's UTC date, so that both runtimes and a test agree on the order:

1. Candidates: records of type T (or of the type whose `legacy` names T), `scope: user`, not
   superseded (M-26), with every sealed field readable (M-10).
2. Score each candidate:
   - +8 when it links `about → self` (or any link to `self`);
   - +6 when the usage log holds a `read` or `accepted` entry for it by the requesting package id within
     the last 365 days;
   - +4 when it links to, or is linked from, a record already selected in this plan;
   - +2 when the usage log holds any `read` entry for it within the last 30 days;
   - −4 when it is expired (`valid_until` before today).
3. Order by score descending, then by the latest usage `at` for it descending (none last), then by
   `updated` descending, then by `id` ascending.

A host without a usage log (the Python CLI by default) applies the rules it can. T19's D-220 may
change the weights, in both runtimes together, with the conformance comparison updated.

## 7. Permission semantics

Every rule here is enforced by both runtimes; the Chrome host adds the person-facing flow (recall
card, review sheet) of the UI design and the Python reference takes the same decisions from files
(T20). The decisions a package can obtain are the three permission kinds below; nothing else in a
package touches memory.

### 7.1 `memory.read`: recall, then one record

M-33. **Declaration.** A permission of kind `memory.read` names in `resources` exactly one type id
(a well-known id, a custom local id of §4.4, or a legacy id under the alias `personal.read`); two
types in one permission are `ambiguous`, as for `personal.read` today. The package declares one
`local` tool per such permission: `binding` = `host.memory.<type id>` (`host.resource.<legacy id>`
under the alias), `input_schema` the empty object, `output_schema` the record view of the type
(M-16; the legacy schema under the alias), `permissions` naming that one permission, `side_effects:
"read"`, `approval_required: true`, `domains: []`. A tool whose output schema does not canonicalize
to the host's view is not bound (`binding_schema_mismatch`).

M-34. **Recall, then the person.** At authorization the host computes the candidates of §6.3 for
each `memory.read` request and shows a recall card per request: the top-ranked record proposed with
its title, type, last use ("last used 3 days ago on WebAir") and provenance, "change" opening the full
list (the customize view shows all), and "none" denying the permission. What the preset decides is
§7.5: privacy-first pre-selects nothing, balanced pre-selects the top candidate and the person
confirms, convenience auto-selects the top candidate of an **unsealed** type and shows it in the
summary. A type with a sealed field is never auto-selected. The person's pick (or the preset's
auto-selection, recorded as `preset` in the plan's provenance, D-053 amended) is frozen into the
receipt and the plan as M-12 says. A package never sees candidates: the plan carries one id and one
digest per granted permission.

M-35. **The read.** The tool takes no arguments (`tool_request_invalid` otherwise); the host
resolves exactly the plan's grant for the tool's type under a permission the tool links; a missing
grant is `tool_request_invalid`, a record that changed or disappeared `tool_unavailable` (and the plan
was stale before the run, `resource_changed` / `resource_removed`); a denied permission is
`permission_denied` at the mediator, before the tool. The answer is the record view (M-15), attributed
in the audit (`memory.read`, §9) by id and digest. `max_calls_per_tool` bounds the reads as for every
tool. Nothing about other records, their count, their ids or their titles reaches the run beyond
the text of the granted record itself: the view body carries a record id only for a record the run
was granted (M-15). A record view
reaches a model only where the package's signed graph routes it, as `data`; a host that renders model
requests labels memory-sourced data as the person's stored content and never as instructions (the
threat model, § User memory), and the same framing applies to the agent document (M-51).

M-36. **Egress: tools** (carried over from `personal.read`, D-011). Before every tool call except a
memory read, the arguments are scanned (case-insensitive, anywhere, keys included, no depth cut-off)
for the run's **scan set**: a sealed value of a record this run was not granted may go nowhere
(`permission_denied`, `sealed_value_not_granted`); a granted one may go only to a tool whose
permissions include the permission it was granted under (`permission_denied`, `sealed_value_egress`).
A scan that cannot finish (more strings than the scanner's ceiling) refuses. The signed package
therefore states where each sealed value may go: a tool that sends a record to a service links the
record's permission.

**The scan set** of a run is fixed when the run starts and is the same for M-36, M-37 and M-40: the
sealed values, by record id and pointer, of **every record of the store** when the run is **opened
with the store**, and **empty** otherwise. A run is opened with the store exactly when its plan
grants a memory record (a `memory.read` or alias grant) or binds a memory tool (`host.memory.*`,
`host.resource.*`), which under D-195 needs the store unlocked before the run starts; any other run
(Literature Review on Ollama with no memory permission) is opened without it, holds no sealed value,
and runs while the store is locked. That is sufficient because a sealed value can enter such a run
only from outside the store (the task input, a tool's answer), which the guard does not police: it
is an exact-value check over values the host holds, not data-loss prevention. The locked-store case
never refuses a model call: a run that needs the store does not start while it is locked, and a run
that does not need it has an empty scan set.

M-37. **Egress: models** (new, Q2). Before every model request, including the token count that
precedes it, the complete request as it will be sent (task, instructions, data, schema, feedback)
is scanned the same way for the scan set; a hit refuses the call before anything leaves
(`permission_denied`, `sealed_value_in_model_request`, naming the record id and the pointer, never
the value), and the node fails `permission_denied`. This holds in every mode, fixture included
(M-62 says what the scan set is in fixture mode): a package's graph that routes a sealed value into
a model step is refused mechanically in both runtimes, where today it is refused by the package's
own read sets and a test-time observer. Unsealed fields (a home airport, a cabin) are ordinary data
and may reach a model when the graph routes them there.

### 7.2 `memory.write`: proposals only

M-38. **Declaration.** A permission of kind `memory.write` names in `resources` the type ids (≤ 8)
the package may propose, never `person.self` or `agent.memory` (neither can be proposed, M-22, M-49:
a policy naming one is refused at validation, `memory_type_reserved`, as is a `memory.read` naming
`agent.memory`); a package declaring it also declares **exactly one** export `{path:
"proposals.json", format: "memory.proposal", value: …}` in its graph, and a graph declaring that
export's format belongs to a package declaring `memory.write` (`memory_proposal_undeclared` at
validation otherwise). Any package that declares `memory.write`, `memory.read` with a non-legacy type,
a custom type or `agent-scoped` memory declares `runtime.minimum_version` **0.4.0** or later (M-67).

M-39. **The proposals document.** The export's value is constructed from the final result like any
export and must match `memory-proposals.schema.json`:

```json memory.proposals
{"schema": "memory.v0 proposals",
 "proposals": [
   {"action": "create", "type": "travel.preference", "title": "Aisle seat",
    "fields": {"kind": "seat", "value": "aisle"}, "body": "Chosen on the Boston booking of 14 October.",
    "tags": ["seat"], "links": [{"to": "self", "rel": "about"}],
    "rationale": "You chose an aisle seat when booking WA101."},
   {"action": "update", "type": "travel.profile", "target": "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60",
    "title": "Home travel profile",
    "fields": {"home_airport": "BOS", "preferred_cabin": "economy", "prefer_nonstop": true, "preferred_currency": "USD"},
    "body": "Used for most trips. Business only when someone else pays.",
    "tags": ["home"], "links": [{"to": "#0", "rel": "prefers"}],
    "rationale": "Links your home profile to the seat preference."}
 ]}
```

At most 8 proposals; `title` as M-2; `fields`, `body` and `tags` as a record's; `links` ≤ 64 with
`to` one of `self`, a record id this run was granted, or `#<n>` naming another proposal of the same
document by index, and `rel` any relation **except `supersedes`** (the schema refuses it: only an
`update` supersedes, through its `target`, and only at acceptance, M-42); `rationale` 1–500
characters, shown to the person as the package's words; `target` required for `update` and forbidden
for `create`.

M-40. **Host checks on completion.** After the export is constructed and before the run is reported
complete, both runtimes check the document in memory **in this order** and fail the run on the first
hit: steps 1 and 7 run once over the whole document; steps 2 to 6 run **proposal by proposal, in
index order**, each proposal through steps 2 to 6 before the next one is looked at, so that a document
with two refusable proposals makes both runtimes report the lower index's first failing step (N19);
**the file is written only when every check passes**, so that a refused document, which may hold a
sealed value, never reaches the Run Record (the failure's code and the proposal index are what the
record and the audit carry):
1. the document against the schema (`schema_validation`; a `supersedes` link fails here);
2. every `type` is one of the permission's `resources` (a custom local id resolved as §4.4) and not
   a reserved type (`person.self`, `agent.memory`: never proposable, whatever `resources` says,
   M-38), else `permission_denied` (`memory_proposal_type_undeclared`);
3. no proposal's `fields` contains a pointer the type seals, nor, for an `update` whose target is a
   record this run was granted with the proposal's type (what step 5 checks), a pointer that record
   seals (the person's additions, M-24; the view told the package which, M-15), else
   `schema_validation` (`memory_proposal_sealed_field`): a proposal never carries a sealed field. An
   ungranted target contributes nothing to this step or to step 4 (the type's seals alone apply),
   so that no code before step 5 says whether such a record exists or what it seals;
4. every proposal's `fields` validates against the type's schema **with those sealed pointers
   removed from `required`** (a required sealed field is what the person types at acceptance, or
   what an update carries over, M-42), else `schema_validation`;
5. every `update` names a `target` among the ids this run was granted (M-12) and the target's type
   equals the proposal's `type`, else `permission_denied` (`memory_proposal_target_not_granted`);
6. every link's `to` is `self`, an id this run was granted, or `#<n>` naming an existing **other**
   proposal: a `#<n>` that does not is `schema_validation`; a record id the run was not granted,
   learned in an earlier run or guessed, is `permission_denied` (`memory_proposal_link_not_granted`);
   the same holds for every unescaped id wikilink in the proposal's `body` (an edge, M-3), checked
   after the `links` array in document order;
7. **no sealed value anywhere in the document:** every string of the canonical document (titles,
   fields at any depth, bodies, tags, rationales, keys) is scanned with M-36's scanner for the run's
   scan set, else `permission_denied` (`sealed_value_in_proposal`, naming the proposal index, the
   record id and the pointer, never the value). Step 3 catches a sealed *field*; this step catches a
   sealed *value* copied into an unsealed place (an e-mail as a `travel.preference` value, a card
   token in a body), which M-1 refuses.
A run whose `memory.write` permission was denied still produces and checks the document (a package
bug is a package bug) and the audit records `memory.proposed` with `offered: 0` and `reason:
"permission_denied"`; nothing is reviewed. A signed policy with `memory.proposals: "refuse"` has
the same effect (`reason: "policy"`).

M-41. **Nothing is written by a run.** The proposals document is an artifact of the Run Record
(`proposals.json` beside the other exports; the record's `memory.proposals` summary gives the count
and the types). The host offers the review after the run ends (or at a consent step once
`conversation.v0` exists, D-186). Until the person acts, no record exists, no link exists, and the
usage log holds no `proposed` entry.

M-42. **Acceptance (D-213).** The review (in an unlocked store, M-10) shows each proposal with the
package's rationale, the type (with "new type" and its description when the type was approved at
first use), the fields, the body, the links as edges to existing titles, the record it would replace
(M-44), and, for an `update`, **what is kept from the record it replaces** (its sealed values by
field name, its links the proposal did not carry, the edges of its body the view hid). Per proposal
the person may **accept**, **edit then accept** (title, unsealed fields, body, tags, links; a sealed field is typed here and only here,
and for an update is pre-filled from the target), or **reject**. Acceptance writes:
- for `create`: one record `{id: fresh, type, title, scope: "user", created: now, updated: now,
  source: {kind: "package", package_id, package_version, run_id, proposal: n, accepted: now},
  fields, sealed: the type's sealed pointers, links: the type's `default_links` and the proposal's
  links, resolved (`self` as is; a granted id as is; `#m` → the id of sibling m when m is accepted in
  the same review, else the link is listed as "to a proposal you rejected" and left out with that
  note), **sorted into canonical order** (M-9, duplicate `{to, rel}` pairs dropped), tags, demo:
  false, valid_until: the proposal's when given}`; the body's plain wikilinks are resolved by M-3
  **only against `self`, the run's granted records and the siblings accepted in the same review**
  (package-authored text never links into a record the run was not granted, step 6), anything else
  staying text;
- for `update`: the same record, **carrying over from the target what the run never saw and could
  not send**: the target's value at every sealed pointer the proposal left out (the type's and the
  person's additions; the person may retype one in the edit form), the target's `sealed` pointers,
  the target's out-links except its own `supersedes` link, `demo`, and `valid_until` unless the
  proposal sets one; plus the link `{to: target, rel: "supersedes"}`; the whole link set sorted into
  canonical order (M-9); and **the edges of the target's body that the view hid** (M-15): before
  any other resolution of the proposal's body, the rendering of M-15 is reversed **by position**
  over the link occurrences of the target's view: the n-th wikilink of the proposal's body with a
  given text (backslashes included) is the n-th occurrence of that text in the view and becomes
  what that occurrence was in the stored body (the hidden link it rendered, or itself), whether
  the occurrence was a hidden link or plain text; a wikilink beyond the view's occurrences of its
  text is left as it is, for the resolution above. So an `update` that echoes the view exactly
  stores the body as it was, two hidden links with one text (`[[Trip ideas]]` twice) both return,
  and plain text beside a hidden link of the same words never becomes an edge. Every hidden link
  the reversal placed nowhere (its target restored at no position) is kept as a frontmatter link
  `{to: <its target>, rel: "related"}`, so that an update never drops an edge the run could not
  see; the review sheet lists both under "Kept from the record it replaces". The target is kept
  and becomes superseded (M-26).
  When the target is no longer a head at review time (another record superseded it since the plan
  was made), the sheet says so and offers to replace the chain's **head** instead (the link then
  targets the head) or to keep the new record without replacing anything (no `supersedes` link); a
  second superseder is never written (`superseded_twice` cannot occur through a review);
- the usage log entries `proposed` and `accepted` for the new record (`at` as M-29 says);
- the review's outcome in the Run Record (`memory.proposals.accepted`, `rejected`, by index).
Rejection writes nothing. The decisions of one review **take effect together** when the last
proposal is decided (or on "Accept all" / "Reject all"): every accepted proposal receives its id
first, then links are resolved, so a link to a sibling of higher index (`#1` from proposal 0) is kept
whenever that sibling is accepted, whatever the order of the clicks. A proposal is reviewed once: a
closed review cannot be reopened for the same run (the file stays inspectable).

### 7.3 Hygiene: replacement, expiry, Tidy up, caps (D-219)

M-43. A memory must be able to shrink. Three mechanisms, none of which removes anything without a
click.

M-44. **Replacement by identity.** When a `create` proposal, a person's new record or an imported
record has a type with `identity` pointers and a **head** record of the same type whose values at
those pointers are equal (strings compared NFKC case-insensitively, other JSON values exactly; an
absent optional field equals another absent one and never a present value), the host offers it as a
**replacement**: "Replace *<old title>*" (on by default in the review sheet and
the new-record form) adds `{to: old, rel: "supersedes"}` to the new record; "Keep both" adds nothing.
Two matches offer the newest; the person may pick. The old record is never deleted by this: it is
superseded and listed in Tidy up.

M-45. **Expiry.** `valid_until` marks a fact's horizon (a card's expiry month, a seasonal address, a
review that goes stale). An expired record is still recalled (demoted, M-32) and still readable; the
recall card and the record card say "expired on <date>"; Tidy up lists it. A proposal may set
`valid_until` only when the type's schema has no field by that name (it is frontmatter, not a field).

M-46. **Tidy up** is a view of the Memory page listing, each with a count and bulk actions
("delete", "keep"): superseded records (by chain), expired records, records with unreadable sealed
values (M-10), records with dangling links (M-27), records not used by any package for 180 days,
the demo set, and agent documents by package (§7.4). Each deletion is a click on a listed record or a
confirmed bulk action naming the count.

M-47. **Caps never delete.** The store holds at most 8,192 records (agent documents included) and
128 types. A write that would pass a cap is refused `memory_full` with a pointer to Tidy up; a proposal
that would pass it is shown in the review with "memory is full" instead of accept; nothing is evicted.

### 7.4 `memory` with scope `agent-scoped`: the agent document

M-48. **Declaration.** A package whose policy says `memory.scope: "agent-scoped"` (with `retention:
"user-managed"`, `raw_documents: false`, `sharing: "explicit_views"`; the run's state semantics are
unchanged) declares one permission of kind `memory` whose `resources` is `["agent"]` and up to two
`local` tools: `host.memory.agent.read` (input the empty object; output `{"body": string ≤ 32,768
characters, "updated": timestamp or null}`) and `host.memory.agent.write` (input `{"body": string ≤
32,768 characters}`; output `{"staged": true, "bytes": integer}`, `bytes` the UTF-8 size of the
staged body), both linking that permission, `side_effects` `read` and `write`, `approval_required:
true`, `domains: []`, and the write with `max_calls_per_tool` exactly 1 (`agent_memory_write_cap`
otherwise). **The four schemas are exactly the files** `memory-empty-input.schema.json`,
`memory-agent-read.output.schema.json`, `memory-agent-write.input.schema.json` and
`memory-agent-write.output.schema.json` in `memory-v0/`: a package ships copies, and the host binds a
reserved agent tool only when the canonical JSON of the package's input and output schemas equals
them (`binding_schema_mismatch` otherwise, as for a `memory.read` tool, M-16), so that the registry
hashes the same bytes in both runtimes. The bindings are refused in a package whose scope is not
`agent-scoped`, and `agent-scoped` is refused without the `memory`/`agent` permission (both at
validation). `publisher-scoped`, `user-global` and `enterprise-governed` stay refused as today
(PolicyError before the run). The Literature Review example (§12) ships the pair.

M-49. **One document per package.** The host keeps at most one record of type `agent.memory`,
`scope: "agent"`, per `package_id`, with the id `agent_` + the first 16 hex characters of
SHA-256(package id), the title = the package's `name` at the last write, `fields: {package_id}`,
`source {kind: "agent", …}` of the last writing run, no links, no tags, and a body that is never
rewritten (M-3: its wikilinks are text, never resolved against the store, never edges). It is never a recall
candidate, never proposable, never in the text index, and counts against the record cap. Its body is
the package's own Markdown; the host shows it in Settings → Memory → Agent notes and on the graph
under its package node, and the person can read, export and clear it.

M-50. **Read at start, write at the end.** `host.memory.agent.read` returns the current body (empty
string and `updated: null` when none). `host.memory.agent.write` **stages** the body: the audit
records `memory.agent.write` with its size and hash, and the document is **committed only when the
workflow completes** (`workflow.completed`, after exports and M-40), recorded as
`memory.agent.committed` before `memory.cleared`; a failed, cancelled or interrupted run discards
the staged body (`memory.agent.discarded`, reason `run_failed` | `cancelled` | `preset` | `policy`).
The host writes the document **before** it records `memory.agent.committed`; a write the store
refuses (a full disk, a read-only folder) is recorded as `memory.agent.discarded` with reason
`store_failed`, and the run stays completed: a Run Record never claims a commit that did not happen.
Under the privacy-first preset, or a policy with `memory.agent: "refuse"`, the read returns the empty
document and the write is staged and discarded at the end with that reason: the package runs; nothing
persists; the agent page says so.

M-51. **Bounds (D-214).** The body is at most 32,768 characters (the tool's input schema, so an
oversize write fails `schema_validation` at the tool; the same cap is the record schema's for
`scope: agent`, M-3, so a staged body is always committable), one write per run, no links, no
fields beyond `package_id`, no sealed field, no recall, no sharing: a package reads only its own
document (the package id is the run's, never an argument). A document's content is data
to the next run's model, framed as the package's own stored notes (M-35, the threat model § User
memory), never an instruction to the runtime.

### 7.5 Presets (D-216) and what the plan records

M-52. The three host presets (D-050) decide durations and pre-selections; they never widen
anything:

| Preset | `memory.read` | `memory.write` | agent document |
|---|---|---|---|
| privacy-first | `once`; the recall card pre-selects nothing: the person picks or denies | `once`; every proposal reviewed | not persisted (M-50, reason `preset`) |
| balanced (default) | `session`; the top candidate pre-selected, one click confirms; a sealed type (payment, identity, contact) gets the privacy-first card: nothing pre-selected, the person picks | `session`; every proposal reviewed | persisted |
| convenience | `session`; the top candidate of an **unsealed** type auto-selected and shown in the summary ("Using *Home travel profile* · change"); a sealed type gets the privacy-first card, as under every preset | `session`; every proposal reviewed | persisted |

Without a profile, `memory.read` is treated like `personal.read` in D-050's optional-permission rule
(balanced grants it only with the person's choice; convenience grants it) and `memory.write` like a
non-personal permission (granted by balanced and convenience; nothing is written without acceptance).
With a profile, the profile decides membership and the preset only the durations (D-022). `always`
is never offered.

M-53. The plan's `authorization.provenance.resource_selections` records each pick as `user`, or as
`preset` for a convenience auto-selection (D-053 amended: a preset may select a record of an unsealed
memory type and says so). The summary card's words: `memory.read` → "read your <type display name>
(you choose which)", or, once chosen, "use *<title>*"; `memory.write` → "propose things to remember
(<type display names>); you review each one after the run"; `memory`/`agent` → "keep its own notes
between runs (at most 32,768 characters), which you can read and clear in Settings", or under
privacy-first "keep
no notes between runs".

### 7.6 What a signed policy may restrict

M-54. A subscribed policy bundle (`spec/extensions/policy-bundle-v0.md`, the patch in
`memory-v0/`) may set default decisions for the kinds `memory.read` and `memory.write` (`deny`,
`once`, `session`) and a `memory` object with `types_allowed` (type ids a package may be granted
`memory.read` or `memory.write` for; absent: no restriction), `proposals` (`ask` | `refuse`),
`agent` (`allow` | `refuse`) and `recall` (a ceiling on the preset's pre-selection: `ask` <
`propose` < `auto`; a preset above the ceiling is clamped). Every restriction is shown with the
policy's provenance like any other (D-102) and a policy can never grant: it only lowers.

### 7.7 Refusal codes

| Where | Code | Meaning |
|---|---|---|
| validation | `memory_proposal_undeclared` | `memory.write` without the export, or the export without the permission |
| validation | `agent_memory_write_cap`, `agent_memory_scope` | the write tool's cap is not 1; a reserved agent binding outside `agent-scoped`, or `agent-scoped` without the permission |
| validation | `custom_type_shadows_sealed_type`, `custom_type_schema_open`, `custom_type_reserved`, `reserved_field_name` | §4.4 and M-8 (a custom type that declares `sealed_fields` fails the policy schema, `schema_validation`) |
| validation | `memory_type_reserved` | a `memory.write` naming `person.self` or `agent.memory`, or a `memory.read` naming `agent.memory` (M-38) |
| binding | `binding_schema_mismatch` | a `memory.read` tool's output schema is not the type's view |
| plan | `resource_selection_required`, `resource_changed`, `resource_removed`, `memory_type_unknown` | as for host resources; a type the host does not hold |
| run | `permission_denied` with `sealed_value_not_granted`, `sealed_value_egress`, `sealed_value_in_model_request`, `sealed_value_in_proposal`, `memory_proposal_type_undeclared`, `memory_proposal_target_not_granted`, `memory_proposal_link_not_granted` | M-36, M-37, M-40 |
| run | `schema_validation` with `memory_proposal_sealed_field` and the schema failures of M-40 (a `supersedes` link, a bad `#n`) | M-40 |
| run | `tool_request_invalid`, `tool_unavailable` | M-35 |
| store | `store_locked`, `sealed_value_in_text`, `sealed_field_invalid`, `body_reserved_marker`, `memory_record_too_large`, `supersedes_cycle`, `superseded_twice`, `type_in_use`, `memory_full`, `frontmatter_invalid` | §2, §5, §7.3 |

## 8. Export and import (D-215)

### 8.1 The folder

M-55. An export is a folder (or a STORED zip of it, as run exports are, D-073):

```
<root>/index.md                       the index document (M-58)
<root>/memory-usage.json              the usage log (M-29), optional
<root>/<type id>/<stem>.md            one file per record, grouped by type
<root>/agent.memory/<stem>.md         agent documents, when the person includes them
```

The **stem** is the title after NFC normalization with `/ \ : * ? " < > | [ ] # ^` and control
characters replaced by `-` (the first seven break file names, the last four break a wikilink or
Obsidian's reading of one), runs of whitespace collapsed to one space, cut to 100 characters and
to 200 bytes of UTF-8 (whole characters removed from the end: 100 CJK characters are 300 bytes,
and a file name is at most 255 bytes on APFS and ext4) and **then** stripped of leading and
trailing dots and spaces (so a cut never leaves a trailing space); an empty result (a title such
as `...`) is `untitled`. The **file name** of a record is chosen by one walk: the records are
ordered **heads first** (a superseded record after every head), then by `id` ascending, and each
takes the first **free** name of the sequence `<stem>`, `<stem> (<8>)`, `<stem> (<full>)`,
`<stem> (<full>) (2)`, `<stem> (<full>) (3)`, …, where `<8>` is the first 8 characters of the id
after its prefix and `<full>` the whole id after the prefix (`self` for the hub, either way); a
name is free when no earlier record of the walk took it, names being compared
**case-insensitively** (Unicode case folding), because the file systems the folder lands on are;
and the bare `<stem>` is never free when it is a well-formed record id (`self`, `mem_` + 32 hex,
`agent_` + 16 hex, §2.1), because an import reads a well-formed id as a link by id (M-59). So the
bare stem names the current record of a title, never an obsolete one (a link typed by title in an
editor reaches it); a note titled `self` is `self (<8 hex>).md`, never `self.md`, and a link to it
can never point at the hub; a record whose suffixed name is another record's title (`Trip`, `Trip`
and `Trip (bbbbbbbb)`) takes its full id, and a title crafted to equal that takes the counter, so
no two files share a name; and every name fits a file name with `.md` (200 + 38 bytes + a counter
< 255). Type folders use the type id verbatim (`:` in a custom id becomes
`-`). Only `<root>/index.md` is the index: a record titled "index" lives in its type folder and is a
record. The same memory exports to the same bytes (M-9), so an export is comparable. The Python
reference's memory directory is this folder plus its key file `memory.key` (M-63), which no export
writes and every import ignores.

M-56. **Sealed values are omitted by default.** Every sealed field that holds a value is written as
the string `"sealed:omitted"` (the **placeholder**) and the `sealed` list stays, so the file says what
is missing; an absent optional sealed field stays absent. The placeholder is not a value: a reader
removes it before validating the fields against the type schema (it matches no e-mail or token
pattern), and an import treats the field as *missing* (M-59). "Include sealed values" is offered only
in an unlocked store, after a confirmation that names the count of sealed values and their types, and
the export then holds them in clear: the person owns the file. There is no encrypted export format
(Q5): an encrypted folder is not readable by an editor, which is the point of the format; disk
encryption and the person's care are the controls, and the threat model says so.

### 8.2 The file

M-57. A record file is the canonical document (M-9) with these differences for an editor's sake:
- `links` is replaced by **one list property per relation**, in the vocabulary order of §5.1
  (`about`, `prefers`, `pays_with`, `belongs_to`, `supersedes`, `derived_from`, `related`), the
  items in the stored (canonical) order, each a whole-value wikilink `"[[<stem of the target>]]"`; a
  dangling target (no record with that id in the export) is written **in id form**, `"[[<id>]]"`, so
  that the edge survives an import (M-27, M-59);
- body wikilinks `[[<id>|<alias>]]` are rewritten to `[[<stem>]]` when the alias equals the alias of
  the target's title (M-3) and `[[<stem>|<alias>]]` otherwise; a body link to a dangling target is
  left unchanged, alias included; every **plain-text or escaped** wikilink (not an edge, M-3) gains
  one backslash in front (`[[Shopping list]]` → `\[[Shopping list]]`, `\[[X]]` → `\\[[X]]`), so
  that the import can never turn text into an edge, even when a stem or a later record matches it;
  an editor shows it as literal text, which is what it is; an agent document's body is written as
  stored (M-3);
- the body ends with a **generated mirror** of the frontmatter edges when the record has any (a
  dangling target appears there in id form too): the marker line `<!-- memory.v0 links -->`, the
  heading `## Links` and one line `- <rel>: [[<target>]]` per edge in canonical order, appended
  after one empty line (or as the whole body when the body is empty); the mirror is generated on
  export and stripped on import as the **block** that starts at the file's last marker line
  (M-59), never read; a stored body never holds the marker line (M-3), so that line is the
  export's or an editor's, and text an editor types after the block is body text:

```
<!-- memory.v0 links -->
## Links
- about: [[Me]]
- prefers: [[Aisle seat]]
```

The mirror exists because Obsidian's help says text and list properties may hold `[[links]]`, while
user reports say only a link that fills the whole property value is indexed (read 2026-10-14); the
whole-value properties cover Obsidian's graph and backlinks, and the mirror covers every other
Markdown tool and the case where properties are not indexed. The user verifies both in Obsidian
(T19 User runs); if property links do not show, the mirror alone carries the graph, and nothing in
this format changes.

The stored example of §2.1, exported, after the person linked the accepted seat preference of §7.2 from it (`[[Dario]]` is the hub's title, §11.2):

```md memory.export
---
id: "mem_7c1f0a4e9b2d4c5e8f6a1b2c3d4e5f60"
type: "travel.profile"
title: "Home travel profile"
scope: "user"
created: "2026-10-14T09:12:00Z"
updated: "2026-10-14T09:12:00Z"
tags:
  - "home"
home_airport: "BOS"
preferred_cabin: "economy"
prefer_nonstop: true
preferred_currency: "USD"
about:
  - "[[Dario]]"
prefers:
  - "[[Aisle seat]]"
source:
  kind: "migration"
  from_type: "personal.travel_profile"
  migrated: "2026-10-14T09:12:00Z"
---

Used for most trips. Business only when someone else pays.

<!-- memory.v0 links -->
## Links
- about: [[Dario]]
- prefers: [[Aisle seat]]
```
M-58. **`index.md`** lists every exported record by type, agent documents included when exported: a
heading per type (`## <display name> (<type id>)`) and a table `| Title | Id | Updated | Tags |` with
the title as a wikilink to the file, ordered by title then id; the first line after the heading
names the exporting runtime by its **memory implementation's version** (`agentpkg <version>` for the
Python reference, `chrome-agent-browser core <CORE_VERSION>` for the extension, whose own version
D-197 keeps apart), the export time and the record count; a last section `## Missing` lists dangling
link targets (the id, and the last known title when a body alias caches one). The index is for
people and for import; it is not authoritative over the files.

### 8.3 Import

M-59. An import reads a folder or zip of `.md` files (other files ignored, `memory-usage.json` read
when present) and produces a **report** before writing anything, which the person confirms:
- a file whose frontmatter fails M-7 is listed as refused with its line; nothing of it is imported;
- a file with no frontmatter, or none of `id`/`type`, becomes a `document.note` with the stem as its
  title and the whole file as its body;
- an unknown `type` becomes `document.note` with the original type id added as the tag
  `type/<original id>`; the fields stay as fields only if the note schema allows them (it does not:
  they are rendered into the body as a `## Fields` table, so nothing is lost);
- an `id` is kept when well-formed and either absent from the store or of the same type; otherwise a
  fresh id is assigned and the report says so;
- the mirror (M-57) is stripped unread as a **block**: from the body's last marker line
  `<!-- memory.v0 links -->`, the heading `## Links` when it directly follows, and then every
  directly following line `- <rel>: [[…]]`; the text before and after the block stays as body
  text, joined by one empty line (empty lines next to the join dropped), so that a paragraph typed
  after the mirror in an editor (the most common edit) is imported, and a mirror reduced to its
  heading or to the marker alone is removed as well; the per-relation properties are the edges, so
  a mirror an editor left stale (a property changed, the list not) is dropped and nothing in it is
  read; a second marker line is body text, and the record then fails M-24 (`body_reserved_marker`),
  is listed as refused and is never cut;
- a per-relation property item or body wikilink whose target is a **well-formed record id** is kept
  as that id, alias included; when no record of the import or the store has the id, it is a dangling
  edge of that relation (M-27), kept and reported;
- a body wikilink preceded by a backslash is text: one backslash is removed and nothing is resolved
  (M-57's mark reversed; a link the person escaped in an editor arrives as plain text, which is
  what an escape means);
- any other per-relation property item or body wikilink is resolved by stem to the imported set
  first, then by title to the store as it will be after the import (the store and the imported
  set; M-3's rule: exactly one record); a resolved body wikilink `[[<stem>]]` is rewritten to
  `[[<id>|<alias of the target's title>]]` and `[[<stem>|<alias>]]` to `[[<id>|<alias>]]` (the
  write-time form of M-3, so that a round trip is exact even when the stem differs from the
  title); the import applies no other resolution (M-3's write-time rule does not run again over an
  imported body); an agent document's body is imported as written; a body wikilink that resolves
  to nothing, or to more than one record,
  stays as written and is not an edge; a property item that resolves to nothing cannot be an edge
  and is appended to the body as a plain `[[<text>]]` on its own line, so the text is kept and shown
  as dangling text; the report counts the links that resolved, the dangling edges and the links kept
  as text;
- a sealed field holding the placeholder `"sealed:omitted"` (M-56) is **removed before the fields
  are validated** and then: when a record with the same id exists in the store, the store's value at
  that pointer is restored, so the imported record is complete and its digest input is the stored
  one when nothing else changed; when none exists and the type requires the field, the record is
  **incomplete**: listed for completion and not written until the person types the value; when none
  exists and the field is optional, it is imported without it;
- the hub is **merged, never duplicated**: an imported file with `id: self` replaces the store's
  hub's title, fields, body, `tags`, `demo`, `valid_until` and `updated` (each as the file has it,
  absent included), unites its links with the store's (when the union adds a
  link the file did not carry, `updated` becomes the import instant), takes the **earlier** of the
  two `created` values (compared as instants), keeps `source {kind: "person"}` (the hub's only provenance, M-22), and is
  never superseded or re-identified (the report says "your *Me* record will be updated from the
  import"); after "Forget everything" the fresh hub is therefore replaced byte for byte by the
  imported one (M-60); an export without a hub leaves the store's as it is; a file of type
  `person.self` under any other id is refused by the record schema and listed;
- any other imported record equal to a stored one (same id, same digest input) is a no-op; one that
  differs is written as the **newer** by `updated`, and the older copy is kept under a fresh id with
  the newer linking `supersedes` to it (M-44's rule for identity matches applies to new ids too);
- `source` is kept when present and well-formed, else `{kind: "import", from, imported}`;
- caps and M-24 apply to each record; a record that fails is listed, not written.

M-60. **Round trip.** On the same host, export with sealed values included → clear the memory →
import reproduces every record byte for byte, the hub included (M-59), every link (dangling ones
included, M-27) and every digest (the key did not change); with sealed
values omitted, an import **into the same store** restores every sealed value by id (M-59) and
reproduces every digest, while an import into an **empty** store imports every unsealed record as it
was and every record with a required sealed field as incomplete, completed by the person. The WebAir
example ships both forms of the same memory (§12) and the check script imports the omitted one
against the other; its `round_trip` check exports and imports a note that holds every link form
(canonical order, an alias equal to the title, another alias, no alias, a target whose stem differs
from its title, a dangling target in the frontmatter and in the body, plain text, a title two records
carry, a stem typed as text, a record created after the body was written, an escaped link, a title
holding `[`, `]` and `|`, a title that is `self`, a title that is another record's id, a title
empty once cleaned, a title cut at a space, names that collide only after suffixing, a title of
100 CJK characters; a stale mirror, a typed marker, text typed after the mirror, a mirror reduced
to its heading or to its marker, an empty body with links) and merges the hub after "Forget
everything". A record edited in Obsidian round-trips as its edit when the edit stays
in the subset (M-7); properties Obsidian adds (`aliases`, `cssclasses`) are reserved and dropped with a note.
T19 tests the first and the conformance suite compares the export bytes of both runtimes.

## 9. Audit

M-61. Both runtimes record these actions in the run's hash-chained audit (`audit-event.schema.json`
needs no change: the action pattern admits them); each carries identifiers, counts and hashes, never
a value, title or body:

| Action | When | Fields beside the common ones |
|---|---|---|
| `memory.read` | a `memory.read` or alias tool answered | `permission_id`, `resource_type`, `record_id`, `record_digest`, `bytes` (of the view) |
| `memory.proposed` | after the export checks of M-40, before `workflow.completed` | `count`, `types` (sorted, unique), `proposals_sha256` (of the canonical document), `offered` (count the person will review), `reason` when `offered` < `count` (`permission_denied`, `policy`, `memory_full`) |
| `memory.agent.read` | the read tool answered | `package_id`, `bytes`, `body_sha256`, `present` (boolean) |
| `memory.agent.write` | the write tool staged a body | `package_id`, `bytes`, `body_sha256` |
| `memory.agent.committed` | after the terminal `workflow.completed`, before `memory.cleared` | `package_id`, `bytes`, `body_sha256` |
| `memory.agent.discarded` | after any terminal workflow event when a body was staged and not committed | `package_id`, `reason` (`run_failed`, `cancelled`, `preset`, `policy`, `store_failed`) |

The refusals of §7 are the existing `permission.checked` (decision `deny` with the reason code),
`node.failed` and `tool.failed` events with their codes. The conformance backbone (D-091) gains
`memory.proposed`, `memory.agent.committed` and `memory.agent.discarded`. Acceptance after the run is
not in the run's audit (the run is over); it is in the usage log and the Run Record's
`memory.proposals` outcome.

## 10. Fixture mode and conformance

M-62. In fixture mode (D-063) a memory read, an agent read and an agent write are **tools like any
other**: the package's fixture document holds their answers for the exact input (the empty object,
or the written body), the runtime replays them, no store is touched, and the egress scans of M-36 and
M-37 still run. **The scan set in fixture mode** is the store's when the runtime has one (the Chrome
host, or the Python CLI given `--memory-dir`), and otherwise the values at the `sealed` pointers of
every replayed memory-read answer (the view carries them, M-15) and at the legacy type's sealed
pointers of every replayed host-resource answer, so that N11 is testable with no store at all. The
proposals export is produced from the fixture result and checked exactly as live (M-40), so a fixture
run writes `proposals.json`; nothing is reviewed or written to a store. Both CLIs therefore produce the same `proposals.json` for the same package and
input, and the conformance suite compares it as an export.

M-63. The Python reference's CLI takes its memory from an **export folder** (§8) given as
`--memory-dir`, with the sealed values in clear in that folder (the operator's choice) and the key
file **`memory.key` inside it** (M-11): a JSON object `{"schema": "memory.v0 key", "key": "<base64url
of 32 random bytes>"}`, mode 0600, generated when absent, ignored by an import (not a `.md` file) and
never written by an export; `--memory-grant <permission id>=<record id>` selects a record exactly as a
`--resource-grant` does; `proposals.json` is written into `--out`; an agent write commits into the
folder's `agent.memory/` on completion. The format is the one format: a Chrome export is a valid
`--memory-dir`.

M-64. **Negative cases both runtimes must refuse identically** (T20 ships them; the enforcement
catalog v2's memory family starts here):

| Case | Expected in both |
|---|---|
| N1 a proposal of a type outside `memory.write`'s resources | run fails `permission_denied` (`memory_proposal_type_undeclared`) |
| N2 a proposal carrying a sealed field | run fails `schema_validation` (`memory_proposal_sealed_field`) |
| N3 a `memory.read` tool called under a denied permission | `permission_denied` at the mediator, before the tool |
| N4 an agent write over 32,768 characters | the tool call fails `schema_validation` (input schema) |
| N5 a package with `runtime.minimum_version` 0.4.0 on a 0.3.x runtime | refused by version before anything runs |
| N6 a `memory.read` tool whose output schema is not the type's view | not bound (`binding_schema_mismatch`); the plan is not ready |
| N7 two agent writes in one run | the second is `budget_exhausted` (`max_calls_per_tool` 1) |
| N8 an `update` whose target the run was not granted | run fails `permission_denied` (`memory_proposal_target_not_granted`) |
| N9 a proposal link `#9` with two proposals | run fails `schema_validation` |
| N10 `memory.scope: "publisher-scoped"` | refused before the run (PolicyError), as today |
| N11 a graph that routes a sealed field into a model step | the model call is refused `permission_denied` (`sealed_value_in_model_request`) and the node fails |
| N12 `memory.write` declared without the `proposals.json` export | refused at validation (`memory_proposal_undeclared`) |
| N13 a proposal whose unsealed field, body or title holds a sealed value of a record the run holds (the granted identity's e-mail as a `travel.preference` value) | run fails `permission_denied` (`sealed_value_in_proposal`); no `proposals.json` is written |
| N14 a proposal link to a record id the run was not granted, in `links` or as an id wikilink in the body | run fails `permission_denied` (`memory_proposal_link_not_granted`) |
| N15 a proposal link with `rel: "supersedes"` | run fails `schema_validation` (M-40 step 1) |
| N16 a custom type with a property named `email` (or any sealed starter field name) | refused at validation (`custom_type_shadows_sealed_type`) |
| N17 a custom type whose local id is a well-known id (`contact`) | refused at validation (`custom_type_reserved`) |
| N18 an edit, acceptance or import while the store is locked | refused `store_locked`; nothing changes (Chrome only: the Python directory is never locked) |
| N19 two refusable proposals: index 0 links to a record id the run was not granted, index 1 is of an undeclared type | run fails `permission_denied` (`memory_proposal_link_not_granted`): M-40 runs steps 2 to 6 proposal by proposal, so index 0's step 6 is reported, not index 1's step 2 |
| N20 an agent write whose body holds `[[<title of a record>]]` and `[[<id of a record>]]` | committed byte for byte; the next agent read returns exactly what was written (no id, no title resolved, M-3, M-49) |
| N21 a custom type whose schema is not closed (an open nested object, `anyOf`, `patternProperties`, an untyped property, an array without `items`, a `const` or `enum` holding an object) | refused at validation (`custom_type_schema_open`) |
| N22 a proposal whose body holds the mirror marker `<!-- memory.v0 links -->` as a whole line | run fails `schema_validation` (M-40 step 1; the marker line is reserved, M-3; the string inside a longer line is text) |

`check_memory_spec.py` demonstrates N1, N2, N8, N9, N13–N17 and N19–N22 over the worked examples with
the check functions the spec names, so that the two runtimes' tests can cite the same inputs; it
also shows that a view body hides the links the run was not granted and that an `update` echoing it
passes M-40 (M-15, the WebAir example), and, in `view_reversal`, every form of M-15's rendering and
M-42's positional reversal (an exact echo, two hidden links with one text, two bare dangling ids,
plain text beside a hidden link, an id-shaped alias, a dropped link kept as `related`, an
occurrence beyond the view's left as text).

## 11. The starter taxonomy (D-217)

M-65. Every host ships the types of `memory-v0/taxonomy.json` as its well-known types, with the
schemas, sealed fields, identity fields, default links and display rules given there; a host may add
the person's own types (`declared_by: {kind: "person"}`) and packages' custom types (§4.4), never
change a well-known one (a changed well-known type is a new specification version). The fields below
summarize the JSON; the JSON is normative where they differ. Every example record validates against
its type under `check_memory_spec.py`.

### 11.1 Types

| Type | Display name | Fields (required in bold) | Sealed | Identity | Default links |
|---|---|---|---|---|---|
| `person.self` | Me | **display_name** | — | — | — |
| `person.identity` | Identity | **given_name**, **family_name**, **email**, phone, date_of_birth | email, phone, date_of_birth | email | about → self |
| `person.personality` | About me | summary | — | — | about → self |
| `person.preference` | Preference | **domain**, **key**, **value**, strength | — | domain, key | about → self |
| `contact` | Contact | **given_name**, **family_name**, relation, email, phone | email, phone | given_name, family_name | — |
| `payment.card` | Payment card | **payment_method_id**, **display**, network, last4, expires | payment_method_id | payment_method_id | about → self |
| `travel.profile` | Travel profile | **home_airport**, **preferred_cabin**, **prefer_nonstop**, **preferred_currency** | — | — | about → self |
| `travel.preference` | Travel preference | **kind**, **value**, applies_to | — | kind, applies_to | about → self |
| `research.profile` | Research profile | **interests**, affiliations, seed_papers, avoid | — | — | about → self |
| `research.review` | Literature review | **question**, **reviewed_on**, **papers**, claims | — | question | — |
| `document.note` | Note | — (body only) | — | — | — |
| `agent.memory` | Agent notes | **package_id** | — | — | — (reserved, `scope: agent`, §7.4) |

`payment.card` has no field that could hold a card number or a security code: `last4` is four
digits and `payment_method_id` is the opaque token a merchant accepts (D-011). `person.identity`,
`contact` and `payment.card` are the sealed starter types M-19 protects from shadowing.

### 11.2 Example records

```md memory.record
---
id: "self"
type: "person.self"
title: "Dario"
scope: "user"
created: "2026-10-14T09:00:00Z"
updated: "2026-10-14T09:00:00Z"
display_name: "Dario"
source:
  kind: "person"
---
```
```md memory.record
---
id: "mem_0a1b2c3d4e5f60718293a4b5c6d7e8f9"
type: "person.identity"
title: "Alex Traveler"
scope: "user"
created: "2026-10-14T09:12:00Z"
updated: "2026-10-14T09:12:00Z"
demo: true
given_name: "Alex"
family_name: "Traveler"
email: "alex.traveler@example.com"
sealed:
  - "/email"
  - "/phone"
  - "/date_of_birth"
links:
  - to: "self"
    rel: "about"
source:
  kind: "migration"
  from_type: "personal.passenger_identity"
  migrated: "2026-10-14T09:12:00Z"
---

Fictional demo identity.
```
```md memory.record
---
id: "mem_1b2c3d4e5f60718293a4b5c6d7e8f90a"
type: "person.personality"
title: "How I like things done"
scope: "user"
created: "2026-10-14T09:20:00Z"
updated: "2026-10-14T09:20:00Z"
summary: "Direct, short answers; numbers over adjectives."
links:
  - to: "self"
    rel: "about"
source:
  kind: "person"
---

I read quickly and skip preambles. When a choice is close, give the trade-off in one line and
pick one. I prefer local models when the task is not time-critical.
```
```md memory.record
---
id: "mem_2c3d4e5f60718293a4b5c6d7e8f90a1b"
type: "person.preference"
title: "Coffee: no sugar"
scope: "user"
created: "2026-10-14T09:21:00Z"
updated: "2026-10-14T09:21:00Z"
domain: "food"
key: "coffee"
value: "espresso, no sugar"
strength: "strong"
links:
  - to: "self"
    rel: "about"
source:
  kind: "person"
---
```
```md memory.record
---
id: "mem_3d4e5f60718293a4b5c6d7e8f90a1b2c"
type: "contact"
title: "Sam Traveler"
scope: "user"
created: "2026-10-14T09:22:00Z"
updated: "2026-10-14T09:22:00Z"
demo: true
tags:
  - "family"
given_name: "Sam"
family_name: "Traveler"
relation: "travel companion"
email: "sam.traveler@example.com"
sealed:
  - "/email"
  - "/phone"
source:
  kind: "person"
---

Travels with me on the demo bookings.
```
```md memory.record
---
id: "mem_4e5f60718293a4b5c6d7e8f90a1b2c3d"
type: "payment.card"
title: "Demo Visa •••• 4242"
scope: "user"
created: "2026-10-14T09:12:00Z"
updated: "2026-10-14T09:12:00Z"
valid_until: "2028-12-31"
demo: true
payment_method_id: "demo-visa-4242"
display: "Demo Visa •••• 4242"
network: "visa"
last4: "4242"
expires: "2028-12"
sealed:
  - "/payment_method_id"
links:
  - to: "self"
    rel: "about"
source:
  kind: "migration"
  from_type: "wallet.payment_method"
  migrated: "2026-10-14T09:12:00Z"
---
```
```md memory.record
---
id: "mem_5f60718293a4b5c6d7e8f90a1b2c3d4e"
type: "travel.preference"
title: "Aisle seat"
scope: "user"
created: "2026-10-14T11:03:00Z"
updated: "2026-10-14T11:03:00Z"
tags:
  - "seat"
kind: "seat"
value: "aisle"
links:
  - to: "self"
    rel: "about"
source:
  kind: "package"
  package_id: "org.webagents.webair"
  package_version: "0.6.0"
  run_id: "7f9d1c2e-5b4a-4c3d-9e8f-0a1b2c3d4e5f"
  proposal: 0
  accepted: "2026-10-14T11:03:00Z"
---

Chosen on the Boston booking of 14 October.
```
```md memory.record
---
id: "mem_60718293a4b5c6d7e8f90a1b2c3d4e5f"
type: "research.profile"
title: "Research profile"
scope: "user"
created: "2026-10-14T09:30:00Z"
updated: "2026-10-14T09:30:00Z"
interests:
  - "prompt injection defenses"
  - "capability-based security for agents"
affiliations:
  - "USI"
seed_papers:
  - title: "Defending against indirect prompt injection"
    doi: "10.1234/example.2025.1"
avoid:
  - "benchmarks without code"
links:
  - to: "self"
    rel: "about"
source:
  kind: "person"
---

Looking for mechanisms, not surveys. Recent (2024+) first.
```
```md memory.record
---
id: "mem_718293a4b5c6d7e8f90a1b2c3d4e5f60"
type: "research.review"
title: "Prompt-injection defenses, 14 October 2026"
scope: "user"
created: "2026-10-14T12:40:00Z"
updated: "2026-10-14T12:40:00Z"
question: "What defenses have been proposed against prompt injection attacks on LLM-integrated applications?"
reviewed_on: "2026-10-14"
papers:
  - title: "Defending against indirect prompt injection"
    doi: "10.1234/example.2025.1"
    year: 2025
  - title: "Capability confinement for tool-using agents"
    doi: "10.1234/example.2026.7"
    year: 2026
claims: 4
links:
  - to: "mem_60718293a4b5c6d7e8f90a1b2c3d4e5f"
    rel: "derived_from"
source:
  kind: "package"
  package_id: "org.webagents.literature-review"
  package_version: "0.2.8"
  run_id: "9c0b7a6d-3e2f-4a1b-8c9d-0e1f2a3b4c5d"
  proposal: 0
  accepted: "2026-10-14T12:40:00Z"
---

Two families: input filtering (weak against adaptive attacks) and capability confinement
(strong, costs expressiveness). Four grounded claims; see the run's `review.md`.
```
```md memory.record
---
id: "mem_8293a4b5c6d7e8f90a1b2c3d4e5f6071"
type: "document.note"
title: "Why I keep a memory"
scope: "user"
created: "2026-10-14T09:40:00Z"
updated: "2026-10-14T09:40:00Z"
tags:
  - "meta"
source:
  kind: "import"
  from: "Why I keep a memory.md"
  imported: "2026-10-14T09:40:00Z"
---

So that an agent recalls [[self|me]] before asking, and so that I can see what it knows.
```
```md memory.record
---
id: "agent_174749d5c5b954b6"
type: "agent.memory"
title: "Literature Review Agent"
scope: "agent"
created: "2026-10-14T12:39:55Z"
updated: "2026-10-14T12:39:55Z"
package_id: "org.webagents.literature-review"
source:
  kind: "agent"
  package_id: "org.webagents.literature-review"
  package_version: "0.2.8"
  run_id: "9c0b7a6d-3e2f-4a1b-8c9d-0e1f2a3b4c5d"
---

# Notes
- Last question: prompt-injection defenses (14 October 2026); 2 papers kept, 4 claims grounded.
- Crossref answered within the budget; the Citation Resolver was reachable.
- Next time: start from the kept DOIs before searching again.
```
### 11.3 Migration of the vault (`chrome-agent-browser-vault-v0`)

M-66. The first time a host with a vault opens the memory store it migrates every vault record once,
shows a report (counts per type, every record that failed with its reason, the three mappings below)
and keeps the vault document until the person confirms the report (T19's D-221). The mapping:

| Vault type (legacy id) | Memory type | Fields | Also |
|---|---|---|---|
| `personal.travel_profile` | `travel.profile` | identical | title = the vault label |
| `personal.passenger_identity` | `person.identity` | `given_name`, `family_name`, `contact_email` → `email` | `sealed`: the type's three pointers (`/email` holds the value, as before; `/phone` and `/date_of_birth` are listed and empty) |
| `wallet.payment_method` | `payment.card` | `payment_method_id`, `display` | `sealed`: `/payment_method_id`; `network`, `last4`, `expires` left empty |

Every migrated record gets `source {kind: "migration", from_type}`, `demo` as in the vault, the
type's `default_links` (`about → self`), and `created`/`updated` from the vault record. A vault type
outside the table becomes a person-declared custom type with the same schema and sealed fields, and
its records migrate unchanged. The three legacy ids stay answerable through the alias (M-17), so a
package signed before memory.v0 runs on the migrated host with the same grants it had.

## 12. Worked examples

Two example folders under `memory-v0/examples/` show what T20 ships as fixtures and what T19 tests
against until then; `check_memory_spec.py` validates each file:

- **`webair-0.6.0/`**: the policy excerpt (`memory.read` for `travel.profile` with the alias kept
  for `person.identity` and `payment.card` under their legacy ids until 0.7.0 moves them; `memory.write`
  for `travel.preference` and `travel.profile`), the three host tools, the record view schema the
  package ships for `travel.profile`, the graph's `proposals.json` export, fixture answers for the
  three reads, a `proposals.json` as a completed booking emits it, and the memory folder after
  acceptance (`memory/`: `Me`, the demo identity and card with their sealed values in clear, as a
  `--memory-dir` holds them, `Aisle seat`, a `Packing list` note the run was never granted, and the
  `Home travel profile` chain: the accepted update is the head and carries the old record's
  `pays_with` link, which the run never saw; `index.md`; the usage log). The old profile's body
  links to the note (`[[<id>|Packing list]]`); the fixture answer for `travel.profile` is the view,
  whose body renders that link as `[[Packing list]]` without the id (M-15); the `update` proposal
  echoes the view body and passes M-40; the head's body holds the link restored at acceptance
  (M-42), which the check script verifies. **`memory-export-omitted/`** is the same memory exported with sealed values
  omitted (M-56): the check script imports it against `memory/` and shows every digest input restored
  (M-59, M-60). The run's scan set is the two sealed values, so N13 is demonstrated against this
  folder.
- **`literature-review-0.2.8/`**: `memory.read` for `research.profile`, `memory.write` for
  `research.review`, `memory.scope: "agent-scoped"` with the two reserved agent tools and their
  schemas (M-48), the view schema, a profile record, fixture answers for the profile read and the
  agent read, a `proposals.json` with one review whose `papers` are the run's `papers-found.json`
  entries, and the folder after acceptance with the review `derived_from` the profile and the
  package's agent document under `agent.memory/` as the Python CLI commits it (M-63).

Neither example changes a signed package: WebAir 0.6.0 and Literature Review 0.2.8 are T20's.

## 13. Rules of D-184 by number, versions, limits

### 13.1 D-184 → M-n

| D-184 says | Rules |
|---|---|
| `memory.read` by type generalizes `personal.read`, which stays an alias | M-17, M-33 |
| the host recalls candidates, proposes the most recently used, the person confirms or picks (one click; the customize view shows all) | M-32, M-34, M-52 |
| the plan binds the record by opaque id and digest as today | M-11, M-12 |
| the tool returns the record; sealed values never reach a model and never a tool whose permissions do not link the grant | M-15, M-35, M-36, M-37 |
| a package cannot search memory and never sees records the person did not select | M-1, M-30, M-35 |
| `memory.write` yields proposals only; nothing is written until the person accepts, edits or rejects each | M-38 to M-42 |
| every written record carries the proposing package and run as provenance | M-5, M-42 |
| `memory` with scope `agent` is a package-private document, bounded, read at start and written at the end, listed and clearable in Settings | M-48 to M-51 |
| `publisher` and `user_global` scopes stay refused | M-1, M-48 |
| presets: privacy-first asks for every read and proposal and persists no agent memory; balanced proposes the last-used record and asks for proposals; convenience auto-selects the last-used record of an unsealed type and asks for anything sealed and every write | M-52, M-53 |
| recall ranks with the graph: linked to `person.self`, read or proposed by the same package before, linked to a record already selected | M-32 |
| a proposal may carry links (to `self`, to the record it refines, `supersedes` for an update), shown as edges the person accepts with the record | M-39, M-40, M-42 (the `supersedes` edge of an update comes from its `target`, never from a link) |

### 13.2 Versions

M-67. A package that uses anything in this specification beyond the `personal.read` alias declares
`runtime.minimum_version: "0.4.0"` or later; agentpkg 0.4.0 and Chrome core 0.2.0 are the first
runtimes that implement it; a 0.3.x runtime refuses such a package by version before anything runs,
and a 0.4.0 runtime runs every earlier package unchanged (D-188). The schema patches in `memory-v0/`
are applied to `agentpkg/src/agentpkg/schemas/` by T20 and copied to the Chrome core by T19 under
the existing equality test (D-025).

### 13.3 Deliberate limits

No embeddings, no package-initiated search, no cross-package types beyond the well-known ones, no
shared or publisher-scoped memory, no automatic deletion, no sync, no encrypted export, no in-run
acceptance (until `conversation.v0`), no history beyond `supersedes` chains, no per-field provenance.
What a record *means* is the person's: the runtime checks structure, sealing and authority, not truth.

### 13.4 Prior art

Taken from, not copied: one fact per Markdown file with frontmatter and an index (Claude Code's
auto-memory); frontmatter, wikilinks and a graph over files (Obsidian); a small always-present core
and a larger recalled store (Letta/MemGPT, here the hub and recall by type); graph memory with
provenance and time (Mem0, Zep/Graphiti, here typed links, `source` and `valid_until`); control of
where data may flow by its origin (CaMeL, here sealed values and the two egress scans).
