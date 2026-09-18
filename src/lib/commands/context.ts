import { isIgnoredUserMessage, isMessageCompacted } from "../compress/withparts.ts";
import type { WithPart, WithParts } from "../compress/withparts.ts";
import type { SessionState } from "../types.ts";
import { countTokens } from "../token-utils.ts";

/**
 * v2 port of v1 `lib/commands/context.ts` token breakdown (context screen
 * data for the /dcp panel). The v1 `handleContextCommand` / ASCII
 * `formatContextMessage` are not ported: the v2 panel renders structured
 * screens instead of an ignored-message payload.
 *
 * TOKEN CALCULATION STRATEGY
 * ==========================
 * API-reported values are used wherever possible.
 *
 *   SYSTEM = firstAssistant.input + cache.read + cache.write -
 *            tokenizer(firstUserMessage)
 *   TOOLS  = tokenizer(toolInputs + toolOutputs)
 *   USER   = tokenizer(all user messages)
 *   ASSISTANT = total - system - user - tools  (residual)
 *   TOTAL  = input + output + reasoning + cache.read + cache.write
 */

export interface TokenBreakdown {
  system: number;
  user: number;
  assistant: number;
  tools: number;
  toolCount: number;
  toolsInContextCount: number;
  prunedTokens: number;
  prunedToolCount: number;
  prunedMessageCount: number;
  total: number;
}

const COMPACTED_TOOL_OUTPUT_PLACEHOLDER = "[Old tool result content cleared]";

const stringifyToolContent = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const extractCompletedToolOutput = (part: WithPart | undefined): string | undefined => {
  if (!part || part.type !== "tool" || part.state?.status !== "completed") {
    return undefined;
  }
  if (part.state?.output === undefined) {
    return undefined;
  }
  if (part.state?.time?.compacted) {
    return COMPACTED_TOOL_OUTPUT_PLACEHOLDER;
  }
  return stringifyToolContent(part.state.output);
};

export function analyzeContextTokens(state: SessionState, messages: WithParts[]): TokenBreakdown {
  const breakdown: TokenBreakdown = {
    system: 0,
    user: 0,
    assistant: 0,
    tools: 0,
    toolCount: 0,
    toolsInContextCount: 0,
    prunedTokens: state.stats.totalPruneTokens,
    prunedToolCount: 0,
    prunedMessageCount: 0,
    total: 0,
  };

  let firstAssistant: WithParts | undefined;
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const tokens = msg.info.tokens;
      if (
        (tokens?.input ?? 0) > 0 ||
        (tokens?.cache?.read ?? 0) > 0 ||
        (tokens?.cache?.write ?? 0) > 0
      ) {
        firstAssistant = msg;
        break;
      }
    }
  }

  let lastAssistant: WithParts | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role === "assistant" && (msg.info.tokens?.output ?? 0) > 0) {
      lastAssistant = msg;
      break;
    }
  }

  const apiInput = lastAssistant?.info.tokens?.input || 0;
  const apiOutput = lastAssistant?.info.tokens?.output || 0;
  const apiReasoning = lastAssistant?.info.tokens?.reasoning || 0;
  const apiCacheRead = lastAssistant?.info.tokens?.cache?.read || 0;
  const apiCacheWrite = lastAssistant?.info.tokens?.cache?.write || 0;
  breakdown.total = apiInput + apiOutput + apiReasoning + apiCacheRead + apiCacheWrite;

  const userTextParts: string[] = [];
  const toolInputParts: string[] = [];
  const toolOutputParts: string[] = [];
  let firstUserText = "";
  let foundFirstUser = false;
  const allToolIds = new Set<string>();
  const activeToolIds = new Set<string>();
  const prunedByMessageToolIds = new Set<string>();
  const allMessageIds = new Set<string>();

  for (const msg of messages) {
    allMessageIds.add(msg.info.id);
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const isCompacted = isMessageCompacted(state, msg);
    const pruneEntry = state.prune.messages.byMessageId.get(msg.info.id);
    const isMessagePruned = !!pruneEntry && pruneEntry.activeBlockIds.length > 0;
    const isIgnoredUser = isIgnoredUserMessage(msg);

    for (const part of parts) {
      if (part.type === "tool") {
        if (part.callID) {
          allToolIds.add(part.callID);
          if (!isCompacted) {
            activeToolIds.add(part.callID);
          }
          if (isMessagePruned) {
            prunedByMessageToolIds.add(part.callID);
          }
        }

        const isPruned = !!part.callID && state.prune.tools.has(part.callID);
        if (!isCompacted && !isPruned) {
          if (part.state?.input) {
            const inputStr =
              typeof part.state.input === "string"
                ? part.state.input
                : JSON.stringify(part.state.input);
            toolInputParts.push(inputStr);
          }

          const outputStr = extractCompletedToolOutput(part);
          if (outputStr !== undefined) {
            toolOutputParts.push(outputStr);
          }
        }
      } else if (
        part.type === "text" &&
        msg.info.role === "user" &&
        !isCompacted &&
        !isIgnoredUser
      ) {
        const text = part.text || "";
        userTextParts.push(text);
        if (!foundFirstUser) {
          firstUserText += text;
        }
      }
    }

    if (msg.info.role === "user" && !isIgnoredUser && !foundFirstUser) {
      foundFirstUser = true;
    }
  }

  const prunedByToolIds = new Set<string>();
  for (const id of allToolIds) {
    if (state.prune.tools.has(id)) {
      prunedByToolIds.add(id);
    }
  }

  const prunedToolIds = new Set<string>([...prunedByToolIds, ...prunedByMessageToolIds]);
  breakdown.toolsInContextCount = [...activeToolIds].filter(
    (id) => !prunedByToolIds.has(id),
  ).length;

  let prunedMessageCount = 0;
  for (const [id, entry] of state.prune.messages.byMessageId) {
    if (allMessageIds.has(id) && entry.activeBlockIds.length > 0) {
      prunedMessageCount++;
    }
  }

  breakdown.toolCount = allToolIds.size;
  breakdown.prunedToolCount = prunedToolIds.size;
  breakdown.prunedMessageCount = prunedMessageCount;

  const firstUserTokens = countTokens(firstUserText);
  breakdown.user = countTokens(userTextParts.join("\n"));
  const toolInputTokens = countTokens(toolInputParts.join("\n"));
  const toolOutputTokens = countTokens(toolOutputParts.join("\n"));

  if (firstAssistant) {
    const firstInput =
      (firstAssistant.info.tokens?.input || 0) +
      (firstAssistant.info.tokens?.cache?.read || 0) +
      (firstAssistant.info.tokens?.cache?.write || 0);
    breakdown.system = Math.max(0, firstInput - firstUserTokens);
  }

  breakdown.tools = toolInputTokens + toolOutputTokens;
  breakdown.assistant = Math.max(
    0,
    breakdown.total - breakdown.system - breakdown.user - breakdown.tools,
  );

  return breakdown;
}
