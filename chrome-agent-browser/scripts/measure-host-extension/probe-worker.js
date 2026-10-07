// A dedicated Worker inside a host context: which of the runner's dependencies exist here?
self.onmessage = async (event) => {
  let fetchOk = null;
  try { const r = await fetch(`${event.data.server}/ping?mode=worker-probe&n=1`); fetchOk = r.ok; } catch (error) { fetchOk = `error:${error && error.name}`; }
  self.postMessage({ hasLanguageModel: typeof self.LanguageModel !== "undefined", hasIndexedDB: typeof self.indexedDB !== "undefined", fetchOk });
};
