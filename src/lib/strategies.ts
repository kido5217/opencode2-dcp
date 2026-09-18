import type { DcpConfig } from "../config.ts";
import type { Logger } from "./logger.ts";
import type { SessionState } from "./types.ts";
import type { WithParts } from "./compress/withparts.ts";

/**
 * #14 seam: v1 `lib/strategies` (deduplication + purge-errors) operates on
 * `WithParts` session messages and prunes tool calls in place; ported in its
 * own ticket. No-ops for now.
 */
export const deduplicate = (
  _state: SessionState,
  _logger: Logger,
  _config: DcpConfig,
  _messages: WithParts[],
): void => {};

export const purgeErrors = (
  _state: SessionState,
  _logger: Logger,
  _config: DcpConfig,
  _messages: WithParts[],
): void => {};
