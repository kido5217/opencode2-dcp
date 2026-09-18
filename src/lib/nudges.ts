import type { DcpConfig } from "../config.ts";
import type { Logger } from "./logger.ts";
import type { DcpMessage, SessionState } from "./types.ts";
import type { RuntimePrompts } from "./prompts/store.ts";
import type { CompressionPriorityMap } from "./messages/priority.ts";

/**
 * #15 seam: v1's `injectCompressNudges` (context-limit / turn / iteration
 * nudges with anchor bookkeeping, from `lib/messages/inject/inject.ts`)
 * ports with the "nudges + context limits" ticket. The v1 mechanism operates
 * on state slices that already exist here (`state.nudges` anchor sets,
 * `state.currentTokenUsage`, `state.modelContextLimit`); this no-op stub keeps
 * the pipeline chain order identical to v1 so #15 drops in without rewiring.
 */
export const injectCompressNudges = (
  _state: SessionState,
  _config: DcpConfig,
  _logger: Logger,
  _messages: DcpMessage[],
  _prompts: RuntimePrompts,
  _compressionPriorities?: CompressionPriorityMap,
): void => {
  // Intentionally empty until #15.
};
