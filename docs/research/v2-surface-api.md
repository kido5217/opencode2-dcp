# Research: v2 Surface APIs — CLI plugin panel, notifications, model metadata

Ticket: #4 (map #2). Baseline: `opencode2` 2.0.7, `@opencode/plugin` 2.0.7, `@opencode/client` 2.0.7.
Date: 2026-09-18. All claims below are grounded in the sources listed at the end; type shapes are quoted from the published `.d.ts` of the pinned npm tarballs.

## 0. Architecture overview

A v2 plugin is one package with up to two entrypoints (per `@opencode/plugin` `host.d.ts` — `Host.resolve()` returns `Entrypoints { server?, tui?, rpc? }`):

- **Core (server) plugin** — `import { Plugin } from "@opencode/plugin"` (`.` export). Runs in the server process. `Plugin.define({ id, setup(ctx) })`; `ctx` has `app`, `location`, `options`, and domains: `agent`, `aisdk`, `command`, `event` (subscribe-only), `model`, `provider`, `session`, `skill`, `storage`, `tool`, `permission`, `mcp`, `generate`, `rpc`, `vcs`, `worktree`, `websearch`, `integration`, `reference`, `plugin` (`promise/plugin.d.ts`).
- **CLI (TUI) plugin** — `import { Plugin } from "@opencode/plugin/tui"`. Runs inside the terminal UI. Same `define({ id, setup(context) })` shape; `context` has `options`, `location`, `app`, `renderer` (OpenTUI), `client` (full `OpenCodeClient`), `data` (reactive cached session/model/project collections + event subscription), `attention`, `theme`, `markdown`, `keymap`, `storage`, `ui` (`tui/context.d.ts`).

Discovery (docs `v2/docs/cli/plugins`): packages in `opencode.json(c)` `plugins[]` are loaded by the CLI automatically (server plugin list comes from the connected server, so it works with remote servers too); `cli.json` (global `~/.config/opencode/cli.json`) adds CLI-only plugins that stay active against remote servers; `<project>/.opencode/plugins/<name>/{index.ts,tui.ts}` and the global config dir are also discovered. Package convention (docs `v2/docs/build/plugins/cli`): `exports` with `".": "./src/index.ts"` (core) and `"./tui": "./src/tui.tsx"` (CLI), peers `@opentui/core`, `@opentui/solid`, `solid-js`.

Loading is per-`location`: a TUI plugin's `setup` gets `context.location` (the location the TUI is at; may be `undefined` until `context.data.location.default()` is read).

## A. The `/dcp` panel — v2 mechanism

**Mechanism: a CLI plugin contributes to the `session.panel` slot and opens it from a slash command.** This is a first-class, documented feature ("Session panels", docs `v2/docs/build/plugins/cli`): "The host owns sizing, focus, and full-screen presentation; the plugin owns its contents."

### A1. Registration code shape

```ts
// src/tui.ts — CLI plugin entrypoint (exported as "./tui")
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"

export default Plugin.define({
  id: "opencode-dcp",
  setup(context) {
    // 1. Contribute the panel content to the session.panel slot.
    //    panel.name is the selected content name; render only when it's ours.
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "opencode-dcp.panel"}>
          <DcpPanel panel={panel} />
        </Show>
      ),
    })

    // 2. Register the /dcp slash command (also palette + optional keybind).
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "dcp.panel",
        title: "Open DCP panel",
        group: "DCP",
        bind: "ctrl+d c",          // optional; omit or set false to disable binding
        palette: true,
        slash: { name: "dcp", aliases: ["dcp"] },   // prompt slash completion
        run: () => { context.ui.panel.open("opencode-dcp.panel") },
      }],
      bindings: ["dcp.panel"],
    }))

    // 3. Optional: status line in the footer while DCP is active.
    // context.ui.slot({ append: "home.footer.status", render: () => <text>DCP {…}</text> })

    const stop = context.data.on("session.usage.updated", (e) => { /* refresh stats */ })
    return () => { stop() }
  },
})
```

Opening API: `context.ui.panel.open(name, { presentation?: "panel" | "fullscreen" }) → boolean` (false when opened outside a session); `context.ui.panel.close()` (closes only this plugin's panel); `context.ui.panel.current()` → `{ name, sessionID } | undefined` (reactive).

### A2. What the panel component receives (`PanelInput`, `tui/context.d.ts`)

```ts
interface PanelInput {
  readonly name: string            // selected content name (set by ui.panel.open)
  readonly sessionID: string       // the current session
  readonly width: number           // host-computed width
  readonly presentation: "panel" | "fullscreen"
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}
```

The host keeps narrow terminals full-screen. Panel keyboard layers and input modes are active only while the panel owns input; a keymap layer can target the panel renderable (`context.keymap.layer(() => ({ target: () => panel, commands: [{ bind: "escape", run: ... }] }))`). In-panel components use `usePlugin()` to get the context (docs + `tui/solid.d.ts`).

### A3. Session state the panel code can read

`context.data` (`tui/context.d.ts`), all reactive (Solid stores) with `sync`/`invalidate`:

- `data.session.list()` / `get(sessionID)` → `SessionInfo` (id, `parentID?`, `agent?`, selected `model?` (ModelRef), `cost`, `tokens` {input, output, reasoning, cache.read/write}, `outcome?`, `time`, location, title, fork info).
- `data.session.status(sessionID)` → `"idle" | "running"`; `data.session.cost(sessionID)`; `data.session.root(id)`, `data.session.family(id)` (hierarchy — subagent detection, see D).
- `data.session.message.list(sessionID)` / `get(sessionID, messageID)` → `SessionMessageInfo[]`; assistant messages carry per-message `tokens?: TokenUsageInfo` and `content` (text/reasoning/tool parts) (`@opencode/client` generated types).
- `data.session.pending.list(sessionID)` (inbox), `data.session.permission.list(sessionID)`, `data.session.form.*`.
- `data.location.model.list(location)` → `ModelInfo[]` (each with `limit.context` — see C); `data.location.provider.list(location)`; `data.location.agent.list(location)` → `AgentInfo[]`.
- Current route: `context.ui.router.current()` → `{ type: "session", sessionID } | { type: "home" } | { type: "plugin", ... }`.
- Events: `context.data.on(type, handler)` / `data.listen(handler)`; relevant event types (generated `V2Event` union): `session.usage.updated` ({sessionID, cost, tokens}), `session.execution.started/succeeded/failed/interrupted`, `session.compaction.started/delta/ended/failed`, `session.step.started/ended`, `message...` (content updated), `model.updated`, `tui.toast.show`, etc.
- Full server API from the TUI: `context.client` (`OpenCodeClient`) — e.g. `client.session.command({ sessionID, command, arguments })` to trigger `/dcp-compress`-style actions from panel buttons.

**State that lives in the core plugin (pruning stats: tokens before/after, protected ranges, strategy toggles) must be bridged into the TUI via shared storage** — see B3/G1. `context.storage.store(key, { initial })` returns `[Store, mutator]` and is "persisted to disk, survives hot reloads and TUI restarts, and stays live-synced across running TUI instances"; `storage.memory(key, { initial })` is ephemeral but shared across hot-reload generations.

### A4. Commands: TUI slash vs core command

- TUI `KeymapCommand.slash` (above) is client-side: appears in prompt slash completion, runs `run(input?)` locally. Best for "open panel".
- Core `ctx.command.transform((editor) => editor.add({ name, description?, execute: async ({ sessionID, prompt, delivery }) => ... }))` registers a server-side command invoked via `ctx.session.command({ sessionID, command, arguments })` — the natural home for `/dcp-compress` (a server action that needs the pruning pipeline), or it can also be a TUI slash command calling `client.session.command`. Decide during T16; both shapes are grounded above.

## B. Prune notifications — v2 equivalents

v1 had `pruneNotification: off | minimal | detailed` + `pruneNotificationType: chat | toast`. v2 splits this into three orthogonal channels:

### B1. Toasts (TUI side) — `ui.toast.show`

```ts
context.ui.toast.show({
  title?: string,
  message: string,
  variant?: "info" | "success" | "warning" | "error",   // optional
  duration?: number,                                      // ms
})
```

`Toast`/`ToastOptions` in `tui/context.d.ts`; also documented in `v2/docs/build/plugins/cli` ("Dialogs and toasts"). There is a matching server event `tui.toast.show` in the `V2Event` union (data: `{ title?, message, variant, duration? }`), but the plugin-facing writer is `ui.toast.show` from the TUI context; the server event stream is subscribe-only for plugins (`EventDomain extends Pick<EventApi, "subscribe">`).

### B2. Chat messages (core side) — `session.synthetic`

```ts
await ctx.session.synthetic({ sessionID, text: "DCP pruned 12 messages (−41k tokens)", description?: "..." })
```

`SessionContext.synthetic(input: SessionSyntheticInput) → Promise<SessionInboxSynthetic>` (docs `v2/docs/build/plugins`, Sessions section; `SessionSyntheticInput { sessionID, id?, text, description?, delivery?: "steer" | "queue", resume? }`). This is the v1 "chat" notification: a user-visible synthetic message appended to the session transcript.

### B3. OS notifications / attention (TUI side) — `attention.notify` + `attention.*` config

```ts
const result = await context.attention.notify({
  title?: string,
  message: string,
  notification?: boolean | { when?: "always" | "focused" | "blurred" },
  sound?: boolean | { name?: "default" | "question" | "permission" | "error" | "done" | "subagent_done", volume?: number, when?: ... },
})
// → { ok, notification, sound, skipped?: "attention_disabled" | "empty_message" | "blurred" | "focused" | "focus_unknown" | "renderer_destroyed" }
```

`Attention` in `tui/context.d.ts`. User config (docs `v2/docs/cli/config`, "Alerts"): `cli.json` → `attention.notifications` (system notifications, normally when terminal unfocused), `attention.sound`, `attention.volume`, `attention.sound_pack`, `attention.sounds` overrides (including `subagent_done`). A built-in CLI plugin `opencode.notifications` ships with the TUI and can be disabled per `cli.json` (`plugins: ["-opencode.notifications"]`) — evidence that OS-level notification wiring is host-owned, and plugins hook in via `attention.notify`.

### B4. Mapping v1 config → v2

| v1 | v2 |
|---|---|
| `pruneNotification: off` | don't call anything |
| `minimal` + `toast` | `ui.toast.show({ message: short, variant: "info" })` |
| `detailed` + `toast` | `ui.toast.show({ title: "DCP", message: detailed, variant: "info", duration: 5000 })` |
| `*` + `chat` | `ctx.session.synthetic({ sessionID, text: detailed })` |
| (no v1 equivalent) | `attention.notify` for OS-level "DCP pruned while you were away" (optional, decision) |

**Bridge problem (G1):** toast/attention are TUI-only; `session.synthetic` is core-side. The pruning happens in the core plugin. So the port needs either (a) the TUI plugin subscribes to a shared durable storage key written by the core plugin and fires the toast itself, or (b) the core plugin writes the notification payload to `ctx.storage` and the TUI side renders it. See gap G1 — the storage-bridge key naming must be verified at implementation.

## C. Model context-window metadata

**Answer: `ModelInfo.limit.context`** (plus `limit.input?`, `limit.output`).

- Schema: `@opencode/schema` `Model.Info` — `limit: { context: Int, input?: Int, output: Int }` (`model.d.ts`).
- Generated client type `ModelInfo.limit: { context: number; input?: number; output: number }` (`@opencode/client` promise/generated/types.d.ts).
- Read paths:
  - Core plugin: `await ctx.model.list()` → `ModelInfo[]` (all active models, each with `limit.context`); `await ctx.model.default()` → `{ providerID, modelID }`; `await ctx.session.get({ sessionID })` → `SessionInfo` with the session's selected `model` (ModelRef { providerID, id, variant? }); `ctx.model.transform(editor => { editor.get(providerID, modelID); editor.update(providerID, modelID, m => { m.limit.context = ... }) })` — the docs themselves show a transform clamping `limit.context` (docs `v2/docs/build/plugins`, Models section), so **per-model max/min limit overrides can be expressed as a native model transform** (v2-native candidate for DCP's per-model limits — needs user sign-off per map decision 4).
  - TUI plugin: `context.data.location.model.list(location)` → `ModelInfo[]`; the active session's model from `data.session.get(sessionID)?.model`.
- Live token usage for %-relative limits:
  - Per session: `SessionInfo.tokens` (`TokenUsage.Info { input, output, reasoning, cache: { read, write } }`; the schema exports a `total(tokens)` helper) and event `session.usage.updated` `{ sessionID, cost, tokens }`.
  - Per assistant message: `SessionMessageAssistant.tokens?` — enough to reconstruct "tokens before/after pruning" for the panel.

So the v1 read of "model context limit" maps to: session's model ref → `model.list()` → `limit.context`. No separate catalog API is needed.

## D. Subagent sessions (map fog item)

v2 has a first-class subagent concept:

- `Agent.Info.mode: "subagent" | "primary" | "all"` (`@opencode/schema` agent.d.ts) — agents can be declared as subagent-mode; `ctx.agent.list()`/`transform` manages them. The `subagent_done` attention sound name corroborates subagent completion as a host event.
- `Session.Info` carries `parentID?: SessionID` and `agent?: Agent.ID` — child sessions record their parent; TUI `data.session.root(id)` / `family(id)` expose the hierarchy.

So a plugin can tell it is operating in a subagent session by checking `session.get({ sessionID }).parentID` (or the session's agent having `mode: "subagent"`). Whether *every* subagent session (e.g. spawned by the built-in task tool) is parented the same way should be verified against a live subagent run in the E2E prototype (P1) — flagged as G4.

## E. Local binary observations (`opencode2 --help`, 2.0.7)

No `cli` subcommand exists; the TUI is the default invocation. Relevant subcommands: `run` (headless message run), `mini` (minimal interactive interface, `cli.json` `mini.*` incl. `mini.footer` which "shows persistent activity, model, usage, and context details"), `session`, `plugin` (manage plugins), `models` (list models), `api` (make a request to the running server), `debug`, `service`, `acp`, `mcp`, `auth`, `stats`. Flags: `--standalone`, `--server`, `--continue/-c`, `--session/-s`, `--prompt`, `--auto`. Nothing here replaces the CLI-plugin panel mechanism; `opencode2 plugin add/list` is the install surface (map decision 6).

## F. GAP LIST — decision questions for the user

1. **G1 — Server→TUI notification bridge.** Core plugins cannot emit toasts or OS notifications directly; `event` subscription is one-way. The only first-party shared state is durable storage (`ctx.storage.set/get` core ↔ `context.storage.store` TUI, "live-synced across running TUI instances"). **Question:** is a storage-key bridge (e.g. `dcp:notify`, core writes last-prune payload + monotonically-increasing id, TUI plugin watches it and fires toast/attention) acceptable as the `pruneNotification` transport, or should "chat" (synthetic message) be the default channel with toast as TUI-side only? Also to verify at implementation: whether core-plugin storage keys are namespaced by plugin id and whether the TUI sees core-written keys unchanged.
2. **G2 — Panel state refresh path.** DCP stats (tokens before/after, protected ranges) are computed in the core plugin; the panel needs them reactively. Same storage bridge (G1) carries a `dcp:stats` document per session. **Question:** accept periodic/pull-on-open reads plus event-driven writes (on `session.usage.updated` / after each prune), i.e. stats freshness = "last prune event", or is live per-token streaming to the panel expected?
3. **G3 — `/dcp-compress` command home.** Core `command.transform` (server-side, invocable by name from anywhere including the panel via `client.session.command`) vs TUI `keymap.slash` (client-side). **Question:** register `/dcp-compress` as a core command (recommended: it needs the pipeline) with an optional TUI slash alias, or keep it TUI-only calling a server API?
4. **G4 — Subagent detection contract.** `SessionInfo.parentID` + `Agent.Info.mode === "subagent"` are the candidates. **Question:** treat a session as "subagent" when `parentID` is set, when its agent is mode `subagent`, or either? (Verify semantics in the P1 E2E run before T-allowSubAgents lands.)
5. **G5 — Per-model limits as native transform.** v2 supports clamping `limit.context` via `model.transform` (docs example). This would make DCP's per-model max/min limits host-visible (affects host nudge/compaction math, not just DCP's). **Question:** adopt the native transform for per-model limits (v2-native improvement, map decision 4 requires sign-off), or keep them DCP-internal?
6. **G6 — `off|minimal|detailed` × `chat|toast` matrix.** v2 has no single severity knob; the matrix maps cleanly (see B4), but "detailed" toast text has no length guidance in the docs and toast content can't be deep-linked to a message. **Question:** cap detailed-toast text (e.g. first line) and put full detail only in the chat (synthetic) variant?
7. **G7 — Notifications doc URL.** The ticket's primary source `https://opencode.ai/v2/docs/cli/notifications` is a 404; the notification surface is documented at `https://opencode.ai/v2/docs/cli/config` ("Alerts") and `https://opencode.ai/v2/docs/build/plugins/cli` (Attention/Toasts). No action needed; noted so the map doesn't keep a stale link.

## Sources

- Docs (fetched 2026-09-18): `https://opencode.ai/v2/docs/build/plugins/cli` (CLI plugins — context, client, events, sessions, attention, keymaps/slash, storage, dialogs/toasts, routes/tabs, slots, session panels, publish/load); `https://opencode.ai/v2/docs/build/plugins` (core plugin context, lifecycle, transforms, Models/Models-transform `limit.context` example, Sessions incl. `synthetic`, Commands, Storage); `https://opencode.ai/v2/docs/cli/config` (cli.json: Alerts/`attention.*`, Plugins, keybinds, mini, debug); `https://opencode.ai/v2/docs/cli/plugins` (cli.json CLI-only plugins, `opencode.notifications` disable, discovery paths).
- npm `@opencode/plugin@2.0.7`: `dist/promise/plugin.d.ts` (core Context), `dist/tui/{plugin,context,solid,index}.d.ts` (TUI Context, PanelInput, SlotMap/SlotClaim, Keymap/KeymapCommand, Toast, Attention, Dialog, Storage, Route), `dist/promise/{model,provider,session,event,registration}.d.ts` (domains, SessionHooks, hooks), `dist/host.d.ts` (EntryPoints server/tui/rpc).
- npm `@opencode/client@2.0.7`: `promise/api.d.ts` (domain = client group), `promise/generated/client.d.ts` (`model.list/default`, `event.subscribe`, `session.synthetic`, `rpc.call`), `promise/generated/types.d.ts` (`ModelInfo.limit`, `SessionMessageAssistant.tokens`, `SessionUsageUpdated`, `TuiToastShow`, `SessionSyntheticInput`, `V2Event` union).
- npm `@opencode/schema@2.0.7`: `model.d.ts` (`Model.Info.limit`), `session.d.ts` (`Session.Info`: parentID, agent, model, cost, tokens, outcome), `agent.d.ts` (`Agent.Info.mode`), `token-usage.d.ts` (`TokenUsage.Info` + `total()`).
- Local `opencode2` 2.0.7 `--help` (read-only, 2026-09-18).
- GitHub issues: kido5217/opencode2-dcp#2 (map, v1 feature list + fog items), #4 (this ticket).
