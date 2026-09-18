import type { DcpConfig } from "../config.ts";
import type { DcpMessage, SessionState } from "./types.ts";
import { formatMessageIdTag } from "./message-ids.ts";
import type { CompressionPriorityMap } from "./messages/priority.ts";
import { compressPermission } from "./compress-permission.ts";
import { isIgnoredUserMessage, isProtectedUserMessage } from "./messages/query.ts";
import {
  appendToLastTextPart,
  appendToTextPart,
  appendToAllToolParts,
  createSyntheticTextPart,
  hasContent,
} from "./messages/utils.ts";
import { isTextPart, isToolCallPart } from "./messages/shape.ts";

/**
 * v2 port of v1's `injectMessageIds` (from `lib/messages/inject/inject.ts`).
 *
 * Boundary ID tags are injected into the outgoing request only (ephemeral):
 * every message with an allocated reference gets its `mNNNN` tag (or
 * `BLOCKED` for protected user messages in message mode) appended to its
 * text parts, or to its completed tool results when the message has no text.
 */
export const injectMessageIds = (
  state: SessionState,
  config: DcpConfig,
  messages: DcpMessage[],
  compressionPriorities?: CompressionPriorityMap,
): void => {
  if (compressPermission(state, config) === "deny") {
    return;
  }

  for (const message of messages) {
    if (isIgnoredUserMessage(message)) {
      continue;
    }

    const rawMessageId = message.id;
    if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
      continue;
    }

    const messageRef = state.messageIds.byRawId.get(rawMessageId);
    if (!messageRef) {
      continue;
    }

    const isBlockedMessage = isProtectedUserMessage(config, message);
    const priority =
      config.compress.mode === "message" && !isBlockedMessage
        ? compressionPriorities?.get(rawMessageId)?.priority
        : undefined;
    const tag = formatMessageIdTag(
      isBlockedMessage ? "BLOCKED" : messageRef,
      priority ? { priority } : undefined,
    );

    if (message.role === "user") {
      let injected = false;
      for (const part of message.content) {
        if (isTextPart(part)) {
          injected = appendToTextPart(part, tag) || injected;
        }
      }

      if (injected) {
        continue;
      }

      message.content.push(createSyntheticTextPart(message, tag));
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    if (!hasContent(message, messages)) {
      continue;
    }

    if (appendToAllToolParts(message, messages, tag)) {
      continue;
    }

    if (appendToLastTextPart(message, tag)) {
      continue;
    }

    const syntheticPart = createSyntheticTextPart(message, tag);
    const firstToolIndex = message.content.findIndex((p) => isToolCallPart(p));
    if (firstToolIndex === -1) {
      message.content.push(syntheticPart);
    } else {
      message.content.splice(firstToolIndex, 0, syntheticPart);
    }
  }
};
