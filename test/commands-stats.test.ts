import assert from "node:assert/strict";
import test from "node:test";
import { buildStatsReport } from "../src/lib/commands/stats.ts";
import type { CompressionBlock } from "../src/lib/types.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import { Logger } from "../src/lib/logger.ts";
import type { DcpStorage } from "../src/lib/state/persistence.ts";

const mockStorage: DcpStorage = {
  get: async () => null,
  set: async () => {},
  scan: async () => [],
};

function buildBlock(overrides: Partial<CompressionBlock>): CompressionBlock {
  return {
    blockId: 1,
    runId: 10,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 1000,
    summaryTokens: 300,
    durationMs: 1200,
    mode: "range",
    topic: "Test topic",
    startId: "m0001",
    endId: "m0002",
    anchorMessageId: "m0002",
    compressMessageId: "m0003",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: ["m0001", "m0002"],
    directToolIds: [],
    effectiveMessageIds: ["m0001", "m0002"],
    effectiveToolIds: [],
    createdAt: 1,
    summary: "Summary",
    ...overrides,
  };
}

test("buildStatsReport aggregates session stats from state", async () => {
  const state = createSessionState();
  state.stats.totalPruneTokens = 5000;

  const messages = state.prune.messages;
  messages.blocksById.set(1, buildBlock({ blockId: 1, effectiveToolIds: ["t1", "t2"] }));
  messages.blocksById.set(2, buildBlock({ blockId: 2, active: false, summaryTokens: 999 }));
  messages.activeBlockIds.add(1);
  messages.byMessageId.set("msg-1", { tokenCount: 100, allBlockIds: [1], activeBlockIds: [1] });
  messages.byMessageId.set("msg-2", { tokenCount: 50, allBlockIds: [2], activeBlockIds: [] });
  state.prune.tools.set("t3", 100);

  const report = await buildStatsReport(state, mockStorage, new Logger(false));

  assert.equal(report.sessionTokens, 5000);
  assert.equal(report.sessionSummaryTokens, 300);
  assert.equal(report.sessionDurationMs, 1200);
  assert.equal(report.sessionTools, 3);
  assert.equal(report.sessionMessages, 1);
  assert.deepEqual(report.allTime, {
    totalTokens: 0,
    totalTools: 0,
    totalMessages: 0,
    sessionCount: 0,
  });
});

test("buildStatsReport counts grouped message targets once for duration", async () => {
  const state = createSessionState();

  const messages = state.prune.messages;
  messages.blocksById.set(
    1,
    buildBlock({ blockId: 1, runId: 10, mode: "message", durationMs: 500 }),
  );
  messages.blocksById.set(
    2,
    buildBlock({ blockId: 2, runId: 10, mode: "message", durationMs: 700 }),
  );
  messages.blocksById.set(3, buildBlock({ blockId: 3, runId: 11, mode: "range", durationMs: 800 }));
  messages.activeBlockIds.add(1);
  messages.activeBlockIds.add(2);
  messages.activeBlockIds.add(3);

  const report = await buildStatsReport(state, mockStorage, new Logger(false));

  // Grouped message run (runId 10) contributes its max duration once.
  assert.equal(report.sessionDurationMs, 700 + 800);
  assert.equal(report.sessionSummaryTokens, 900);
});
