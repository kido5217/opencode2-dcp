import type { DcpMessage, SessionState } from "../types.ts";
import type { Logger } from "../logger.ts";
import type { DcpConfig } from "../../config.ts";
import { isMessageCompacted } from "../state/utils.ts";
import { createSyntheticUserMessage, replaceBlockIdsWithBlocked } from "./utils.ts";
import { getLastUserMessage } from "./query.ts";
import { findToolResult, isToolCallPart, isToolResultPart } from "./shape.ts";

/**
 * v2 port of v1 `lib/messages/prune.ts`.
 *
 * Shape adaptation: v1 tool parts carried input/output/status inline; the v2
 * request shape splits them — tool calls live in assistant messages and
 * results in separate tool-result parts. "Completed" means a non-error
 * result exists; the placeholders now replace the result value (tool
 * outputs) or string input values (tool inputs/errors).
 *
 * `pruneFullTool` stays disabled, as in v1 (commented out there).
 */

const PRUNED_TOOL_OUTPUT_REPLACEMENT =
  "[Output removed to save context - information superseded or no longer needed]";
const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]";
const PRUNED_QUESTION_INPUT_REPLACEMENT = "[questions removed - see output for user's answers]";

export const prune = (
  state: SessionState,
  logger: Logger,
  config: DcpConfig,
  messages: DcpMessage[],
): void => {
  filterCompressedRanges(state, logger, config, messages);
  // pruneFullTool(state, logger, messages)
  pruneToolOutputs(state, logger, messages);
  pruneToolInputs(state, logger, messages);
  pruneToolErrors(state, logger, messages);
};

const pruneToolOutputs = (state: SessionState, _logger: Logger, messages: DcpMessage[]): void => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    for (const part of msg.content) {
      if (!isToolResultPart(part)) {
        continue;
      }
      if (!state.prune.tools.has(part.id)) {
        continue;
      }
      if (part.result.type === "error") {
        continue;
      }
      if (part.name === "question" || part.name === "edit" || part.name === "write") {
        continue;
      }
      part.result = { type: "text", value: PRUNED_TOOL_OUTPUT_REPLACEMENT };
    }
  }
};

const pruneToolInputs = (state: SessionState, _logger: Logger, messages: DcpMessage[]): void => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    for (const part of msg.content) {
      if (!isToolCallPart(part) || part.name !== "question") {
        continue;
      }
      if (!state.prune.tools.has(part.id)) {
        continue;
      }
      const result = findToolResult(messages, part.id);
      if (!result || result.result.type === "error") {
        continue;
      }
      const input = part.input as { questions?: unknown } | undefined;
      if (input && typeof input === "object" && input.questions !== undefined) {
        input.questions = PRUNED_QUESTION_INPUT_REPLACEMENT;
      }
    }
  }
};

const pruneToolErrors = (state: SessionState, _logger: Logger, messages: DcpMessage[]): void => {
  for (const msg of messages) {
    if (isMessageCompacted(state, msg)) {
      continue;
    }
    for (const part of msg.content) {
      if (!isToolResultPart(part) || part.result.type !== "error") {
        continue;
      }
      if (!state.prune.tools.has(part.id)) {
        continue;
      }
      const call = findToolCall(messages, part.id);
      const input = call?.input;
      if (input && typeof input === "object") {
        const record = input as { [key: string]: unknown };
        for (const key of Object.keys(record)) {
          if (typeof record[key] === "string") {
            record[key] = PRUNED_TOOL_ERROR_INPUT_REPLACEMENT;
          }
        }
      }
    }
  }
};

const filterCompressedRanges = (
  state: SessionState,
  logger: Logger,
  config: DcpConfig,
  messages: DcpMessage[],
): void => {
  if (
    state.prune.messages.byMessageId.size === 0 &&
    state.prune.messages.activeByAnchorMessageId.size === 0
  ) {
    return;
  }

  const result: DcpMessage[] = [];

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex];
    const msgId = msg.id;

    const blockId = msgId ? state.prune.messages.activeByAnchorMessageId.get(msgId) : undefined;
    const summary =
      blockId !== undefined ? state.prune.messages.blocksById.get(blockId) : undefined;
    if (summary) {
      const rawSummaryContent: unknown = summary.summary;
      if (
        summary.active !== true ||
        typeof rawSummaryContent !== "string" ||
        rawSummaryContent.length === 0
      ) {
        logger.warn("Skipping malformed compress summary", {
          anchorMessageId: msgId,
          blockId: summary.blockId,
        });
      } else {
        const userMessage = getLastUserMessage(messages, msgIndex);
        if (userMessage) {
          const summaryContent =
            config.compress.mode === "message"
              ? replaceBlockIdsWithBlocked(rawSummaryContent)
              : rawSummaryContent;
          const summarySeed = `${summary.blockId}:${summary.anchorMessageId}`;
          result.push(createSyntheticUserMessage(userMessage, summaryContent, summarySeed));
          logger.info("Injected compress summary", {
            anchorMessageId: msgId,
            summaryLength: summaryContent.length,
          });
        } else {
          logger.warn("No user message found for compress summary", {
            anchorMessageId: msgId,
          });
        }
      }
    }

    const pruneEntry = msgId ? state.prune.messages.byMessageId.get(msgId) : undefined;
    if (pruneEntry && pruneEntry.activeBlockIds.length > 0) {
      continue;
    }

    result.push(msg);
  }

  messages.length = 0;
  messages.push(...result);
};

function findToolCall(
  messages: DcpMessage[],
  callId: string,
): (DcpMessage["content"][number] & { input: unknown }) | undefined {
  for (const message of messages) {
    for (const part of message.content) {
      if (isToolCallPart(part) && part.id === callId) return part;
    }
  }
  return undefined;
}
