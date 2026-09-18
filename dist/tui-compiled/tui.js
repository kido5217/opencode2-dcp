import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
/**
 * TUI entry for the DCP plugin (`./tui` export, loaded by the opencode host).
 *
 * Registers:
 *   - a `session.panel` slot claim that renders the `/dcp` panel screens
 *   - an `app` slot claim whose mount component registers the global keymap
 *     command (`/dcp` slash + palette) that opens the panel. `keymap.layer`
 *     must be called from inside a component in the host's tree ("owned by
 *     the calling component"), so it cannot run from `setup` — there is no
 *     Keymap.Provider there.
 *
 * Gated on `config.enabled && config.commands.enabled` (mirrors the core
 * entry).
 */
import { Show } from "opentui:runtime-module:solid-js";
import { resolveDcpConfig } from "../../src/config.ts";
import { PANEL_NAME } from "../../src/lib/tui/data.ts";
import { DcpPanelHost } from "./panel.js";

/** The host TUI context, derived from the public `usePlugin` API. */

/**
 * Renders nothing; its only job is to register the DCP keymap layer from
 * inside the host component tree, where `keymap.layer` is legal.
 */
function DcpKeymapMount(props) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "dcp.panel",
      title: "DCP panel",
      description: "Show DCP context stats and manual controls",
      group: "DCP",
      palette: true,
      slash: {
        name: "dcp"
      },
      run: () => {
        const ctx = props.context;
        if (ctx.ui.router.current().type !== "session") {
          const sessions = ctx.data.session.list();
          if (sessions.length === 0) return;
          const latest = sessions.reduce((a, b) => b.time.updated > a.time.updated ? b : a);
          ctx.ui.router.navigate({
            type: "session",
            sessionID: latest.id
          });
          setTimeout(() => ctx.ui.panel.open(PANEL_NAME), 300);
          return;
        }
        ctx.ui.panel.open(PANEL_NAME);
      }
    }],
    bindings: ["dcp.panel"]
  }));
  return _$createComponent(Show, {
    when: false,
    children: () => _$createElement("box")
  });
}
export default {
  id: "opencode-dcp",
  setup(context) {
    const {
      config
    } = resolveDcpConfig({
      startDir: context.location?.directory,
      writeDefault: false
    });
    if (!config.enabled || !config.commands.enabled) return;
    const releasePanelSlot = context.ui.slot({
      append: "session.panel",
      render: panel => _$createComponent(DcpPanelHost, {
        context: context,
        panel: panel,
        config: config
      })
    });
    const releaseKeymapMount = context.ui.slot({
      append: "app",
      render: () => _$createComponent(DcpKeymapMount, {
        context: context
      })
    });
    return () => {
      releasePanelSlot();
      releaseKeymapMount();
    };
  }
};