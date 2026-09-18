import { createHash } from "node:crypto";
import type { DcpMessage, DcpTextPart, DcpToolResultPart, SessionState } from "../types.ts";
import { isMessageCompacted } from "../state/utils.ts";
import { findToolResult, isTextPart, isToolCallPart, toolCallParts } from "./shape.ts";

/**
 * v2 port of v1 `lib/messages/utils.ts`. Shape adaptation: v1 synthetic
 * messages carried info/parts; v2 synthetic messages are plain
 * `{ id, role: "user", content: [{ type: "text", text }] }`. Tool outputs
 * live in separate tool-result parts, so tag-appending and `hasContent`
 * resolve the corresponding results from the full message list.
 */

const SUMMARY_ID_HASH_LENGTH = 16;
// eslint-disable-next-line
const DCP_BLOCK_ID_TAG_REGEX = /(<dcp-message-id(?=[\s>])[^>]*>)b\d+(<\/dcp-message-id>)/g;
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi;
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi;
const INJECTED_MESSAGE_ID_SUFFIX_REGEX = /(?<=\n)<dcp-message-id[^>]*>m\d+<\/dcp-message-id>\s*$/;
const HALLUCINATED_PARAMETER_SUFFIX_REGEX = /(?<=\n)m\d+<\/parameter>\s*$/;

const generateStableId = (prefix: string, seed: string): string => {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH);
  return `${prefix}_${hash}`;
};

export const createSyntheticUserMessage = (
  baseMessage: DcpMessage,
  content: string,
  stableSeed?: string,
): DcpMessage => {
  const deterministicSeed = stableSeed?.trim() || baseMessage.id || content;
  const messageId = generateStableId("msg_dcp_summary", deterministicSeed);
  return {
    id: messageId,
    role: "user",
    content: [{ type: "text", text: content }],
  };
};

export const createSyntheticTextPart = (
  baseMessage: DcpMessage,
  content: string,
  stableSeed?: string,
): DcpTextPart => {
  // v2 text parts carry no id; the stable seed is kept for signature parity
  // with v1 (and for future use by anchored nudges).
  void stableSeed;
  void baseMessage;
  return { type: "text", text: content };
};

const findLastTextPart = (message: DcpMessage): DcpTextPart | null => {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i];
    if (isTextPart(part)) return part;
  }
  return null;
};

export const appendToLastTextPart = (message: DcpMessage, injection: string): boolean => {
  const textPart = findLastTextPart(message);
  if (!textPart) return false;
  return appendToTextPart(textPart, injection);
};

export const appendToTextPart = (part: DcpTextPart, injection: string): boolean => {
  if (typeof part.text !== "string") return false;
  const normalizedInjection = injection.replace(/^\n+/, "");
  if (!normalizedInjection.trim()) return false;
  if (part.text.includes(normalizedInjection)) return true;
  const baseText = part.text.replace(/\n*$/, "");
  part.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection;
  return true;
};

const isStringToolResult = (part: DcpToolResultPart): boolean =>
  part.result.type === "text" && typeof part.result.value === "string";

export const appendToToolPart = (part: DcpToolResultPart, tag: string): boolean => {
  if (!isStringToolResult(part)) return false;
  const output = part.result.value as string;
  if (output.includes(tag)) return true;
  part.result.value = `${output}${tag}`;
  return true;
};

/** Append a tag to every completed string tool output of this message's tool calls. */
export const appendToAllToolParts = (
  message: DcpMessage,
  messages: DcpMessage[],
  tag: string,
): boolean => {
  let injected = false;
  for (const call of toolCallParts(message)) {
    const result = findToolResult(messages, call.id);
    if (result && result.result.type !== "error") {
      injected = appendToToolPart(result, tag) || injected;
    }
  }
  return injected;
};

/** Whether the message has visible content (text, or a completed string tool output). */
export const hasContent = (message: DcpMessage, messages: DcpMessage[]): boolean => {
  for (const part of message.content) {
    if (isTextPart(part) && typeof part.text === "string" && part.text.trim().length > 0)
      return true;
  }
  for (const call of toolCallParts(message)) {
    const result = findToolResult(messages, call.id);
    if (result && result.result.type !== "error" && isStringToolResult(result)) return true;
  }
  return false;
};

export function buildToolIdList(state: SessionState, messages: DcpMessage[]): string[] {
  const toolIds: string[] = [];
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) continue;
    for (const part of msg.content) {
      if (isToolCallPart(part) && part.id) {
        toolIds.push(part.id);
      }
    }
  }
  state.toolIdList = toolIds;
  return toolIds;
}

export const replaceBlockIdsWithBlocked = (text: string): string => {
  DCP_BLOCK_ID_TAG_REGEX.lastIndex = 0;
  return text.replace(DCP_BLOCK_ID_TAG_REGEX, "$1BLOCKED$2");
};

export const stripHallucinationsFromString = (text: string): string => {
  const withoutKnownSuffixes = text
    .replace(INJECTED_MESSAGE_ID_SUFFIX_REGEX, "")
    .replace(HALLUCINATED_PARAMETER_SUFFIX_REGEX, "");
  DCP_PAIRED_TAG_REGEX.lastIndex = 0;
  DCP_UNPAIRED_TAG_REGEX.lastIndex = 0;
  return withoutKnownSuffixes.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "");
};

export const stripHallucinations = (messages: DcpMessage[]): void => {
  for (const message of messages) {
    for (const part of message.content) {
      if (isTextPart(part) && typeof part.text === "string") {
        part.text = stripHallucinationsFromString(part.text);
      }
      if (part.type === "tool-result" && isStringToolResult(part)) {
        part.result.value = stripHallucinationsFromString(part.result.value as string);
      }
    }
  }
};
