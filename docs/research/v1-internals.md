# v1 DCP Internals Inventory

Research for ticket #5 (port the DCP plugin from opencode v1 to v2). This document is a
code-level inventory of the **v1** DCP plugin so the v2 port can be planned.

- **Source:** `Opencode-DCP/opencode-dynamic-context-pruning`
- **Pinned SHA:** `11f6517780a502512a3467645074be447cb0369e` (npm `@tarquinen/opencode-dcp` **v3.1.15**)
- **Language/build:** TypeScript (ESM), `tsup` bundle + `tsc --emitDeclarationOnly`; runtime deps: `@opencode-ai/sdk`, `@opentui/core` + `@opentui/solid` (Solid TUI), `@anthropic-ai/tokenizer`, `jsonc-parser`.
- **Peer dep:** `@opencode-ai/plugin >= 1.4.3`.
- **License:** AGPL-3.0-or-later.
- **Package exports:** `.` / `./server` → `dist/index.js` (plugin), `./tui` → `tui.tsx` (TUI entry).

> Porting note: every v1 API touchpoint listed in §3 is the **left column** of the v1→v2 port
> map. The exact v2 replacement is a **separate research ticket** (v2 core/surface API); where a
> v2 guess is given it is explicitly labeled a *guess*.

---

## 1. Module inventory

### Entry points
| File | Lines | Purpose |
|---|---|---|
| `index.ts` | 137 | Plugin entry. Async `Plugin` factory: loads config, builds `Logger`/`SessionState`/`PromptStore`/host-permission snapshot, kicks off autoUpdate, and returns the object of v1 hooks + the `compress` tool + the `config` mutator. Returns `{}` early when `!config.enabled`. |
| `tui.tsx` | 26 | TUI entry (Solid/`@opentui`). Exports the DCP TUI surface (modals/dialogs) rendered into the opencode TUI. |

### Root `lib/`
| File | Lines | Purpose |
|---|---|---|
| `config.ts` | 1007 | Config schema (TS interfaces), defaults, `VALID_CONFIG_KEYS`, type validation (`validateConfigTypes`, `getInvalidConfigKeys`), 3-layer file lookup + merge (`getConfig`), warning toasts. See §5. |
| `hooks.ts` | 383 | The **5 v1 hook handler factories** (system transform, chat-messages transform, text.complete, command.execute.before, event) + internal-agent detection. See §2/§3. |
| `update.ts` | 185 | autoUpdate subsystem (npm-registry version check, wrapper-dir removal, toast). See §7. |
| `auth.ts` | 37 | `isSecureMode()`, `configureClientAuth(client)` — injects auth into the SDK client when secure mode is detected. |
| `logger.ts` | 226 | `Logger` class: `debug/info/warn/error` (gated by `config.debug`), context dump `saveContext(sessionId, messages)`. |
| `message-ids.ts` | 172 | Message-id aliasing: `assignMessageRefs`, `injectMessageIds` (injects a `<dcp-message-id>` marker into every tool output of assistant messages; marks protected user text as blocked in message mode), id-alias reset after native compaction. |
| `token-utils.ts` | 164 | Token accounting: `getCurrentTokenUsage`, `getCurrentParams`, `isContextOverLimits`, tool-call input counting (uses `@anthropic-ai/tokenizer`). |
| `protected-patterns.ts` | 132 | `matchesGlob`, `isFilePathProtected`, `isToolNameProtected` (Windows separator normalization, multiedit/apply_patch path handling). |
| `host-permissions.ts` | 101 | `HostPermissionSnapshot` (global + per-agent), `compressDisabledByOpencode(opencodeConfig.permission)`, `hasExplicitToolPermission`. |
| `compress-permission.ts` | 25 | `compressPermission(state, config)`, `syncCompressPermissionState(...)` — resolves the effective compress permission (wildcard deny/allow, per-agent overrides). |

### `lib/state/` — session state model
| File | Lines | Purpose |
|---|---|---|
| `types.ts` | 111 | Core types: `SessionState`, `CompressionBlock`, `Prune`/`PruneMessagesState`, `WithParts`, `MessageIdState`, `Nudges`, `ToolParameterEntry`, `SessionStats`. |
| `state.ts` | 208 | `createSessionState`, `checkSession` (init/refresh, reset id aliases after native compaction), `syncToolCache`, `refreshManualMode`. |
| `persistence.ts` | 305 | `saveSessionState`, load/persist state across requests, `ensureSessionInitialized`. |
| `utils.ts` | 345 | Helpers incl. `isMessageCompacted`. |
| `tool-cache.ts` | 98 | Tool-parameter caching. |
| `index.ts` | 4 | Barrel. |

Key `SessionState` fields: `sessionId`, `isSubAgent`, `manualMode` (`false | "active" | "compress-pending"`), `compressPermission`, `pendingManualTrigger`, `prune` (`tools: Map<callId,turn>`, `messages: { byMessageId, blocksById, activeBlockIds, activeByAnchorMessageId, nextBlockId, nextRunId }`), `nudges`, `stats`, `compressionTiming`, `toolParameters`, `subAgentResultCache`, `toolIdList`, `messageIds`, `lastCompaction`, `currentTurn`, `modelContextLimit`, `systemPromptTokens`.

### `lib/messages/` — the per-request transform pipeline
| File | Lines | Purpose |
|---|---|---|
| `prune.ts` | 233 | `prune()` = `filterCompressedRanges` + `pruneToolOutputs` + `pruneToolInputs` + `pruneToolErrors`. `filterCompressedRanges` injects compress summaries (as synthetic user messages at anchor) and drops pruned messages; the other three replace tool output/input/error with short placeholders. |
| `priority.ts` | 102 | `buildPriorityMap` (which messages are high-priority for nudge guidance). |
| `sync.ts` | 124 | `syncCompressionBlocks`, `syncToolCache` (rebuild in-memory block/ids state from session). |
| `query.ts` | 72 | `getLastUserMessage`, `isIgnoredUserMessage`. |
| `utils.ts` | 192 | `createSyntheticUserMessage`, `replaceBlockIdsWithBlocked`. |
| `shape.ts` | 50 | `filterMessages`, `filterMessagesInPlace` (drop messages with unexpected shape). |
| `reasoning-strip.ts` | 40 | Strip reasoning parts. |
| `index.ts` | 8 | Barrel re-exporting the pipeline fns. |
| `inject/inject.ts` | 215 | `injectCompressNudges` (context-limit / turn / iteration nudges appended to text parts). |
| `inject/subagent-results.ts` | 82 | `injectExtendedSubAgentResults`. |
| `inject/utils.ts` | 374 | `stripHallucinations`, `stripHallucinationsFromString`, `stripStaleMetadata`, `buildToolIdList` — remove model-hallucinated `<dcp-…>` XML tags (orphan/paired/nested, colon/underscore variants). |

### `lib/compress/` — the compress tool (two modes)
| File | Lines | Purpose |
|---|---|---|
| `index.ts` | 3 | `createCompressMessageTool`, `createCompressRangeTool` (selected by `config.compress.mode`). |
| `pipeline.ts` | 116 | `prepareSession` (manual-mode guard, `ask` permission, fetch session messages, dedup, purgeErrors, build search context) and `finalizeSession` (clear pending manual, apply durations, save state, send notification). |
| `search.ts` | 267 | `fetchSessionMessages`, `buildSearchContext`. |
| `range.ts` / `range-utils.ts` | 192 / 308 | Range-mode compression (batch ranges, overlap validation, placeholder validation, block summary append). |
| `message.ts` / `message-utils.ts` | 145 / 250 | Message-mode compression (batch individual messages, protected-prompt info, call-id capture). |
| `state.ts` | 268 | Compression block/run bookkeeping. |
| `protected-content.ts` | 208 | Protected prompt/tag/user-message handling. |
| `timing.ts` | 77 | `buildCompressionTimingKey`, `consumeCompressionStart`, `resolveCompressionDuration`, `applyPendingCompressionDurations` (attach durations to blocks via the event hook). |
| `types.ts` | 108 | `ToolContext`, `SearchContext`, etc. |

### `lib/commands/` — `/dcp` and `/dcp-compress` subcommands
Dispatched from `command.execute.before` (§3). | File | Lines | Purpose |
|---|---|---|
| `index.ts` | 11 | Barrel. |
| `context.ts` | 305 | `/dcp context` — context/usage report. |
| `stats.ts` | 159 | `/dcp stats`. |
| `sweep.ts` | 268 | `/dcp sweep` (bulk operations; takes `workingDirectory`). |
| `manual.ts` | 127 | `/dcp manual [on/off]`, and `handleManualTriggerCommand` (the manual compress trigger path; returns the prompt or null when blocked). |
| `compress` (via `manual.ts`) | — | `/dcp compress [focus]` → sets `manualMode="compress-pending"`, sets `pendingManualTrigger`, rewrites the command text to `/dcp-compress`. |
| `decompress.ts` | 275 | `/dcp decompress`. |
| `recompress.ts` | 224 | `/dcp recompress`. |
| `help.ts` | 76 | `/dcp` (no subcommand) help. |
| `compression-targets.ts` | 137 | Active/inactive compression target accounting. |

### `lib/prompts/` — prompt store (see §6)
`index.ts` (`renderSystemPrompt`), `store.ts` (`PromptStore`), `system.ts`, `compress-range.ts`, `compress-message.ts`, `context-limit-nudge.ts`, `turn-nudge.ts`, `iteration-nudge.ts`, `extensions/{system,tool,nudge}.ts`.

### `lib/tui/` + `lib/ui/` + `lib/subagents/`
| File | Lines | Purpose |
|---|---|---|
| `tui/ui.tsx`, `dialogs.tsx`, `modals.tsx`, `commands.ts`, `data.ts`, `format.ts`, `types.ts` | 219/235/92/31/73/25/16 | Solid TUI components/modals for DCP state display. |
| `ui/notification.ts` | 347 | `sendCompressNotification` + prune notifications (chat vs toast, minimal/detailed). |
| `ui/utils.ts` | 304 | `cacheSystemPromptTokens` and other UI/token helpers. |
| `subagents/subagent-results.ts` | 74 | Subagent result capture. |

### Tests, scripts, config artifacts
- `tests/*.test.ts` — **17** test files (node built-in test runner via tsx). See §8.
- `scripts/` — helper CLIs: `opencode_api.py`, `opencode-dcp-stats`, `opencode-find-session`, `opencode-get-message`, `opencode-message-token-counts`, `opencode-session-timeline`, `opencode-token-stats`, `print.ts`, `verify-package.mjs`.
- `dcp.schema.json` — JSON Schema for the DCP config (referenced by the auto-created `dcp.jsonc` `$schema`).
- `tsconfig.json`, `tsup.config.ts`, `.github/workflows/{pr-checks,publish}.yml`.

---

## 2. Core data flow

DCP **never mutates persisted session history**. It transforms the *outgoing* message array on
each request and injects summaries, so the model sees a pruned context while the session on disk
is untouched.

**Request flow (per turn):**

1. **Init** (`index.ts`): `getConfig` → build `Logger`, `createSessionState()`, `new PromptStore(...)`, host-permission snapshot; `startAutoUpdate` once.
2. **`config` hook** (once, on opencode config load): if compress is enabled, registers the
   `/dcp-compress` command, appends `compress` to `experimental.primary_tools` (unless subagents
   allowed), ensures a `compress` permission entry, and snapshots global + per-agent permissions
   into `hostPermissions`.
3. **`experimental.chat.system.transform`** (`createSystemPromptHandler`): cache the model context
   limit; skip subagents (unless `experimental.allowSubAgents`) and internal agents (title-gen /
   summarizer signatures); if effective permission is `deny`, skip; else `renderSystemPrompt` the
   DCP system prompt (+ protected-tools extension, + manual/subagent extensions) and append to the
   last system prompt.
4. **`experimental.chat.messages.transform`** (`createChatMessageTransformHandler`) — the heart:
   `filterMessagesInPlace` → `checkSession` → `syncCompressPermissionState` → (subagent guard) →
   `stripHallucinations` → `cacheSystemPromptTokens` → `assignMessageRefs` → `syncCompressionBlocks`
   → `syncToolCache` → `buildToolIdList` → **`prune`** → `injectExtendedSubAgentResults` →
   `buildPriorityMap` → `injectCompressNudges` → `injectMessageIds` → `applyPendingManualTrigger` →
   `stripStaleMetadata` → `logger.saveContext`.
   - `prune` = `filterCompressedRanges` (inject stored summaries as synthetic user messages at
     anchor, drop pruned messages) + `pruneToolOutputs/Inputs/Errors` (replace with placeholders).
   - `injectMessageIds` stamps `<dcp-message-id>` markers into tool outputs so later `compress`
     calls can reference exact messages.
5. **`command.execute.before`** (`createCommandExecuteHandler`): intercept `/dcp` and
   `/dcp-compress`, dispatch to the command handlers (§1).
6. **`experimental.text.complete`** (`createTextCompleteHandler`): `stripHallucinationsFromString`
   on streamed assistant text.
7. **`event`** (`createEventHandler`): on `message.part.updated` for the `compress` tool, record
   start/duration (keyed by `messageID`+`callID`) and attach durations to compression blocks.

**Compress tool execution** (range or message mode), once the model calls the `compress` tool:
`prepareSession` (manual-mode guard; `ask({permission:"compress", patterns:["*"]})`; fetch session
messages; `deduplicate`; `purgeErrors`; `buildSearchContext`) → model produces the summary →
`finalizeSession` (clear pending manual mode, apply durations, `saveSessionState`, send
notification).

**Strategies** (run inside `prepareSession`): `deduplication` (collapse duplicate tool outputs,
respect `protectedTools`) and `purgeErrors` (purge old errored tool calls after N turns).

---

## 3. v1 plugin API touchpoints (PORT MAP — left column)

These are the exact extension points the v1 plugin registers/uses. This is the primary input to the
v1→v2 port map.

### Registered hooks (returned by the `Plugin` factory in `index.ts`)
| v1 hook key | Handler factory (`hooks.ts`) | What it does |
|---|---|---|
| `experimental.chat.system.transform` | `createSystemPromptHandler` | Inject the DCP system prompt + extensions into `output.system[]`. |
| `experimental.chat.messages.transform` | `createChatMessageTransformHandler` | The full per-request prune/inject pipeline on `output.messages[]`. |
| `experimental.text.complete` | `createTextCompleteHandler` | Strip hallucinated tags from `output.text`. |
| `command.execute.before` | `createCommandExecuteHandler` | Intercept `/dcp` & `/dcp-compress`, dispatch subcommands. |
| `event` | `createEventHandler` | Track `compress` tool timing on `message.part.updated`. |
| `tool` (map) | `createCompressMessageTool` / `createCompressRangeTool` | Register the `compress` tool (mode chosen by `config.compress.mode`). |
| `config` | inline in `index.ts` | Mutate opencode config (command, primary_tools, permission) + snapshot permissions. |

> All hook keys use opencode's `experimental.*` namespace plus the stable `command.execute.before`,
> `event`, `tool`, and `config` extension points. **v2 equivalents: pending v2-core-api research**
> (guess: v2 likely keeps `event`/`tool`/`config` but renames the `experimental.chat.*` transforms
> — *guess only*).

### SDK / client usage (`ctx.client`, `@opencode-ai/sdk`)
- `ctx.client.session.messages({ path: { id } })` — fetch session messages (commands + compress tool).
- `ctx.client.tui.showToast({ body: { title, message, variant, duration } })` — TUI toasts (config
  warnings, autoUpdate, compress notifications).
- `ctx.directory` — working directory (config lookup, PromptStore).
- `toolCtx.ask({ permission, patterns, always, metadata })` and `toolCtx.metadata({ title })` — the
  tool-execution context passed to the compress tool (permission prompt + metadata).
- `configureClientAuth(ctx.client)` (secure mode).

### Permission model
- `config.compress.permission` ∈ `{ ask, allow, deny }`; default `allow`.
- `host-permissions.ts` resolves wildcard deny/allow and per-agent overrides
  (`hasExplicitToolPermission`, `compressDisabledByOpencode`).
- The `config` hook also *writes* a `compress` permission into opencode's config if none is explicit.

---

## 4. Configuration reference

### File lookup & merge order (lowest → highest precedence)
1. **Global:** `$XDG_CONFIG_HOME/opencode/dcp.jsonc` (fallback `dcp.json`); else `$HOME/.config/opencode/dcp.jsonc`.
2. **Config dir:** `$OPENCODE_CONFIG_DIR/dcp.jsonc` (fallback `dcp.json`).
3. **Project:** `<project>/.opencode/dcp.jsonc` (fallback `dcp.json`) — found by walking up from `ctx.directory` to the nearest `.opencode/` dir.

- Parsed with `jsonc-parser` (trailing commas allowed). If no global file exists, a stub `dcp.jsonc`
  with only the `$schema` URL is auto-created. Later layers override earlier ones (per-key merge;
  `protectedTools`/`protectedFilePatterns` arrays are **unioned**, not replaced). Unknown keys and
  type errors produce a delayed TUI warning toast.

### Defaults (`defaultConfig`)
| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch; `{}` plugin if false. |
| `autoUpdate` | `true` | See §7. |
| `debug` | `false` | Enables `Logger` debug + context dumps. |
| `pruneNotification` | `"detailed"` | `off` \| `minimal` \| `detailed`. |
| `pruneNotificationType` | `"chat"` | `chat` \| `toast`. |
| `commands.enabled` | `true` | Enables `/dcp*` subcommands. |
| `commands.protectedTools` | `[task, skill, todowrite, todoread, compress, batch, plan_enter, plan_exit, write, edit]` | `DEFAULT_PROTECTED_TOOLS`. |
| `manualMode.enabled` | `false` | Manual compress mode. |
| `manualMode.automaticStrategies` | `true` | Run dedup/purge even in manual mode. |
| `turnProtection.enabled` | `false` | |
| `turnProtection.turns` | `4` | |
| `experimental.allowSubAgents` | `false` | Inject into subagent sessions too. |
| `experimental.customPrompts` | `false` | Enable prompt overrides/managed defaults. |
| `protectedFilePatterns` | `[]` | |
| `compress.mode` | `"range"` | `range` \| `message`. |
| `compress.permission` | `"allow"` | `ask` \| `allow` \| `deny`. |
| `compress.showCompression` | `false` | |
| `compress.summaryBuffer` | `true` | Extend max threshold by active summary tokens. |
| `compress.maxContextLimit` | `100000` | number or `"N%"`. |
| `compress.minContextLimit` | `50000` | number or `"N%"`. |
| `compress.modelMaxLimits` / `modelMinLimits` | *(unset)* | `Record<modelID, number\|"%">` overrides. |
| `compress.nudgeFrequency` | `5` | |
| `compress.iterationNudgeThreshold` | `15` | |
| `compress.nudgeForce` | `"soft"` | `strong` \| `soft`. |
| `compress.protectedTools` | `[task, skill, todowrite, todoread]` | `COMPRESS_DEFAULT_PROTECTED_TOOLS`. |
| `compress.protectTags` | `false` | |
| `compress.protectUserMessages` | `false` | |
| `strategies.deduplication.enabled` | `true` | |
| `strategies.deduplication.protectedTools` | `[]` | |
| `strategies.purgeErrors.enabled` | `true` | |
| `strategies.purgeErrors.turns` | `4` | |
| `strategies.purgeErrors.protectedTools` | `[]` | |

Valid keys are enumerated in `VALID_CONFIG_KEYS` (incl. dotted paths); `getInvalidConfigKeys` /
`validateConfigTypes` drive the warning toasts.

---

## 5. Prompt management

Six overridable prompts (keys), each a `.md` file, bundled in-source and overridable on disk:

| Key | File | Purpose |
|---|---|---|
| `system` | `system.md` | Core DCP system instruction block; injected into the system prompt every request. |
| `compress-range` | `compress-range.md` | Range-mode compress tool instructions. |
| `compress-message` | `compress-message.md` | Message-mode compress tool instructions. |
| `context-limit-nudge` | `context-limit-nudge.md` | Nudge when context > max threshold. |
| `turn-nudge` | `turn-nudge.md` | Nudge to compress closed ranges at a turn boundary (between min/max). |
| `iteration-nudge` | `iteration-nudge.md` | Nudge after many iterations without user input. |

Plus non-file internal extensions: `MANUAL_MODE_SYSTEM_EXTENSION`, `SUBAGENT_SYSTEM_EXTENSION`
(`extensions/system.ts`), `RANGE_FORMAT_EXTENSION` / `MESSAGE_FORMAT_EXTENSION`
(`extensions/tool.ts`), and nudge guidance builders (`extensions/nudge.ts`).

**`PromptStore`** (`store.ts`):
- Bundled defaults live in `BUNDLED_EDITABLE_PROMPTS` (source-of-truth, from the prompt `.ts` files).
- When `experimental.customPrompts` is on, `ensureDefaultFiles()` writes the managed defaults + a
  `README.md` into a defaults dir.
- **Override precedence (highest first):**
  1. `<project>/.opencode/dcp-prompts/overrides/`
  2. `$OPENCODE_CONFIG_DIR/dcp-prompts/overrides/`
  3. `~/.config/opencode/dcp-prompts/overrides/`
- `reload()` re-resolves each prompt: override candidate → normalize → wrap; else fall back to bundled.
- Normalization pipeline: `stripPromptComments` (HTML `<!-- -->` + legacy `//…//` lines),
  `normalizeReminderPromptContent` (D `CP system-reminder` tag handling), `toEditablePromptText`,
  `wrapRuntimePromptContent` (`stripConditionalTag`, `unwrapDcpTagIfWrapped`).
- `renderSystemPrompt(prompts, protectedToolsExtension, manual, subagent)` joins the system prompt +
  extensions with blank lines.

> Note: the bundled prompt text (and the `DCP_SYSTEM_REMINDER_TAG_REGEX`) embeds `<dcp-…>` marker
> tags; these are the same tags the hallucination-stripping utilities remove.

---

## 6. autoUpdate subsystem (`update.ts`)

- Package name tracked: `@tarquinen/opencode-dcp`.
- `startAutoUpdate(ctx, enabled)` (called at init): no-op if disabled; 10s `AbortController`
  timeout; runs `checkAutoUpdate`; on success schedules a TUI toast after 5s
  (“Updated … from … to …. Restart OpenCode to finish.”).
- `checkAutoUpdate(signal)`:
  1. `findPackageDir` (walk up from the module to the `node_modules` package dir).
  2. Read its `package.json` (name + version).
  3. `fetchLatestVersion` from `https://registry.npmjs.org/<name>/latest`.
  4. If `isVersionNewer(latest, current)`, `updateRemoveDir` → `rm -rf` the **opencode npm wrapper**
     dir (only when the install spec is auto-updatable).
- `isAutoUpdatableSpec(spec)`: allows `latest`, `*`, `~x`, `^x`, `>=/>/<=/<` ranges and compound
  specs; **rejects pinned versions** (so version-locked installs are never auto-removed).
- `isVersionNewer` / `parseVersion`: semver compare incl. prerelease ordering.

---

## 7. Test suite

- **Runner:** `node --import tsx --test tests/*.test.ts` (Node built-in test runner + tsx).
- **Result at port SHA:** all pass (103 runner tests: 100 top-level `test()` + 3 subtests in
  `prompts.test.ts`).
- **17 test files** (`tests/`): `compress-message`, `compress-range`, `compress-range-placeholders`,
  `compression-groups`, `compression-targets`, `finalize-session`, `hooks-permission`,
  `host-permissions`, `message-ids`, `message-priority`, `message-utils`, `prompts`,
  `protected-patterns`, `token-counting`, `token-usage`, `update`, plus `test-dcp-cache.sh` (bash).

Coverage themes: message/range-mode compress behavior & batching; protected user messages/tags;
notification increments per tool call; decompress grouping; `finalizeSession` manual-mode restore;
system-prompt handler (context-limit caching, internal-agent skip); chat-transform (hallucination
stripping, malformed-message safety); command-execute permission resolution; event-hook duration
attachment; manual-mode persistence; wildcard deny/allow permission resolution (incl.
`Array.findLast`/`Object.hasOwn` fallbacks); `checkSession` id-alias reset; `injectMessageIds`
(marker injection, blocked marking, subagent skip); priority/nudge injection; hallucination
stripping (all `dcp-` tag variants, orphans, nesting); `matchesGlob`/`isFilePathProtected` Windows
handling; token counting (built-in tool inputs, compacted placeholders, post-compaction usage,
context-limit thresholds); `isVersionNewer`/`isAutoUpdatableSpec`/`updateRemoveDir` autoUpdate logic.

---

## 8. Build & packaging

- `main`/`exports`: `dist/index.js` (bundled by `tsup`) for `.` and `./server`; `tui.tsx` for `./tui`.
- `build`: `tsup` + `tsc --emitDeclarationOnly`. `prepublishOnly` runs `check:package`
  (`build` + `scripts/verify-package.mjs`).
- `files` shipped: `dist/`, `lib/`, `tui.tsx`, `README.md`, `LICENSE`.
- CI: `.github/workflows/pr-checks.yml`, `publish.yml`.
- `overrides`: pins `@babel/core@7.29.7`, `esbuild@0.28.1`.
