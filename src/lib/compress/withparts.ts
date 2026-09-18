import type { DcpConfig } from "../../config.ts";
import type { Logger } from "../logger.ts";
import type { SessionState, ToolStatus } from "../types.ts";
import { countTokens } from "../token-utils.ts";
import { MESSAGE_REF_MAX_INDEX, formatMessageRef } from "../message-ids.ts";

/**
 * WithParts — v1 session-message shape, structural mirror.
 *
 * v1's compress internals (search, range-utils, message-utils,
 * protected-content, state, pipeline) all operate on the host session
 * messages `{ info, parts }`, so they port near-verbatim over this shape.
 * The v2 durable `SessionMessageInfo[]` from `ctx.session.context` is
 * adapted into this shape by the durable adapter (see index.ts wiring).
 *
 * `info.summary === true` marks a native compaction summary (the v1
 * compaction marker); the durable adapter maps durable `compaction`
 * entries onto it so `findLastCompactionTimestamp` works verbatim.
 */

export interface WithPartInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number };
  summary?: boolean;
  agent?: string;
  model?: { providerID?: string; modelID?: string; variant?: string };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface ToolPartState {
  status: ToolStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  time?: { compacted?: boolean; start?: number; end?: number };
}

export interface WithPart {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: ToolPartState;
  ignored?: boolean;
  synthetic?: boolean;
  [key: string]: unknown;
}

export interface WithParts {
  info: WithPartInfo;
  parts: WithPart[];
}

// v1 lib/messages/shape.ts (verbatim)

export function isMessageWithInfo(message: unknown): message is WithParts {
  if (!message || typeof message !== "object") {
    return false;
  }

  const info = (message as { info?: WithPartInfo }).info;
  const parts = (message as { parts?: WithPart[] }).parts;
  if (!info || typeof info !== "object") {
    return false;
  }

  return (
    typeof info.id === "string" &&
    info.id.length > 0 &&
    typeof info.sessionID === "string" &&
    info.sessionID.length > 0 &&
    (info.role === "user" || info.role === "assistant") &&
    info.time &&
    typeof info.time === "object" &&
    typeof info.time.created === "number" &&
    Array.isArray(parts)
  );
}

export function filterMessages(messages: unknown): WithParts[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.filter(isMessageWithInfo);
}

export function filterMessagesInPlace(messages: unknown): WithParts[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  let writeIndex = 0;

  for (const message of messages) {
    if (isMessageWithInfo(message)) {
      messages[writeIndex++] = message;
    }
  }

  messages.length = writeIndex;
  return messages as WithParts[];
}

// v1 lib/messages/query.ts (verbatim, config = DcpConfig)

export const getLastUserMessage = (
  messages: WithParts[],
  startIndex?: number,
): WithParts | null => {
  const start = startIndex ?? messages.length - 1;
  for (let i = start; i >= 0; i--) {
    const msg = messages[i];
    if (!isMessageWithInfo(msg)) {
      continue;
    }
    if (msg.info.role === "user" && !isIgnoredUserMessage(msg)) {
      return msg;
    }
  }
  return null;
};

export const messageHasCompress = (message: WithParts): boolean => {
  if (!isMessageWithInfo(message)) {
    return false;
  }

  if (message.info.role !== "assistant") {
    return false;
  }

  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts.some(
    (part) =>
      part.type === "tool" && part.tool === "compress" && part.state?.status === "completed",
  );
};

export const isIgnoredUserMessage = (message: WithParts): boolean => {
  if (!isMessageWithInfo(message)) {
    return false;
  }

  if (message.info.role !== "user") {
    return false;
  }

  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length === 0) {
    return true;
  }

  for (const part of parts) {
    if (!part.ignored) {
      return false;
    }
  }

  return true;
};

export function isProtectedUserMessage(config: DcpConfig, message: WithParts): boolean {
  if (!isMessageWithInfo(message)) {
    return false;
  }

  return (
    config.compress.mode === "message" &&
    config.compress.protectUserMessages &&
    message.info.role === "user" &&
    !isIgnoredUserMessage(message)
  );
}

// v1 lib/state/utils.ts (verbatim)

export const isMessageCompacted = (state: SessionState, msg: WithParts): boolean => {
  if (!isMessageWithInfo(msg)) {
    return false;
  }

  if (msg.info.time.created < state.lastCompaction) {
    return true;
  }
  const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id);
  if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
    return true;
  }
  return false;
};

export function findLastCompactionTimestamp(messages: WithParts[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isMessageWithInfo(msg)) {
      continue;
    }
    if (msg.info.role === "assistant" && msg.info.summary === true) {
      return msg.info.time.created;
    }
  }
  return 0;
}

/**
 * v2 delta (matches the #12 request-shape convention): v1 counted
 * `step-start` parts; the v2 durable entries carry no step markers, so
 * turns are the non-compacted, non-summary assistant messages.
 */
export function countTurns(state: SessionState, messages: WithParts[]): number {
  let turnCount = 0;
  for (const msg of messages) {
    if (!isMessageWithInfo(msg)) {
      continue;
    }
    if (msg.info.summary === true) {
      continue;
    }
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    if (msg.info.role === "assistant") {
      turnCount++;
    }
  }
  return turnCount;
}

// v1 lib/state/utils.ts (verbatim)

export function collectTurnNudgeAnchors(messages: WithParts[]): Set<string> {
  const anchors = new Set<string>();
  let pendingUserMessageId: string | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (messageHasCompress(message)) {
      break;
    }

    if (message.info.role === "user") {
      if (!isIgnoredUserMessage(message)) {
        pendingUserMessageId = message.info.id;
      }
      continue;
    }

    if (message.info.role === "assistant" && pendingUserMessageId) {
      anchors.add(message.info.id);
      anchors.add(pendingUserMessageId);
      pendingUserMessageId = null;
    }
  }

  return anchors;
}

// v1 lib/token-utils.ts (WithParts-based originals; countTokens shared)

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";

function stringifyToolContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function extractCompletedToolOutput(part: any): string | undefined {
  if (
    part?.type !== "tool" ||
    part.state?.status !== "completed" ||
    part.state?.output === undefined
  ) {
    return undefined;
  }

  if (part.state?.time?.compacted) {
    return COMPACTED_TOOL_OUTPUT_PLACEHOLDER;
  }

  return stringifyToolContent(part.state.output);
}

export function extractToolContent(part: any): string[] {
  const contents: string[] = [];

  if (part?.type !== "tool") {
    return contents;
  }

  if (part.state?.input !== undefined) {
    contents.push(stringifyToolContent(part.state.input));
  }

  const completedOutput = extractCompletedToolOutput(part);
  if (completedOutput !== undefined) {
    contents.push(completedOutput);
  } else if (part.state?.status === "error" && part.state?.error) {
    contents.push(stringifyToolContent(part.state.error));
  }

  return contents;
}

export function countToolTokens(part: any): number {
  const contents = extractToolContent(part);
  return estimateTokensBatch(contents);
}

export function countMessageTextTokens(msg: WithParts): number {
  const texts: string[] = [];
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  if (texts.length === 0) return 0;
  return estimateTokensBatch(texts);
}

export function countAllMessageTokens(msg: WithParts): number {
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else {
      texts.push(...extractToolContent(part));
    }
  }
  if (texts.length === 0) return 0;
  return estimateTokensBatch(texts);
}

export function estimateTokensBatch(texts: string[]): number {
  if (texts.length === 0) return 0;
  return countTokens(texts.join(" "));
}

// v1 lib/token-utils.ts (verbatim; v1's host SDK casts replaced by the
// structural WithPartInfo fields)

export function getCurrentParams(
  state: SessionState,
  messages: WithParts[],
  logger: Logger,
): {
  providerId: string | undefined;
  modelId: string | undefined;
  agent: string | undefined;
  variant: string | undefined;
} {
  const userMsg = getLastUserMessage(messages);
  if (!userMsg) {
    logger.debug("No user message found when determining current params");
    return {
      providerId: undefined,
      modelId: undefined,
      agent: undefined,
      variant: undefined,
    };
  }
  const userInfo = userMsg.info;
  const agent: string | undefined = userInfo.agent;
  const providerId: string | undefined = userInfo.model?.providerID;
  const modelId: string | undefined = userInfo.model?.modelID;
  const variant: string | undefined = userInfo.model?.variant;

  return { providerId, modelId, agent, variant };
}

// v1 lib/message-ids.ts assignMessageRefs (WithParts-based original)

export function assignMessageRefs(state: SessionState, messages: WithParts[]): number {
  let assigned = 0;
  let skippedSubAgentPrompt = false;

  for (const message of messages) {
    if (isIgnoredUserMessage(message)) {
      continue;
    }

    if (state.isSubAgent && !skippedSubAgentPrompt && message.info.role === "user") {
      skippedSubAgentPrompt = true;
      continue;
    }

    const rawMessageId = message.info.id;
    if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
      continue;
    }

    const existingRef = state.messageIds.byRawId.get(rawMessageId);
    if (existingRef) {
      if (state.messageIds.byRef.get(existingRef) !== rawMessageId) {
        state.messageIds.byRef.set(existingRef, rawMessageId);
      }
      continue;
    }

    const ref = allocateNextMessageRef(state);
    state.messageIds.byRawId.set(rawMessageId, ref);
    state.messageIds.byRef.set(ref, rawMessageId);
    assigned++;
  }

  return assigned;
}

function allocateNextMessageRef(state: SessionState): string {
  let candidate = Number.isInteger(state.messageIds.nextRef)
    ? Math.max(1, state.messageIds.nextRef)
    : 1;

  while (candidate <= MESSAGE_REF_MAX_INDEX) {
    const ref = formatMessageRef(candidate);
    if (!state.messageIds.byRef.has(ref)) {
      state.messageIds.nextRef = candidate + 1;
      return ref;
    }
    candidate++;
  }

  throw new Error(
    `Message ID alias capacity exceeded. Cannot allocate more than ${formatMessageRef(
      MESSAGE_REF_MAX_INDEX,
    )} aliases in this session.`,
  );
}
