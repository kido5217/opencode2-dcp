import type { DcpMessage, DcpToolCallPart, SessionState, ToolStatus } from "../types.ts";
import type { Logger } from "../logger.ts";
import type { DcpConfig } from "../../config.ts";
import { isMessageCompacted } from "./utils.ts";
import { countToolTokens } from "../token-utils.ts";
import { findToolResult, isToolCallPart } from "../messages/shape.ts";

const MAX_TOOL_CACHE_SIZE = 1000;

/**
 * v2 port of v1 `lib/state/tool-cache.ts`.
 *
 * Shape adaptation: v1 counted `step-start` parts as turns and read tool
 * parts inline from assistant messages. The v2 request has no step-start
 * parts (each assistant message is one step) and splits tool calls from
 * results — status is derived from the matching tool-result part.
 */
export function syncToolCache(
  state: SessionState,
  config: DcpConfig,
  logger: Logger,
  messages: DcpMessage[],
): void {
  try {
    logger.info("Syncing tool parameters from OpenCode messages");

    let turnCounter = 0;

    for (const msg of messages) {
      if (isMessageCompacted(state, msg)) {
        continue;
      }

      if (msg.role === "assistant") {
        turnCounter++;
      }

      for (const part of msg.content) {
        if (!isToolCallPart(part) || !part.id) {
          continue;
        }

        const turnProtectionEnabled = config.turnProtection.enabled;
        const turnProtectionTurns = config.turnProtection.turns;
        const isProtectedByTurn =
          turnProtectionEnabled &&
          turnProtectionTurns > 0 &&
          state.currentTurn - turnCounter < turnProtectionTurns;

        if (state.toolParameters.has(part.id)) {
          continue;
        }

        if (isProtectedByTurn) {
          continue;
        }

        const result = findToolResult(messages, part.id);
        const status = toolStatusOf(part, result);
        const tokenCount = countToolTokens(part, result);

        state.toolParameters.set(part.id, {
          tool: part.name,
          parameters: (typeof part.input === "object" && part.input !== null
            ? part.input
            : {}) as Record<string, unknown>,
          status,
          error:
            status === "error" && result
              ? typeof result.result.value === "string"
                ? result.result.value
                : JSON.stringify(result.result.value ?? "")
              : undefined,
          turn: turnCounter,
          tokenCount,
        });
        logger.info(
          `Cached tool id: ${part.id} (turn ${turnCounter}${tokenCount !== undefined ? `, ${tokenCount} tokens` : ""})`,
        );
      }
    }

    logger.info(
      `Synced cache - size: ${state.toolParameters.size}, currentTurn: ${state.currentTurn}`,
    );
    trimToolParametersCache(state);
  } catch (error) {
    logger.warn("Failed to sync tool parameters from OpenCode", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function toolStatusOf(
  call: DcpToolCallPart,
  result: ReturnType<typeof findToolResult>,
): ToolStatus {
  if (!result) {
    return "pending";
  }
  return result.result.type === "error" ? "error" : "completed";
}

/**
 * Trim the tool parameters cache to prevent unbounded memory growth.
 * Uses FIFO eviction - removes oldest entries first.
 */
export function trimToolParametersCache(state: SessionState): void {
  if (state.toolParameters.size <= MAX_TOOL_CACHE_SIZE) {
    return;
  }

  const keysToRemove = Array.from(state.toolParameters.keys()).slice(
    0,
    state.toolParameters.size - MAX_TOOL_CACHE_SIZE,
  );

  for (const key of keysToRemove) {
    state.toolParameters.delete(key);
  }
}
