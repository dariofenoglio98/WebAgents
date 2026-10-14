# Privacy policy — WebAgents Agent Browser

*Host this text at a public URL (the repository's GitHub Pages or the WebAir origin's `/privacy`)
and paste that URL into the dashboard's "Privacy policy" field. It describes the extension as
shipped in version 0.2.0.*

## What the extension stores, and where

Everything the extension keeps stays in your Chrome profile on your computer. Nothing is written
to Chrome's sync storage, so nothing travels to your Google account.

- **Encrypted at rest, under your passphrase:** the API keys you type for OpenAI or Anthropic,
  and the personal records you create under "Your data" (for example a travel profile or a
  fictional demo passenger). They are encrypted with AES-256-GCM under a key derived from your
  passphrase with scrypt. They are decrypted only in the extension's own memory while you have
  unlocked them for the browser session, and they lock again after the idle time you choose, when
  you press "Lock now", and when the browser closes. The extension cannot recover a forgotten
  passphrase; "Forget everything" deletes the encrypted store.
- **In clear, in the profile:** your settings (models, limits, presets), the publisher keys you
  trust, the signed indexes and policy you added, the agent packages you opened (as downloaded,
  for verification), your runs with their results, audit chains and artifacts, the PDFs you picked
  for an agent to read, and the list of origins you allowed with the reason for each.

## What leaves your computer, and to whom

The extension sends nothing at install, at start, or on its own. Requests leave only when you act,
and only to origins you allowed (the extension checks every request against your grants and a run
against the origins its plan recorded; Chrome holds the grants):

- **The website that publishes an agent:** to download the package you open and, if you allowed
  the site, to read its pages' agent-package links.
- **The services the package declares** (for example the publishing site's own API, or Crossref
  for a literature search): the tool calls a run makes, each with the package's own schema-checked
  arguments, no cookies and no credentials of your browsing. A run can reach only the origins its
  run plan recorded, which are shown before you run.
- **The model provider you chose:** your prompts and the package's instructions, sent to Ollama on
  this machine, to Chrome's built-in model, or directly to OpenAI or Anthropic with your own key.
  The provider's own privacy terms apply to what you send there.
- **A signed index or policy you add:** fetched from the URL you entered.

There is no WebAgents server, no account, no analytics, no crash reporting, no advertising. The
extension's authors receive nothing from it.

## Personal records and sealed values

A record you grant to an agent reaches that agent's run as a value only through the tool that the
package declared for it; fields marked sealed (an e-mail, a payment identifier) are refused in any
tool call whose permissions do not link that grant, and never reach a model. Receipts, plans, run
records and exports refer to records by an opaque id and a keyed digest, never by value.

## Permissions

The extension holds no access to any website until you grant it. Chrome asks you for each origin
when you open a package, use an agent, choose a site to detect agents on, or add a signed
document; Settings → Permissions lists every grant with its reason and lets you revoke it.
"Detect agents on every site" is off unless you turn it on.

On macOS, an optional helper installed separately can unlock your encrypted keys and records from
your login keychain. The extension talks to it only after you turn this on in Settings → Security
(Chrome asks for the permission then); it sends the helper the key that opens your encrypted store
to be wrapped or unwrapped, and asks whether Ollama is running. Nothing else, and nothing that
leaves your computer.

## Changes and contact

This policy describes the extension's behaviour as its source code implements it; the code is
public in the WebAgents repository, and a new version of the extension updates this text with it.
Questions: the repository's issue tracker.

---

## Dashboard answers (Privacy practices tab)

- **Does your extension collect or use personal data?** Yes: authentication information (API keys
  the user types) and personal communications/content the user enters (their own records and the
  text they give an agent). Stored locally, encrypted; sent only to the model provider and the
  services the user approves.
- **Data use certifications:** not sold to third parties; not used for purposes unrelated to the
  single purpose; not used to determine creditworthiness or for lending.
- **Remote code:** no.
