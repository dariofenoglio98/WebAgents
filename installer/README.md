# The macOS installer

One `.pkg` that sets up the optional native helper of the WebAgents Agent Browser on a Mac (T17,
D-200…D-204; T41, D-446, D-457). The Chrome extension works without it: you unlock with your
passphrase, and the extension runs open-weight models itself, in the browser (Settings → Models →
In this browser), so nothing else needs installing.

| Part | What it does |
|---|---|
| Native helper | Lets the extension unlock your keys and records from the login keychain, and report whether an Ollama you installed is running (a read-only report). Three operations, nothing else ([threat model](../docs/threat-model.md#native-helper-and-macos-installer-t17)). |

Since 0.2.0 (T41) the installer has no Ollama component: it neither installs Ollama nor sets
`OLLAMA_ORIGINS`. Ollama stays a route a person may choose; it runs outside the browser's
protection (D-319), and its one-time setup is in Settings → Models and in
[`docs/getting-started.md`](../docs/getting-started.md) under *Other local routes*.

## Build

```sh
installer/macos/build-pkg.sh            # builds native-helper (universal), then dist/WebAgents-<version>.pkg
installer/macos/dry-run.sh              # every path and setting it would touch here; changes nothing
installer/macos/test-installer.sh       # builds, expands and checks the .pkg without installing it
```

Needs the Xcode Command Line Tools (Swift 6, `pkgbuild`, `productbuild`) and Node for the helper's
smoke test. The helper's own tests: `cd native-helper && swift test`.

## Install

Double-click `installer/macos/dist/WebAgents-0.2.0.pkg`. It is **not signed or notarized yet** (U8),
so Gatekeeper refuses the first double-click with a message that Apple could not verify it is free
of malware (the exact words vary by macOS version). Close it, then System Settings → Privacy &
Security → **Open Anyway** next to the message about `WebAgents-0.2.0.pkg`, and confirm. The installer asks
for an administrator password: it writes to `/Library`.

At the end, a page opens with the next steps: load the extension (until the Web Store listing
exists, **Load unpacked** from `chrome-agent-browser/dist/extension`; its id must read
`kjegegjdnpdcjhgamhjdphgemegefapb`), then Settings → Security → **Unlock with the macOS keychain**
→ **Turn on**, and Settings → Models → **In this browser** to download a model.

The log is `/Library/Logs/WebAgents/installer.log` (the Installer's own is `/var/log/install.log`).

## What it writes

| Path | From |
|---|---|
| `/Library/Application Support/WebAgents/` | `webagents-helper`, `extension-ids.json`, `paths.sh`, `uninstall.sh`, `welcome.html` |
| `/Library/Google/Chrome/NativeMessagingHosts/org.webagents.helper.json` | Chrome's host manifest: the helper's path and the extension ids it allows |
| login keychain item `org.webagents.helper` / `store-wrapping-key` | created by the helper when you turn keychain unlock on, not by the installer |
| `/Library/Logs/WebAgents/installer.log`, receipt `org.webagents.helper` | the installer |

`installer/macos/dry-run.sh` prints this list for your Mac.

## Uninstall

```sh
sudo "/Library/Application Support/WebAgents/uninstall.sh"        # --dry-run to list first
```

Removes everything above. It also removes what an earlier 0.1.0 install's Ollama choice left: its
login item (`/Library/LaunchAgents/org.webagents.ollama-origins.plist`), its receipt
(`org.webagents.ollama-setup`), and the extension's entries in `OLLAMA_ORIGINS` (through that
install's own script; the rest of the variable is kept). Ollama and its models are never removed.
The extension, its encrypted store and its in-browser model cache are untouched: unlock with your
passphrase; uninstalling the extension in Chrome removes the model cache.

## Ids and signing

The helper answers the extension ids in [`macos/extension-ids.json`](macos/extension-ids.json):
today the id every unpacked build has (the manifest's `key`, D-200). When the Web Store listing
exists (U7), its public key replaces the development key in the manifest, and the id stays the
same. Signing the helper and the `.pkg` with a Developer ID and notarizing them is U8.
