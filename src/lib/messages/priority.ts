import type { DcpConfig } from "../../config.ts";
import type { DcpMessage, SessionState } from "../types.ts";
import { countAllMessageTokens } from "../token-utils.ts";
import { isMessageCompacted } from "../state/utils.ts";
import { isIgnoredUserMessage, isProtectedUserMessage, messageHasCompress } from "./query.ts";

/**
 * v2 port of v1 `lib/messages/priority.ts` (message-mode message priorities).
 */

const MEDIUM_PRIORITY_MIN_TOKENS = 500;
const HIGH_PRIORITY_MIN_TOKENS = 5000;

export type MessagePriority = "low" | "medium" | "high";

export interface CompressionPriorityEntry {
  ref: string;
  tokenCount: number;
  priority: MessagePriority;
}

export type CompressionPriorityMap = Map<string, CompressionPriorityEntry>;

export function buildPriorityMap(
  config: DcpConfig,
  state: SessionState,
  messages: DcpMessage[],
): CompressionPriorityMap {
  if (config.compress.mode !== "message") {
    return new Map();
  }
  const priorities: CompressionPriorityMap = new Map();

  for (const message of messages) {
    if (isIgnoredUserMessage(message)) {
      continue;
    }

    if (isProtectedUserMessage(config, message)) {
      continue;
    }

    if (isMessageCompacted(state, message)) {
      continue;
    }

    const rawMessageId = message.id;
    if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
      continue;
    }

    const ref = state.messageIds.byRawId.get(rawMessageId);
    if (!ref) {
      continue;
    }

    const tokenCount = countAllMessageTokens(message, messages);
    priorities.set(rawMessageId, {
      ref,
      tokenCount,
      priority: messageHasCompress(message, messages)
        ? "high"
        : classifyMessagePriority(tokenCount),
    });
  }

  return priorities;
}

export function classifyMessagePriority(tokenCount: number): MessagePriority {
  if (tokenCount >= HIGH_PRIORITY_MIN_TOKENS) {
    return "high";
  }

  if (tokenCount >= MEDIUM_PRIORITY_MIN_TOKENS) {
    return "medium";
  }

  return "low";
}

export function listPriorityRefsBeforeIndex(
  messages: DcpMessage[],
  priorities: CompressionPriorityMap,
  anchorIndex: number,
  priority: MessagePriority,
): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const upperBound = Math.max(0, Math.min(anchorIndex, messages.length));

  for (let index = 0; index < upperBound; index++) {
    const rawMessageId = messages[index]?.id;
    if (typeof rawMessageId !== "string") {
      continue;
    }

    const entry = priorities.get(rawMessageId);
    if (!entry || entry.priority !== priority || seen.has(entry.ref)) {
      continue;
    }

    seen.add(entry.ref);
    refs.push(entry.ref);
  }

  return refs;
}
