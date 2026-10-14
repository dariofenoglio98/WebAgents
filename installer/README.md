# The macOS installer

One `.pkg` that sets up the optional parts of the WebAgents Agent Browser on a Mac (T17,
D-200…D-204). The Chrome extension works without it: you unlock with your passphrase and configure
Ollama by hand (Settings → Models shows the commands).

| Part | What it does | Choice |
|---|---|---|
| Native helper | Lets the extension unlock your keys and records from the login keychain, and report Ollama's state. Three operations, nothing else ([threat model](../docs/threat-model.md#native-helper-and-macos-installer-t17)). | required |
| Ollama for local models | Uses Ollama if it is already installed (only configures it); otherwise installs it with Homebrew (`brew install --cask ollama-app`, as you), or downloads the pinned release ([`macos/ollama-pin.env`](macos/ollama-pin.env)) and checks its SHA-256 and signing team before moving it into `/Applications`. Then adds the extension's origin to `OLLAMA_ORIGINS`, now and at every login, and starts Ollama (or restarts it if it rejects the extension). | optional, on |

## Build

```sh
installer/macos/build-pkg.sh            # builds native-helper (universal), then dist/WebAgents-<version>.pkg
installer/macos/dry-run.sh              # every path and setting it would touch here; changes nothing
installer/macos/test-installer.sh       # builds, expands and checks the .pkg without installing it
```

Needs the Xcode Command Line Tools (Swift 6, `pkgbuild`, `productbuild`) and Node for the helper's
smoke test. The helper's own tests: `cd native-helper && swift test`.

## Install

Double-click `installer/macos/dist/WebAgents-0.1.0.pkg`. It is **not signed or notarized yet** (U8),
so Gatekeeper refuses the first double-click with a message that Apple could not verify it is free
of malware (the exact words vary by macOS version). Close it, then System Settings → Privacy &
Security → **Open Anyway** next to the message about `WebAgents-0.1.0.pkg`, and confirm. The installer asks
for an administrator password: it writes to `/Library`.

On the **Installation Type** screen, untick *Ollama for local models* to leave Ollama alone. At
the end, a page opens with the next steps: load the extension (until the Web Store listing exists,
**Load unpacked** from `chrome-agent-browser/dist/extension`; its id must read
`kjegegjdnpdcjhgamhjdphgemegefapb`), then Settings → Security → **Unlock with the macOS keychain**
→ **Turn on**.

The log is `/Library/Logs/WebAgents/installer.log` (the Installer's own is `/var/log/install.log`).

## What it writes

| Path | From |
|---|---|
| `/Library/Application Support/WebAgents/` | `webagents-helper`, `extension-ids.json`, `paths.sh`, `uninstall.sh`, `welcome.html`; with the Ollama choice also `ollama-origins.sh`, `ollama-pin.env` |
| `/Library/Google/Chrome/NativeMessagingHosts/org.webagents.helper.json` | Chrome's host manifest: the helper's path and the extension ids it allows |
| `/Library/LaunchAgents/org.webagents.ollama-origins.plist` | Ollama choice: at each login, add the extension's origin to `OLLAMA_ORIGINS` |
| `OLLAMA_ORIGINS` (launchd, your session) | Ollama choice: `chrome-extension://<id>` appended; a wildcard you set is kept |
| `/Applications/Ollama.app` | Ollama choice, only when Ollama was not found and Homebrew is absent |
| login keychain item `org.webagents.helper` / `store-wrapping-key` | created by the helper when you turn keychain unlock on, not by the installer |
| `/Library/Logs/WebAgents/installer.log`, receipts `org.webagents.helper`, `org.webagents.ollama-setup` | the installer |

`installer/macos/dry-run.sh` prints this list for your Mac, with what it would do about Ollama.

## Uninstall

```sh
sudo "/Library/Application Support/WebAgents/uninstall.sh"        # --dry-run to list first
```

Removes everything above except Ollama and your models; the extension's entries are taken out of
`OLLAMA_ORIGINS` and the rest of the variable is kept. The extension and its encrypted store are
untouched: unlock with your passphrase.

## Ids and signing

The helper answers the extension ids in [`macos/extension-ids.json`](macos/extension-ids.json):
today the id every unpacked build has (the manifest's `key`, D-200). When the Web Store listing
exists (U7), its public key replaces the development key in the manifest, and the id stays the
same. Signing the helper and the `.pkg` with a Developer ID and notarizing them is U8.
