# WebAgents native helper

The optional macOS helper of the Chrome Agent Browser (T17, D-201, D-204). Chrome starts it
through native messaging for one request and one reply; it does three things only:

| Operation | Request | Reply |
|---|---|---|
| `keychain.wrap` | `{"op", "key"}`: the store's 32-byte master key, base64 | `{"blob"}`: AES-256-GCM under a key-encryption key kept in the login keychain (service `org.webagents.helper`, account `store-wrapping-key`) |
| `keychain.unwrap` | `{"op", "blob"}` | `{"key"}` |
| `ollama.status` | `{"op"}` | `{"ollama": {installed, version, running, server_version, origins, extension_allowed}}`: `origins` is the launchd `OLLAMA_ORIGINS`; `extension_allowed` is what the running server answers to `GET /api/version` with the caller's `Origin` (200 or 403), and the launchd value only when the server is not running |

Every reply carries `ok` and `helper` (the version); a refusal is `{"ok": false, "error": {code,
message}}`. Anything else is refused: another operation (`unknown_operation`), an extra field or
a wrong size (`bad_request`), a message above 16 KiB (`message_too_large`), and every request
whose caller is not an extension id in `extension-ids.json` beside the binary running inside a
Google-signed Chrome (`caller_refused`). Framing: a 4-byte little-endian length, then UTF-8 JSON.

```sh
swift test                         # HelperCore: framing, the closed list, the wrap, the caller check
scripts/build.sh                   # dist/webagents-helper, universal (arm64 + x86_64), ad-hoc signed
node scripts/smoke.mjs dist/webagents-helper
```

`Sources/HelperCore` has no I/O; `Sources/webagents-helper/main.swift` adds the login keychain,
the parent-process check and the Ollama probe. The blob format is pinned by a vector that the
extension's tests check too. Installing it: [`installer/README.md`](../installer/README.md).
