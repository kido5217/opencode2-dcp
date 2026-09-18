import type { WithParts } from "../compress/withparts.ts";
import { syncCompressionBlocksForIds } from "../messages/sync.ts";
import type { Logger } from "../logger.ts";
import type { SessionState } from "../types.ts";

/**
 * Durable-shape wrapper over the shared block-sync core. The command
 * handlers operate on durable messages (`WithParts`, v1 parity); the
 * context pipeline uses the request-shape wrapper in
 * `../messages/sync.ts`.
 */
export const syncCompressionBlocks = (
  state: SessionState,
  logger: Logger,
  messages: WithParts[],
): void => {
  syncCompressionBlocksForIds(state, logger, new Set(messages.map((message) => message.info.id)));
};
