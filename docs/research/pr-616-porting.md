# Research: PR #616 porting analysis (format_retry_fix)

**Ticket:** #6 (wayfinder map #2, decision #5)
**Question:** How does PR #616 change the v1 DCP code, and what is the exact port plan for those changes into the v2 port?
**Date:** 2026-09-18
**Status:** research complete; v2-host details marked *pending v2-core-api research* (ticket #3) where not grounded in the 2.0.7 packages themselves.

## Sources (all primary, read this session)

| Source | Ref |
|---|---|
| Fork PR head | `kido5217/opencode-dynamic-context-pruning` @ `format_retry_fix` = `d52e5f4` (5 commits over upstream master `11f6517`) |
| Upstream PR | https://github.com/Opencode-DCP/opencode-dynamic-context-pruning/pull/616 (OPEN, MERGEABLE, no reviews/comments; author kido5217, created 2026-09-12; body captured via `gh pr view 616 --json`) |
| v1 DCP base tree | same clone @ `11f6517` (upstream master) |
| v1 plugin API | `@opencode-ai/plugin@1.4.3` npm tarball → `dist/tool.d.ts` |
| opencode v1 host (tag v1.4.3, sst/opencode) | `packages/opencode/src/tool/registry.ts`, `tool/tool.ts`, `session/prompt.ts`, `provider/transform.ts` |
| v2 plugin API | `@opencode/plugin@2.0.7` npm tarball → `dist/promise/*.d.ts` |
| v2 schema API | `@opencode/schema@2.0.7` npm tarball → `dist/tool.d.ts` |
| opencode v2 host (sst/opencode `dev` branch) | `packages/opencode/src/session/tools.ts` |
| v1 test suite | run on fork @ `d52e5f4`: **114/114 pass** (`npm test` = `node --import tsx --test tests/*.test.ts`) |

Fork commit log (base `11f6517` → head `d52e5f4`, +276/−6, 7 files):

| SHA | Subject |
|---|---|
| `9cc77ff` | fix: coerce mis-wrapped compress content args and teach format on rejection |
| `f57a0d9` | fix: give a JSON-encoded empty compress content array the right error |
| `1061efa` | refactor: dedupe compress arg guards and normalization into args.ts |
| `b58bbad` | refactor: hoist the non-empty-array error message to a shared constant |
| `d52e5f4` | test: drop the gold-plated message-mode execute replay test |

Full diff saved at `/tmp/opencode/pr616.diff` (411 lines) on the research host.

---

## 1. The exact coercion logic

All line references below are the **fork @ `d52e5f4`** (post-change) unless noted "base".

### 1.1 New module `lib/compress/args.ts` (84 lines, entirely new)

- `NON_EMPTY_ARRAY_ERROR_MESSAGE` (args.ts:14) = `"content is required and must be a non-empty array"` — the single source of truth for the model-facing non-empty-array message (commit `b58bbad` hoisted it out of 4 literal copies).
- `isStringFields(value, keys)` (args.ts:16–20): true iff `value` is a non-null plain object (not array) and every key in `keys` is a string on it. Extra fields allowed; missing field → false.
- `coerceContentArray<T>(raw, isEntry, guidance)` (args.ts:24–59):

| Input shape for `content` | Outcome | Cite |
|---|---|---|
| Any JS array | returned as-is; **element shapes NOT checked** (deferred to `validateArgs`, per header comment args.ts:10–11) | args.ts:28–30 |
| String, trimmed starts with `[` or `{`, parses to **non-empty array** | decoded array returned | args.ts:33–46 |
| String, parses to **empty array** (i.e. `"[]"`) | throws `NON_EMPTY_ARRAY_ERROR_MESSAGE` | args.ts:43–45 (commit `f57a0d9`) |
| String, parses to a single object passing `isEntry` | wrapped as `[parsed]` | args.ts:47–49 |
| String, plain text (no leading `[`/`{`) | throws `` `content must be a JSON array, not a plain string. ${guidance}` `` | args.ts:52 |
| String, starts with `[`/`{` but JSON.parse fails | same "plain string" error (parsed = undefined) | args.ts:36–41, 52 |
| String, valid JSON but number/bool/null/non-entry object (e.g. `"123"`, `"{\"a\":1}"`) | same "plain string" error | args.ts:52 |
| Non-null object passing `isEntry` (single entry, unwrapped) | wrapped as `[raw]` | args.ts:54–56 |
| `null`, number, boolean, or object failing `isEntry` (e.g. `{}`) | throws `NON_EMPTY_ARRAY_ERROR_MESSAGE` | args.ts:58 |
| Topic not a string / empty | NOT handled here — `topic` is cast (`args as string`, args.ts:80) and left to `validateArgs` ("topic is required and must be a non-empty string") | args.ts:79–82 |
| Whole-args `null` / non-object / array | throws `` `compress takes a JSON object with "topic" (string) and "content" (array of ${contentNoun}). Re-send as: ${shapeExample}` `` | args.ts:72–78 |

- `normalizeCompressArgs<TEntry>(args, spec)` (args.ts:69–83): the whole-args guard above + `coerceContentArray` on `args.content`. Spec fields: `isEntry`, `contentNoun` ("ranges"/"messages"), `shapeExample`, `contentGuidance` (commit `1061efa` introduced this parameterization to dedupe the two modes).

### 1.2 Range mode (`lib/compress/range-utils.ts`)

- `RANGE_ENTRY_KEYS = ["startId", "endId", "summary"]` (range-utils.ts:16); `isRangeEntry` (range-utils.ts:18–20).
- `RANGE_CONTENT_GUIDANCE` (range-utils.ts:22–25):
  > re-send with content as an array of range objects: `[{ "startId": "m0001", "endId": "m0031", "summary": "..." }]`. startId and endId must be the message (mNNNN) or compressed-block (bN) IDs, visible as `<dcp-message-id>` tags in context, that bound the range your summary covers. A summary string alone does not say which messages to replace.
- `normalizeRangeArgs` (range-utils.ts:27–34): `normalizeCompressArgs` with `shapeExample` `{ "topic": "...", "content": [{ "startId": "m0001", "endId": "m0031", "summary": "..." }] }`.
- `validateArgs` (range-utils.ts:37–58): unchanged checks (topic non-empty string; content non-empty array via the shared constant at range-utils.ts:43; per-entry `startId`/`endId`/`summary` non-empty strings with `content[i].<field>` prefixes).

### 1.3 Message mode (`lib/compress/message-utils.ts`)

- `MESSAGE_ENTRY_KEYS = ["messageId", "topic", "summary"]` (message-utils.ts:16); `isMessageEntry` (message-utils.ts:18–20).
- `MESSAGE_CONTENT_GUIDANCE` (message-utils.ts:22–25):
  > re-send with content as an array of message objects: `[{ "messageId": "m0001", "topic": "...", "summary": "..." }]`. messageId must be the message ID (mNNNN), visible as `<dcp-message-id>` tags in context, that your summary covers. A summary string alone does not say which message to replace.
- `normalizeMessageArgs` (message-utils.ts:27–34): `normalizeCompressArgs` with `shapeExample` `{ "topic": "...", "content": [{ "messageId": "m0001", "topic": "...", "summary": "..." }] }`.
- `validateArgs` (message-utils.ts:52–75): same structure; shared constant at message-utils.ts:58.

### 1.4 Accepted/rejected summary (per mode; message mode symmetric)

- **Coerced (fix the call, model never sees an error):** array (passthrough); single entry object → `[entry]`; JSON string encoding an array or a single entry → decoded.
- **Rejected, guiding error:** plain-string summary → "content must be a JSON array, not a plain string. <mode guidance>"; whole-args string/array/null → "compress takes a JSON object … Re-send as: <shapeExample>".
- **Rejected, non-empty-array error** (`content is required and must be a non-empty array`): `[]`, `"[]"`, `null`, numbers/booleans, non-entry objects (e.g. `{}`).
- **Rejected, field-specific errors** (pre-existing `validateArgs`, now reachable *after* coercion): `content[i].<field> is required and must be a non-empty string`; `topic is required and must be a non-empty string`.

Layering note: `isEntry` passes for entries with empty-string fields (e.g. `{startId: "", ...}`); those are then rejected by `validateArgs` with the specific field error — deliberate, per the args.ts header comment.

## 2. Where it plugs in (v1)

- **Only two call sites**, both tool `execute` entry points; grep confirms no other callers (no TUI/command path goes through `validateArgs`):
  - `lib/compress/range.ts:65–66` — `const input = normalizeRangeArgs(args); validateArgs(input)` (base: `args as CompressRangeToolArgs` blind cast at base range.ts:57).
  - `lib/compress/message.ts:54–55` — `const input = normalizeMessageArgs(args); validateArgs(input)` (base: blind cast at base message.ts:49).
- **v1 validation architecture (what v1 actually uses):**
  - Tool `args` schema is built with `tool.schema` from `@opencode-ai/plugin` — **zod** (`tool.schema` is literally `typeof z`, v1 plugin `dist/tool.d.ts:43`; `execute(args: z.infer<...>)`, line 36). `buildSchema()` in range.ts:26–51 / message.ts:26–44 is **untouched by the PR**.
  - The host (opencode v1.4.3) converts that zod object to JSON Schema for the model only: `z.toJSONSchema(item.parameters)` → `ProviderTransform.schema(...)` → AI SDK `tool({ inputSchema: jsonSchema(schema) })` (`session/prompt.ts:393–397`). Per-provider sanitizers (`provider/transform.ts:951–1050`) only touch Gemini enum/array quirks — `content: {type: "array"}` survives.
  - The host does **not** run a strict parse of plugin-tool args before `execute`: plugin tools are registered via `fromPlugin` (`tool/registry.ts:95–118`) which bypasses the `wrap()` layer that would call `parameters.parse(args)` (`tool/tool.ts:77–88`; `wrap` is only applied via `Tool.define`/`init`, not to `fromPlugin` output). Execution flows raw into `def.execute(args as any, ...)` through the AI SDK `tool({inputSchema})` (`session/prompt.ts:398–407`).
  - Empirically (PR body + commit `9cc77ff`): 10 observed real-session failures had a plain-string `content` **reach** DCP's `validateArgs` and surface the bare error to the model — i.e. the plugin's own throw is the authoritative runtime validation and the model-visible error channel. That is why the fix lives entirely plugin-side and is portable regardless of host validation behavior.
- **Tool descriptions unchanged:** the model-facing format teaching stays in `description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION` / `…compressMessage + MESSAGE_FORMAT_EXTENSION` (`lib/prompts/extensions/tool.ts`, base) — the PR adds a *recovery* path on rejection, not a description change.
- **Error surfacing in v1:** `throw new Error(msg)` inside `execute`; the thrown `msg` is what the model receives (confirmed by the observed failure mode above).

## 3. Port-shape deltas for v2

Grounded from the 2.0.7 packages + v2 `dev`-branch source:

- **Schema representation.** v2 `ValueSchema = Schema.Codec | StandardSchemaV1 | JsonSchema.JsonSchema` (`@opencode/schema@2.0.7` `dist/tool.d.ts:32`) — a **raw JSON Schema is first-class**; for a raw JSON Schema the execute input type is `unknown` (`InputValue`, `dist/tool.d.ts:33`). So the port declares `content` as a hand-written JSON Schema (array of objects with string `startId`/`endId`/`summary` + descriptions), **no zod**. The coercion/normalization logic then must live entirely inside `execute` (input is `unknown`) — exactly the v1 placement.
  - *pending v2-core-api research (#3):* does the v2 host validate model input against the JSON Schema before `execute`, and if a shape fails, what reaches the model? v2 host source uses the same AI SDK pattern (`session/tools.ts:98–133`: `ToolJsonSchema.fromTool` → `jsonSchema(schema)` → `tool({inputSchema})`, raw `args` into `item.execute`). If the host *rejects* mis-shapes before `execute` (unlike v1's observed pass-through), the guiding error would need an alternative home (schema-level hints / description). The empirical v1 evidence says pass-through happens in practice for these model mis-wraps; the v2 equivalent is unverified.
- **Error surface.** v2 `execute: (input, ctx) => Effect<Result, Tool.Error>` where `Tool.Error` is a tagged struct `{ message: string; error?: Defect; metadata? }` (`@opencode/schema` `dist/tool.d.ts:35–41, 75`); plugin promise flavor adapts `execute` to `Promise<Tool.Result>` (`@opencode/plugin@2.0.7` `dist/promise/tool.d.ts:12–14`). Tool hooks report `execute.after` with `status: "error"` + `error: Tool.Error` (`dist/promise/tool.d.ts:37–50`). The v2-native way to surface a guiding error is a typed `Tool.Error` failure (or a rejection, in the promise flavor) carrying the same message text as v1's thrown `Error`.
  - *pending v2-core-api research (#3):* exact host rendering of a `Tool.Error` (or rejected promise) into the tool-error part the model sees; whether a plain `throw new Error` from promise-flavor execute yields the same message. The v1 message **text** ports verbatim either way.
- **Guidance text vs v2 context tags.** Both guidance strings reference `<dcp-message-id>` tags "in context". The v2 port owns its tag emission in the context transform (ticket #12); if v2 uses the same tag format (CONTEXT.md glossary keeps the same `mNNNN`/`bN` Boundary ID vocabulary), the strings port verbatim; otherwise update the two `*_CONTENT_GUIDANCE` constants + two `shapeExample` strings (single-loc each). Cross-ticket dependency, not a blocker.
- **Everything else ports 1:1.** `args.ts` is pure (no v1 imports); the `validateArgs` bodies, `resolveRanges`/`resolveMessages`, and pipeline code are unaffected by the PR.

### TODO list (depends on v2-core-api research #3)

- [ ] Confirm whether v2 validates tool input against a raw JSON Schema before `execute` (v1 passes through; see §2). If it rejects, decide where the guiding error lives.
- [ ] Confirm the exact mechanism to surface a guiding tool error in v2 (typed `Tool.Error` vs rejection vs plain throw) and that the `message` text reaches the model verbatim.
- [ ] Confirm v2 promise-flavor tool registration shape (`ctx.tool.transform` / `ToolEditor.add`, `dist/promise/tool.d.ts:15–27`) for the port's tool definition (also needed by ticket #13 generally).

## 4. Port plan

Per decision #5 the port is built from master + `format_retry_fix`, i.e. adopts the **final post-review shape** (deduped `args.ts`, hoisted constant, dropped redundant test).

### Modules / functions to add or modify (v2 port)

| v2 port module | What lands |
|---|---|
| `lib/compress/args.ts` (new) | `NON_EMPTY_ARRAY_ERROR_MESSAGE`, `isStringFields`, `coerceContentArray`, `CompressArgsSpec`, `normalizeCompressArgs` — verbatim port (pure functions; zero v1 dependencies) |
| `lib/compress/range-utils.ts` | `RANGE_ENTRY_KEYS`, `isRangeEntry`, `RANGE_CONTENT_GUIDANCE`, `normalizeRangeArgs`; `validateArgs` uses the shared constant |
| `lib/compress/message-utils.ts` | `MESSAGE_ENTRY_KEYS`, `isMessageEntry`, `MESSAGE_CONTENT_GUIDANCE`, `normalizeMessageArgs`; `validateArgs` uses the shared constant |
| `lib/compress/range.ts` | `execute` first lines: `normalizeRangeArgs(args)` → `validateArgs(input)` (v1: range.ts:65–66) |
| `lib/compress/message.ts` | `execute` first lines: `normalizeMessageArgs(args)` → `validateArgs(input)` (v1: message.ts:54–55) |
| tool schemas | v1's zod `buildSchema()` becomes hand-written JSON Schema literals (v2-native; §3) — content: array of objects {startId,endId,summary / messageId,topic,summary}, all string + descriptions; **schema itself unchanged in meaning by the PR** |

### Tests to carry over (11 net-new on the branch; base suite 103 → 114)

`tests/compress-range.test.ts` (7 new, fork lines):
- L387 "compress range normalizes single-object content into an array"
- L398 "compress range normalizes JSON-string content into an array" (array + single-object encodings)
- L416 "compress range rejects plain-string content with re-send guidance" (asserts substrings "JSON array", "startId", "endId")
- L430 "compress range still rejects empty content arrays"
- L435 "compress range rejects a JSON-encoded empty content array with the non-empty error"
- L442 "compress range rejects a whole-args string with re-send guidance" (asserts `"topic"` and `"content"` in message)
- L449 "compress range execute rejects the captured string-content payload with guidance" — end-to-end replay of the real session payload through `createCompressRangeTool(...).execute`; v2 version must adapt the v2 execute context shape (pending #3). This replay is the reason the message-mode twin was dropped (`d52e5f4`).

`tests/compress-message.test.ts` (4 new, fork lines):
- L893 "compress message normalizes single-object content into an array"
- L904 "compress message rejects plain-string content with re-send guidance" (asserts "JSON array", "messageId")
- L915 "compress message still rejects empty content arrays"
- L920 "compress message rejects a JSON-encoded empty content array with the non-empty error"

Not carried over: the dropped message-mode execute-replay test (deliberate, KISS per `d52e5f4`).

Wording-pinning: several tests assert the literal error substrings; keep the error text verbatim so those assertions survive. Test runner: v1 uses `node --import tsx --test tests/*.test.ts`; v2 runner comes from the skeleton/flake tickets (#8/#9). Baseline check: fork suite runs green at **114/114** (this session), matching the PR claim and map decision #10's "114-test suite".

## 5. Follow-ups requiring user confirmation

Standing rule (map #2, decision #4 / Q4 addendum): v2-native improvements must be checked **and asked** before implementing.

1. **Adopt the post-review shape as-is?** Port the final structure (shared `lib/compress/args.ts` + per-mode `normalizeXArgs` wrappers, hoisted `NON_EMPTY_ARRAY_ERROR_MESSAGE`, dropped redundant test) rather than the first-commit shape? (Recommendation: yes — decision #5 already pins "master + format_retry_fix".)
2. **Guiding-error mechanism (v2-native):** v1 throws plain `Error`s; v2 exposes a typed `Tool.Error { message }` failure channel (and promise-flavor rejections). Use the typed channel with identical message text? *Blocked on #3* to confirm host rendering before implementing.
3. **Schema style (v2-native):** hand-written JSON Schema literals, no zod dependency in the port (map premise: "v2 tool schemas are JSON Schema")? Confirm no zod in the devShell for tool definitions.
4. **Guidance tag text:** guidance strings cite `<dcp-message-id>` tags; confirm the v2 context transform (ticket #12) emits the same tag text, else update the two guidance constants + two shape examples (cheap, single-loc).
5. **Coverage gap in #616 itself:** v1 tests JSON-string coercion only in range mode; message mode has just the single-object case. Add the missing message-mode JSON-string array test for the port, or keep strict 114-test parity? (KISS says parity; it's 3 lines if we add.)

## Out of scope

- Merging #616 upstream (map "Out of scope"); upstream merge status is not a gate (decision #5).
- Any v1-line work.
- v2 host-side tool validation behavior in depth — ticket #3.
