import type { Logger } from "./logger.ts";
import type { DcpConfig } from "../config.ts";
import type { DcpMessage, SessionState } from "./types.ts";
import { buildCompressedBlockGuidance } from "./prompts/extensions/nudge.ts";
import { isIgnoredUserMessage } from "./messages/query.ts";
import { isIgnoredPart, isTextPart } from "./messages/shape.ts";

/**
 * v2 port of the manual-trigger half of v1 `lib/commands/manual.ts`.
 *
 * Scope note: `handleManualToggleCommand` / `handleManualTriggerCommand`
 * (command dispatch, `/dcp manual`, ignored-message notifications) belong to
 * the `/dcp-compress` command ticket (#16) and its notification scope (#18).
 * The pipeline only consumes the pending-trigger mechanism and the trigger
 * prompt text, which are ported here.
 */

export const MANUAL_MODE_ON =
  "Manual mode is now ON. Use /dcp-compress to trigger context tools manually.";

export const MANUAL_MODE_OFF = "Manual mode is now OFF.";

export const COMPRESS_TRIGGER_PROMPT = [
  "<compress triggered manually>",
  "Manual mode trigger received. You must now use the compress tool.",
  "Find the most significant completed conversation content that can be compressed into a high-fidelity technical summary.",
  "Follow the active compress mode, preserve all critical implementation details, and choose safe targets.",
  "Return after compress with a brief explanation of what content was compressed.",
].join("\n\n");

export function getTriggerPrompt(
  tool: "compress",
  state: SessionState,
  config: DcpConfig,
  userFocus?: string,
): string {
  const base = COMPRESS_TRIGGER_PROMPT;
  const compressedBlockGuidance =
    config.compress.mode === "message" ? "" : buildCompressedBlockGuidance(state);

  const sections = [base, compressedBlockGuidance];
  if (userFocus && userFocus.trim().length > 0) {
    sections.push(`Additional user focus:\n${userFocus.trim()}`);
  }

  return sections.join("\n\n");
}

/**
 * Replace the last non-ignored user message's first text part with the
 * pending manual-trigger prompt (v1 parity: v1 rewrote the command's text
 * part; the v2 command ticket (#16) sends the prompt instead, so the pending
 * mechanism is the same and this path is kept for parity of the state
 * lifecycle — it clears the trigger when no target text part exists).
 */
export function applyPendingManualTrigger(
  state: SessionState,
  messages: DcpMessage[],
  logger: Logger,
): void {
  const pending = state.pendingManualTrigger;
  if (!pending) {
    return;
  }

  if (!state.sessionId || pending.sessionId !== state.sessionId) {
    state.pendingManualTrigger = null;
    return;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || isIgnoredUserMessage(msg)) {
      continue;
    }

    for (const part of msg.content) {
      if (!isTextPart(part) || isIgnoredPart(part)) {
        continue;
      }

      part.text = pending.prompt;
      state.pendingManualTrigger = null;
      logger.debug("Applied manual prompt", { sessionId: pending.sessionId });
      return;
    }
  }

  state.pendingManualTrigger = null;
}
