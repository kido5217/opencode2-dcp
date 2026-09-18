import type { PruneMessagesState } from "../types.ts";

/**
 * #13 seam: v1 `lib/compress/state.ts::attachCompressionDuration` records a
 * completed compression run's duration on its block. Ported together with the
 * compress tool (the block mutation lives in the #13 module graph).
 */
export function attachCompressionDuration(
  _messages: PruneMessagesState,
  _messageId: string,
  _callId: string,
  _durationMs: number,
): number {
  return 0;
}
