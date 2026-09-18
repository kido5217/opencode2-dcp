import type { Logger } from "../../logger.ts";
import type { DcpMessage, SessionState } from "../../types.ts";
import {
  buildSubagentResultText,
  getSubAgentId,
  mergeSubagentResult,
  type DurableSessionMessage,
} from "../../subagents/subagent-results.ts";
import { findToolResult, isToolCallPart } from "../shape.ts";
import { stripHallucinationsFromString } from "../utils.ts";

export type FetchSubAgentMessages = (sessionID: string) => Promise<DurableSessionMessage[]>;

/**
 * v2 port of v1 `lib/messages/inject/subagent-results.ts`.
 *
 * Shape adaptation: v1 mutated the inline `part.state.output` of task tool
 * parts. In the v2 request shape the tool output lives on the matching
 * `tool-result` part, so the merge rewrites `result.value` for completed
 * text results. Subagent transcripts come from `ctx.session.context`
 * (durable) instead of `client.session.messages`, injected via dependency.
 */
export const injectExtendedSubAgentResults = async (
  state: SessionState,
  logger: Logger,
  messages: DcpMessage[],
  allowSubAgents: boolean,
  fetchSubAgentMessages: FetchSubAgentMessages,
): Promise<void> => {
  if (!allowSubAgents) {
    return;
  }

  for (const message of messages) {
    for (const part of message.content) {
      if (!isToolCallPart(part) || part.name !== "task" || !part.id) {
        continue;
      }
      if (state.prune.tools.has(part.id)) {
        continue;
      }

      const result = findToolResult(messages, part.id);
      if (
        !result ||
        result.result.type === "error" ||
        result.result.type !== "text" ||
        typeof result.result.value !== "string"
      ) {
        continue;
      }

      const cachedResult = state.subAgentResultCache.get(part.id);
      if (cachedResult !== undefined) {
        if (cachedResult) {
          result.result.value = stripHallucinationsFromString(
            mergeSubagentResult(result.result.value, cachedResult),
          );
        }
        continue;
      }

      const subAgentSessionId = getSubAgentId(part);
      if (!subAgentSessionId) {
        continue;
      }

      let subAgentMessages: DurableSessionMessage[] = [];
      try {
        subAgentMessages = await fetchSubAgentMessages(subAgentSessionId);
      } catch (error) {
        logger.warn("Failed to fetch subagent session for output expansion", {
          subAgentSessionId,
          callID: part.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const subAgentResultText = buildSubagentResultText(subAgentMessages);
      if (!subAgentResultText) {
        continue;
      }

      state.subAgentResultCache.set(part.id, subAgentResultText);
      result.result.value = stripHallucinationsFromString(
        mergeSubagentResult(result.result.value, subAgentResultText),
      );
    }
  }
};
