# Signed documents v0 (`org.webagents:signed-document-v0`)

Status: experimental. Schema: [`signed-document-v0.schema.json`](signed-document-v0.schema.json).
Used by [agent indexes](agent-index-v0.md) and [policy bundles](policy-bundle-v0.md). First
implemented by the Chrome Agent Browser (T8); the publisher-side tool is
`node chrome-agent-browser/dist/cli.js document sign|verify`.

## 1. Purpose

An agent index and a policy bundle are JSON documents a browser fetches over HTTPS and believes
only because a key the person pinned signed them. Unlike an `agent.pkg`, they are not archives and
carry no executable behaviour; they need one small signed envelope, shared by both, so that the
same verification code and the same refusals apply to both.

**Properties.** This specification implements P-2 and P-18 (a signed document is metadata or delegated trust; it grants nothing by itself) of [the security and privacy model](../../docs/security-and-privacy-model.md#3-properties); a change to one of them is a new version of both documents (D-336).

## 2. Envelope and signature

```json
{
  "format": "org.webagents:signed-document-v0",
  "content_type": "org.webagents:agent-index-v0",
  "content": { "…": "the index or the policy" },
  "signature": {
    "algorithm": "ed25519",
    "key_fingerprint": "sha256:<64 lowercase hex>",
    "value": "<base64 of the 64-byte Ed25519 signature>"
  }
}
```

The signature is Ed25519 over

```text
UTF8("WebAgents signed document v0") || 0x00 || UTF8(content_type) || 0x00 || JCS(content)
```

where JCS is the RFC 8785 canonical JSON serialization (the one `agent.pkg` uses for its integrity
statement). The content type is part of the transcript, so an index signature never verifies as a
policy, and the domain string differs from the package signature's
(`Agent Package v0.1 publisher signature`), so neither can stand for the other.

`key_fingerprint` is `sha256:` plus the lowercase hex SHA-256 of the 32 raw key bytes, the
fingerprint `agent.pkg` uses. **The envelope carries no key.** The verifier holds the key the person
pinned out of band, when they added the index or subscribed to the policy, and uses the fingerprint
only to select it. A document signed by any other key is refused (`document_key_unknown`), however
valid its signature.

## 3. Verification

A verifier reads at most 1 MiB, parses strict JSON (no duplicate keys, no integer beyond 2^53),
validates the envelope against the schema, checks `content_type` against the type it expects,
selects the pinned key by fingerprint, verifies the signature over the transcript, and only then
validates `content` against the content type's schema and its rules. Each failure has a stable code:

| Code | Meaning |
|---|---|
| `document_too_large` | more than 1 MiB |
| `document_invalid` | not strict JSON, or not an envelope |
| `document_type_mismatch` | a document of another content type |
| `document_key_unknown` | signed by a key not pinned for it |
| `document_signature_invalid` | the signature does not verify over this content |
| `document_content_invalid` | signed, but the content breaks its schema or its rules |

What a verified document is identified by: `content_sha256`, the SHA-256 of `JCS(content)` (the
identity a receipt or a cache names), and `document_sha256`, the SHA-256 of the bytes as received
(the transport identity).

## 4. Publishing

```sh
node chrome-agent-browser/dist/cli.js document sign --type agent-index \
  --key ~/.config/agentpkg/keys/webagents-index.private.pem examples/agent-index.content.json \
  --out examples/agent-index.json
node chrome-agent-browser/dist/cli.js document verify --type agent-index \
  --key examples/keys/webagents-index.pub.pem examples/agent-index.json
```

`sign` validates the content against its schema and rules before signing, never overwrites an
existing file, and verifies what it wrote under the key that signed it. Private keys stay outside
the repository. A changed document is a new version (§ "Versions" of each content type).
