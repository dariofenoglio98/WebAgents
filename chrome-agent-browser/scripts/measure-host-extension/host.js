// One host context (an offscreen document or a hidden extension tab, by ?mode=). It behaves the
// way a run would: a chained 1 s timer (deadlines, pacer waits, progress coalescing), a short
// fetch every 5 s (a tool or model call), one IndexedDB write per tick (a checkpoint), one long
// fetch held open by the server (a slow model call), and it reports what it observed to the
// local server every 10 ticks. Nothing here touches chrome.* beyond what the page needs.
const params = new URLSearchParams(location.search);
const MODE = params.get("mode") || "unknown";
const SERVER = params.get("server");
const HOLD_SECONDS = Number(params.get("hold") || "1500");
const started = Date.now();
const state = { mode: MODE, started, ticks: 0, maxGapMs: 0, gapsOver2s: 0, gapsOver10s: 0, lastTick: started, pings: 0, pingFailures: 0, pingMaxMs: 0, idbWrites: 0, idbFailures: 0, hold: { started: null, settled: null, outcome: null }, visibility: [], hasLanguageModel: typeof globalThis.LanguageModel !== "undefined", reports: 0 };
let lastVisibility = null;
function noteVisibility() {
  const v = `${document.visibilityState}/${document.hidden}`;
  if (v !== lastVisibility) { lastVisibility = v; state.visibility.push({ t: Date.now() - started, v }); }
}
document.addEventListener("visibilitychange", noteVisibility);
noteVisibility();
const dbOpen = new Promise((resolve, reject) => {
  const req = indexedDB.open(`measure-${MODE}`, 1);
  req.onupgradeneeded = () => req.result.createObjectStore("ticks", { keyPath: "n" });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function idbWrite(n) {
  try {
    const db = await dbOpen;
    await new Promise((resolve, reject) => { const tx = db.transaction("ticks", "readwrite"); tx.objectStore("ticks").put({ n, t: Date.now() }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    state.idbWrites += 1;
  } catch { state.idbFailures += 1; }
}
async function report() {
  state.reports += 1;
  try { await fetch(`${SERVER}/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...state, now: Date.now() }) }); } catch { /* the server records the silence */ }
}
async function ping(n) {
  const t0 = performance.now();
  try {
    const r = await fetch(`${SERVER}/ping?mode=${MODE}&n=${n}`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    state.pings += 1;
    state.pingMaxMs = Math.max(state.pingMaxMs, Math.round(performance.now() - t0));
  } catch { state.pingFailures += 1; }
}
function hold() {
  state.hold.started = Date.now() - started;
  fetch(`${SERVER}/hold?mode=${MODE}&seconds=${HOLD_SECONDS}`, { cache: "no-store" }).then(
    async (r) => { const text = await r.text(); state.hold.settled = Date.now() - started; state.hold.outcome = `ok:${r.status}:${text.slice(0, 40)}`; },
    (error) => { state.hold.settled = Date.now() - started; state.hold.outcome = `error:${error && error.name}:${error && error.message}`; },
  );
}
function tick() {
  const now = Date.now();
  const gap = now - state.lastTick;
  state.lastTick = now;
  state.ticks += 1;
  if (state.ticks > 1) {
    state.maxGapMs = Math.max(state.maxGapMs, gap);
    if (gap > 2000) state.gapsOver2s += 1;
    if (gap > 10000) state.gapsOver10s += 1;
  }
  noteVisibility();
  void idbWrite(state.ticks);
  if (state.ticks % 5 === 0) void ping(state.ticks);
  if (state.ticks % 10 === 0) void report();
  setTimeout(tick, 1000);
}
// Is the Prompt API exposed inside a dedicated Worker of this context? (decides where a runner may live)
try {
  const worker = new Worker("probe-worker.js");
  worker.onmessage = (event) => { state.workerHasLanguageModel = event.data.hasLanguageModel; state.workerHasIndexedDB = event.data.hasIndexedDB; state.workerFetch = event.data.fetchOk; };
  worker.postMessage({ server: SERVER });
} catch (error) { state.workerHasLanguageModel = `error:${error && error.message}`; }
hold();
setTimeout(tick, 1000);
void report();
