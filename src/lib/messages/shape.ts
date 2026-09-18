import type {
  DcpContentPart,
  DcpMessage,
  DcpTextPart,
  DcpToolCallPart,
  DcpToolResultPart,
} from "../types.ts";

/**
 * v2 shape guards and accessors. v1 operated on the durable session-message
 * shape (`WithParts = { info, parts }`); the v2 `context` hook receives the
 * flat request shape. All DCP logic that is shape-agnostic builds on these
 * accessors so the adaptation stays in one place.
 */

const ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

export function isDcpMessage(value: unknown): value is DcpMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  if (!ROLES.includes(msg.role as string)) return false;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as unknown[]).every((part) => isDcpContentPart(part));
}

function isDcpContentPart(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as Record<string, unknown>).type;
  switch (type) {
    case "text":
      return typeof (value as DcpTextPart).text === "string";
    case "media":
      return typeof (value as Record<string, unknown>).mediaType === "string";
    case "tool-call":
      return (
        typeof (value as DcpToolCallPart).id === "string" &&
        typeof (value as DcpToolCallPart).name === "string"
      );
    case "tool-result":
      return (
        typeof (value as DcpToolResultPart).id === "string" &&
        typeof (value as DcpToolResultPart).name === "string"
      );
    case "reasoning":
      return typeof (value as Record<string, unknown>).text === "string";
    case "compaction":
    case "effort":
      return true;
    default:
      return false;
  }
}

/**
 * Drop messages the pipeline cannot reason about (bad role or non-array
 * content), in place. v1 parity: `filterMessagesInPlace`.
 */
export function filterMessagesInPlace(messages: DcpMessage[]): void {
  let write = 0;
  for (let read = 0; read < messages.length; read++) {
    if (isDcpMessage(messages[read])) {
      messages[write++] = messages[read];
    }
  }
  messages.length = write;
}

export function isTextPart(part: DcpContentPart): part is DcpTextPart {
  return part.type === "text";
}

export function isToolCallPart(part: DcpContentPart): part is DcpToolCallPart {
  return part.type === "tool-call";
}

export function isToolResultPart(part: DcpContentPart): part is DcpToolResultPart {
  return part.type === "tool-result";
}

export function textParts(message: DcpMessage): DcpTextPart[] {
  return message.content.filter(isTextPart);
}

export function toolCallParts(message: DcpMessage): DcpToolCallPart[] {
  return message.content.filter(isToolCallPart);
}

/** All tool calls in the request, in message order. */
export function allToolCalls(messages: DcpMessage[]): DcpToolCallPart[] {
  const out: DcpToolCallPart[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (isToolCallPart(part)) out.push(part);
    }
  }
  return out;
}

/** All tool results in the request, in message order. */
export function allToolResults(messages: DcpMessage[]): DcpToolResultPart[] {
  const out: DcpToolResultPart[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (isToolResultPart(part)) out.push(part);
    }
  }
  return out;
}

/**
 * Defensive read of the v1 `part.ignored` flag. Not part of the 2.0.7
 * request schema, but the host may surface ignored parts through it; v1
 * skipped user messages whose parts were all ignored.
 */
export function isIgnoredPart(part: DcpContentPart): boolean {
  return (part as { ignored?: unknown }).ignored === true;
}

/** The tool call part whose result is `resultPart`, if any (same `id`). */
export function findToolCall(
  messages: DcpMessage[],
  resultId: string,
): DcpToolCallPart | undefined {
  for (const message of messages) {
    for (const part of message.content) {
      if (isToolCallPart(part) && part.id === resultId) return part;
    }
  }
  return undefined;
}

/** The first tool result part matching a tool call id, if any. */
export function findToolResult(
  messages: DcpMessage[],
  callId: string,
): DcpToolResultPart | undefined {
  for (const message of messages) {
    for (const part of message.content) {
      if (isToolResultPart(part) && part.id === callId) return part;
    }
  }
  return undefined;
}
