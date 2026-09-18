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
import { writeFile } from "node:fs/promises";
import { Show } from "solid-js";
import type { usePlugin } from "@opencode/plugin/tui";
import { resolveDcpConfig } from "./config.ts";
import { kvDbPath } from "./lib/tui/bridge.ts";
import { PANEL_NAME } from "./lib/tui/data.ts";
import { DcpPanelHost } from "./lib/tui/panel.tsx";

/** The host TUI context, derived from the public `usePlugin` API. */
type Ctx = ReturnType<typeof usePlugin>;

/**
 * Renders nothing; its only job is to register the DCP keymap layer from
 * inside the host component tree, where `keymap.layer` is legal.
 */
function DcpKeymapMount(props: { context: Ctx }) {
  props.context.keymap.layer(() => ({
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
          const ctx = props.context;
          if (ctx.ui.router.current().type !== "session") {
            const sessions = ctx.data.session.list();
            if (sessions.length === 0) return;
            const latest = sessions.reduce((a, b) => (b.time.updated > a.time.updated ? b : a));
            ctx.ui.router.navigate({ type: "session", sessionID: latest.id });
            setTimeout(() => ctx.ui.panel.open(PANEL_NAME), 300);
            return;
          }
          ctx.ui.panel.open(PANEL_NAME);
        },
      },
    ],
    bindings: ["dcp.panel"],
  }));
  return <Show when={false}>{() => <box />}</Show>;
}

export default {
  id: "opencode-dcp",
  setup(context: Ctx) {
    const { config } = resolveDcpConfig({
      startDir: context.location?.directory,
      writeDefault: false,
    });
    if (!config.enabled || !config.commands.enabled) return;

    // PROBE(temp, #17): verify the `bun:sqlite` read path the panel bridge
    // uses from the TUI process; the result lands in /tmp/dcp-tui-probe.json.
    // Remove once the smoke has read the panel docs through it.
    void (async () => {
      const probe: Record<string, unknown> = { at: new Date().toISOString() };
      try {
        const { Database } = await import("bun:sqlite");
        const db = new Database(kvDbPath(), { readonly: true });
        try {
          const rows = db.query("select key from kv where key like '%dcp%' limit 5").all() as {
            key: string;
          }[];
          probe.sqlite = { ok: true, keys: rows.map((row) => row.key) };
        } finally {
          db.close();
        }
      } catch (error) {
        probe.sqlite = { ok: false, error: String(error) };
      }
      try {
        await writeFile("/tmp/dcp-tui-probe.json", JSON.stringify(probe, null, 2));
      } catch {
        // Probe output is best-effort.
      }
    })();

    const releasePanelSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => <DcpPanelHost context={context} panel={panel} config={config} />,
    });
    const releaseKeymapMount = context.ui.slot({
      append: "app",
      render: () => <DcpKeymapMount context={context} />,
    });

    return () => {
      releasePanelSlot();
      releaseKeymapMount();
    };
  },
};
