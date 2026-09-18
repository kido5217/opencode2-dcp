import type { DcpMessage, SessionState } from "../types.ts";
import type { Logger } from "../logger.ts";

/**
 * v2 port of v1 `lib/messages/sync.ts` — state-only logic, verbatim. The
 * message id set is built from the v2 request shape (`message.id`, which is
 * optional, so undefined ids are skipped).
 */

function sortBlocksByCreation(
  a: { createdAt: number; blockId: number },
  b: { createdAt: number; blockId: number },
): number {
  const createdAtDiff = a.createdAt - b.createdAt;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }
  return a.blockId - b.blockId;
}

export const syncCompressionBlocks = (
  state: SessionState,
  logger: Logger,
  messages: DcpMessage[],
): void => {
  const messagesState = state.prune.messages;
  if (!messagesState?.blocksById?.size) {
    return;
  }

  const messageIds = new Set(
    messages.map((msg) => msg.id).filter((id): id is string => typeof id === "string"),
  );
  const previousActiveBlockIds = new Set<number>(
    Array.from(messagesState.blocksById.values())
      .filter((block) => block.active)
      .map((block) => block.blockId),
  );

  messagesState.activeBlockIds.clear();
  messagesState.activeByAnchorMessageId.clear();

  const now = Date.now();
  const missingOriginBlockIds: number[] = [];
  const orderedBlocks = Array.from(messagesState.blocksById.values()).sort(sortBlocksByCreation);

  for (const block of orderedBlocks) {
    const hasOriginMessage =
      typeof block.compressMessageId === "string" &&
      block.compressMessageId.length > 0 &&
      messageIds.has(block.compressMessageId);

    if (!hasOriginMessage) {
      block.active = false;
      block.deactivatedAt = now;
      block.deactivatedByBlockId = undefined;
      missingOriginBlockIds.push(block.blockId);
      continue;
    }

    if (block.deactivatedByUser) {
      block.active = false;
      if (block.deactivatedAt === undefined) {
        block.deactivatedAt = now;
      }
      block.deactivatedByBlockId = undefined;
      continue;
    }

    for (const consumedBlockId of block.consumedBlockIds) {
      if (!messagesState.activeBlockIds.has(consumedBlockId)) {
        continue;
      }

      const consumedBlock = messagesState.blocksById.get(consumedBlockId);
      if (consumedBlock) {
        consumedBlock.active = false;
        consumedBlock.deactivatedAt = now;
        consumedBlock.deactivatedByBlockId = block.blockId;

        const mappedBlockId = messagesState.activeByAnchorMessageId.get(
          consumedBlock.anchorMessageId,
        );
        if (mappedBlockId === consumedBlock.blockId) {
          messagesState.activeByAnchorMessageId.delete(consumedBlock.anchorMessageId);
        }
      }

      messagesState.activeBlockIds.delete(consumedBlockId);
    }

    block.active = true;
    block.deactivatedAt = undefined;
    block.deactivatedByBlockId = undefined;
    messagesState.activeBlockIds.add(block.blockId);
    if (messageIds.has(block.anchorMessageId)) {
      messagesState.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId);
    }
  }

  for (const entry of messagesState.byMessageId.values()) {
    const allBlockIds = Array.isArray(entry.allBlockIds)
      ? [...new Set(entry.allBlockIds.filter((id) => Number.isInteger(id) && id > 0))]
      : [];

    entry.allBlockIds = allBlockIds;
    entry.activeBlockIds = allBlockIds.filter((id) => messagesState.activeBlockIds.has(id));
  }

  const nextActiveBlockIds = messagesState.activeBlockIds;
  let deactivatedCount = 0;
  let reactivatedCount = 0;

  for (const blockId of previousActiveBlockIds) {
    if (!nextActiveBlockIds.has(blockId)) {
      deactivatedCount++;
    }
  }
  for (const blockId of nextActiveBlockIds) {
    if (!previousActiveBlockIds.has(blockId)) {
      reactivatedCount++;
    }
  }

  if (missingOriginBlockIds.length > 0 || deactivatedCount > 0 || reactivatedCount > 0) {
    logger.info("Synced compress block state", {
      missingOriginCount: missingOriginBlockIds.length,
      deactivatedCount,
      reactivatedCount,
    });
  }
};
