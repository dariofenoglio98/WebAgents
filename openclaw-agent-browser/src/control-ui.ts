/**
 * Native Control UI entry: one page and one sidebar destination.
 *
 * This module is the only browser-side code in the plugin. It holds no
 * credentials and makes no network requests of its own: every call goes
 * through `createFeatureClient`, which uses the operator's existing
 * authenticated Gateway connection to reach the plugin backend.
 */
import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { mountAgentBrowser } from "./ui/page.js";
import "./control-ui.css";

const PAGE_ID = "agent-browser";

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({
      id: PAGE_ID,
      label: "Agent Browser",
      page: { id: PAGE_ID },
      icon: "package",
      order: 40,
    });
    host.ui.registerPage({
      id: PAGE_ID,
      label: "Agent Browser",
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);
        const dispose = mountAgentBrowser(container, {
          // The client validates against the same contract on both sides.
          invoke: (operation, input) =>
            feature.invoke(operation as never, input as never) as Promise<unknown>,
          signal: context.signal,
          canWrite: context.host.connection.canWrite,
        });
        return { dispose };
      },
    });
  },
});
