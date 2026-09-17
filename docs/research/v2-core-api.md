# Research: v2 Core Plugin API (`@opencode/plugin@2.0.7`)

**Ticket:** [#3](https://github.com/kido5217/opencode2-dcp/issues/3) — How do v2 plugins register tools/commands, transform session context, and subscribe to events?

**Method.** Everything below is grounded in primary sources read in this session, not memory:

1. `@opencode/plugin@2.0.7` npm tarball (`npm pack`) — the canonical published `.d.ts` files (`dist/promise/*`, `dist/effect/*`).
2. Dependency tarballs: `@opencode/schema@2.0.7` (tool/session/prompt/model/location schemas), `@opencode/ai@2.0.7` (model-request `Message`/`SystemPart`), `@opencode/client@2.0.7` (public `V2Event` catalog).
3. Official docs: `opencode.ai/v2/docs/build/plugins` and `.../plugins/migrate-v1` (scraped 2026-09-17/18).
4. Local `opencode2` 2.0.7 binary (bun-compiled ELF) — minified core runtime, used to confirm tool-error semantics and event publication.
5. `opencode2 --help` (2.0.7).

Confidence tags: **[T]** = from published `.d.ts`; **[D]** = from official docs; **[C]** = from compiled core (minified — strong but indirect); **[I]** = inference, needs empirical check.

---

## 1. Plugin loading & registration

**Entry shape [T]:**

```ts
import { Plugin } from "@opencode/plugin"   // main export = dist/promise/index.js (ESM)

export default Plugin.define({
  id: "dcp",
  setup: (ctx: Context) => Promise<Cleanup | void> | Cleanup | void,
})
```

```ts
// dist/promise/plugin.d.ts
export type Cleanup = () => Promise<void> | void
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export declare function define(plugin: Plugin): Plugin
```

- `define()` is the identity entrypoint helper (the promise variant wraps the plugin in the Effect runtime via `fromPromise` in `dist/promise/adapter.js`). **[T]**
- An **Effect** variant exists: `@opencode/plugin/effect` → `Plugin { id, effect: (ctx) => Effect.Effect<void, never, R> }`; no cleanup return — cleanup is scope-based (acquire/release on the plugin scope). **[T]**
- **Lifecycle [D]:** `setup` runs when the plugin loads; the returned cleanup runs when the plugin unloads. Hook/transform registrations are scoped to the plugin and are disposed automatically on unload ("Hook and transform registrations are scoped to the plugin and are cleaned up automatically").
- **Discovery [D]:** plugins under `.opencode/plugins/` (and `.opencode/plugin/`) load automatically. Packages or other locations load via the `plugins` array in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    "opencode-dcp-plugin",            // npm package
    "opencode-dcp-plugin@1.2.0",      // pinned
    "./plugins/local",                // relative/absolute/file:// paths
    {
      "package": "./plugins/dcp",
      "options": { "threshold": 0.75 }   // object form → ctx.options
    }
  ]
}
```

- **Options [D][T]:** only the object form carries options; read during setup from `ctx.options: Readonly<Record<string, any>>` (`dist/options.d.ts`).
- **`id` scoping [D]:** "Every V2 plugin needs a stable `id`. Plugin storage is scoped by this ID, and the ID also identifies the plugin in status and diagnostics."
- **Dual V1/V2 package [D]:** default-export an object spreading `Plugin.define(...)` plus a V1 `server()` function; V2 reads `id` + `setup()` and ignores `server()`. Supported by V1 ≥ 1.18.29.

**`ctx` surface [T] (`dist/promise/plugin.d.ts`):**

```ts
interface Context {
  readonly app: App                                  // { name, version, channel }
  readonly location: Location.Info                   // { directory, workspaceID?, project: { id, directory, canonical } }
  readonly options: PluginOptions                    // Readonly<Record<string, any>>
  readonly agent: AgentDomain                        // get/list/transform/reload
  readonly aisdk: AISDKDomain                        // hook(...)
  readonly command: CommandDomain                    // list/transform/reload
  readonly event: EventDomain                        // subscribe
  readonly experimental: { terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read"> }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain                            // list/transform/reload
  readonly model: ModelDomain                        // list/default/transform/reload
  readonly generate: GenerateApi                     // text(...)
  readonly permission: PermissionDomain              // hook/list/get/reply
  readonly plugin: Pick<PluginApi, "list">           // list loaded plugins
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain                    // client methods + hook
  readonly shell: ShellDomain                        // hook
  readonly skill: SkillDomain
  readonly storage: StorageDomain                    // get/set/remove/scan
  readonly tool: ToolDomain                          // transform/reload/hook
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}
```

- `ctx` "is essentially an OpenCode server client" — read/action methods mirror the client API. **[D]**
- `ctx.location` is **the plugin instance's load location, not the location of every session or event** the plugin can see. **[D]**
- `ctx.plugin.list({ location? })` → `{ location, data: PluginInfo[] }` where `PluginInfo = { id?, source: builtin|package{target,version?,outdated?}|local{path}|sdk, features?, state: {status:"active"}|{status:"failed",error} }`. **[T]** (useful for DCP self-detection / diagnostics)

---

## 2. `ctx.session.hook(...)` — session hooks

```ts
// dist/promise/registration.d.ts
export interface Registration { readonly dispose: () => Promise<void> }
export interface ModelHookOptions { readonly providerID?: string }
export type ModelHooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
  options?: Spec[Name] extends { readonly model: unknown } ? ModelHookOptions : never,
) => Promise<Registration>
```

```ts
// dist/promise/session.d.ts
export type SessionRequestKind = "primary" | "compaction" | "title" | "generate"
export type SessionDomain = Pick<SessionApi, "create"|"get"|"switchAgent"|"switchModel"|"prompt"|"generate"|"command"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context">
  & { readonly hook: ModelHooks<SessionHooks> }
```

Hook set:

```ts
export interface SessionHooks {
  prompt: SessionPrompt
  context: SessionContext
  compaction: SessionCompaction
  generate: SessionGenerate
  title: SessionTitle
  "model.request": SessionModelRequest
  "http.request": SessionHttpRequest
  "http.response": SessionHttpResponse
  "experimental.ws.handshake": SessionWebSocketHandshake
  "experimental.ws.send": SessionWebSocketSend
  "experimental.ws.receive": SessionWebSocketReceive
  retry: SessionRetry
}
```

### Payloads (exact, from `dist/promise/session.d.ts` + `@opencode/ai` + `@opencode/schema`)

```ts
// Base for context/compaction/generate/title
export interface SessionRequest {
  readonly sessionID: Session.ID            // branded string, readonly
  readonly model: Model.Ref                 // { id, providerID, variant? }, readonly
  system: Array<SystemPart>                 // MUTABLE (not readonly)
  messages: Array<Message>                  // MUTABLE (not readonly)
  options: SessionRequestOptions            // MUTABLE: typed gen-keys + provider opts
}

// @opencode/ai (schema/messages.d.ts)
type SystemPart = { type: "text", text: string, cache?: CacheHint, metadata?: Record<string, unknown> }

type Message = {
  id?: string,
  role: "system" | "user" | "assistant" | "tool",
  content: ContentPart[]                    // tagged union, see below
}

type ContentPart =
  | { type: "text",      text: string, cache?, metadata?, providerMetadata? }
  | { type: "media",     mediaType: string, data: string | Uint8Array, filename?, ... }
  | { type: "tool-call", id: string, name: string, namespace?, input: unknown, providerExecuted?, ... }
  | { type: "tool-result", id: string, name: string, namespace?, result: ToolResultValue, providerExecuted?, ... }
  | { type: "reasoning", text: string, encrypted?, ... }
  | { type: "compaction", provider: ProviderID, id?, encrypted?, text: string | null | undefined }  // null = keep prior history
  | { type: "effort",     effort?, previous? }

// ToolResultValue: { type: "json"|"text"|"error", value: unknown } | { type: "content", value: Tool.Content[] }
// Tool.Content = { type:"text", text } | { type:"file", uri, mime, name? }

// SessionRequestOptions
type GenerationOptionsFields = { maxTokens?, temperature?, topP?, topK?, frequencyPenalty?, presencePenalty?, seed?, stop?: string[] }
type SessionRequestOptions = DeepMutable<GenerationOptionsFields> & Record<string, unknown>  // other keys = provider options

// context hook (the one DCP prunes)
export interface SessionContext extends SessionRequest {
  readonly agent: Agent.ID
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>   // MUTABLE (delete to hide a tool)
}

// compaction: SessionContext + optional shortcut
export interface SessionCompaction extends SessionContext {
  /** Set to use this compaction and skip the model request. */
  result?: { summary: string, providerState?, metadata?, tokens? }
}

// generate: same shape as SessionContext
export interface SessionGenerate extends SessionContext {}

// title: no agent, no tools
export interface SessionTitle extends SessionRequest {
  /** Set to use this title and skip the model request. */
  result?: string
}

// prompt admission (mutable draft)
export interface SessionPrompt {
  readonly sessionID: Session.ID
  readonly messageID: SessionMessage.ID
  prompt: DeepMutable<PromptInput.Prompt>   // { text, files?, agents?, skills? } — fully mutable
  metadata?: Record<string, unknown>
  delivery: SessionInbox.Delivery           // "steer" | "queue" — mutable
}
```

### Semantics [D] (plugins doc, "Model requests" + "Prompt admission"; confirmed by migrate-v1)

- **`context`**: "Modify assembled system instructions, messages, tools, or request options **immediately before model dispatch**." Runs **for the agent loop, including tool-driven continuations** — i.e. before *every* agent-loop model request. Edits `event.system` (push/replace parts), `event.messages` (replace/splice), `event.tools` (`delete event.tools.write`), `event.options` (typed keys or provider options).
- **`compaction`**: runs for checkpoint summaries. `messages` is the transcript being summarized; **OpenCode appends its summary prompt after hooks run**. Set `event.result` to record the compaction yourself and skip the model call.
- **`generate`**: runs for transient `ctx.session.generate` calls.
- **`title`**: runs for title generation. No `agent` or `tools`. Set `event.result` (a string) to skip the model call.
- **`prompt`**: prompt admission, before attachment/skill resolution and durable inbox admission. Runs **once at admission, not before every model call**; commands submitted through `session.prompt` run it; synthetic/shell/compaction/move controls do not. `sessionID`/`messageID` readonly (cannot redirect admission). "Prompt hooks transform input and do not expose a typed rejection API." Keep retry-safe (not exactly-once).
- **No `kind` field on `context`/`compaction`/`generate`/`title` payloads.** The hook *name* is the kind discriminator. (`kind` exists only on the lower-level `model.request`/`http.*`/`retry` events.) A transform that must apply to every request kind must register on each hook. [T][D]
- **Edits are not persisted**: "Changes affect only the outgoing model call, not persisted history or configuration."
- **Ordering**: multiple plugins hook the same event; "OpenCode runs them in plugin order, so later hooks see changes made by earlier hooks." Hook registrations run in registration order. [D]
- **Provider scoping**: third arg `{ providerID }` on any hook whose payload has `model` (all except `prompt`). [T][D]
- **`options` rules** [D]: starts empty per call (does not contain resolved model settings); typed keys = generation settings, other keys = provider options; deleting a key or setting `undefined` falls back to configured defaults (does not remove defaults); provider option objects merge recursively, arrays/scalars replace.

### Client-side session methods DCP may use

- `ctx.session.prompt({ sessionID, id?, text, files?, agents?, skills?, metadata?, delivery?: "steer"|"queue"|null, resume? })` — submit a prompt (runs the `prompt` hook). **[T]** (generated `SessionPromptInput`)
- `ctx.session.context({ sessionID })` → `SessionMessageInfo[]` — the **persisted** transcript (a different, larger tagged union: `user`/`synthetic`/`system`/`skill`/`shell`/`assistant`/`compaction`/`idle`/`agent-switched`/... — `@opencode/schema` `session-message.d.ts`), not the request-shaped `Message[]`. **[T]**
- `ctx.session.generate`, `ctx.session.interrupt`, `ctx.session.wait`, `ctx.session.update`, `ctx.session.switchAgent`, `ctx.session.switchModel`, `ctx.session.synthetic`, `ctx.session.command` also exposed. **[T]**
- `ctx.generate.text({ prompt: string, model?: Model.Ref | null })` → `{ text: string }`. **[T]**

---

## 3. `ctx.tool.transform` — registering a `compress` tool

```ts
// dist/promise/tool.d.ts
export interface ToolDomain {
  readonly transform: Transform<ToolEditor>        // (cb) => Promise<Registration>
  readonly reload: () => Promise<void>
  readonly hook: Hooks<ToolHooks>                  // "execute.before" | "execute.after"
}
export interface ToolEditor {
  list(): readonly (Info & { readonly id: string })[]
  get(id: string): (Info & { readonly id: string }) | undefined
  namespace(namespace: { name: string; description: string }): void
  add<Input, Output>(tool: Info<Input, Output>): void
  /** Updates an existing tool; missing IDs are ignored. */
  update(id: string, update: (tool: Types.Mutable<Info>) => void): void
  remove(id: string): void
}
```

```ts
// Tool.Info (@opencode/schema/tool.d.ts)
type ValueSchema<A = unknown> = Schema.Codec<A, any>      // effect Schema
  | StandardSchemaV1<any, A>                               // standard-schema v1 (zod v4 qualifies)
  | JsonSchema.JsonSchema                                   // plain JSON Schema object ← DCP path

interface Info<Input extends ValueSchema<any>, Output extends ValueSchema<any> | undefined> {
  name: string
  input: Input
  description: string
  execute: (input: InputValue<Input>, context: ToolContext) => Promise<Result<Output>>   // promise world
  output?: Output                                           // output schema; Result.output validated against it
  options?: { namespace?: string; permission?: string; codemode?: boolean; pinned?: boolean }
}

interface Result<Output> {
  output?: OutputValue<Output>                              // structured output (validated by `output` schema)
  content?: string | ReadonlyArray<Content>                 // Content = {type:"text",text} | {type:"file",uri,mime,name?}
  metadata?: Record<string, any>                            // surfaced via session.tool.progress / event metadata
}

// dist/promise/tool.d.ts — ToolContext (what DCP's execute receives as 2nd arg)
interface ToolContext {
  sessionID: Session.ID
  agent: Agent.ID
  messageID: SessionMessage.ID
  id: Tool.CallID
  progress: (update: Record<string, any>) => Promise<void>  // streams session.tool.progress events
}
```

**Naming & validation [D][C]:**
- Effective tool name includes namespace: `ns_name`; dots/unsupported chars become `_`. Names must match `^[A-Za-z0-9_-]{1,64}$` (namespace segments `^[A-Za-z0-9_-]{1,64}$`). `execute` is reserved when Code Mode is active. Invalid registrations are logged ("Skipping invalid tool registration") and skipped. **[D][C]**
- **Permission**: `options.permission` is glob-matched against the session's permission rules; a denied tool is **excluded from that request's tool snapshot**. **[C]**
- **Code Mode**: tools with `codemode !== false` go into the Code Mode namespace catalog; `codemode: false` keeps them as a plain tool. **[C]**
- **Snapshot semantics** [D]: "Each model request captures a stable, executable tool snapshot. Later transforms, reloads, and disposal affect future snapshots, not the definitions, Code Mode namespace descriptions, or executors already captured. Executors that close over mutable plugin data still observe that data."

**Tool hooks [T][D]:**

```ts
"execute.before": { tool: string, sessionID, agent, messageID, id: CallID, input: unknown /* MUTABLE */ }
"execute.after":  { tool, sessionID, agent, messageID, id, input,
                    status: "completed" & { result: Tool.Result } | status: "error" & { error: Tool.Error } }
```

`execute.before.input` is mutable (rewrite args); `execute.after.result` is mutable (metadata can be set).

### Error semantics — the big one

- `Tool.Error` (from `@opencode/schema/tool`, re-exported as `Error` by `@opencode/plugin`'s tool module) is a tagged class: `{ type: "Tool.Error", message: string, error?: Defect, metadata? }`. **[T]**
- **Effect plugins**: `Tool.Info.execute` is `Effect.Effect<Result<Output>, Tool.Error>` — a *typed* failure. The core's tool executor catches exactly `Tool.Error` (`ve("Tool.Error", ...)` in the minified core), fires `execute.after` with `status: "error"`, and fails the tool call: the session publishes `session.tool.failed` with `error: {type:"tool.execution", message}` and the **agent loop continues** — the model receives the error as the tool result and can retry. **[C]**
- **Promise plugins**: the adapter wraps `execute` as `Effect.promise(() => tool.execute(input, ctx))` (`dist/promise/adapter.js`, `executePromiseTool`). A promise rejection is a **defect**, and the core's typed `Tool.Error` catch does **not** catch defects — a thrown `Tool.Error` (or any throw) propagates as an uncaught defect and **fails the session** (`session.execution.failed`), not the tool call. **[T][C]**
  - **Consequence for DCP (promise plugin):** there is no typed guidance-error channel in `execute`. Express "guiding errors" as a *successful* `Result` whose `content` carries the guidance text (the model reads it and adapts). Reserve throwing for genuine hard failures. Verify empirically in ticket #8. **[I]**

---

## 4. `ctx.command.transform` — commands

```ts
// dist/promise/command.d.ts
export interface CommandInvocation {
  readonly sessionID: Session.ID
  readonly prompt: PromptInput.Prompt        // { text, files?, agents?, skills? }
  readonly delivery: SessionInbox.Delivery   // "steer" | "queue"
}
export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  readonly execute: (input: CommandInvocation) => Promise<void>   // side effects only — no return value
}
export interface CommandEditor {
  add(definition: CommandDefinition): void
}
export interface CommandDomain extends Pick<CommandApi, "list"> {
  readonly transform: Transform<CommandEditor>
  readonly reload: () => Promise<void>
}
```

**Confirmed [T]:** `execute({ sessionID, prompt, delivery })` exactly as DCP's v1 design assumed. `execute` returns `Promise<void>` — a command can't itself produce structured output; to act on a session it submits via `ctx.session.prompt({ sessionID, text, ... })` (which then runs the `prompt` hook) or uses other session methods. `ctx.command.list()` lists built-in + plugin commands. **[T]**

---

## 5. `ctx.event.subscribe()` — public event stream

```ts
// dist/promise/event.d.ts
export interface EventDomain extends Pick<EventApi, "subscribe"> {}
// client promise: subscribe(options?: { signal?: AbortSignal, onActivity? }): AsyncIterable<V2Event>
```

Events cross as **plain JSON objects** (`V2EventEncoded`): envelope `{ id: Event.ID, created: number, type: string, data: {...}, location?: { directory, workspaceID? }, metadata?, durable?: { aggregateID, seq, version } }`. Durable events carry an aggregate log position; `session.idle` and TUI events are ephemeral. **[T]**

**Full `V2Event` union (2.0.7)** [T] (`@opencode/client` generated types):

- Location/infra: `location.shutdown`, `modelsdev.refreshed`, `credential.updated|switched`, `integration.updated`, `provider.updated`, `model.updated`, `agent.updated`
- Sessions: `session.created`, `session.agent.selected`, `session.model.selected`, `session.moved`, `session.renamed`, `session.permissions`, `session.viewed`, `session.usage.updated`, `session.deleted`, `session.forked`, `session.inbox.delivered|enqueued|cancelled|delivery.changed`, `session.execution.started|succeeded|failed|interrupted`, `session.instructions.updated`, `session.synthetic`, `session.skill.activated`, `session.shell.started|ended`
- Steps (per model-call iteration): `session.step.started`, `session.step.streamed`, `session.step.ended`, `session.step.failed`
- Streaming: `session.text.started|delta|ended`, `session.reasoning.started|delta|ended`
- Tools: `session.tool.input.started|delta|ended`, `session.tool.called`, `session.tool.progress`, `session.tool.success`, `session.tool.failed`
- Retries/compaction: `session.retry.scheduled`, `session.compaction.started|delta|ended|failed`, `session.revert.staged|cleared|committed`
- Other: `filesystem.changed`, `reference.updated`, `permission.asked|replied`, `plugin.updated`, `project.updated`, `worktree.updated|resolved`, `command.updated`, `config.updated`, `skill.updated`, `pty.created|updated|exited|deleted`, `persistentpty.added|removed`, `shell.created|exited|deleted`, `form.created|replied|cancelled`, `websearch.updated`, `session.status.updated`, `session.idle`, `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`, `tui.session.select`, `installation.updated|update.available`, `vcs.branch.updated`, `mcp.status.changed`, `mcp.resources.changed`, `rpc.*`, `server.connected`

**Key payloads for DCP nudge/strategy work [T]:**

| Event | `data` |
|---|---|
| `session.created` | `sessionID, projectID, location, subpath?, parentID?, slug, title?, agent?, model?, metadata?, permissions?, version` |
| `session.step.started` | `sessionID, assistantMessageID, agent, model, snapshot?, started` |
| `session.step.ended` | `sessionID, assistantMessageID, finish: "stop"\|"length"\|"tool-calls"\|"content-filter"\|"error"\|"unknown", rawFinish?, providerState?, cost, tokens: {input,output,reasoning,cache{read,write}}, snapshot?, files?` |
| `session.tool.called` | `sessionID, assistantMessageID, id, input, executed, state?` |
| `session.tool.success` | `sessionID, assistantMessageID, id, content: Content[], metadata?, executed, resultState?` |
| `session.tool.failed` | `sessionID, assistantMessageID, id, error: {type,message,status?}, content?, metadata?, executed, resultState?` |
| `session.idle` | `sessionID` (ephemeral) |
| `session.execution.succeeded/failed/interrupted` | `sessionID` (failed carries `error`) |
| `session.inbox.delivered` | `sessionID, inboxID` |

**Per-iteration counting** for nudge timing: `session.step.started`/`session.step.ended` bracket one model-call iteration; token deltas come from `step.ended.data.tokens`. **Subscription hygiene [D]**: `for await` + `AbortController`; abort from the `setup` cleanup.

---

## 6. `ctx.storage` — plugin-scoped durable state

```ts
// dist/promise/storage.d.ts
get(key: string): Promise<Schema.Json | undefined>
set(key: string, value: Schema.Json): Promise<void>
remove(key: string): Promise<void>
scan(options: { prefix: string, after?: string, limit?: number }): Promise<{ entries: readonly { key: string, value: Schema.Json }[], next?: string }>
```

- "Store, read, or remove **durable JSON values scoped to the plugin**" [D]; scope is by plugin `id` (migrate-v1). Use a `dcp/...` prefix convention for namespacing (e.g. `dcp/state/<sessionID>`).
- Values must be JSON (effect `Schema.Json` — no Dates/Maps/undefined). **[T]**
- Where the bytes live (per-project? per-location?) is **not documented** — see open questions.

---

## 7. `reload()`, `registration.dispose()`, cleanup

- **Transforms are replayable state edits** [D]: "Any registration, removal, or `reload()` marks the registry changed; the next read rebuilds it by replaying every active transform in registration order onto a fresh value. Keep transforms cheap and repeatable." The transform callback itself is **synchronous** (`(editor) => void`) — load external data *before* the callback; call `ctx.<domain>.reload()` after captured inputs change. Reload does **not** rerun plugin setup.
- **`registration.dispose()`**: removes that one transform/hook and rebuilds from the remaining transforms "revealing any earlier definition it overrode." **Idempotent.** Plugin unload disposes all its registrations. **[T][D]**
- **Cleanup function**: returned from `setup`; the adapter runs it via `acquireRelease` on the plugin scope when the plugin unloads. **[T]**
- Boot-time batching: promise-plugin transforms registered during setup "still coalesce into one reload per domain" (adapter doc comment). **[T]**

---

## 8. DCP feature → v2 API mapping

| DCP feature (v1) | v2 API |
|---|---|
| Context pruning before model request (`experimental.chat.messages.transform` + `chat.params`) | `ctx.session.hook("context", cb)` — mutate `event.messages` (splice/replace) + `event.system` + `event.options` |
| Compress placeholder for pruned ranges | In-place message rewrite inside the `context` hook; persist per-session pruning state via `ctx.storage` |
| `compress` tool (model-invoked) | `ctx.tool.transform(e => e.add({ name: "compress", input: <JSON Schema>, execute }))`; return guidance via `Result.content` (promise plugins have no typed error channel) |
| `compress` / strategy recalc on tool boundaries | `ctx.tool.hook("execute.before"/"execute.after")` + `ctx.event.subscribe()` on `session.tool.*` / `session.step.*` |
| Per-iteration nudge counting | `ctx.event.subscribe()`: `session.step.started`/`ended` (per model call), `session.step.ended.data.tokens` |
| Commands (e.g. `/dcp:compress`, `/dcp:status`) | `ctx.command.transform(e => e.add({ name, description, execute: ({sessionID, prompt, delivery}) => ... }))` — side-effect only; submit via `ctx.session.prompt` |
| Strategy threshold config | `ctx.options` from `plugins: [{ package, options }]` in `opencode.jsonc` |
| v1 `event` subscription (nudge panel data) | `ctx.event.subscribe({ signal })` — `V2Event` async iterable |
| v1 `dispose` | cleanup returned from `setup` |
| Compaction awareness (don't prune the summary prompt) | `ctx.session.hook("compaction", ...)` — `messages` = transcript, summary prompt appended *after* hooks; optionally set `result` to take over |
| Title generation cost control | `ctx.session.hook("title", ...)` — set `event.result` to skip the model call |

---

## 9. Registration code shape DCP needs (minimal, loadable)

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "dcp",
  async setup(ctx) {
    const disposables: { dispose: () => Promise<void> }[] = []

    // (a) Context transform: prune messages before the agent-loop model request
    const contextReg = await ctx.session.hook("context", (event) => {
      // event: SessionContext — { sessionID, model, system: SystemPart[], messages: Message[],
      //                            options, agent, tools }
      // Only the outgoing model call is affected; history is untouched.
      const state = /* read pruning state from ctx.storage (async — load/cache before hook if needed) */
      // Placeholder replacement: rewrite old messages in place, e.g.
      // event.messages = prune(event.messages, state)   // array replacement is fine (field is mutable)
      // or splice/replace content parts:
      // for (const m of event.messages) m.content = m.content.map((p) => p.type === "text" && isPruned(p) ? { type: "text", text: p.text.slice(0, 200) + "…[pruned]" } : p)
      // event.system.push({ type: "text", text: "Earlier context was compressed." })
    })
    disposables.push(contextReg)

    // Compaction: don't clobber the summary prompt (appended after hooks run)
    const compactionReg = await ctx.session.hook("compaction", (event) => {
      // event.messages is the transcript being summarized; set event.result to skip the model call
    })
    disposables.push(compactionReg)

    // (b) compress tool (JSON Schema input — no zod required)
    const toolReg = await ctx.tool.transform((editor) => {
      editor.add({
        name: "compress",
        description: "Compress an earlier part of the conversation into a summary placeholder.",
        input: {
          type: "object",
          properties: {
            startId: { type: "string", description: "Message/block ID marking the range start" },
            endId: { type: "string", description: "Message/block ID marking the range end" },
            summary: { type: "string", description: "Dense technical summary replacing the range" },
          },
          required: ["startId", "endId", "summary"],
          additionalProperties: false,
        },
        // NOTE: with a plain JSON Schema, `input` is typed `unknown` — cast inside execute.
        async execute(input, tool) {
          const { startId, endId, summary } = input as { startId: string; endId: string; summary: string }
          // tool: { sessionID, agent, messageID, id, progress }
          const state = await ctx.storage.get(`dcp/state/${tool.sessionID}`)
          await ctx.storage.set(`dcp/state/${tool.sessionID}`, { ...(state as object | undefined), ranges: [{ startId, endId, summary }] })
          // Success path: content is what the model reads. No typed error channel in promise plugins.
          return { content: `Compressed range ${startId}..${endId} into a placeholder.` }
        },
      })
    })
    disposables.push(toolReg)

    // (c) Commands (side effects only; return Promise<void>)
    const cmdReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "dcp:compress",
        description: "Run DCP compression now for this session",
        async execute({ sessionID, prompt, delivery }) {
          // e.g. submit guidance back into the session (runs the prompt hook):
          await ctx.session.prompt({ sessionID, text: prompt.text ?? "Compress this session's context now." })
        },
      })
      editor.add({
        name: "dcp:status",
        description: "Show DCP pruning stats for this session",
        async execute({ sessionID }) {
          const state = await ctx.storage.get(`dcp/state/${sessionID}`)
          await ctx.session.prompt({ sessionID, text: `DCP status: ${JSON.stringify(state ?? {})}` })
        },
      })
    })
    disposables.push(cmdReg)

    // Nudge / strategy recomputation: public event stream
    const controller = new AbortController()
    const events = ctx.event.subscribe({ signal: controller.signal })
    void (async () => {
      for await (const event of events) {
        switch (event.type) {
          case "session.step.started":
            /* per-iteration count += 1 */
            break
          case "session.step.ended":
            /* tokens = event.data.tokens; recalc strategy threshold */
            break
          case "session.tool.called":
          case "session.tool.failed":
            /* nudge timing hooks */
            break
          case "session.idle":
            /* turn boundary */
            break
        }
      }
    })().catch(() => {})

    // cleanup: abort the stream; registrations are auto-disposed on unload, but dispose explicitly too
    return () => {
      controller.abort()
      return Promise.allSettled(disposables.map((d) => d.dispose()))
    }
  },
})
```

Config (`opencode.jsonc`):

```jsonc
{
  "plugins": [
    { "package": "./plugins/dcp", "options": { "threshold": 0.75, "keepRecent": 8 } }
  ]
}
```

---

## 10. Pitfalls & ambiguities

**Pitfalls**

1. **No `kind` on `context`/`compaction`/`generate`/`title` payloads** — the hook name is the kind. A transform that must apply to every model request kind must register four hooks. `[T][D]`
2. **Context-hook edits are ephemerality-by-design**: they never touch persisted history. DCP placeholders must be *recomputed on every request* from durable state (`ctx.storage`), not written back to the transcript. `[D]`
3. **Promise tools have no typed error channel**: rejection = defect = session failure (adapter uses `Effect.promise`; core catches only typed `Tool.Error`). Guidance to the model must be a successful `Result.content`. Effect plugins get the proper `session.tool.failed` guidance path. `[T][C]`
4. **Transform callbacks are synchronous and replayed** on every registry rebuild (registration/removal/`reload()`/plugin load). No `await` inside; capture external data beforehand. `[D]`
5. **Tool snapshots are per-request**: mid-session tool add/update/remove only affects *future* requests; executors closing over mutable data keep seeing mutations. `[D]`
6. **`options` semantics**: starts empty per call; deleting a key falls back to configured defaults (does not remove defaults); provider option objects merge recursively. `[D]`
7. **`prompt` hook** is not exactly-once and runs once at admission (not per model call); no `providerID` option; IDs readonly. `[D]`
8. **`ctx.location` is the plugin's load location**, not per-session/per-event — filter events/sessions by their own `sessionID`/`location`. `[D]`
9. **`messages` in `compaction` excludes the summary prompt** (appended after hooks) — don't assume "last message = prompt". `[D]`
10. **`ctx.session.context()` returns persisted `SessionMessageInfo`** (different union than the request `Message`) — don't mix the two shapes in one pipeline. `[T]`
11. **Storage values are JSON only**; scoping is by plugin `id` (exact key namespace across locations/projects undocumented). `[D][T]`
12. **Tool naming**: effective name `ns_name`; `^[A-Za-z0-9_-]{1,64}$`; `execute` reserved under Code Mode; invalid definitions are logged and skipped, not thrown at setup. `[D][C]`
13. **Permission-filtered tools** (`options.permission`) silently drop from a request's snapshot when a permission rule denies them. `[C]`
14. **`delivery`** is `"steer"` (default) or `"queue"`; `SessionPrompt.delivery` and command invocations expose it — pass it through deliberately when resubmitting. `[T]`
15. **Event stream**: `for await` must be driven by an async IIFE; abort via the cleanup's `AbortController`. `[D]`

**Open questions (verify empirically, likely ticket #8)**

1. **Storage key scoping**: per plugin-id × project? × location? × server? Docs say "scoped to the plugin"; test by creating sessions in two project directories.
2. **Promise `Tool.Error` rejection**: confirm the defect→session-failure behavior with a 10-line test plugin (adapter + minified core evidence above is strong but indirect).
3. **In-place `Message` mutation**: the docs promise outgoing-call effect for `event.messages`/`event.system` (prompt hook is explicitly "owned, mutable draft"); confirm splicing `event.messages` and replacing `content` parts works for *all* providers (serialization path).
4. **Reload necessity**: after `storage` state changes, is `ctx.tool.reload()`/`ctx.command.reload()` needed for the next request's snapshot to pick up new behavior, or does each request rebuild automatically? (Snapshot text suggests per-request rebuild; test.)
5. **`context` hook vs steered/queued prompts**: does a `"queue"`-delivered prompt that starts mid-turn fire the `context` hook on its first model call? (Should — "agent loop, including tool-driven continuations" — but verify.)
6. **`ctx.session.prompt` `id`/`resume` fields** for idempotent resubmission (prompt admission retry semantics interact with DCP re-compress).
7. **`session.usage.updated` / `session.status.updated` payloads** (not needed for the core, needed for the UI panel ticket).

---

## Appendix A: source file map

| Fact | Source |
|---|---|
| `Plugin`/`Context`/`Cleanup`/`define` | `@opencode/plugin` `dist/promise/plugin.d.ts` |
| `Registration`/`Hooks`/`ModelHooks`/`Transform` | `dist/promise/registration.d.ts` |
| `SessionHooks` payloads, `SessionRequestKind` | `dist/promise/session.d.ts` |
| `ToolDomain`/`ToolEditor`/`ToolContext`/tool hooks | `dist/promise/tool.d.ts` |
| `CommandDefinition`/`CommandInvocation` | `dist/promise/command.d.ts` |
| `EventDomain` | `dist/promise/event.d.ts`; `@opencode/client` `dist/promise/client.d.ts` |
| `StorageDomain`/`StorageScan*` | `dist/promise/storage.d.ts`, `dist/storage.d.ts` |
| `Message`/`SystemPart`/`ContentPart`/`ToolResultValue` | `@opencode/ai` `dist/schema/messages.d.ts`, `dist/schema/options.d.ts` |
| `Tool.Info`/`Tool.Result`/`Tool.Error`/`ValueSchema`/`Tool.Context` | `@opencode/schema` `dist/tool.d.ts` |
| `PromptInput.Prompt` | `@opencode/schema` `dist/prompt-input.d.ts` |
| `SessionInbox.Delivery` | `@opencode/schema` `dist/session-inbox.d.ts` |
| `Location.Info`, `Model.Ref` | `@opencode/schema` `dist/location.d.ts`, `dist/model.d.ts` |
| Persisted `SessionMessageInfo` union | `@opencode/schema` `dist/session-message.d.ts` |
| `V2Event` catalog + payloads | `@opencode/client` `dist/promise/generated/types.d.ts` |
| Promise↔Effect adapter (setup/cleanup, `Effect.promise` tool wrap, scope disposal, boot batching) | `@opencode/plugin` `dist/promise/adapter.js` |
| Loading/config/options/storage/transforms/hooks/events docs | `opencode.ai/v2/docs/build/plugins` |
| V1→V2 mapping table, id-scoped storage | `opencode.ai/v2/docs/build/plugins/migrate-v1` |
| Tool-error catch (typed `Tool.Error` vs defects), permission filtering, Code Mode split, event publication | `opencode2` 2.0.7 binary (bun-compiled, minified core) |
