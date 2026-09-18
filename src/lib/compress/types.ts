import type { DcpConfig } from "../../config.ts";
import type { Logger } from "../logger.ts";
import type { PromptStore } from "../prompts/store.ts";
import type { CompressionBlock, CompressionMode, SessionState } from "../types.ts";
import type { SessionDeps } from "../state/state.ts";
import type { WithParts } from "./withparts.ts";

export interface ToolContext {
  state: SessionState;
  logger: Logger;
  config: DcpConfig;
  prompts: PromptStore;
  deps: SessionDeps;
  fetchDurableMessages: (sessionID: string) => Promise<WithParts[]>;
}

// v2 equivalent of the v1 plugin tool-execution context (sessionID/messageID/id/progress).
export interface ToolRunContext {
  sessionID: string;
  messageID: string;
  id: string;
  progress?: (update: Record<string, unknown>) => Promise<void>;
}

// v2 tool definition returned by the range.ts / message.ts factories; index.ts
// wires it into ctx.tool.transform with options { permission: "compress" }.
export interface CompressToolInfo {
  description: string;
  input: Record<string, unknown>;
  execute: (input: unknown, context: ToolRunContext) => Promise<{ content: string }>;
}

export interface CompressRangeEntry {
  startId: string;
  endId: string;
  summary: string;
}

export interface CompressRangeToolArgs {
  topic: string;
  content: CompressRangeEntry[];
}

export interface CompressMessageEntry {
  messageId: string;
  topic: string;
  summary: string;
}

export interface CompressMessageToolArgs {
  topic: string;
  content: CompressMessageEntry[];
}

export interface BoundaryReference {
  kind: "message" | "compressed-block";
  rawIndex: number;
  messageId?: string;
  blockId?: number;
  anchorMessageId?: string;
}

export interface SearchContext {
  rawMessages: WithParts[];
  rawMessagesById: Map<string, WithParts>;
  rawIndexById: Map<string, number>;
  summaryByBlockId: Map<number, CompressionBlock>;
}

export interface SelectionResolution {
  startReference: BoundaryReference;
  endReference: BoundaryReference;
  messageIds: string[];
  messageTokenById: Map<string, number>;
  toolIds: string[];
  requiredBlockIds: number[];
}

export interface ResolvedMessageCompression {
  entry: CompressMessageEntry;
  selection: SelectionResolution;
  anchorMessageId: string;
}

export interface ResolvedRangeCompression {
  index: number;
  entry: CompressRangeEntry;
  selection: SelectionResolution;
  anchorMessageId: string;
}

export interface ResolvedMessageCompressionsResult {
  plans: ResolvedMessageCompression[];
  skippedIssues: string[];
  skippedCount: number;
}

export interface ParsedBlockPlaceholder {
  raw: string;
  blockId: number;
  startIndex: number;
  endIndex: number;
}

export interface InjectedSummaryResult {
  expandedSummary: string;
  consumedBlockIds: number[];
}

export interface AppliedCompressionResult {
  compressedTokens: number;
  messageIds: string[];
  newlyCompressedMessageIds: string[];
  newlyCompressedToolIds: string[];
}

export interface CompressionStateInput {
  topic: string;
  batchTopic: string;
  startId: string;
  endId: string;
  mode: CompressionMode;
  runId: number;
  compressMessageId: string;
  compressCallId?: string;
  summaryTokens: number;
}
