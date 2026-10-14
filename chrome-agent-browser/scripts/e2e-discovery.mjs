#!/usr/bin/env node
/**
 * End-to-end discovery check for the Chrome Agent Browser (T1 acceptance, D-037).
 *
 * Launches the installed Google Chrome headless with the DevTools protocol over a pipe and
 * loads the built extension through `Extensions.loadUnpacked` (branded Chrome ≥ 137 ignores
 * `--load-extension`; the pipe command needs `--enable-unsafe-extension-debugging`). A local
 * HTTPS mock of the WebAir origin runs on 127.0.0.1 with a throwaway certificate; the name
 * `webair.example` is mapped to it with `--host-resolver-rules`, so the extension's URL policy
 * sees an ordinary HTTPS origin on port 443 and nothing in the extension is relaxed for the
 * test. Only that certificate's key is trusted (`--ignore-certificate-errors-spki-list`).
 *
 * It then drives, and asserts:
 *   0. the unmodified build (T16, D-196): the manifest holds no host permission beyond the
 *      loopback names and no static content script; opening the WebAir package from the full
 *      page is refused `origin_not_granted` before any byte moves. Headless Chrome cannot
 *      grant an origin, so the walk below runs on a copy of the build whose manifest holds
 *      `https://webair.example/*`, the state a person's Allow leaves the extension in; the
 *      harness then records the site grant with the worker (`permissions.granted`, kind
 *      `site`), which registers the discovery script there, as the website card's button does.
 *   1. the WebAir page: the content script reports, the badge says 1, the service worker holds
 *      the candidate; a navigation to a page without the link clears both;
 *   2. the full page: website discovery → Inspect → the agent page (name, "Signed, publisher
 *      unknown", digest, archive SHA-256, signer) → Trust (two presses) → "Signed by a publisher
 *      you trust" → the Trust page lists the key → Remove → unknown again;
 *   3. the full page: the package URL typed directly opens the same digest; a tampered package,
 *      a redirecting package URL and an http:// URL are refused with their codes;
 *   4. the side panel, when it can be opened headlessly; otherwise the report says it was left
 *      to the manual checklist (the spec allows this);
 *   5. view holders (T3): the worker stores the full page's hold with the document Chrome
 *      reported, `getContexts` finds that document open, and after Chrome stops the worker
 *      another view's release leaves the full page's session open.
 * Prints JSON with "passed". No network beyond 127.0.0.1. Nothing executes a package.
 *
 *   node scripts/e2e-discovery.mjs [--chrome <path>] [--keep] [--out <report.json>]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { grantedBuild } from "./lib/granted-build.mjs";
import { certificate } from "./lib/origin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(here, "..");
const ROOT = resolve(PROJECT, "..");
const EXTENSION = join(PROJECT, "dist", "extension");
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SITE_HOST = "webair.example";
const SITE = `https://${SITE_HOST}`;
const WEBAIR = join(ROOT, "dist", "webair-0.3.0.agent.pkg");
const WEBAIR_KEY = join(ROOT, "examples", "keys", "webair-publisher.pub.pem");
const STEP_TIMEOUT_MS = 20_000;

// -- arguments ----------------------------------------------------------------------------
const args = { chrome: process.env.CHROME_PATH || DEFAULT_CHROME, keep: false, out: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--chrome") args.chrome = process.argv[(index += 1)];
  else if (argument === "--keep") args.keep = true;
  else if (argument === "--out") args.out = process.argv[(index += 1)];
  else {
    console.error(`unknown argument ${argument}`);
    process.exit(2);
  }
}
if (!existsSync(join(EXTENSION, "manifest.json"))) {
  console.error("dist/extension/manifest.json is missing; run `npm run build` first");
  process.exit(2);
}
if (!existsSync(args.chrome)) {
  console.error(`Chrome not found at ${args.chrome}; pass --chrome <path>`);
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// -- the mock WebAir origin ----------------------------------------------------------------
function mockOrigin(tls) {
  const site = JSON.parse(readFileSync(join(ROOT, "examples", "webair-site.json"), "utf8"));
  const webair = readFileSync(WEBAIR);
  const tampered = Buffer.from(webair);
  tampered[Math.floor(tampered.length / 2)] ^= 0xff; // inside a payload member's data
  const pages = new Map(site.pages.map((page) => [page.path.split("?")[0], page]));
  const index = pages.get("/");
  const noAgent = index.html.replace(/<link rel="agent-package"[^>]*>\s*/u, "");
  const hits = [];
  const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    const path = request.url.split("?")[0];
    hits.push(`${request.method} ${path}`);
    const html = (body) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(body);
    };
    if (pages.has(path)) return html(pages.get(path).html);
    if (path === "/no-agent") return html(noAgent);
    if (path === "/static/webair.css") {
      response.writeHead(200, { "content-type": "text/css" });
      return response.end("");
    }
    const pkg = (bytes) => {
      response.writeHead(200, {
        "content-type": "application/vnd.webagents.agent-package",
        "content-length": String(bytes.length),
        "content-disposition": 'attachment; filename="webair.agent.pkg"',
        "cache-control": "no-cache",
        etag: `"sha256:${sha256(bytes)}"`,
        "x-agent-package-sha256": sha256(bytes),
      });
      response.end(bytes);
    };
    if (path === "/agent.pkg") return pkg(webair);
    if (path === "/tampered.pkg") return pkg(tampered);
    if (path === "/moved.pkg") {
      response.writeHead(302, { location: `${SITE}/agent.pkg` });
      return response.end();
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer({ server, port: server.address().port, hits, archiveSha256: sha256(webair) }));
  });
}

// -- the DevTools protocol over the pipe --------------------------------------------------
class Cdp {
  constructor(child) {
    this.out = child.stdio[3];
    this.in = child.stdio[4];
    this.next = 0;
    this.pending = new Map();
    this.listeners = [];
    let buffer = "";
    this.in.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
          else resolve(message.result);
        } else if (message.method) {
          for (const listener of this.listeners) listener(message);
        }
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = (this.next += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression, options = {}) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: options.userGesture ?? false }, sessionId);
    if (result.exceptionDetails) throw new Error(`page error: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
    return result.result?.value;
  }

  /** Poll an expression until it yields a truthy value. */
  async waitFor(sessionId, expression, label, timeoutMs = STEP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(sessionId, expression);
        if (last) return last;
      } catch (error) {
        last = error;
      }
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
  }

  async targets() {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  async waitForTarget(predicate, label, timeoutMs = STEP_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = (await this.targets()).find(predicate);
      if (found) return found;
      await sleep(150);
    }
    throw new Error(`timed out waiting for target ${label}`);
  }
}

/** Page-side helpers for the extension's own pages: operate controls by their labels. */
const HELPERS = String.raw`
window.__ab = {
  click(label, scope) {
    const button = [...(scope || document).querySelectorAll("button")].find((b) => b.textContent.trim() === label && !b.disabled);
    if (!button) return false;
    button.click();
    return true;
  },
  setInput(selector, value) {
    const node = document.querySelector(selector);
    if (!node) return false;
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  },
  text(selector, scope) { const node = (scope || document).querySelector(selector); return node ? node.textContent.trim() : null; },
  agent() {
    const article = document.querySelector("article.ab-agent");
    if (!article) return null;
    const technical = [...article.querySelectorAll("details.ab-details")].find((d) => d.querySelector("summary")?.textContent === "Technical details");
    return {
      session: article.dataset.session,
      trust: article.dataset.trust,
      name: article.querySelector("h2")?.textContent ?? null,
      publisher: article.querySelector(".ab-agent-publisher")?.textContent ?? null,
      headline: article.querySelector(".ab-trust-head .ab-chip")?.textContent ?? null,
      pinOffered: Boolean(article.querySelector(".ab-pin")),
      source: article.querySelector(".ab-source")?.textContent ?? null,
      technical: technical ? technical.textContent : null,
      kinds: [...article.querySelectorAll(".ab-access-group")].map((g) => g.dataset.kind),
      cardTitles: [...article.querySelectorAll(".ab-card-title")].map((n) => n.textContent),
    };
  },
  error() { const box = document.querySelector(".ab-error"); return box ? { code: box.querySelector("strong")?.textContent ?? null, text: box.textContent } : null; },
};
true;
`;

// -- the walk ----------------------------------------------------------------------------
async function main() {
  const startedAt = new Date();
  const run = join(PROJECT, ".e2e", `run-${startedAt.toISOString().replace(/[:.]/gu, "-")}`);
  mkdirSync(run, { recursive: true });
  const profile = join(run, "profile");
  mkdirSync(profile);
  const report = {
    profile: "chrome-agent-browser-e2e-discovery-v0",
    recordedAt: startedAt.toISOString(),
    extension: EXTENSION,
    package: { path: WEBAIR, archive_sha256: null },
    chrome: null,
    steps: {},
    failures: [],
    passed: false,
  };
  const check = (step, name, condition, detail) => {
    report.steps[step] ??= {};
    report.steps[step][name] = condition ? "ok" : { failed: detail ?? null };
    if (!condition) report.failures.push(`${step}: ${name}${detail === undefined ? "" : ` (${JSON.stringify(detail)})`}`);
  };

  const tls = certificate(run, SITE_HOST);
  const origin = await mockOrigin(tls);
  report.package.archive_sha256 = origin.archiveSha256;
  const expectedFingerprint = `sha256:${createHash("sha256")
    .update(Buffer.from(readFileSync(WEBAIR_KEY, "utf8").replace(/-----[A-Z ]+-----/gu, "").replace(/\s+/gu, ""), "base64").subarray(-32))
    .digest("hex")}`;

  const chrome = spawn(
    args.chrome,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1:${origin.port}`,
      `--ignore-certificate-errors-spki-list=${tls.spkiHash}`,
      "--window-size=1280,1800",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const cdp = new Cdp(chrome);
  try {
    report.chrome = (await cdp.send("Browser.getVersion")).product;

    // 0. the unmodified build: least privilege, and the refusal by name (T16)
    {
      const { id: bareId } = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION });
      const bareBase = `chrome-extension://${bareId}`;
      await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${bareBase}/service-worker.js`, "the bare service worker");
      const manifest = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8"));
      report.steps.least_privilege = { host_permissions: manifest.host_permissions, optional_host_permissions: manifest.optional_host_permissions, content_scripts: manifest.content_scripts ?? null, permissions: manifest.permissions };
      check("least_privilege", "the manifest holds the loopback names only", JSON.stringify([...manifest.host_permissions].sort()) === JSON.stringify(["http://127.0.0.1/*", "http://localhost/*"]), manifest.host_permissions);
      check("least_privilege", "every HTTPS origin is optional", JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(["https://*/*"]), manifest.optional_host_permissions);
      check("least_privilege", "no static content script", manifest.content_scripts === undefined);
      check("least_privilege", "neither tabs nor declarativeContent is requested", !manifest.permissions.includes("tabs") && !manifest.permissions.includes("declarativeContent"), manifest.permissions);
      const { targetId: bareTargetId } = await cdp.send("Target.createTarget", { url: `${bareBase}/browser.html` });
      const barePage = await cdp.attach(bareTargetId);
      await cdp.waitFor(barePage, `typeof chrome !== "undefined" && !!chrome.runtime`, "the bare full page");
      const granted = await cdp.evaluate(barePage, `chrome.permissions.getAll().then((all) => all.origins)`);
      const refusal = await cdp.evaluate(barePage, `chrome.runtime.sendMessage({ type: "package.open", url: ${JSON.stringify(`${SITE}/agent.pkg`)}, advertisedOn: null }).then((reply) => reply.ok ? { ok: true } : reply.error)`);
      report.steps.least_privilege.granted_origins = granted;
      report.steps.least_privilege.refusal = refusal;
      check("least_privilege", "at install Chrome grants the loopback names and nothing else", JSON.stringify([...(granted ?? [])].sort()) === JSON.stringify(["http://127.0.0.1/*", "http://localhost/*"]), granted);
      check("least_privilege", "opening a package from an ungranted origin is refused origin_not_granted, naming it", refusal?.code === "origin_not_granted" && JSON.stringify(refusal?.details?.origins) === JSON.stringify([SITE]), refusal);
      check("least_privilege", "nothing was fetched from the origin before the refusal", origin.hits.length === 0, origin.hits);
      await cdp.send("Target.closeTarget", { targetId: bareTargetId });
      await cdp.send("Extensions.uninstall", { id: bareId });
    }

    // The walk: a copy of the build with the site granted (D-196), the site recorded as one to detect agents on.
    const granted = grantedBuild(EXTENSION, run, [SITE]);
    report.granted_origins = granted.granted;
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: granted.path });
    report.extensionId = extensionId;
    const base = `chrome-extension://${extensionId}`;
    const workerTarget = await cdp.waitForTarget((target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`, "the service worker");
    const worker = await cdp.attach(workerTarget.targetId);
    {
      const { targetId: setupTargetId } = await cdp.send("Target.createTarget", { url: `${base}/browser.html` });
      const setupPage = await cdp.attach(setupTargetId);
      await cdp.waitFor(setupPage, `typeof chrome !== "undefined" && !!chrome.runtime`, "the setup page");
      const permissions = await cdp.evaluate(setupPage, `chrome.runtime.sendMessage({ type: "permissions.granted", origins: [${JSON.stringify(SITE)}], purpose: { kind: "site", subject: ${JSON.stringify(SITE)} } }).then((reply) => reply.ok ? reply.result : reply.error)`);
      const registered = await cdp.evaluate(worker, `chrome.scripting.getRegisteredContentScripts().then((scripts) => scripts.map((script) => ({ id: script.id, matches: script.matches, js: script.js })))`);
      report.steps.site_grant = { permissions: permissions?.origins ?? permissions, registered };
      check("site_grant", "the worker records the site and registers the discovery script for it alone", registered?.length === 1 && JSON.stringify(registered[0].matches) === JSON.stringify([`${SITE}/*`]) && JSON.stringify(registered[0].js) === JSON.stringify(["content-script.js"]), registered);
      await cdp.send("Target.closeTarget", { targetId: setupTargetId });
    }

    // 1. the WebAir page: content script, badge, candidate state
    const { targetId: siteTargetId } = await cdp.send("Target.createTarget", { url: `${SITE}/` });
    const siteSession = await cdp.attach(siteTargetId);
    await cdp.waitFor(siteSession, `document.readyState === "complete" && document.title`, "the WebAir page");
    const tabId = await cdp.waitFor(worker, `chrome.tabs.query({ url: "${SITE}/*" }).then((tabs) => tabs[0]?.id ?? 0)`, "the WebAir tab id");
    const badge = await cdp.waitFor(worker, `chrome.action.getBadgeText({ tabId: ${tabId} })`, "the badge");
    const stored = await cdp.evaluate(worker, `chrome.storage.session.get("tab:${tabId}").then((items) => items["tab:${tabId}"] ?? null)`);
    report.steps.page = { title: await cdp.evaluate(siteSession, "document.title"), tabId, badge, candidates: stored?.candidates?.map((c) => ({ accepted: c.accepted, resolved_url: c.resolved_url })) ?? null };
    check("page", "badge shows one package", badge === "1", badge);
    check("page", "the worker holds the candidate", stored?.candidates?.[0]?.resolved_url === `${SITE}/agent.pkg` && stored.candidates[0].accepted === true, stored?.candidates);
    check("page", "the candidate state names the page", stored?.pageUrl === `${SITE}/` && stored?.status === "candidate", stored?.pageUrl);

    // 2. the full page: discovery → Inspect → agent page → trust → untrust
    const { targetId: pageTargetId } = await cdp.send("Target.createTarget", { url: `${base}/browser.html` });
    const page = await cdp.attach(pageTargetId);
    await cdp.waitFor(page, `document.querySelector('input[name="package-url"]') !== null`, "the full page");
    await cdp.evaluate(page, HELPERS);
    await cdp.evaluate(page, `__ab.setInput('input[name="package-url"]', ${JSON.stringify(`${SITE}/`)}) && __ab.click("Open", document.querySelector("form.ab-address"))`);
    const candidate = await cdp.waitFor(page, `__ab.text(".ab-candidate code")`, "the website card");
    report.steps.discovery = { candidate, intro: await cdp.evaluate(page, `__ab.text(".ab-card .ab-hint")`) };
    check("discovery", "the website card lists the package as a location", candidate === `${SITE}/agent.pkg`, candidate);
    check("discovery", "the candidate is marked unverified", await cdp.evaluate(page, `document.querySelector(".ab-candidate")?.textContent.includes("Unverified candidate")`));

    await cdp.evaluate(page, `__ab.click("Inspect agent package")`);
    const agent = await cdp.waitFor(page, `__ab.agent()`, "the agent page");
    report.steps.inspect = { ...agent, technical: `${agent.technical?.length ?? 0} characters` };
    check("inspect", "name and publisher", agent.name === "WebAir Travel Agent" && agent.publisher === "by WebAir (fictional demo airline)", [agent.name, agent.publisher]);
    check("inspect", "signed, publisher unknown", agent.trust === "unknown" && agent.headline === "Signed, publisher unknown" && agent.pinOffered === true, [agent.trust, agent.headline]);
    check("inspect", "the person-first cards in order", JSON.stringify(agent.cardTitles) === JSON.stringify(["Publisher", "What it does", "Access", "Origin and cost"]), agent.cardTitles);
    check("inspect", "personal data comes first among the access groups", agent.kinds[0] === "personal.read", agent.kinds);
    check("inspect", "technical details carry the digest", agent.technical?.includes("ffe8f5b344f97c631498bb6da3e17217ae7e5730721935b0e66c5d595b335e94"));
    check("inspect", "technical details carry the archive SHA-256", agent.technical?.includes(origin.archiveSha256));
    check("inspect", "technical details carry the signer fingerprint", agent.technical?.includes(expectedFingerprint), expectedFingerprint);
    check("inspect", "the source names the website", agent.source?.includes(`${SITE}/agent.pkg`) && agent.source?.includes(`Advertised on${SITE}/`), agent.source);
    const sessionId = agent.session;

    await cdp.evaluate(page, `__ab.click("Trust this publisher key", document.querySelector(".ab-pin"))`);
    const armed = await cdp.evaluate(page, `__ab.text(".ab-pin button")`);
    check("trust", "the first press only arms", armed === "Press again to trust this key" && (await cdp.evaluate(page, `__ab.agent().trust`)) === "unknown", armed);
    await cdp.evaluate(page, `__ab.click("Press again to trust this key", document.querySelector(".ab-pin"))`);
    const trusted = await cdp.waitFor(page, `(() => { const a = __ab.agent(); return a && a.trust === "trusted" ? a : null; })()`, "the trusted agent page");
    report.steps.trust = { headline: trusted.headline, pinOffered: trusted.pinOffered };
    check("trust", "signed by a publisher you trust", trusted.headline === "Signed by a publisher you trust" && trusted.pinOffered === false, trusted.headline);
    const storedTrust = await cdp.evaluate(worker, `chrome.storage.local.get("trustStore").then((items) => items.trustStore ?? null)`);
    check("trust", "the trust store lives in storage.local in the agentpkg format", storedTrust?.format === "agentpkg-trust-store-v0" && storedTrust?.publishers?.length === 1, storedTrust?.format);
    check("trust", "the pin is scoped to this package id", storedTrust?.publishers?.[0]?.package_id_prefix === "org.webagents.webair" && storedTrust?.publishers?.[0]?.fingerprint === expectedFingerprint, storedTrust?.publishers?.[0]);

    await cdp.evaluate(page, `location.hash = "trust"; true`);
    const entry = await cdp.waitFor(page, `document.querySelector(".ab-trust-entry")?.dataset.fingerprint ?? null`, "the Trust page entry");
    check("trust", "the Trust page lists the key", entry === expectedFingerprint, entry);
    await cdp.evaluate(page, `__ab.click("Remove", document.querySelector(".ab-trust-entry"))`);
    await cdp.evaluate(page, `__ab.click("Press again to remove", document.querySelector(".ab-trust-entry"))`);
    const empty = await cdp.waitFor(page, `__ab.text(".ab-empty")`, "the empty Trust page");
    check("trust", "removal needs two presses and empties the list", empty?.startsWith("No key is trusted yet"), empty);
    await cdp.evaluate(page, `location.hash = "session=${encodeURIComponent(sessionId)}"; true`);
    const downgraded = await cdp.waitFor(page, `(() => { const a = __ab.agent(); return a && a.session === ${JSON.stringify(sessionId)} && a.trust === "unknown" ? a : null; })()`, "the downgraded agent page");
    check("trust", "the session is unknown again after removal", downgraded.headline === "Signed, publisher unknown", downgraded.headline);

    // 3. the full page: direct package URL; refusals. The Open view keeps showing the open
    // agent under the address bar; a new address replaces it.
    await cdp.evaluate(page, `location.hash = "open"; true`);
    await cdp.waitFor(page, `document.querySelector('input[name="package-url"]') !== null`, "the Open view");
    await cdp.evaluate(page, `__ab.setInput('input[name="package-url"]', ${JSON.stringify(`${SITE}/agent.pkg`)}) && __ab.click("Open", document.querySelector("form.ab-address"))`);
    const direct = await cdp.waitFor(page, `(() => { const a = __ab.agent(); return a && a.session !== ${JSON.stringify(sessionId)} ? a : null; })()`, "the directly opened agent page");
    report.steps.direct = { session: direct.session, source: direct.source };
    check("direct", "the package URL opens the same package", direct.name === "WebAir Travel Agent" && direct.technical?.includes(origin.archiveSha256), direct.name);
    check("direct", "the source is the URL, with no advertising page", direct.source?.includes(`${SITE}/agent.pkg`) && !direct.source?.includes("Advertised on"), direct.source);

    const refusals = {};
    for (const [label, url] of [
      ["tampered", `${SITE}/tampered.pkg`],
      ["redirect", `${SITE}/moved.pkg`],
      ["http", `http://${SITE_HOST}/agent.pkg`],
    ]) {
      // Pressing Open clears any earlier error box synchronously, so the next box is this attempt's.
      await cdp.evaluate(page, `__ab.setInput('input[name="package-url"]', ${JSON.stringify(url)}) && __ab.click("Open", document.querySelector("form.ab-address"))`);
      refusals[label] = await cdp.waitFor(page, `__ab.error()`, `the ${label} refusal`);
      refusals[label].text = refusals[label].text.slice(0, 300);
    }
    report.steps.refusals = refusals;
    check("refusals", "tampered bytes: package_rejected", refusals.tampered?.code === "package_rejected", refusals.tampered?.code);
    check("refusals", "tampered bytes: the layered report is shown", /container|integrity/u.test(refusals.tampered?.text ?? ""), refusals.tampered?.text?.slice(0, 200));
    check("refusals", "a redirect: download_redirect_denied", refusals.redirect?.code === "download_redirect_denied", refusals.redirect?.code);
    check("refusals", "http: url_rejected", refusals.http?.code === "url_rejected", refusals.http?.code);
    const openSessions = await cdp.evaluate(page, `chrome.runtime.sendMessage({ type: "sessions.list" }).then((reply) => reply.ok ? reply.result.sessions.map((s) => s.session_id) : reply)`);
    report.steps.refusals.sessions = openSessions;
    check("refusals", "refused packages created no session", Array.isArray(openSessions) && openSessions.length === 2 && openSessions.includes(sessionId) && openSessions.includes(direct.session), openSessions);

    // 4. the side panel, if it can be opened headlessly
    let panel = { driven: false, reason: null };
    try {
      await cdp.evaluate(worker, `chrome.sidePanel.open({ tabId: ${tabId} })`, { userGesture: true });
      const panelTarget = await cdp.waitForTarget((target) => target.url.startsWith(`${base}/sidepanel.html`), "the side panel", 5_000);
      const panelSession = await cdp.attach(panelTarget.targetId);
      await cdp.evaluate(panelSession, HELPERS);
      const listed = await cdp.waitFor(panelSession, `__ab.text(".ab-candidate code")`, "the panel's candidate", 10_000);
      await cdp.evaluate(panelSession, `__ab.click("Inspect agent package")`);
      const inspected = await cdp.waitFor(panelSession, `__ab.agent()`, "the panel's agent page", 15_000);
      panel = { driven: true, candidate: listed, name: inspected.name, headline: inspected.headline, compact: await cdp.evaluate(panelSession, `document.querySelector("article.ab-agent-compact") !== null`) };
      check("panel", "the panel lists the candidate and inspects it", listed === `${SITE}/agent.pkg` && inspected.name === "WebAir Travel Agent" && panel.compact === true, panel);
    } catch (error) {
      panel = { driven: false, reason: error.message };
      report.steps.panel = { manual: "the side panel could not be driven headlessly; see the manual checklist in the T1 spec", reason: error.message };
    }
    if (panel.driven) report.steps.panel = panel;
    // The panel page itself loads in a tab even when the panel cannot be opened: its bundle
    // runs, it asks the worker about the active tab (its own) and renders the empty state.
    const { targetId: panelPageId } = await cdp.send("Target.createTarget", { url: `${base}/sidepanel.html` });
    const panelPage = await cdp.attach(panelPageId);
    const emptyState = await cdp.waitFor(panelPage, `document.querySelector(".ab-card .ab-card-title")?.textContent ?? null`, "the panel's empty state");
    report.steps.panel.loadsAsPage = emptyState;
    check("panel", "the panel bundle loads and renders its empty state", emptyState === "No agent package on this page", emptyState);

    // 1b. navigation away clears the badge
    await cdp.send("Page.navigate", { url: `${SITE}/no-agent` }, siteSession);
    const cleared = await cdp.waitFor(worker, `chrome.action.getBadgeText({ tabId: ${tabId} }).then((text) => text === "" ? "cleared" : null)`, "the cleared badge");
    check("page", "a page without the link clears the badge", cleared === "cleared");
    report.steps.origin = { requests: origin.hits };
    check("origin", "the package was fetched from the mock origin only", origin.hits.filter((hit) => hit === "GET /agent.pkg").length >= 2 && !origin.hits.some((hit) => hit.includes("railway")), origin.hits);

    // 5. view holders outlive the worker (T3 review 1, finding 5): Chrome names the sending
    // document, getContexts finds it open, and after Chrome stops the worker (as it does after
    // about 30 s idle) another view's release leaves the full page's session open.
    const holdersKey = JSON.stringify(`holders:${direct.session}`);
    const held = await cdp.evaluate(worker, `chrome.storage.session.get(${holdersKey}).then((items) => items[${holdersKey}] ?? null)`);
    const pageDocument = Array.isArray(held) && held.length === 1 ? held[0].document_id : null;
    report.steps.holders = { stored: held };
    check("holders", "the full page's hold is stored with the document Chrome reported", typeof pageDocument === "string" && pageDocument.length > 0, held);
    const contexts = await cdp.evaluate(worker, `chrome.runtime.getContexts({ documentIds: [${JSON.stringify(String(pageDocument))}] }).then((list) => list.map((c) => ({ type: c.contextType, url: c.documentUrl })))`);
    check("holders", "getContexts reports that document as the open full page", contexts?.length === 1 && contexts[0].type === "TAB" && contexts[0].url?.startsWith(`${base}/browser.html`), contexts);
    await cdp.evaluate(worker, "globalThis.__e2eBeforeStop = true");
    await cdp.send("ServiceWorker.enable", {}, page);
    await cdp.send("ServiceWorker.stopAllWorkers", {}, page);
    const isWorker = (target) => target.type === "service_worker" && target.url === `${base}/service-worker.js`;
    const stopDeadline = Date.now() + STEP_TIMEOUT_MS;
    while (Date.now() < stopDeadline && (await cdp.targets()).some(isWorker)) await sleep(150);
    check("holders", "Chrome stopped the service worker", !(await cdp.targets()).some(isWorker));
    const released = await cdp.evaluate(
      panelPage,
      `(async () => {
        const sessionId = ${JSON.stringify(direct.session)};
        const got = await chrome.runtime.sendMessage({ type: "package.get", sessionId, viewId: "e2e-panel" });
        if (!got.ok) return got.error;
        const reply = await chrome.runtime.sendMessage({ type: "package.release", sessionId, viewId: "e2e-panel" });
        return reply.ok ? reply.result : reply.error;
      })()`,
    );
    const restarted = await cdp.attach((await cdp.waitForTarget(isWorker, "the restarted service worker")).targetId);
    check("holders", "a new worker answered", (await cdp.evaluate(restarted, "globalThis.__e2eBeforeStop === undefined")) === true);
    report.steps.holders.release = released;
    check("holders", "another view's release leaves the full page's session open", released?.closed === false && released?.holders === 1, released);
  } catch (error) {
    report.failures.push(`harness: ${error.message}`);
  } finally {
    // Wait for Chrome to exit before removing its profile: it writes there until it is gone
    // (rmSync raced it with ENOTEMPTY; T3 review 1, nit 17).
    const exited = chrome.exitCode !== null || chrome.signalCode !== null ? Promise.resolve() : new Promise((resolveExit) => chrome.once("exit", resolveExit));
    chrome.kill();
    await Promise.race([exited, sleep(10_000)]);
    origin.server.close();
  }
  report.passed = report.failures.length === 0;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, text);
  process.stdout.write(text);
  if (!args.keep) rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
