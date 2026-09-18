/** @jsxImportSource @opentui/solid */
/**
 * TUI entry for the DCP plugin (`./tui` export, loaded by the opencode host).
 *
 * Registers:
 *   - a `session.panel` slot claim that renders the `/dcp` panel screens
 *   - a global keymap command (`/dcp` slash + palette) that opens the panel
 *
 * Gated on `config.enabled && config.commands.enabled` (mirrors the core
 * entry). `writeDefault: false` keeps the TUI side effect-free: it only
 * reads/writes the shared DCP storage docs the core owns.
 */
import { Plugin } from "@opencode/plugin/tui";
import { resolveDcpConfig } from "./config.ts";
import { PANEL_NAME } from "./lib/tui/data.ts";
import { DcpPanelHost } from "./lib/tui/panel.tsx";

export default Plugin.define({
  id: "opencode-dcp",
  setup(context) {
    const { config } = resolveDcpConfig({
      startDir: context.location?.directory,
      writeDefault: false,
    });
    if (!config.enabled || !config.commands.enabled) return;

    const releaseSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => <DcpPanelHost context={context} panel={panel} config={config} />,
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "dcp.panel",
          title: "DCP panel",
          description: "Show DCP context stats and manual controls",
          group: "DCP",
          palette: true,
          slash: { name: "dcp" },
          run: () => {
            context.ui.panel.open(PANEL_NAME);
          },
        },
      ],
      bindings: ["dcp.panel"],
    }));

    return () => {
      releaseSlot();
    };
  },
});
