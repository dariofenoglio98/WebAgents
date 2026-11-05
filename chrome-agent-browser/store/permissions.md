# Permission justifications

One line per permission, as the dashboard asks. The manifest is
[`src/extension/manifest.json`](../src/extension/manifest.json); `npm run check-pack` refuses a
zip whose permissions differ from this list.

| Permission | Justification |
|---|---|
| `storage` | Settings, the trust store, the encrypted secret store, run and permission records are kept in `chrome.storage.local`; the unlocked store key lives in `chrome.storage.session` for the browser session only. Nothing is ever written to `storage.sync`. |
| `unlimitedStorage` | Package snapshots, run artifacts, the PDFs a person picks for an agent to read, and the model files a person downloads to run in the browser (gigabytes, kept in the extension's Origin Private File System and listed, with Delete, in Settings → Models) exceed the default quota. |
| `sidePanel` | The side panel is the main surface: the agents a page advertises, the agent page, authorization and the run. |
| `offscreen` | Runs execute in an offscreen document's Worker so that closing the panel or the page does not stop a run (reason `WORKERS`); the same document holds the in-browser model engine's Worker (WebGPU) and a model download, so a loaded model serves the next run and a download continues when the page closes. |
| `activeTab` | When the person clicks the extension's button (or its context-menu item or shortcut) on a page, the extension reads that page's `<link rel="agent-package">` head links, once, and nothing else. This is how agents are found without any host permission. |
| `scripting` | To inject the one discovery script into the clicked tab under `activeTab`, and to register it for the sites the person chose to detect agents on. The script reads the head's agent-package links and reports them; it reads, changes and sends nothing else. |
| `alarms` | One alarm, firing once a minute, wipes the session key once it has been idle longer than the time the person set. |
| `contextMenus` | One page context-menu item, "Look for agents on this page", an alternative to the button click that also grants `activeTab`. |
| Host `http://127.0.0.1/*`, `http://localhost/*` | Ollama on this machine, the local model route; a remote Ollama endpoint is refused by the extension. |
| Optional `nativeMessaging` | Requested only when the person turns on "Unlock with the macOS keychain" in Settings → Security. It lets the extension ask the optional WebAgents helper (installed separately on macOS) to wrap and unwrap the key of the extension's encrypted store with the login keychain, and to report whether Ollama is running. No provider key, record or browsing data is sent to it. |
| Optional host `https://*/*` | Never requested as a whole unless the person turns on "Detect agents on every site". Otherwise single origins are requested, with the person's click as the gesture: the origin of a package they open, the services that package declares and the model provider they chose (listed under the plan's Technical details), a site they chose to detect agents on, a signed index or policy they add, and `https://huggingface.co` when they first download or look up a model to run in the browser. Settings → Permissions lists every grant with its reason and revokes it. |

Not requested: `tabs` (the extension never reads browsing history; a tab's URL is known to it only
through `activeTab` or a granted origin), `declarativeContent` (a head link cannot be matched by it;
recorded in the repository's T16 experiment), `webRequest`, `cookies`, `history`, `bookmarks`.

**Remote code:** none. Every script is in the package; the schema interpreter and the model and tool
adapters are local code. The extension pages' content security policy is
`script-src 'self' 'wasm-unsafe-eval'`: WebAssembly is compiled only from files in the package (a
package's own compute modules, and the in-browser model engine `wllama.wasm`, whose SHA-256 the build
checks). Model weights downloaded from Hugging Face are data: tensors the bundled engine reads,
verified by SHA-256 before they are kept, never executed; a model changes what an agent says, never
what the extension can do.
