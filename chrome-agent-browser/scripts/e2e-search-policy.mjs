#!/usr/bin/env node
/**
 * T8 acceptance in a real Chrome: search over the signed demo index and a policy subscription.
 *
 * The installed Chrome runs headless with the built extension loaded over the DevTools pipe (as
 * `e2e-discovery.mjs` does, D-037). A local HTTPS server answers for the WebAir deployment's
 * hostname (`--host-resolver-rules`, a throwaway certificate whose key alone is trusted) with
 * exactly the files that deployment serves beside the airline (D-105): the signed demo index,
 * the signed research policy, Literature Review 0.2.7 (and 0.2.6 and 0.2.5, which indexes 1.1.0 and
 * 1.0.0 named) and WebAir 0.5.0, all byte for byte from the repository (T15: demo index 1.2.0, D-174). Nothing in the extension is relaxed, and nothing reaches the network.
 *
 * Through the extension's own pages, as a person would:
 *   1. Settings → Search: fill in the demo index, Add and verify → listed as verified, signed by
 *      the development index key;
 *   2. the address bar: "literature review" → one agent card from the demo index → Open and
 *      verify → the agent page with a valid signature, the archive SHA-256 of the shipped
 *      package, and the index's claims shown as matching;
 *   3. Pin to Library → listed on the Library page;
 *   4. Settings → Policies: fill in the research policy, Subscribe → subscribed;
 *   5. WebAir by address → "Signed by a publisher your policy trusts"; "Use this agent" on
 *      "Search flights" → the receipt names the policy and records `policy` for the decisions it
 *      made; Customize → memory once → the receipt records the person for that decision;
 *   6. Unsubscribe → WebAir's publisher is unknown again.
 *   7. the address bar: "flights@webair.example" → WebAir 0.5.0 from the demo index → Open and
 *      verify → every claim matches the bytes (T11).
 * Writes JSON with "passed" (default `examples/verification/chrome-search-policy-e2e-index-120.json`;
 * `chrome-search-policy-e2e.json` is the T8 run over index 1.0.0, kept as recorded).
 *
 *   npm run build && node scripts/e2e-search-policy.mjs [--chrome <path>] [--out <report.json>] [--keep]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Cdp, sleep } from "./lib/cdp.mjs";
import { certificate, serveFiles } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const HOST = "webagents-webair-production.up.railway.app";
const ORIGIN = `https://${HOST}`;
const FILES = {
  "/agent-index.json": { path: join(ROOT, "examples", "agent-index.json"), type: "application/json" },
  "/policies/webagents-research.json": { path: join(ROOT, "examples", "policies", "webagents-research.json"), type: "application/json" },
  "/packages/literature-review-0.2.7.agent.pkg": { path: join(ROOT, "dist", "literature-review-0.2.7.agent.pkg"), type: "application/vnd.webagents.agent-package" },
  "/packages/literature-review-0.2.6.agent.pkg": { path: join(ROOT, "dist", "literature-review-0.2.6.agent.pkg"), type: "application/vnd.webagents.agent-package" },
  "/packages/literature-review-0.2.5.agent.pkg": { path: join(ROOT, "dist", "literature-review-0.2.5.agent.pkg"), type: "application/vnd.webagents.agent-package" },
  "/agent.pkg": { path: join(ROOT, "dist", "webair-0.5.0.agent.pkg"), type: "application/vnd.webagents.agent-package" },
};
const INDEX_FINGERPRINT = "sha256:e0e7022b5836da157d7d55a9d7b00cb58e236d5270ab103162e63706b49f5103";
const POLICY_FINGERPRINT = "sha256:829e28368a71c10bc346a563205ad4b699351d8bed06b21d9671db132c197d7a";

const args = { chrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", out: join(ROOT, "examples", "verification", "chrome-search-policy-e2e-index-120.json"), keep: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--out") args.out = resolve(process.argv[(index += 1)]);
  else if (argument === "--keep") args.keep = true;
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
for (const [path, hint] of [[join(EXTENSION, "manifest.json"), "run `npm run build` first"], [args.chrome, "pass --chrome <path>"]]) {
  if (!existsSync(path)) {
    console.error(`${path} is missing: ${hint}`);
    process.exit(2);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const startedAt = new Date();
const report = {
  profile: "chrome-search-policy-e2e-v0",
  recordedAt: startedAt.toISOString(),
  chrome: null,
  served: Object.fromEntries(Object.entries(FILES).map(([path, file]) => [path, { source: relative(ROOT, file.path), sha256: sha256(readFileSync(file.path)) }])),
  steps: {},
  checks: {},
  failures: [],
  passed: false,
};
const check = (name, condition, detail) => {
  report.checks[name] = condition ? "ok" : { failed: detail ?? null };
  if (!condition) report.failures.push(`${name}${detail === undefined ? "" : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
};

const HELPERS = String.raw`
window.__t8 = {
  click(label, scope) {
    const root = typeof scope === "string" ? document.querySelector(scope) : scope || document;
    const button = root && [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label && !b.disabled);
    if (!button) return false;
    button.click();
    return true;
  },
  type(selector, value) {
    const node = document.querySelector(selector);
    if (!node) return false;
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
  choose(selector, value) {
    const node = document.querySelector(selector);
    if (!node) return false;
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },
  text(selector) { const node = document.querySelector(selector); return node ? node.textContent.trim() : null; },
  has(text) { return document.getElementById("app")?.textContent.includes(text) ?? false; },
  headline() { return document.querySelector("article.ab-agent .ab-trust-head .ab-chip")?.textContent ?? null; },
};
true;
`;

async function main() {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), "chrome-search-policy-"));
  let chrome = null;
  let served = null;
  let snapshot = async () => null;
  try {
    const tls = certificate(scratch, HOST);
    served = await serveFiles(tls, FILES);
    chrome = spawn(args.chrome, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${join(scratch, "profile")}`, "--no-first-run", "--no-default-browser-check", `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${served.port}`, `--ignore-certificate-errors-spki-list=${tls.spkiHash}`, "--window-size=1280,1800", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const cdp = new Cdp(chrome);
    report.chrome = (await cdp.send("Browser.getVersion")).product;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
    const base = `chrome-extension://${extensionId}`;
    await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");
    const { targetId } = await cdp.send("Target.createTarget", { url: `${base}/browser.html#settings?section=search` });
    const page = await cdp.attach(targetId);
    await cdp.waitFor(page, `typeof chrome !== "undefined" && !!chrome.runtime && document.getElementById("app") !== null`, "the full page");
    await cdp.evaluate(page, HELPERS);
    snapshot = () => cdp.evaluate(page, `({ hash: location.hash, error: document.querySelector(".ab-error")?.textContent ?? null, banners: [...document.querySelectorAll(".ab-banner")].map((node) => node.textContent), text: document.getElementById("app")?.textContent.slice(0, 1500) ?? null })`);
    const send = async (request) => {
      const reply = await cdp.evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify(request)})`);
      if (!reply?.ok) throw new Error(`${request.type}: ${reply?.error?.code}: ${reply?.error?.message}`);
      return reply.result;
    };
    const go = async (hash) => {
      await cdp.evaluate(page, `location.hash = ${JSON.stringify(hash)}; true`);
      await sleep(400);
    };
    const sessionId = () => cdp.evaluate(page, `decodeURIComponent((location.hash.match(/^#session=([^?]+)/) || [])[1] || "")`);

    // 1. Settings → Search: the demo index, added with its pinned key.
    await cdp.waitFor(page, `__t8.click("Fill in the WebAgents demo index")`, "the demo index link");
    await cdp.waitFor(page, `__t8.click("Add and verify")`, "Add and verify");
    const indexRow = await cdp.waitFor(page, `(() => { const row = document.querySelector(".ab-index-row"); return row && row.textContent.includes("verified, current") ? row.textContent : null; })()`, "the verified index");
    const indexes = await send({ type: "indexes.list" });
    report.steps.index = { row: indexRow.slice(0, 300), signer: indexes.indexes[0]?.signer_fingerprint, version: indexes.indexes[0]?.index?.version, entries: indexes.indexes[0]?.index?.entries };
    check("the demo index is added and verified under the development key", indexes.indexes.length === 1 && indexes.indexes[0].state === "current" && indexes.indexes[0].signer_fingerprint === INDEX_FINGERPRINT, indexes.indexes[0]);

    // 2. The address bar: a search, a card, open and verify.
    await go("#open");
    await cdp.waitFor(page, `document.querySelector('input[name="package-url"]') !== null`, "the address bar");
    await cdp.evaluate(page, `__t8.type('input[name="package-url"]', "literature review") && __t8.click("Open", "form.ab-address")`);
    const cards = await cdp.waitFor(page, `(() => { const cards = [...document.querySelectorAll(".ab-result")]; return cards.length ? cards.map((card) => ({ id: card.dataset.packageId, url: card.dataset.packageUrl, text: card.textContent })) : null; })()`, "the search results");
    report.steps.search = { results: cards.map((card) => ({ id: card.id, url: card.url })), source: cards[0]?.text.match(/Found in [^·]+/u)?.[0] ?? null };
    check("a search for 'literature review' lists the package from the demo index", cards.length === 1 && cards[0].id === "org.webagents.literature-review" && cards[0].text.includes("Found in WebAgents demo index 1.2.0") && cards[0].url === `${ORIGIN}/packages/literature-review-0.2.7.agent.pkg`, cards);
    await cdp.evaluate(page, `__t8.click("Open and verify", ".ab-result")`);
    await cdp.waitFor(page, `document.querySelector("article.ab-agent") !== null && document.querySelector(".ab-found-via") !== null`, "the agent page");
    const literatureSession = await sessionId();
    const literature = await send({ type: "package.get", sessionId: literatureSession });
    report.steps.open = { headline: await cdp.evaluate(page, `__t8.headline()`), signature: literature.page.trust.signature_status, signer: literature.page.trust.signer_fingerprint, archiveSha256: literature.snapshot.archive_sha256, validation: literature.summary.validation, foundVia: literature.found_via, banner: await cdp.evaluate(page, `document.querySelector(".ab-found-via")?.dataset.claims ?? null`) };
    check("it opens verified: all four layers valid and the signature valid", ["container_status", "integrity_status", "schema_status"].every((layer) => literature.summary.validation?.[layer] === "valid") && literature.page.trust.signature_status === "valid", report.steps.open);
    check("the opened bytes are the shipped Literature Review 0.2.7", literature.snapshot.archive_sha256 === report.served["/packages/literature-review-0.2.7.agent.pkg"].sha256 && literature.page.identity.version === "0.2.7", { archive: literature.snapshot.archive_sha256, version: literature.page.identity.version });
    check("the index's claims match the bytes, and the page says so", literature.found_via && Object.values(literature.found_via.claims).every((claim) => claim === "matches") && report.steps.open.banner === "matches", literature.found_via);

    // 3. The Library.
    await cdp.evaluate(page, `__t8.click("Pin to Library")`);
    await sleep(400);
    await go("#library");
    const pinned = await cdp.waitFor(page, `(() => { const row = document.querySelector(".ab-library-row"); return row ? row.dataset.packageUrl : null; })()`, "the Library");
    report.steps.library = { pinned };
    check("the pinned agent is on the Library page", pinned === `${ORIGIN}/packages/literature-review-0.2.7.agent.pkg`, pinned);

    // 4. Settings → Policies: subscribe to the research policy.
    await go("#settings?section=policies");
    await cdp.waitFor(page, `__t8.click("Fill in the example WebAgents research policy")`, "the demo policy link");
    await cdp.waitFor(page, `__t8.click("Subscribe")`, "Subscribe");
    await cdp.waitFor(page, `__t8.has("org.webagents.research@1.0.0")`, "the subscription");
    const policy = await send({ type: "policy.get" });
    report.steps.policy = { state: policy.state, reference: policy.reference, key: policy.key_fingerprint };
    check("subscribed to the research policy under the development policy key", policy.subscribed && policy.state === "current" && policy.key_fingerprint === POLICY_FINGERPRINT && policy.reference?.policy_id === "org.webagents.research", policy);

    // 5. WebAir: trusted through the policy, "Search flights" pre-decided, one decision overridden.
    await go("#open");
    await cdp.waitFor(page, `document.querySelector('input[name="package-url"]') !== null`, "the address bar");
    await cdp.evaluate(page, `__t8.type('input[name="package-url"]', ${JSON.stringify(`${ORIGIN}/agent.pkg`)}) && __t8.click("Open", "form.ab-address")`);
    // Wait for WebAir's own page and session: the Literature Review page (also trusted through the policy) was showing before.
    await cdp.waitFor(page, `location.hash.startsWith("#session=") && (document.querySelector("article.ab-agent h2")?.textContent ?? "").includes("WebAir") && __t8.has("pre-decided by your policy")`, "WebAir's agent page");
    const headline = await cdp.evaluate(page, `__t8.headline()`);
    const webairSession = await sessionId();
    check("WebAir opened in its own session", webairSession.length > 0 && webairSession !== literatureSession, webairSession);
    check("WebAir's publisher is trusted through the policy, and the page says so", headline === "Signed by a publisher your policy trusts", headline);
    const selected = await cdp.evaluate(page, `document.querySelector(".ab-profile-card[aria-pressed='true']")?.dataset.profile ?? null`);
    await cdp.waitFor(page, `__t8.click("Use this agent")`, "Use this agent");
    const first = await cdp.waitFor(page, `chrome.runtime.sendMessage({ type: "authorization.get", sessionId: ${JSON.stringify(webairSession)} }).then((reply) => reply.ok && reply.result.receipt ? reply.result.receipt : null)`, "the receipt");
    report.steps.useProfile = { profile: selected, receipt: first.receipt_id, provenance: first.provenance, trust_reason: first.publisher.trust_reason, decisions: first.decisions };
    check("'Search flights' is pre-decided by the policy with visible provenance", selected === "search" && first.provenance?.profile_id === "search" && first.provenance?.policy?.policy_id === "org.webagents.research" && first.provenance?.policy?.version === "1.0.0" && ["network.webair", "model.reasoning", "memory.session"].every((id) => first.provenance.decisions[id] === "policy") && first.provenance.decisions["booking.simulate_purchase"] === "profile", first.provenance);
    check("the summary card names the policy", await cdp.evaluate(page, `__t8.has("pre-decided by your policy WebAgents research policy (org.webagents.research@1.0.0)")`));
    await cdp.evaluate(page, `__t8.click("Customize your settings")`);
    await cdp.waitFor(page, `document.querySelector('select[name="decision-memory.session"]') !== null`, "the detailed view");
    const chip = await cdp.evaluate(page, `[...document.querySelectorAll("[data-permission='network.webair'] .ab-chip")].map((node) => node.textContent).find((text) => text.startsWith("decided by")) ?? null`);
    check("the detailed view names the policy on its decisions", chip === "decided by policy org.webagents.research@1.0.0", chip);
    await cdp.evaluate(page, `__t8.choose('select[name="decision-memory.session"]', "once")`);
    await sleep(200);
    await cdp.evaluate(page, `__t8.click("Authorize with these settings")`);
    const second = await cdp.waitFor(page, `chrome.runtime.sendMessage({ type: "authorization.get", sessionId: ${JSON.stringify(webairSession)} }).then((reply) => reply.ok && reply.result.receipt && reply.result.receipt.receipt_id !== ${JSON.stringify(first.receipt_id)} ? reply.result.receipt : null)`, "the new receipt");
    report.steps.override = { receipt: second.receipt_id, memory: second.decisions["memory.session"], provenance: second.provenance?.decisions };
    check("overriding one decision records the person as its decider; the rest stay the policy's", second.decisions["memory.session"] === "once" && second.provenance?.decisions["memory.session"] === "user" && second.provenance?.decisions["network.webair"] === "policy" && second.provenance?.decisions["model.reasoning"] === "policy" && second.provenance?.policy?.policy_id === "org.webagents.research", second.provenance);

    // 6. Revoke.
    await go("#settings?section=policies");
    await cdp.waitFor(page, `__t8.click("Unsubscribe")`, "Unsubscribe");
    await cdp.waitFor(page, `chrome.runtime.sendMessage({ type: "policy.get" }).then((reply) => reply.ok && reply.result.subscribed === false)`, "the unsubscription");
    const after = await send({ type: "package.get", sessionId: webairSession });
    report.steps.revoke = { trust: after.page.trust.trust_status, reason: after.page.trust.trust_reason };
    check("after unsubscribing, WebAir's publisher is unknown again", after.page.trust.trust_status === "unknown", report.steps.revoke);

    // 7. WebAir from the index (T11): the entry names 0.5.0, the bytes the origin serves, so its claims match.
    //    Waits for WebAir's own card, not any card: step 2's results may still be on the page (T12, B-147 nit 8).
    await go("#open");
    await cdp.waitFor(page, `document.querySelector('input[name="package-url"]') !== null`, "the address bar");
    await cdp.evaluate(page, `__t8.type('input[name="package-url"]', "flights@webair.example") && __t8.click("Open", "form.ab-address")`);
    const webairCards = await cdp.waitFor(page, `(() => { const cards = [...document.querySelectorAll(".ab-result")]; return document.querySelector('.ab-result[data-package-id="org.webagents.webair"]') ? cards.map((card) => ({ id: card.dataset.packageId, url: card.dataset.packageUrl, text: card.textContent })) : null; })()`, "the WebAir search result");
    check("a search for WebAir's locator lists WebAir 0.5.0 from the demo index", webairCards.length === 1 && webairCards[0].id === "org.webagents.webair" && webairCards[0].url === `${ORIGIN}/agent.pkg` && webairCards[0].text.includes("0.5.0"), webairCards);
    await cdp.evaluate(page, `__t8.click("Open and verify", '.ab-result[data-package-id="org.webagents.webair"]')`);
    await cdp.waitFor(page, `(document.querySelector("article.ab-agent h2")?.textContent ?? "").includes("WebAir") && document.querySelector(".ab-found-via") !== null`, "WebAir's agent page from the index");
    const fromIndex = await send({ type: "package.get", sessionId: await sessionId() });
    report.steps.webairFromIndex = { results: webairCards.map((card) => ({ id: card.id, url: card.url })), version: fromIndex.page.identity.version, archiveSha256: fromIndex.snapshot.archive_sha256, foundVia: fromIndex.found_via, banner: await cdp.evaluate(page, `document.querySelector(".ab-found-via")?.dataset.claims ?? null`) };
    check("WebAir opened from the index is 0.5.0, the served bytes, and every claim matches", fromIndex.page.identity.version === "0.5.0" && fromIndex.snapshot.archive_sha256 === report.served["/agent.pkg"].sha256 && fromIndex.found_via && Object.values(fromIndex.found_via.claims).every((claim) => claim === "matches") && report.steps.webairFromIndex.banner === "matches", report.steps.webairFromIndex);

    report.steps.origin = { requests: served.hits };
    check("only the served files were requested", served.hits.every((hit) => Object.keys(FILES).some((path) => hit.endsWith(path))), served.hits);
  } catch (error) {
    report.failures.push(`harness: ${error instanceof Error ? error.message : String(error)}`);
    report.steps.lastPage = await snapshot().catch(() => null);
  } finally {
    if (chrome) {
      chrome.kill();
      await new Promise((resolveExit) => (chrome.exitCode !== null ? resolveExit() : chrome.once("exit", resolveExit)));
    }
    served?.server.close();
    if (!args.keep) rmSync(scratch, { recursive: true, force: true });
  }
  report.passed = report.failures.length === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(args.out, text);
  process.stdout.write(text);
  process.exit(report.passed ? 0 : 1);
}

main();
