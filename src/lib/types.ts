/**
 * v2 request-shape message types (structural mirror of the opencode 2.0.7
 * `context` hook payload, verified against the installed @opencode/ai schema)
 * and the DCP session state types ported from v1 `lib/state/types.ts`.
 *
 * The `context` hook payload is MUTABLE: edits to `messages` / `system` apply
 * to the outgoing model request only and are never persisted. DCP therefore
 * recomputes all ephemeral rewrites (placeholders, boundary tags, nudges)
 * from durable state on every request.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type ToolResultType = "json" | "text" | "error" | "content";

export interface ToolResultContentItem {
  type: "text";
  text: string;
}

export interface ToolResultFileItem {
  type: "file";
  uri: string;
  mime: string;
  name?: string;
}

export interface ToolResultValue {
  type: ToolResultType;
  value: unknown;
}

export interface DcpTextPart {
  type: "text";
  text: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  /** Not part of the 2.0.7 request schema; read defensively for parity with v1's `part.ignored`. */
  ignored?: boolean;
}

export interface DcpMediaPart {
  type: "media";
  mediaType: string;
  data: string | Uint8Array;
  filename?: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface DcpToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  namespace?: string;
  input: unknown;
  providerExecuted?: boolean;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface DcpToolResultPart {
  type: "tool-result";
  id: string;
  name: string;
  namespace?: string;
  result: ToolResultValue;
  providerExecuted?: boolean;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface DcpReasoningPart {
  type: "reasoning";
  text: string;
  encrypted?: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
}

export interface DcpCompactionPart {
  type: "compaction";
  provider: string;
  id?: string;
  text?: string | null;
  encrypted?: string;
}

export interface DcpEffortPart {
  type: "effort";
  effort?: string;
  previous?: string;
}

export type DcpContentPart =
  | DcpTextPart
  | DcpMediaPart
  | DcpToolCallPart
  | DcpToolResultPart
  | DcpReasoningPart
  | DcpCompactionPart
  | DcpEffortPart;

export interface DcpMessage {
  id?: string;
  role: MessageRole;
  content: DcpContentPart[];
  metadata?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  native?: Record<string, unknown>;
}

/** System prompt part of the outgoing request (`system: SystemPart[]`). */
export interface DcpSystemPart {
  type: "text";
  text: string;
  cache?: unknown;
  metadata?: Record<string, unknown>;
}

/** Model reference carried by every session event (`Model.Ref`). */
export interface DcpModelRef {
  providerID: string;
  id: string;
}

export interface DcpStepTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/**
 * Tool call status. v1 derived it from the tool part's state; the v2 request
 * shape carries no status field — a tool call is `completed` when a
 * `tool-result` part with the same `id` exists and its result type is not
 * `"error"`, `error` when the result type is `"error"`, else `pending`.
 * `running` (v1 in-flight) maps to `pending` in the request shape.
 */
export type ToolStatus = "pending" | "running" | "completed" | "error";

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: ToolResultValue;
  /** Index of the assistant message containing the tool call. */
  callIndex: number;
  /** Index of the message carrying the tool result, if any. */
  resultIndex?: number;
}

// ---------------------------------------------------------------------------
// DCP session state (ported from v1 `lib/state/types.ts`)
// ---------------------------------------------------------------------------

export interface ToolParameterEntry {
  tool: string;
  parameters: Record<string, unknown>;
  status?: ToolStatus;
  error?: string;
  turn: number;
  tokenCount?: number;
}

export interface SessionStats {
  pruneTokenCounter: number;
  totalPruneTokens: number;
}

export interface PrunedMessageEntry {
  tokenCount: number;
  allBlockIds: number[];
  activeBlockIds: number[];
}

export type CompressionMode = "range" | "message";

export interface CompressionBlock {
  blockId: number;
  runId: number;
  active: boolean;
  deactivatedByUser: boolean;
  compressedTokens: number;
  summaryTokens: number;
  durationMs: number;
  mode?: CompressionMode;
  topic: string;
  batchTopic?: string;
  startId: string;
  endId: string;
  anchorMessageId: string;
  compressMessageId: string;
  compressCallId?: string;
  includedBlockIds: number[];
  consumedBlockIds: number[];
  parentBlockIds: number[];
  directMessageIds: string[];
  directToolIds: string[];
  effectiveMessageIds: string[];
  effectiveToolIds: string[];
  createdAt: number;
  deactivatedAt?: number;
  deactivatedByBlockId?: number;
  summary: string;
}

export interface PruneMessagesState {
  byMessageId: Map<string, PrunedMessageEntry>;
  blocksById: Map<number, CompressionBlock>;
  activeBlockIds: Set<number>;
  activeByAnchorMessageId: Map<string, number>;
  nextBlockId: number;
  nextRunId: number;
}

export interface Prune {
  tools: Map<string, number>;
  messages: PruneMessagesState;
}

export interface PendingManualTrigger {
  sessionId: string;
  prompt: string;
}

export interface MessageIdState {
  byRawId: Map<string, string>;
  byRef: Map<string, string>;
  nextRef: number;
}

export interface Nudges {
  contextLimitAnchors: Set<string>;
  turnNudgeAnchors: Set<string>;
  iterationNudgeAnchors: Set<string>;
}

export interface CompressionTimingState {
  startsByCallId: Map<string, number>;
  pendingByCallId: Map<string, PendingCompressionDuration>;
}

export interface PendingCompressionDuration {
  messageId: string;
  callId: string;
  durationMs: number;
}

export interface SessionState {
  sessionId: string | null;
  isSubAgent: boolean;
  manualMode: false | "active" | "compress-pending";
  compressPermission: "ask" | "allow" | "deny" | undefined;
  pendingManualTrigger: PendingManualTrigger | null;
  prune: Prune;
  nudges: Nudges;
  stats: SessionStats;
  compressionTiming: CompressionTimingState;
  toolParameters: Map<string, ToolParameterEntry>;
  subAgentResultCache: Map<string, string>;
  toolIdList: string[];
  messageIds: MessageIdState;
  lastCompaction: number;
  currentTurn: number;
  modelContextLimit: number | undefined;
  systemPromptTokens: number | undefined;
  /**
   * v2-only: live token usage derived from `session.step.ended` events (v2
   * request messages carry no token data; v1 re-derived this from message
   * tokens). Reset on compaction and session init. Not persisted.
   */
  currentTokenUsage: number;
  /**
   * v2-only: input-side tokens (input + cache read/write) of the first step
   * after session init/compaction; the event-based stand-in for v1's
   * first-assistant-message token read in `cacheSystemPromptTokens`.
   * In-memory only, not persisted.
   */
  firstStepInput: number | undefined;
}
