# WebAir live demo: presentation script

A 3–5 minute live demonstration of one idea, on a real public website and the real Agent
Browser:

```text
                         WebAir origin
                    HTML            agent.pkg
                     |                  |
                   Human         Agent Browser
                                       |
                              verify / trust
                                       |
                                 authorization
                                       |
                   +-------------------+-------------------+
                   |                   |                   |
                Model             Host resources        Tools
                                      |                   |
                                profile/identity     WebAir APIs
                                 demo payment             |
                                      +---------+---------+
                                                |
                                             execute
```

**WebAir publishes behavior. The user's runtime supplies authority.**

WebAir is a fictional airline. Its public demo origin, <https://webagents-webair-production.up.railway.app/>,
serves ordinary HTML pages for people and, from the same origin, a signed agent package
(`org.webagents.webair` 0.4.0). Nothing is ever booked, reserved or charged; every passenger and
card in the demo is fictional. The package declares *what* WebAir can do. The Agent Browser — the
person's own runtime — decides *whether* and *with what*: which publisher to trust, which model to
use, which tool implementation to call, which of the person's resources to share, and for how
long.

| Step | Time | You show |
|---|---|---|
| [D](#d-human-website-30-s) | 0:30 | an ordinary airline website |
| [E](#e-website-discovery-20-s)–[G](#g-trust-15-s) | 0:55 | the same address in the Agent Browser: advertised, verified, untrusted, then trusted |
| [H](#h-search-40-s) | 0:40 | a search filled from the person's travel profile |
| [I](#i-booking-40-s) | 0:40 | a quote for a passenger only the host holds |
| [J](#j-purchase-60-s) | 1:00 | a simulated purchase, `once`; the second try refused; a denied purchase |
| [K](#k-audit-and-result-30-s) | 0:30 | what ran, on what, under which authority |

Run times with the recommended model: search ~35 s, booking ~25 s, purchase ~10 s. Talk over them.

## A. Concept

Say: *"A normal website is built for people. An agent that wants to use it has to scrape pages
and fill forms. WebAir also publishes an agent package: its workflow and its API contracts, signed.
But a package is behavior only. It cannot choose the model, it cannot trust itself, it cannot
reach any server the host did not bind, and it owns none of my data. My runtime owns all of that."*

| WebAir (origin and package) owns | The person's runtime owns |
|---|---|
| the workflow, search semantics, fare rules, the booking protocol, its API contracts | publisher trust, the model, every permission, the travel profile, the passenger identity, the payment method, which tool implementation runs, budgets |

## B. Prerequisites

Before the audience arrives (once per machine; [Reset](#l-reset-the-demo) before each talk):

1. **OpenClaw 2026.9.5** with the Gateway running and **Settings → Labs → Custom plugin UI** on.
2. **A runtime from v0.2.0 or later.** WebAir 0.4.0 declares the `personal.read` permission
   kind, which agentpkg accepts from the v0.2.0 release on: use the repository's editable
   `agentpkg/.venv` (`python3 -m venv agentpkg/.venv && agentpkg/.venv/bin/python -m pip install -e './agentpkg[dev]'`)
   or the `dist/agentpkg-0.2.2-py3-none-any.whl` shipped with v0.2.0. The v0.1.0 release's
   0.2.2 wheel refuses the package.
3. **The Agent Browser plugin from v0.2.0 or later:**

   ```sh
   cd openclaw-agent-browser && npm ci && npm run build && npm run pack
   openclaw plugins install ./agent-browser.tgz --force --accept-capabilities
   ```

4. **The demo host's configuration** (replace `<repo>` with the absolute path of this checkout):

   ```sh
   openclaw config patch --stdin <<'JSON'
   { "plugins": { "entries": { "agent-browser": {
       "llm": { "allowModelOverride": true },
       "config": {
         "agentpkgPath": "<repo>/agentpkg/.venv/bin/agentpkg",
         "sessionTtlSeconds": 7200,
         "hostResources": { "file": "<repo>/demo/webair/host-resources.json" },
         "tools": { "bindingsFile": "<repo>/demo/webair/host-bindings.json" } } } } } }
   JSON
   ```

   `host-resources.json` is what this host holds for the person — two travel profiles, two
   passenger identities, two demo payment methods, all fictional. `host-bindings.json` binds
   WebAir's four tools to the public origin with the Agent Browser's service-neutral JSON adapter.
   Both are host configuration: neither is part of the package or of the public website.
5. **A model.** Recommended: **`openai/gpt-6-astra`** (hosted, through OpenClaw's OpenAI route;
   the live acceptance ran on it). Local alternative: **`ollama/qwen3:30b`** — about 3× slower,
   and in 1 of 4 live booking runs it spent the select step's whole output budget thinking (the
   run fails closed with `model_output_truncated`; run it again). The package names no model.
6. **The origin is up:**

   ```sh
   curl -sS https://webagents-webair-production.up.railway.app/health
   # {"status":"ok","service":"webair-origin","fictional":true,
   #  "agent_package_sha256":"b537cf5cba06bce8137533eb75b491486f57caf3098af30f657343b741492887"}
   ```

## C. Start or restart OpenClaw

```sh
openclaw gateway restart
openclaw gateway call plugins.sessionAction --json \
  --params '{"pluginId":"agent-browser","actionId":"service.status","payload":{}}'   # "state": "running"
openclaw dashboard                                                                   # opens the Control UI
```

Choose **Agent Browser** in the sidebar. The header says *Control plane running*.

## D. Human website (30 s)

In an ordinary browser tab:

1. <https://webagents-webair-production.up.railway.app/> — the search form, Boston → Zurich,
   Fri 9 Oct 2026, already filled in. Press **Search flights**.
2. [Results](https://webagents-webair-production.up.railway.app/results?origin=BOS&destination=ZRH&date=2026-10-09&passengers=1&nonstop_only=on&max_price_usd=900)
   (nonstop, ≤ $900): WA101 and WA105.
3. [WA101 Economy Standard](https://webagents-webair-production.up.railway.app/fare/WA101-20261009-STANDARD):
   $858, one checked bag, change and refund rules.

Say: *"An ordinary airline site: pages and forms, made for people."*

## E. Website discovery (20 s)

In the Agent Browser, type the **same address** — `https://webagents-webair-production.up.railway.app/`
— and press **Open**.

The page shows **Website · Agent package advertised**, with the candidate
`https://webagents-webair-production.up.railway.app/agent.pkg` marked **Unverified candidate**.

Say: *"The page's head says where WebAir's agent package is. That is a location, nothing more:
who published it, whether it is intact, what it may do — all unknown."*

## F. Package inspection (20 s)

Press **Inspect agent package**. The control plane downloads and verifies it:

- Container, Integrity, Schema **Valid**; Runtime **Compatible**;
- Signature **Cryptographically valid**, signer `sha256:2e53acce…a20b`;
- Publisher trust **Unknown publisher**;
- warnings: it requests host-owned personal data (travel profile, passenger identity, payment
  method) and payment authority, and its four remote tools may contact
  `webagents-webair-production.up.railway.app` only.

Optional (10 s): set `network.webair`, `model.reasoning` and `memory.session` to *Allow for
session* and press **Authorize** → **Cannot run with these decisions**, `publisher_not_trusted`.

Say: *"Valid signature, public HTTPS, same origin — and still not trusted. That decision is mine."*

## G. Trust (15 s)

Expand **Review publisher key**, keep **Only org.webagents.webair**, press **Trust this publisher
key**, then **Confirm: pin this key permanently**. The publisher becomes **Trusted by this
OpenClaw host**. (The key's fingerprint is that of
[`examples/keys/webair-publisher.pub.pem`](../examples/keys/webair-publisher.pub.pem).)

## H. Search (40 s)

**Permissions** — every one starts at *Deny*:

| Permission | Decision | Host resource |
|---|---|---|
| `network.webair`, `model.reasoning`, `memory.session` | Allow for session | — |
| `profile.travel` | Allow for session | Travel profile: **Demo Traveler — BOS / Economy / Nonstop** |
| `identity.passenger`, `wallet.payment`, `booking.simulate_purchase` | Deny | — |

Tick all seven **Tool approvals**, press **Authorize** → **✓ Authorized for this session**.
Under **Model**, choose `openai/gpt-6-astra` (*Compatible*), press **Prepare run** → **Ready to run**.

In the Run panel: *"Find me a flight to Zurich on 9 October under $900."*, leave **Booking**
unchecked and the purchase fields empty, press **Run**.

Expected: WA101 Economy Basic **$704**, WA101 Economy Standard **$858**, WA105 Economy Basic **$749**
— WebAir searched BOS → ZRH, nonstop, economy, ≤ $900.

Say: *"I never said Boston, economy or nonstop: my runtime supplied them from the profile I chose.
The model that read my request never saw the profile."*

## I. Booking (40 s)

Change `profile.travel` to *Deny*, `identity.passenger` to *Allow for session* with
**Alex Traveler — a\*\*\*@example.com**. **Authorize** again (a new receipt replaces the old plan),
**Prepare run**, then **New run**:

*"Prepare WA101 Standard for 9 October for me."*, tick **Booking**, **Run**.

Expected: quote **WAQ-C82CB5B08515FAE6**, $858, one passenger. Nothing is reserved.

Say: *"Alex's name and email went to exactly one place, WebAir's quote endpoint. No model saw
them, and the result only says 'one passenger'."*

## J. Purchase (60 s)

A **new authorization**, never the search's: keep Alex, set `wallet.payment` to *Allow for
session* with **Demo Visa •••• 4242**, and `booking.simulate_purchase` to **Allow once**.
**Authorize**, **Prepare run**, **New run**:

- Request: *"Simulate purchase of quote WAQ-C82CB5B08515FAE6."*
- Booking: unchecked · Quote id: `WAQ-C82CB5B08515FAE6` · Fare id: `WA101-20261009-STANDARD`
- **Run**.

Expected: *"Your purchase was simulated. Demo confirmation: **WA-DEMO-TYD4M** … The amount charged
is **$0**. **No real transaction was performed.**"* — and in the result, `real_transaction: false`,
`amount_charged_usd: 0`. The package re-quoted first and bought only that exact quote; WebAir
received the opaque `demo-visa-4242`, never a label or card number.

Press **New run** and try again: **Run** stays disabled — *"This authorization granted something
once, and a run has already used it."*

Denial (optional, 20 s): set `wallet.payment` and `booking.simulate_purchase` to *Deny*,
**Authorize**, **Prepare run**, run the same purchase → **A permission was denied during the
run**, stopped at *Payment method (host)*. Nothing was resolved, nothing was sent to WebAir, no
model was called.

Say: *"Trusted is not authorized. The publisher is trusted; I still decide what it may do, once."*

## K. Audit and result (30 s)

Open **Technical details** in the Run panel: the model the plan bound (and that every call used),
the tool bindings (`demo:webair.*` → `https://webagents-webair-production.up.railway.app`), the
permissions, the host resources by opaque id and digest, the audit chain (**valid**) and every
check re-verified before the run started. **Artifacts** → `answer.md`, `booking.json`, `audit.json`.

The recorded acceptance of this exact sequence — public origin, package bytes, discovery, trust,
the four runs, every model input and WebAir request checked for the host's data — is
[`examples/verification/webair-030-live-demo.json`](../examples/verification/webair-030-live-demo.json).

## L. Reset the demo

Operator commands, not product features:

1. **Publisher trust** (so step F shows *Unknown publisher* again):

   ```sh
   agentpkg/.venv/bin/agentpkg trust remove \
     --trust-store ~/.openclaw/agent-browser/trust.json \
     --fingerprint sha256:2e53accec575b37bf16c189e03cd3a6b2f2cfae2339ff05361bf585dc3d4a20b
   ```

   It removes only WebAir's pin; other publishers' pins stay.
2. **Sessions, authorizations, `once` grants, run plans:** `openclaw gateway restart`. They live in
   the control plane's memory for the package session, so a restart (or closing the package with
   **×**) ends them all; a new session starts with every permission at *Deny*.
3. **Recent runs** (optional, to declutter the list): finished runs stay on disk under
   `~/.openclaw/agent-browser/runs/` and are inspectable evidence. To hide them until the next
   Gateway start:

   ```sh
   openclaw gateway call plugins.sessionAction --json \
     --params '{"pluginId":"agent-browser","actionId":"execution.clear","payload":{}}'
   ```

4. **Host resources:** `demo/webair/host-resources.json` is static; nothing to reset. (Resource
   digests are keyed per Gateway process, so a restart changes them, which is expected.)
5. **The public origin:** stateless and deterministic; nothing to reset.

## Operating the public origin

The origin runs on Railway (service `webagents-webair`) from an allowlisted bundle: the origin's
code, its pinned runtime requirements, the platform configuration and exactly one signed package —
never the demo host's `host-resources.json` or `host-bindings.json`. See
[demo/webair/README.md, Public deployment](../demo/webair/README.md#public-deployment-milestone-5).

```sh
python3 demo/webair/deploy/bundle.py --package dist/webair-0.4.0.agent.pkg \
  --expect-sha256 c12f9db3bd7b3b4b6721c67e1d0b8143ebd94381df0e5e57c196357b7ca77f63 --out /tmp/webair-bundle
railway up /tmp/webair-bundle --path-as-root --service webagents-webair --environment production
curl -sS https://webagents-webair-production.up.railway.app/agent.pkg | shasum -a 256
```

## Re-running the live acceptance

The page walk above, automated against the real Control UI (headless Chrome over CDP, the
operator's own browser binary), then checked:

```sh
node openclaw-agent-browser/scripts/run-webair-live.mjs \
  --site https://webagents-webair-production.up.railway.app/ --model openai/gpt-6-astra --out /private/dir/ui.json
agentpkg/.venv/bin/python scripts/verify_webair_live.py --ui /private/dir/ui.json \
  --observer /private/dir/model-inputs.jsonl --needles /private/dir/needles.json
```

It expects the WebAir key unpinned (step L1) and spends real model tokens (about $0.25 with the
recommended model, as OpenClaw reports it). The model-input evidence comes from
[`model-input-observer.mjs`](../openclaw-agent-browser/scripts/model-input-observer.mjs), preloaded
into the Gateway for the session (`NODE_OPTIONS=--import=…` in the Gateway's environment, with
`AGENT_BROWSER_MODEL_OBSERVER_OUT`, `AGENT_BROWSER_MODEL_OBSERVER_NEEDLES` and
`AGENT_BROWSER_TOOL_OBSERVER_HOSTS=webagents-webair-production.up.railway.app`): it records, per
package model call and per WebAir request, a body digest and how many values of each class of host
data it held — never the text or the values. Remove it from the Gateway's environment afterwards.

The script was written for the recorded 0.3.0 acceptance: it checks that the origin serves
exactly `dist/webair-0.3.0.agent.pkg` and that the source rebuilds to it. Once the origin serves
0.4.0, point it at `dist/webair-0.4.0.agent.pkg` before re-running it.
