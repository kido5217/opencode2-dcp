import type { DcpConfig } from "../../config.ts";
import type { DcpMessage } from "../types.ts";
import { findToolResult, isIgnoredPart, toolCallParts } from "./shape.ts";

/**
 * v2 port of v1 `lib/messages/query.ts`. The v1 shape carried tool status on
 * the tool part itself; the v2 request shape carries results in separate
 * messages, so `messageHasCompress` takes the full message list to resolve
 * the corresponding tool result.
 */

export const getLastUserMessage = (
  messages: DcpMessage[],
  startIndex?: number,
): DcpMessage | null => {
  const start = startIndex ?? messages.length - 1;
  for (let i = start; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && !isIgnoredUserMessage(msg)) {
      return msg;
    }
  }
  return null;
};

export const messageHasCompress = (message: DcpMessage, messages: DcpMessage[]): boolean => {
  if (message.role !== "assistant") {
    return false;
  }
  return toolCallParts(message).some((part) => {
    if (part.name !== "compress") return false;
    const result = findToolResult(messages, part.id);
    return result !== undefined && result.result.type !== "error";
  });
};

export const isIgnoredUserMessage = (message: DcpMessage): boolean => {
  if (message.role !== "user") {
    return false;
  }
  if (message.content.length === 0) {
    return true;
  }
  for (const part of message.content) {
    if (!isIgnoredPart(part)) {
      return false;
    }
  }
  return true;
};

export function isProtectedUserMessage(config: DcpConfig, message: DcpMessage): boolean {
  return (
    config.compress.mode === "message" &&
    config.compress.protectUserMessages &&
    message.role === "user" &&
    !isIgnoredUserMessage(message)
  );
}
