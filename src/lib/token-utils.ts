import * as _anthropicTokenizer from "@anthropic-ai/tokenizer";
import type { DcpMessage, DcpToolCallPart, DcpToolResultPart, SessionState } from "./types.ts";
import { findToolResult, isTextPart, toolCallParts } from "./messages/shape.ts";

/**
 * v2 port of v1 `lib/token-utils.ts`.
 *
 * v2 deltas: v2 request messages carry no token counts or timestamps, so
 * `getCurrentTokenUsage` reads the event-derived `state.currentTokenUsage`
 * (populated from `session.step.ended`, reset on compaction/session init)
 * instead of re-deriving from assistant message tokens. `getCurrentParams`
 * is dropped: the v2 `context` event carries the model ref directly.
 */

const anthropicCountTokens = ((_anthropicTokenizer as { countTokens?: (text: string) => number })
  .countTokens ??
  (_anthropicTokenizer as { default?: { countTokens?: (text: string) => number } }).default
    ?.countTokens) as (text: string) => number;

export function getCurrentTokenUsage(state: SessionState): number {
  return state.currentTokenUsage > 0 ? state.currentTokenUsage : 0;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return anthropicCountTokens(text);
  } catch {
    return Math.round(text.length / 4);
  }
}

export function estimateTokensBatch(texts: string[]): number {
  if (texts.length === 0) return 0;
  return countTokens(texts.join(" "));
}

export const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";

function stringifyToolContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** String form of a completed (non-error) tool result, if any. */
export function extractCompletedToolOutput(
  part: DcpToolResultPart | undefined,
): string | undefined {
  if (!part) return undefined;
  if (part.result.type === "error" || part.result.value === undefined) return undefined;
  return stringifyToolContent(part.result.value);
}

/** Tokenizable content of a tool call: its input plus the completed output or the error text. */
export function extractToolContent(call: DcpToolCallPart, result?: DcpToolResultPart): string[] {
  const contents: string[] = [];
  if (call.input !== undefined) {
    contents.push(stringifyToolContent(call.input));
  }
  const completedOutput = extractCompletedToolOutput(result);
  if (completedOutput !== undefined) {
    contents.push(completedOutput);
  } else if (result && result.result.type === "error" && result.result.value !== undefined) {
    contents.push(stringifyToolContent(result.result.value));
  }
  return contents;
}

export function countToolTokens(call: DcpToolCallPart, result?: DcpToolResultPart): number {
  return estimateTokensBatch(extractToolContent(call, result));
}

export function getTotalToolTokens(state: SessionState, toolIds: string[]): number {
  let total = 0;
  for (const id of toolIds) {
    const entry = state.toolParameters.get(id);
    total += entry?.tokenCount ?? 0;
  }
  return total;
}

export function countMessageTextTokens(msg: DcpMessage): number {
  const texts: string[] = [];
  for (const part of msg.content) {
    if (isTextPart(part)) {
      texts.push(part.text);
    }
  }
  if (texts.length === 0) return 0;
  return estimateTokensBatch(texts);
}

export function countAllMessageTokens(msg: DcpMessage, messages: DcpMessage[]): number {
  const texts: string[] = [];
  for (const part of msg.content) {
    if (isTextPart(part)) {
      texts.push(part.text);
    } else if (part.type === "tool-call") {
      const result = findToolResult(messages, part.id);
      texts.push(...extractToolContent(part, result));
    }
  }
  if (texts.length === 0) return 0;
  return estimateTokensBatch(texts);
}
