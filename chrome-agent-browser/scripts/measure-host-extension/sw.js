// The service worker of the measurement extension: creates the two host contexts once, then
// ticks itself so the server can see when Chrome stops it. The server URL arrives from the
// harness through chrome.storage.local (`server`).
const started = Date.now();
let ticks = 0;
let lastTick = started;
let maxGapMs = 0;
async function server() {
  const { server } = await chrome.storage.local.get("server");
  return server;
}
async function setUp() {
  const base = await server();
  if (!base) return;
  const { setUpDone } = await chrome.storage.local.get("setUpDone");
  if (setUpDone) return;
  await chrome.storage.local.set({ setUpDone: true });
  const url = (mode) => chrome.runtime.getURL(`host.html?mode=${mode}&server=${encodeURIComponent(base)}`);
  await chrome.offscreen.createDocument({ url: url("offscreen"), reasons: ["WORKERS"], justification: "measure an execution host's idle behaviour" });
  const hidden = await chrome.tabs.create({ url: url("tab"), active: false });
  await chrome.tabs.create({ url: "about:blank", active: true, windowId: hidden.windowId });
}
async function tick() {
  const now = Date.now();
  if (ticks > 0) maxGapMs = Math.max(maxGapMs, now - lastTick);
  lastTick = now;
  ticks += 1;
  const base = await server();
  if (base && ticks % 5 === 0) {
    try { await fetch(`${base}/ping?mode=sw&n=${ticks}`, { cache: "no-store" }); } catch { /* recorded as silence */ }
  }
  if (base && ticks % 10 === 0) {
    try { await fetch(`${base}/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "sw", started, ticks, maxGapMs, now: Date.now(), lifetime: Date.now() - started }) }); } catch { /* ditto */ }
  }
  setTimeout(tick, 1000);
}
chrome.storage.onChanged.addListener((changes) => { if (changes.server) void setUp(); });
void setUp();
setTimeout(tick, 1000);
