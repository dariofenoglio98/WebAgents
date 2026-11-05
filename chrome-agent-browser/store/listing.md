# Store listing

**Name:** WebAgents Agent Browser

**Summary (132 characters at most):**
Discover, verify, authorize and run signed agents that websites publish, with your own models, permissions and data.

**Category:** Productivity (Developer Tools is the alternative; the extension is a research prototype)

**Language:** English

**Description:**

WebAgents is a research prototype of an agent-native web: a website publishes a signed, data-only
agent package (`agent.pkg`), and your browser, not the publisher, runs it with the models,
permissions, records and budgets you choose.

What the extension does:

- **Finds agents** on the sites you ask it to read: click the WebAgents button on a page and it
  reads that page's `<link rel="agent-package">` head links; nothing is read on any other page
  unless you allow a site, or every site, under Settings → Permissions.
- **Verifies** a package layer by layer (container, integrity, schema, runtime, signature) and tells
  you in words who signed it and whether you trust that key. Trusting a key grants nothing.
- **Authorizes in two clicks** through the publisher's profiles, or permission by permission:
  every decision is yours, recorded in a receipt and frozen into a run plan with the model you chose.
- **Runs** the agent in the extension's own background host, with a model the extension runs
  itself, in this browser, on your GPU (an open-weight model you download once from Hugging Face,
  after a card shows its size, licence and digest; it is kept as a cache you can see and delete,
  and nothing leaves the browser when it runs), Chrome's built-in model, Ollama on this machine, or
  your own OpenAI or Anthropic key. Every run keeps a hash-linked audit and its artifacts; a run can
  only reach the origins its plan recorded.
- **Protects your keys and records at rest:** provider keys and your personal records are encrypted
  under a passphrase (scrypt, AES-256-GCM), unlocked for a browser session and locked again after
  an idle time you set.
- **Holds no website access by default.** Chrome grants each origin only when you allow it, for a
  package you use, a site you want agents detected on, or a signed index or policy you add; every
  grant is listed and revocable under Settings → Permissions.

The extension sends nothing anywhere at install or start. Requests leave your browser only to the
origins you allowed: the website that publishes a package, the services that package declares, and
the model provider you chose, and Hugging Face when you download a model. No analytics, no
accounts, no server of ours.

Open source (Apache-2.0): the extension, the specifications and the reference runtime are in the
WebAgents repository; the demo site (a fictional airline, "WebAir") shows the whole path from a
published agent to a run with your own model.
