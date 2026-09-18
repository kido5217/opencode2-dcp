import type { DcpToolCallPart } from "../types.ts";

/**
 * v2 port of v1 `lib/subagents/subagent-results.ts`.
 *
 * Shape adaptation: v1 read the subagent's transcript through
 * `client.session.messages` (session-message shape, tool state inline). The
 * v2 plugin reads it through `ctx.session.context({sessionID})` (durable
 * transcript, `AssistantContent[]`). The structural types below mirror the
 * installed @opencode/schema durable assistant shape.
 */

export interface DurableTextContent {
  type: "text";
  text?: string;
  state?: unknown;
}

export interface DurableToolContent {
  type: "tool";
  id?: string;
  name?: string;
  executed?: boolean;
  state?: {
    status?: string;
    input?: unknown;
    content?: unknown;
    error?: unknown;
    metadata?: Record<string, unknown>;
  };
}

export type DurableAssistantContent = DurableTextContent | DurableToolContent;

export interface DurableAssistantMessage {
  type: "assistant";
  agent?: string;
  model?: { id?: string; providerID?: string };
  content?: DurableAssistantContent[];
}

export type DurableSessionMessage =
  DurableAssistantMessage | { type: string; [key: string]: unknown };

const SUB_AGENT_RESULT_BLOCK_REGEX = /(<task_result>\s*)([\s\S]*?)(\s*<\/task_result>)/i;

export function getSubAgentId(toolCall: DcpToolCallPart): string | null {
  const sessionId = toolCall.metadata?.sessionId;
  if (typeof sessionId !== "string") {
    return null;
  }

  const value = sessionId.trim();
  return value.length > 0 ? value : null;
}

export function buildSubagentResultText(messages: DurableSessionMessage[]): string {
  const assistantMessages = messages.filter(
    (message): message is DurableAssistantMessage =>
      typeof message.type === "string" && message.type === "assistant",
  );
  if (assistantMessages.length === 0) {
    return "";
  }

  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const lastText = getLastTextContent(lastAssistant);

  if (assistantMessages.length < 2) {
    return lastText;
  }

  const secondToLastAssistant = assistantMessages[assistantMessages.length - 2];
  if (!assistantMessageHasCompressTool(secondToLastAssistant)) {
    return lastText;
  }

  const secondToLastText = getLastTextContent(secondToLastAssistant);
  return [secondToLastText, lastText].filter((text) => text.length > 0).join("\n\n");
}

export function mergeSubagentResult(output: string, subAgentResultText: string): string {
  if (!subAgentResultText || typeof output !== "string") {
    return output;
  }

  return output.replace(
    SUB_AGENT_RESULT_BLOCK_REGEX,
    (_match, openTag: string, _body: string, closeTag: string) =>
      `${openTag}${subAgentResultText}${closeTag}`,
  );
}

function getLastTextContent(message: DurableAssistantMessage): string {
  const content = Array.isArray(message.content) ? message.content : [];
  for (let index = content.length - 1; index >= 0; index--) {
    const part = content[index];
    if (part.type !== "text" || typeof part.text !== "string") {
      continue;
    }

    const text = part.text.trim();
    if (!text) {
      continue;
    }

    return text;
  }

  return "";
}

function assistantMessageHasCompressTool(message: DurableAssistantMessage): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.some(
    (part) =>
      part.type === "tool" && part.name === "compress" && part.state?.status === "completed",
  );
}
