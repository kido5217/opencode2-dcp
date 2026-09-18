import type { DcpConfig } from "../../config.ts";
import type { Logger } from "../logger.ts";
import type { SessionState } from "../types.ts";

export interface CompressNotificationEntry {
  blockId: number;
  runId: number;
  summary: string;
  summaryTokens: number;
}

/**
 * #18 seam: v1 `lib/ui/notification.ts::sendCompressNotification` pushes a
 * host toast after a compression run; the v2 notification surface is ported
 * in its own ticket. No-op for now.
 */
export async function sendCompressNotification(
  _logger: Logger,
  _config: DcpConfig,
  _state: SessionState,
  _sessionId: string,
  _entries: CompressNotificationEntry[],
  _batchTopic: string | undefined,
  _sessionMessageIds: string[],
  _params: unknown,
): Promise<boolean> {
  return false;
}

/**
 * #18 seam: v1 `lib/ui/notification.ts::sendIgnoredMessage` sends a
 * synthetic no-reply ignored message (`client.session.prompt` with
 * `noReply: true`, an `ignored: true` text part, and the current
 * agent/variant/model) to surface command output (decompress/recompress
 * results, usage errors) without starting a model turn. The real v2
 * channel is wired in its own ticket; no-op for now.
 */
export async function sendIgnoredMessage(
  _logger: Logger,
  _config: DcpConfig,
  _state: SessionState,
  _sessionId: string,
  _text: string,
  _params: unknown,
): Promise<void> {}
