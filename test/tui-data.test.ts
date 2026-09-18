import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInfo, ModelRef } from "@opencode/client";
import type { CompressionBlock } from "../src/lib/types.ts";
import {
  PANEL_NAME,
  allTimeStats,
  buildPanelState,
  currentUsageTokens,
  emptyPanelDoc,
  modelContextLimit,
  zeroAllTime,
  type PanelDoc,
} from "../src/lib/tui/data.ts";

test("PANEL_NAME is the registered slot content name", () => {
  assert.equal(PANEL_NAME, "opencode-dcp.panel");
});

test("emptyPanelDoc hydrates into a clean default-active state", () => {
  const doc = emptyPanelDoc();
  assert.equal(doc.manualMode, undefined);
  assert.deepEqual(doc.prune?.tools, {});
  assert.equal(doc.prune?.messages?.nextBlockId, 1);
  assert.equal(doc.stats?.totalPruneTokens, 0);

  const state = buildPanelState(doc, "ses_1", true);
  assert.equal(state.sessionId, "ses_1");
  assert.equal(state.manualMode, "active");
  assert.equal(state.prune.tools.size, 0);
  assert.equal(state.nudges.contextLimitAnchors.size, 0);
  assert.equal(state.stats.totalPruneTokens, 0);
});

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
    directToolIds: ["tool_1"],
    effectiveMessageIds: ["m0001", "m0002"],
    effectiveToolIds: ["tool_1"],
    createdAt: 1,
    summary: "Summary",
    ...overrides,
  };
}

test("buildPanelState hydrates prune maps and stats from a persisted doc", () => {
  const doc: PanelDoc = {
    manualMode: true,
    prune: {
      tools: { tool_1: 1200, tool_2: 300 },
      messages: {
        byMessageId: {
          msg_1: { tokenCount: 500, allBlockIds: [1], activeBlockIds: [1] },
        },
        blocksById: {
          "1": buildBlock({}),
        },
        activeBlockIds: [1],
        activeByAnchorMessageId: { msg_1: 1 },
        nextBlockId: 2,
        nextRunId: 11,
      },
    },
    nudges: { contextLimitAnchors: ["anchor_a", "anchor_b"] },
    stats: { pruneTokenCounter: 12, totalPruneTokens: 4321 },
    lastCompaction: 1700000000000,
  };

  const state = buildPanelState(doc, "ses_2", false);
  assert.equal(state.manualMode, "active");
  assert.equal(state.prune.tools.get("tool_1"), 1200);
  assert.equal(state.prune.tools.get("tool_2"), 300);
  assert.equal(state.stats.pruneTokenCounter, 12);
  assert.equal(state.stats.totalPruneTokens, 4321);
  assert.equal(state.lastCompaction, 1700000000000);
  assert.deepEqual([...state.nudges.contextLimitAnchors].sort(), ["anchor_a", "anchor_b"]);
  assert.equal(state.prune.messages.activeBlockIds.size, 1);
});

test("manualMode resolution: explicit persisted boolean wins over the default", () => {
  const withTrue = buildPanelState({ manualMode: true }, "s", false);
  assert.equal(withTrue.manualMode, "active");

  const withFalse = buildPanelState({ manualMode: false }, "s", true);
  assert.equal(withFalse.manualMode, false);
});

test("manualMode resolution: undefined persisted value falls back to the default", () => {
  const defaultOn = buildPanelState({}, "s", true);
  assert.equal(defaultOn.manualMode, "active");

  const defaultOff = buildPanelState({}, "s", false);
  assert.equal(defaultOff.manualMode, false);
});

test("currentUsageTokens sums input, output, reasoning and cache", () => {
  assert.equal(
    currentUsageTokens({ input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 15 } }),
    170,
  );
  assert.equal(
    currentUsageTokens({ input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    10,
  );
  assert.equal(currentUsageTokens(undefined), 0);
});

test("allTimeStats reads the aggregate doc with zero fallbacks", () => {
  assert.deepEqual(allTimeStats(zeroAllTime), {
    totalTokens: 0,
    totalTools: 0,
    totalMessages: 0,
    sessionCount: 0,
  });
  assert.deepEqual(
    allTimeStats({ totalTokens: 5, totalTools: 2, totalMessages: 9, sessionCount: 3 }),
    {
      totalTokens: 5,
      totalTools: 2,
      totalMessages: 9,
      sessionCount: 3,
    },
  );
  assert.deepEqual(allTimeStats({}), {
    totalTokens: 0,
    totalTools: 0,
    totalMessages: 0,
    sessionCount: 0,
  });
});

test("modelContextLimit matches providerID + id like the core does", () => {
  const models = [
    {
      id: "claude-sonnet",
      providerID: "anthropic",
      limit: { context: 200_000 },
    },
    {
      id: "small",
      providerID: "anthropic",
      limit: { context: 0 },
    },
    {
      id: "other",
      providerID: "openai",
      limit: { context: 128_000 },
    },
  ] as unknown as ModelInfo[];

  assert.equal(
    modelContextLimit(models, { id: "claude-sonnet", providerID: "anthropic" } as ModelRef),
    200_000,
  );
  // limit <= 0 is treated as "no limit", mirroring refreshModelContextLimits
  assert.equal(
    modelContextLimit(models, { id: "small", providerID: "anthropic" } as ModelRef),
    undefined,
  );
  assert.equal(
    modelContextLimit(models, { id: "missing", providerID: "anthropic" } as ModelRef),
    undefined,
  );
  assert.equal(modelContextLimit(models, undefined), undefined);
  assert.equal(
    modelContextLimit(undefined, { id: "claude-sonnet", providerID: "anthropic" } as ModelRef),
    undefined,
  );
});
