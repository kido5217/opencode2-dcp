import type { Logger } from "../logger.ts";
import type { DcpStorage } from "../state/persistence.ts";
import { saveSessionState } from "../state/persistence.ts";
import type { PruneMessagesState, SessionState } from "../types.ts";
import { getCurrentParams } from "../compress/withparts.ts";
import type { WithParts } from "../compress/withparts.ts";
import { formatTokenCount } from "../ui/utils.ts";
import { parseBlockRef } from "../message-ids.ts";
import {
  getRecompressibleCompressionTargets,
  resolveCompressionTarget,
  type CompressionTarget,
} from "./compression-targets.ts";
import { syncCompressionBlocks } from "./sync.ts";

/**
 * v2 port of v1 `lib/commands/recompress.ts` (re-applies user-decompressed
 * compressions: `/dcp recompress <n>`). Seam adaptations: see
 * `decompress.ts` (injected `storage`, DI `sendIgnoredMessage` sender).
 */
export interface RecompressCommandContext {
  state: SessionState;
  logger: Logger;
  sessionId: string;
  messages: WithParts[];
  args: string[];
  storage: DcpStorage;
  sendIgnoredMessage: (text: string, params: unknown) => Promise<void>;
}

function parseBlockIdArg(arg: string): number | null {
  const normalized = arg.trim().toLowerCase();
  const blockRef = parseBlockRef(normalized);
  if (blockRef !== null) {
    return blockRef;
  }

  if (!/^[1-9]\d*$/.test(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function snapshotActiveMessages(messagesState: PruneMessagesState): Set<string> {
  const activeMessages = new Set<string>();
  for (const [messageId, entry] of messagesState.byMessageId) {
    if (entry.activeBlockIds.length > 0) {
      activeMessages.add(messageId);
    }
  }
  return activeMessages;
}

function formatRecompressMessage(
  target: CompressionTarget,
  recompressedMessageCount: number,
  recompressedTokens: number,
  deactivatedBlockIds: number[],
): string {
  const lines: string[] = [];

  lines.push(`Re-applied compression ${target.displayId}.`);
  if (target.runId !== target.displayId || target.grouped) {
    lines.push(`Tool call label: Compression #${target.runId}.`);
  }
  if (deactivatedBlockIds.length > 0) {
    const refs = deactivatedBlockIds.map((id) => String(id)).join(", ");
    lines.push(`Also re-compressed nested compression(s): ${refs}.`);
  }

  if (recompressedMessageCount > 0) {
    lines.push(
      `Re-compressed ${recompressedMessageCount} message(s) (~${formatTokenCount(recompressedTokens)}).`,
    );
  } else {
    lines.push("No messages were re-compressed.");
  }

  return lines.join("\n");
}

function formatAvailableBlocksMessage(availableTargets: CompressionTarget[]): string {
  const lines: string[] = [];

  lines.push("Usage: /dcp recompress <n>");
  lines.push("");

  if (availableTargets.length === 0) {
    lines.push("No user-decompressed blocks are available to re-compress.");
    return lines.join("\n");
  }

  lines.push("Available user-decompressed compressions:");
  const entries = availableTargets.map((target) => {
    const topic = target.topic.replace(/\s+/g, " ").trim() || "(no topic)";
    const label = `${target.displayId} (${formatTokenCount(target.compressedTokens)})`;
    const details = target.grouped
      ? `Compression #${target.runId} - ${target.blocks.length} messages`
      : `Compression #${target.runId}`;
    return { label, topic: `${details} - ${topic}` };
  });

  const labelWidth = Math.max(...entries.map((entry) => entry.label.length)) + 4;
  for (const entry of entries) {
    lines.push(`  ${entry.label.padEnd(labelWidth)}${entry.topic}`);
  }

  return lines.join("\n");
}

export async function handleRecompressCommand(ctx: RecompressCommandContext): Promise<void> {
  const { state, logger, sessionId, messages, args, storage, sendIgnoredMessage } = ctx;

  const params = getCurrentParams(state, messages, logger);
  const targetArg = args[0];

  if (args.length > 1) {
    await sendIgnoredMessage("Invalid arguments. Usage: /dcp recompress <n>", params);
    return;
  }

  syncCompressionBlocks(state, logger, messages);
  const messagesState = state.prune.messages;
  const availableMessageIds = new Set(messages.map((msg) => msg.info.id));

  if (!targetArg) {
    const availableTargets = getRecompressibleCompressionTargets(
      messagesState,
      availableMessageIds,
    );
    const message = formatAvailableBlocksMessage(availableTargets);
    await sendIgnoredMessage(message, params);
    return;
  }

  const targetBlockId = parseBlockIdArg(targetArg);
  if (targetBlockId === null) {
    await sendIgnoredMessage(
      `Please enter a compression number. Example: /dcp recompress 2`,
      params,
    );
    return;
  }

  const target = resolveCompressionTarget(messagesState, targetBlockId);
  if (!target) {
    await sendIgnoredMessage(`Compression ${targetBlockId} does not exist.`, params);
    return;
  }

  if (target.blocks.some((block) => !availableMessageIds.has(block.compressMessageId))) {
    await sendIgnoredMessage(
      `Compression ${target.displayId} can no longer be re-applied because its origin message is no longer in this session.`,
      params,
    );
    return;
  }

  if (!target.blocks.some((block) => block.deactivatedByUser)) {
    const message = target.blocks.some((block) => block.active)
      ? `Compression ${target.displayId} is already active.`
      : `Compression ${target.displayId} is not user-decompressed.`;
    await sendIgnoredMessage(message, params);
    return;
  }

  const activeMessagesBefore = snapshotActiveMessages(messagesState);
  const activeBlockIdsBefore = new Set(messagesState.activeBlockIds);

  for (const block of target.blocks) {
    block.deactivatedByUser = false;
    block.deactivatedAt = undefined;
    block.deactivatedByBlockId = undefined;
  }

  syncCompressionBlocks(state, logger, messages);

  let recompressedMessageCount = 0;
  let recompressedTokens = 0;
  for (const [messageId, entry] of messagesState.byMessageId) {
    const isActiveNow = entry.activeBlockIds.length > 0;
    if (isActiveNow && !activeMessagesBefore.has(messageId)) {
      recompressedMessageCount++;
      recompressedTokens += entry.tokenCount;
    }
  }

  state.stats.totalPruneTokens += recompressedTokens;

  const deactivatedBlockIds = Array.from(activeBlockIdsBefore)
    .filter((blockId) => !messagesState.activeBlockIds.has(blockId))
    .sort((a, b) => a - b);

  await saveSessionState(state, storage, logger);

  const message = formatRecompressMessage(
    target,
    recompressedMessageCount,
    recompressedTokens,
    deactivatedBlockIds,
  );
  await sendIgnoredMessage(message, params);

  logger.info("Recompress command completed", {
    targetBlockId: target.displayId,
    targetRunId: target.runId,
    recompressedMessageCount,
    recompressedTokens,
    deactivatedBlockIds,
  });
}
