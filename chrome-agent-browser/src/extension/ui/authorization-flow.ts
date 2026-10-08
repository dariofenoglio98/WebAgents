/**
 * The authorization flow's glue, shared by the side panel and the full page: loads the
 * worker's authorization view and model catalog for the open session, owns the view's local
 * state, and turns the view's actions into requests. The surfaces supply where their state
 * lives and how they re-render; nothing here is computed about authority (D-035).
 */
import type { Decision, Provenance } from "../../core/types.js";
import type { AuthorizationView, AuthorizeResult, ModelsView, RunPlanState, SessionView } from "../messages.js";
import { newAuthorizeState, renderAuthorizeView, type AuthorizeState } from "./authorize.js";
import { describeError, send } from "./client.js";
import { el } from "./dom.js";

export interface AuthorizationHost {
  session: () => SessionView | null;
  get: () => AuthorizationView | null;
  set: (view: AuthorizationView | null) => void;
  models: () => ModelsView | null;
  setModels: (models: ModelsView | null) => void;
  setBusy: (text: string | null) => void;
  setError: (error: { code: string; message: string } | null) => void;
  openSettings: (section: "models" | "policies" | "data") => void;
  rerender: () => void;
  compact?: boolean;
}

export interface AuthorizationController {
  /** Load (or reload) the view and the models for the open session. */
  load: () => Promise<void>;
  /** Forget the local state when the session changes or closes. */
  reset: () => void;
  /** The rendered flow for the open session, or nothing when no session is open or loaded. */
  render: (onTrust: (scope: "package" | "publisher") => void) => HTMLElement | null;
  readonly state: AuthorizeState;
}

export function bindAuthorization(host: AuthorizationHost): AuthorizationController {
  let state = newAuthorizeState();
  let busy: string | null = null;
  /** The session whose model list was last re-probed: a view opening on a session re-reads the providers once (D-077). */
  let probedFor: string | null = null;

  const session = () => host.session();

  async function load(): Promise<void> {
    const open = session();
    if (!open) {
      host.set(null);
      host.setModels(null);
      return;
    }
    try {
      const view = await send<AuthorizationView>({ type: "authorization.get", sessionId: open.session.id });
      host.set(view);
      if (view.receipt && !state.selectedModel) state.selectedModel = view.run_plan?.run_plan.model_binding?.host_model_id ?? view.default_model;
      // Models follow authorization, as in the reference plugin: before a receipt exists the catalog is only read on request.
      // The first read for a session asks the providers again, so a stopped Ollama shows as unavailable when the view opens, not a minute later.
      if (view.receipt || state.customize) {
        const refresh = probedFor !== open.session.id;
        host.setModels(await send<ModelsView>({ type: "models.evaluate", sessionId: open.session.id, refresh }));
        probedFor = open.session.id;
      }
    } catch (error) {
      host.setError(describeError(error));
    }
  }

  async function act<T>(label: string, operation: () => Promise<T>, done: (result: T) => void): Promise<void> {
    busy = label;
    host.setBusy(label);
    host.rerender();
    try {
      done(await operation());
      host.setError(null);
    } catch (error) {
      const described = describeError(error);
      state.notice = { text: `${described.code}: ${described.message}`, tone: "bad" };
      host.setError(null);
    } finally {
      busy = null;
      host.setBusy(null);
      await load();
      host.rerender();
    }
  }

  function afterAuthorize(result: AuthorizeResult): void {
    if (result.run_plan?.preflight.ready) state.notice = { text: "Authorized and ready to run. Nothing has run.", tone: "good" };
    else if (result.plan_refused) state.notice = { text: `Authorized. No run plan yet: ${result.plan_refused.map((reason) => reason.message).join(" ")}`, tone: "warn" };
    else state.notice = { text: result.receipt.runnable ? "Authorized for this session. Nothing has run." : "Recorded. The agent is not runnable with these decisions.", tone: result.receipt.runnable ? "good" : "warn" };
    state.customize = false;
    state.draft = null;
  }

  return {
    get state() {
      return state;
    },
    load,
    reset: () => {
      state = newAuthorizeState();
      probedFor = null;
      host.set(null);
      host.setModels(null);
    },
    render(onTrust) {
      const open = session();
      const view = host.get();
      if (!open) return null;
      if (!view) return el("p", { className: "ab-busy", text: "Loading what this agent needs…" });
      return renderAuthorizeView(
        { session: open, view, models: host.models(), busy, compact: host.compact },
        state,
        {
          onUseProfile: (profileId, picks) =>
            void act("Recording your decisions…", () => send<AuthorizeResult>({ type: "authorization.useProfile", sessionId: open.session.id, packageDigest: view.package_digest, profileId, resourceSelections: picks, prepare: true }), afterAuthorize),
          onAuthorize: (decisions: Record<string, Decision>, approvals, picks, provenance: Provenance, modelId) =>
            void act(
              "Recording your decisions…",
              () => send<AuthorizeResult>({ type: "authorization.authorize", sessionId: open.session.id, packageDigest: view.package_digest, decisions, toolApprovals: approvals, resourceSelections: picks, provenance, prepare: true, modelId }),
              afterAuthorize,
            ),
          onPrepare: (modelId) =>
            void act(
              "Preparing the run plan…",
              () => send<RunPlanState>({ type: "runplan.prepare", sessionId: open.session.id, packageDigest: view.package_digest, receiptId: view.receipt!.receipt_id, modelId }),
              (plan) => {
                state.notice = { text: plan.preflight.ready ? "Ready to run. Nothing has run." : "The plan is not ready; see why below.", tone: plan.preflight.ready ? "good" : "warn" };
              },
            ),
          onRefreshModels: () =>
            void act("Reading the model catalog…", () => send<ModelsView>({ type: "models.evaluate", sessionId: open.session.id, refresh: true }), (models) => {
              host.setModels(models);
              state.customize = true;
            }),
          onClearPlan: () =>
            void act("Discarding the run plan…", () => send({ type: "runplan.clear", sessionId: open.session.id }), () => {
              state.notice = { text: "Run plan discarded. The authorization stands.", tone: "warn" };
            }),
          onOpenSettings: host.openSettings,
          onTrust,
          rerender: host.rerender,
        },
      );
    },
  };
}
