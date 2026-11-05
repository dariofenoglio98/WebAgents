/**
 * Settings → Models → In this browser (T41, D-443, D-444, D-446, D-456): the models this extension
 * runs itself, inside the browser, on the machine's GPU. One card with, in order:
 *
 *   what this route is      "Runs inside this extension on your GPU. No network: nothing leaves this
 *                           browser." and the nothing-left-behind words (design §7)
 *   this machine            the GPU the engine sees, the budget with its basis, the benchmark class,
 *                           "This machine's GPU memory" (the person's statement), Measure
 *   the switches            "Let local models think" (a change reloads the model), the idle unload
 *   loaded now              the model the engine holds, its context, Unload
 *   the list                the curated list in four bins with every reason, then the pasted models;
 *                           per model: Download… (the download card), progress and Cancel, or Load,
 *                           Unload, Verify, Delete, Make default; a context that failed, with Clear
 *   paste a repository      owner/name or the page's address → its GGUF files → Add
 *   the cache               totals and the storage estimate; models no longer listed and files no
 *                           model names, each deletable; Check for a newer list
 *
 * Nothing downloads by itself: Download… opens the card (name, size, licence, repository, files,
 * digests, storage before and after, the budget verdict) and only its Download button starts it.
 */
import { gb } from "../../core/models/in-browser-catalog.js";
import type { InBrowserView, PasteView } from "../background/in-browser.js";
import type { Settings, StoredConnection } from "../storage/settings.js";
import { IDLE_UNLOAD_CHOICES } from "../storage/settings.js";
import { button, card, chip, details, el, list, row, shortHash, whenText } from "./dom.js";

export const ROUTE_LINE = "Runs inside this extension on your GPU. No network: nothing leaves this browser.";
/** Design §7, verbatim (D-444): the docs carry the same words. */
export const NOTHING_LEFT_BEHIND = "A model you download is a cache the browser keeps for this extension, like any site's cached files: you can see every model, its size and when it was last used in Settings → Models, delete any of them, and uninstalling the extension removes them all. An agent never installs anything; it runs on the model you chose, and the weights never leave this browser.";

export const BIN_TITLES: Record<string, string> = { recommended: "Recommended for this machine", possible: "Possible", not_suitable: "Not suitable", too_large: "Too large for this machine" };
const BIN_TONES: Record<string, "good" | "neutral" | "warn" | "bad"> = { recommended: "good", possible: "neutral", not_suitable: "warn", too_large: "bad" };

export interface InBrowserPageState {
  /** The paste field's text, kept across re-renders. */
  paste: string;
  pasted: PasteView | null;
  /** The entry whose download card is open. */
  confirm: string | null;
  /** The GPU memory field's text. */
  gpu: string;
  /** The action in flight, as `busyKey` names it, so its button says so (T41 walk-through: Verify showed nothing). */
  busy: string | null;
  /** The last action's outcome for one entry, shown under its row until the next action. */
  outcome: { entry: string; text: string; tone: "good" | "bad" } | null;
}

/** `inbrowser.verify:qwen3-4b-q4_k_m`: which action on which entry is running. */
export function busyKey(request: { type: string; [key: string]: unknown }): string {
  return `${request.type}:${typeof request.entryId === "string" ? request.entryId : ""}`;
}

/**
 * What an action did, in words, for the row it was pressed on: a Verify re-reads every byte and
 * says whether they still match; a Load says the context and how long it took. Null for actions
 * whose effect the row already shows.
 */
export function outcomeOf(request: { type: string; [key: string]: unknown }, result: unknown): InBrowserPageState["outcome"] {
  const entry = typeof request.entryId === "string" ? request.entryId : null;
  if (entry === null) return null;
  if (request.type === "inbrowser.verify") {
    const row = result as { verified?: boolean; files?: Array<{ bytes: number }> } | null;
    const size = gb((row?.files ?? []).reduce((sum, file) => sum + file.bytes, 0));
    return row?.verified === true
      ? { entry, text: `Verified just now: all ${size} re-read, and every file still matches its SHA-256.`, tone: "good" }
      : { entry, text: "Verification failed: the bytes did not match the digest the catalog states. Delete the model and download it again.", tone: "bad" };
  }
  if (request.type === "inbrowser.load") {
    const loaded = result as { n_ctx?: number; load_ms?: number } | null;
    return { entry, text: `Loaded at ${(loaded?.n_ctx ?? 0).toLocaleString("en-US")} tokens in ${((loaded?.load_ms ?? 0) / 1000).toFixed(1)} s.`, tone: "good" };
  }
  return null;
}

/** The words beside a context whose load died (D-441), with the context the next load uses. */
export function failureWords(failed: number, next: number): string {
  return `Failed to run at a ${failed.toLocaleString("en-US")}-token context on this machine (its engine stopped, most likely out of memory)${next < failed ? `; the next load uses ${next.toLocaleString("en-US")} tokens` : ""}. Clear it to try ${failed.toLocaleString("en-US")} again.`;
}

export function newInBrowserPageState(): InBrowserPageState {
  return { paste: "", pasted: null, confirm: null, gpu: "", busy: null, outcome: null };
}

export interface InBrowserActions {
  /** One `inbrowser.*` request; the page re-reads the view afterwards. `origins` are asked of Chrome first, in the click. */
  request: (request: { type: string; [key: string]: unknown }, origins?: string[]) => void;
  save: (settings: Settings) => void;
  rerender: () => void;
}

const HF = "https://huggingface.co";

function withConnection(settings: Settings, change: (connection: StoredConnection) => StoredConnection): Settings {
  return { ...settings, models: { ...settings.models, connections: settings.models.connections.map((item) => (item.provider === "in-browser" ? change(item) : item)) } };
}

function percent(done: number, total: number): string {
  return total > 0 ? `${Math.floor((done / total) * 100)} %` : "";
}

/** The download card (D-444): everything the person consents to, and the one button that starts it. */
function downloadCard(item: InBrowserView["entries"][number], view: InBrowserView, state: InBrowserPageState, actions: InBrowserActions): HTMLElement {
  const entry = item.entry;
  const storage = view.machine.storage;
  const free = storage?.quota !== null && storage?.quota !== undefined ? storage.quota - (storage.usage ?? 0) : null;
  return el(
    "div",
    { className: "ab-download-card", attrs: { "data-download-card": entry.id, role: "group", "aria-label": `Download ${entry.display_name}` } },
    el("strong", { text: `Download ${entry.display_name}` }),
    row("Size", `${gb(entry.bytes_total)} (${entry.bytes_total.toLocaleString("en-US")} bytes)`),
    row("Licence", el("a", { text: entry.license.name, attrs: { href: entry.license.url, target: "_blank", rel: "noopener noreferrer" } })),
    row("Repository", el("a", { text: entry.source.repository, attrs: { href: `${HF}/${entry.source.repository}`, target: "_blank", rel: "noopener noreferrer" } }), ` at ${shortHash(entry.source.revision, 7)}`),
    row("Files", `${entry.files.length} from huggingface.co`),
    details("Digests (SHA-256, checked while the files arrive)", false, list(entry.files.map((file) => el("code", { text: `${file.name}  ${file.sha256}` })))),
    row("Storage", free === null ? "unknown" : `${gb(free)} free now, ${gb(Math.max(0, free - entry.bytes_total))} after`),
    row("On this machine", item.recommendation.reasons[0] ?? "", ` (${BIN_TITLES[item.recommendation.bin]?.toLowerCase() ?? item.recommendation.bin})`),
    entry.curated ? null : el("p", { className: "ab-hint ab-warn", text: entry.notes ?? "Not reviewed by WebAgents." }),
    el("p", { className: "ab-hint", text: "The files come from the repository named above and are kept only if every byte matches the digest the list states. Nothing runs until you choose this model." }),
    el(
      "div",
      { className: "ab-inline" },
      button(`Download (${gb(entry.bytes_total)})`, () => {
        state.confirm = null;
        actions.request({ type: "inbrowser.download", entryId: entry.id }, [HF]);
      }, { variant: "primary" }),
      button("Cancel", () => {
        state.confirm = null;
        actions.rerender();
      }),
    ),
  );
}

function entryRow(item: InBrowserView["entries"][number], view: InBrowserView, settings: Settings, state: InBrowserPageState, actions: InBrowserActions): HTMLElement {
  const entry = item.entry;
  const descriptor = item.descriptor as { id: string; available: boolean; availability_reason: string | null; limits: { context_tokens: number } };
  const loaded = view.engine?.loaded?.entry === entry.id;
  const download = item.download;
  const running = download !== null && (download.state === "downloading" || download.state === "reading_header");
  const isDefault = settings.models.default_model === descriptor.id;
  // An action on this entry is running: its button says so and the others wait.
  const working = state.busy !== null && state.busy.endsWith(`:${entry.id}`);
  const actionsRow: Array<HTMLElement | null> = [];
  if (running) {
    actionsRow.push(el("progress", { attrs: { max: String(download.bytes_total), value: String(download.bytes_done), "aria-label": `Downloading ${entry.display_name}` } }), el("span", { className: "ab-hint", text: `${download.state === "reading_header" ? "reading the header" : `${gb(download.bytes_done)} of ${gb(download.bytes_total)} · ${percent(download.bytes_done, download.bytes_total)}`}${download.resumed_from > 0 ? " · resumed" : ""}` }), button("Cancel download", () => actions.request({ type: "inbrowser.cancel", entryId: entry.id }), { variant: "danger" }));
  } else if (item.cached) {
    actionsRow.push(
      loaded ? button("Unload", () => actions.request({ type: "inbrowser.unload" }), { disabled: working }) : button(state.busy === `inbrowser.load:${entry.id}` ? "Loading…" : "Load", () => actions.request({ type: "inbrowser.load", entryId: entry.id }), { disabled: working || !descriptor.available, title: descriptor.available ? "Load it now so the next run starts at once" : (descriptor.availability_reason ?? "") }),
      button(state.busy === `inbrowser.verify:${entry.id}` ? "Verifying…" : "Verify", () => actions.request({ type: "inbrowser.verify", entryId: entry.id }), { disabled: working, title: `Re-read all ${gb(entry.bytes_total)} and check every file against its SHA-256` }),
      button("Delete", () => actions.request({ type: "inbrowser.delete", entryId: entry.id }), { variant: "danger", disabled: working }),
      isDefault || !descriptor.available ? null : button("Make default", () => actions.save({ ...settings, models: { ...settings.models, default_model: descriptor.id } }), { variant: "primary" }),
    );
  } else {
    actionsRow.push(button("Download…", () => {
      state.confirm = entry.id;
      actions.rerender();
    }, { variant: item.recommendation.bin === "recommended" ? "primary" : "ghost", disabled: item.recommendation.bin === "too_large" && !entry.curated }));
  }
  const row = item.row;
  return el(
    "div",
    { className: "ab-model-row", attrs: { "data-model": descriptor.id, "data-bin": item.recommendation.bin } },
    el(
      "div",
      { className: "ab-model-head" },
      el("strong", { text: entry.display_name }),
      el("code", { className: "ab-model-id", text: descriptor.id }),
      chip(gb(entry.bytes_total)),
      entry.curated ? chip("curated") : chip("not reviewed", "warn"),
      loaded ? chip(`loaded now · ${view.engine!.loaded!.n_ctx.toLocaleString("en-US")} tokens`, "good") : item.cached ? chip(item.verified ? "downloaded" : "does not match its digest", item.verified ? "good" : "bad") : null,
      isDefault ? chip("default", "good") : null,
    ),
    list(item.recommendation.reasons.map((reason) => el("span", { className: "ab-hint", text: reason }))),
    item.cached && !descriptor.available && descriptor.availability_reason ? el("p", { className: "ab-hint ab-model-unavailable", text: `Cannot run now: ${descriptor.availability_reason}.` }) : null,
    row === null || !item.cached
      ? null
      : el("p", { className: "ab-hint", text: [`downloaded ${whenText(row.downloaded_at ?? "")}`, row.verified_at ? `verified ${whenText(row.verified_at)}` : null, row.last_used ? `last used ${whenText(row.last_used)}` : "never used", row.measured ? `measured ${row.measured.decode_tok_per_s} tok/s decode, ${row.measured.prefill_tok_per_s} tok/s prefill at ${row.measured.context.toLocaleString("en-US")} tokens` : null].filter(Boolean).join(" · ") }),
    row?.last_error ? el("p", { className: "ab-banner ab-banner-warn", text: row.last_error.message, attrs: { role: "status" } }) : null,
    // T41 review 1, finding 2: a context whose load died is never tried again by itself; the
    // recommendation picks a smaller one, and Clear lets the person try that size again.
    row?.failed_context !== null && row?.failed_context !== undefined
      ? el(
          "div",
          { className: "ab-inline ab-model-failure", attrs: { "data-failed-context": String(row.failed_context) } },
          el("span", { className: "ab-hint ab-warn", text: failureWords(row.failed_context, descriptor.limits.context_tokens) }),
          button(state.busy === `inbrowser.clearFailure:${entry.id}` ? "Clearing…" : "Clear", () => actions.request({ type: "inbrowser.clearFailure", entryId: entry.id }), { disabled: working, title: `Forget the failure: the next load may try ${row.failed_context.toLocaleString("en-US")} tokens again` }),
        )
      : null,
    download?.state === "failed" && download.error ? el("p", { className: "ab-banner ab-banner-bad", text: download.error.message, attrs: { role: "status" } }) : null,
    entry.curated ? null : el("p", { className: "ab-hint", text: entry.notes ?? "" }),
    el("div", { className: "ab-inline" }, ...actionsRow),
    state.outcome?.entry === entry.id ? el("p", { className: `ab-banner ab-banner-${state.outcome.tone === "good" ? "good" : "bad"} ab-outcome-line`, text: state.outcome.text, attrs: { role: "status" } }) : null,
    state.confirm === entry.id ? downloadCard(item, view, state, actions) : null,
  );
}

/** The card's body; `view` is null until the worker answered. */
export function inBrowserSection(view: InBrowserView | null, settings: Settings, state: InBrowserPageState, actions: InBrowserActions): HTMLElement[] {
  if (view === null) return [el("p", { className: "ab-busy", text: "Reading this browser's models…" })];
  const connection = settings.models.connections.find((item) => item.provider === "in-browser");
  const think = el("input", { attrs: { type: "checkbox", name: "in-browser-think", "aria-label": "Let local models think" } });
  think.checked = connection?.think === true;
  think.addEventListener("change", () => actions.save(withConnection(settings, (item) => ({ ...item, think: think.checked }))));
  const idle = el("select", { className: "ab-select", attrs: { name: "in-browser-idle", "aria-label": "Unload after" } });
  for (const minutes of IDLE_UNLOAD_CHOICES) idle.append(el("option", { text: `Unload after ${minutes} minutes without a run${minutes === 10 ? " (default)" : ""}`, attrs: { value: String(minutes) } }));
  idle.value = String(settings.models.in_browser.idle_unload_minutes);
  idle.addEventListener("change", () => actions.save({ ...settings, models: { ...settings.models, in_browser: { ...settings.models.in_browser, idle_unload_minutes: Number(idle.value) } } }));
  const gpu = el("input", { className: "ab-input ab-input-short", attrs: { type: "number", min: "1", step: "0.5", name: "in-browser-gpu-memory", placeholder: "GB", "aria-label": "This machine's GPU memory in GB" } });
  gpu.value = state.gpu || (settings.models.in_browser.gpu_memory_gb === null ? "" : String(settings.models.in_browser.gpu_memory_gb));
  gpu.addEventListener("input", () => (state.gpu = gpu.value));
  const machine = view.machine;
  const bins = ["recommended", "possible", "not_suitable", "too_large"].map((bin) => [bin, view.entries.filter((item) => item.recommendation.bin === bin)] as const).filter(([, items]) => items.length > 0);
  const paste = el("input", { className: "ab-input", attrs: { name: "in-browser-paste", placeholder: "owner/name or https://huggingface.co/owner/name", autocomplete: "off", "aria-label": "Hugging Face repository" } });
  paste.value = state.paste;
  paste.addEventListener("input", () => (state.paste = paste.value));
  const storage = machine.storage;
  const nodes: Array<HTMLElement | null> = [
    el("p", { className: "ab-hint", text: ROUTE_LINE }),
    el("p", { className: "ab-hint", text: NOTHING_LEFT_BEHIND }),
    el("h4", { text: "This machine" }),
    row("GPU", machine.webgpu === false ? "WebGPU is not available to this extension: in-browser models cannot run here." : machine.adapter ?? "not measured yet"),
    row("GPU memory budget", machine.budget_words),
    row("GPU benchmark", machine.benchmark ? `${machine.benchmark.kernel_class} (${machine.benchmark.gflops} GFLOP/s on a ${machine.benchmark.n}×${machine.benchmark.n} matmul${machine.benchmark.f16 ? ", f16" : ""}, measured ${whenText(machine.benchmark.at)})` : "not run yet", " ", button("Measure this GPU", () => actions.request({ type: "inbrowser.measure" }))),
    el(
      "label",
      { className: "ab-field ab-inline" },
      el("span", { className: "ab-row-label", text: "This machine's GPU memory " }),
      gpu,
      button("Save", () => {
        const value = Number.parseFloat(state.gpu || gpu.value);
        state.gpu = "";
        actions.save({ ...settings, models: { ...settings.models, in_browser: { ...settings.models.in_browser, gpu_memory_gb: Number.isFinite(value) && value > 0 ? value : null } } });
      }),
    ),
    el("p", { className: "ab-hint", text: "No web page can read how much GPU memory a machine has. State it here (for an Apple Silicon Mac, about two thirds of its memory; for a graphics card, its VRAM) and every verdict below uses your number; leave it empty to use the platform's estimate." }),
    el("label", { className: "ab-field ab-inline" }, think, " ", el("span", { text: "Let local models think" })),
    el("p", { className: "ab-hint", text: "Loads the model with its reasoning turned on: slower, sometimes better on multi-step agents. The thinking tokens count against the run's budget. A change reloads the model before its next run." }),
    el("label", { className: "ab-field" }, idle),
    (() => {
      // D-448: a feature detect behind a setting, off; v1 keeps its own digest-keyed cache either way.
      const cos = el("input", { attrs: { type: "checkbox", name: "in-browser-cos", "aria-label": "Use the browser's Cross-Origin Storage" } });
      cos.checked = settings.models.in_browser.cross_origin_storage;
      cos.addEventListener("change", () => actions.save({ ...settings, models: { ...settings.models, in_browser: { ...settings.models.in_browser, cross_origin_storage: cos.checked } } }));
      const present = machine.cross_origin_storage;
      return el("label", { className: "ab-field ab-inline" }, cos, " ", el("span", { text: `Use the browser's Cross-Origin Storage when it has one (this browser: ${present === true ? "present" : present === false ? "absent" : "not measured"}; not used in this version)` }));
    })(),
    el("h4", { text: "Loaded now" }),
    view.engine?.loaded
      ? el("div", { className: "ab-inline" }, el("span", { text: `${view.engine.loaded.entry} at ${view.engine.loaded.n_ctx.toLocaleString("en-US")} tokens${view.engine.runs.length > 0 ? `, in use by ${view.engine.runs.map((item) => item.run_id).join(", ")}` : ""}${view.engine.idle_unload_at ? `, unloads at ${whenText(view.engine.idle_unload_at)} if unused` : ""}` }), button("Unload", () => actions.request({ type: "inbrowser.unload" })))
      : el("p", { className: "ab-hint", text: view.engine?.loading ? `Loading ${view.engine.loading}…` : "No model is loaded. A run on an in-browser model loads it first." }),
    view.engine?.last_failure && view.entries.some((item) => item.entry.id === view.engine!.last_failure!.entry && item.row?.failed_context !== null && item.row?.failed_context !== undefined) ? el("p", { className: "ab-banner ab-banner-warn", text: `${view.engine.last_failure.entry} stopped at a ${view.engine.last_failure.n_ctx.toLocaleString("en-US")}-token context (${view.engine.last_failure.reason}): it is not retried at that size; the next load uses a smaller context.`, attrs: { role: "status" } }) : null,
    ...bins.flatMap(([bin, items]) => [el("h4", {}, chip(BIN_TITLES[bin]!, BIN_TONES[bin])), list(items.map((item) => entryRow(item, view, settings, state, actions)))]),
    el("h4", { text: "Paste a Hugging Face repository" }),
    el("div", { className: "ab-inline" }, paste, button("Look up", () => {
      state.paste = paste.value;
      if (state.paste.trim().length > 0) actions.request({ type: "inbrowser.paste", repository: state.paste.trim() }, [HF]);
    })),
    state.pasted
      ? el(
          "div",
          { className: "ab-pasted", attrs: { "data-repository": state.pasted.repository } },
          el("p", { className: "ab-hint", text: `${state.pasted.repository} · licence: ${state.pasted.license ?? "not stated by the model card"}${state.pasted.gated ? " · gated: needs a token, not supported" : ""}. Not reviewed by WebAgents: check the licence and the model's quality yourself.` }),
          list(state.pasted.candidates.map((candidate) => el("div", { className: "ab-inline" }, el("code", { text: candidate.file }), chip(gb(candidate.bytes_total)), candidate.files.length > 1 ? chip(`${candidate.files.length} parts`) : null, button("Add", () => actions.request({ type: "inbrowser.addPasted", repository: state.pasted!.repository, file: candidate.file }, [HF]), { disabled: state.pasted!.gated })))),
        )
      : null,
    el("h4", { text: "This browser's model cache" }),
    el("p", { className: "ab-hint", text: `${view.totals.entries_cached} model${view.totals.entries_cached === 1 ? "" : "s"}, ${gb(view.totals.cached_bytes)} kept by this browser${storage?.quota ? ` · storage ${gb(storage.usage ?? 0)} used of ${gb(storage.quota)} available to this extension` : ""}.` }),
    // T41 review 1, finding 4: nothing the cache keeps is out of sight or out of reach.
    view.unlisted.length > 0
      ? el(
          "div",
          { className: "ab-unlisted" },
          el("p", { className: "ab-hint", text: "No longer in the model list (kept until you delete them):" }),
          list(view.unlisted.map((item) => el("div", { className: "ab-inline", attrs: { "data-unlisted": item.entry_id } }, el("strong", { text: item.display_name }), el("code", { className: "ab-model-id", text: item.entry_id }), chip(gb(item.bytes)), item.cached ? null : chip("partial", "warn"), button(state.busy === `inbrowser.delete:${item.entry_id}` ? "Deleting…" : "Delete", () => actions.request({ type: "inbrowser.delete", entryId: item.entry_id }), { variant: "danger", disabled: state.busy !== null && state.busy.endsWith(`:${item.entry_id}`) })))),
        )
      : null,
    view.orphan_files !== null && view.orphan_files.count > 0
      ? el("div", { className: "ab-inline ab-orphans" }, el("span", { className: "ab-hint", text: `${view.orphan_files.count} cached file${view.orphan_files.count === 1 ? "" : "s"} no model names (${gb(view.orphan_files.bytes)}), left by an earlier version of a model.` }), button(state.busy === "inbrowser.prune:" ? "Removing…" : "Remove them", () => actions.request({ type: "inbrowser.prune" }), { variant: "danger", disabled: state.busy === "inbrowser.prune:" }))
      : null,
    el("p", { className: "ab-hint", text: `Curated list ${view.catalog.version} (${view.catalog.source === "shipped" ? "shipped with this extension" : "fetched and verified"}, issued ${whenText(view.catalog.issued_at)}), signed by the WebAgents catalog key.` }),
    ...view.catalog.notes.map((note) => el("p", { className: "ab-hint ab-warn", text: note.detail ?? note.code })),
    button("Check for a newer list", () => actions.request({ type: "inbrowser.refreshCatalog" }, [new URL(view.catalog.refresh_url).origin])),
  ];
  return nodes.filter((node): node is HTMLElement => node !== null);
}

/** The Settings card wrapper (the connection's enable switch is drawn by the caller). */
export function inBrowserCard(...children: Array<HTMLElement | null>): HTMLElement {
  return card("In this browser", ...children);
}
