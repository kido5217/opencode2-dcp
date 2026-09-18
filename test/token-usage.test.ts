import assert from "node:assert/strict";
import test from "node:test";
import type { DcpConfig } from "../src/config.ts";
import { wrapCompressedSummary } from "../src/lib/compress/state.ts";
import { isContextOverLimits } from "../src/lib/nudges.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import type { CompressionBlock } from "../src/lib/types.ts";
import { getCurrentTokenUsage } from "../src/lib/token-utils.ts";

// v2 port of the v1 token-usage suite (context token limits). v1 derived the
// current usage from message token counts after the last compaction; v2
// reads the event-derived `state.currentTokenUsage` (host-reported), so the
// tests set it directly.

function buildConfig(
  maxContextLimit: number,
  overrides: Partial<DcpConfig["compress"]> = {},
): DcpConfig {
  return {
    enabled: true,
    debug: false,
    pruneNotification: "off",
    pruneNotificationType: "chat",
    commands: {
      enabled: true,
      protectedTools: [],
    },
    manualMode: {
      enabled: false,
      automaticStrategies: true,
    },
    turnProtection: {
      enabled: false,
      turns: 4,
    },
    experimental: {
      allowSubAgents: false,
      customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
      mode: "message",
      permission: "allow",
      showCompression: false,
      maxContextLimit,
      minContextLimit: 1,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      summaryBuffer: true,
      protectedTools: ["task"],
      protectTags: false,
      protectUserMessages: false,
      ...overrides,
    },
    strategies: {
      deduplication: {
        enabled: true,
        protectedTools: [],
      },
      purgeErrors: {
        enabled: true,
        turns: 4,
        protectedTools: [],
      },
    },
  };
}

function repeatedWord(word: string, count: number): string {
  return Array.from({ length: count }, () => word).join(" ");
}

function createActiveBlock(
  blockId: number,
  summary: string,
  summaryTokens: number,
): CompressionBlock {
  return {
    blockId,
    runId: 1,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens,
    durationMs: 0,
    topic: "Test block",
    batchTopic: "Test batch",
    startId: "m0001",
    endId: "m0001",
    anchorMessageId: "msg-anchor",
    compressMessageId: "msg-compress",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: [],
    directToolIds: [],
    effectiveMessageIds: [],
    effectiveToolIds: [],
    createdAt: 1,
    summary,
  };
}

const STALE_ASSISTANT_TOTAL = 86000 + 1200 + 300 + 5000;
const FRESH_REPORTED_TOTAL = 2400 + 600 + 150 + 300;

test("getCurrentTokenUsage starts at 0 on fresh session state", () => {
  assert.equal(getCurrentTokenUsage(createSessionState()), 0);
});

test("isContextOverLimits ignores stale totals and resumes with fresh reported totals", () => {
  const state = createSessionState();

  state.currentTokenUsage = 0;
  assert.deepEqual(
    isContextOverLimits(buildConfig(STALE_ASSISTANT_TOTAL - 1), state, "anthropic", "claude-test"),
    {
      overMaxLimit: false,
      overMinLimit: false,
    },
  );

  state.currentTokenUsage = FRESH_REPORTED_TOTAL;
  assert.deepEqual(
    isContextOverLimits(buildConfig(FRESH_REPORTED_TOTAL - 1), state, "anthropic", "claude-test"),
    {
      overMaxLimit: true,
      overMinLimit: true,
    },
  );
});

test("isContextOverLimits extends the max threshold by active summary tokens", () => {
  const state = createSessionState();
  state.currentTokenUsage = FRESH_REPORTED_TOTAL;
  const block = createActiveBlock(7, wrapCompressedSummary(7, repeatedWord("summary", 120)), 1000);
  state.prune.messages.blocksById.set(7, block);
  state.prune.messages.activeBlockIds.add(7);

  assert.deepEqual(
    isContextOverLimits(buildConfig(FRESH_REPORTED_TOTAL - 1), state, "anthropic", "claude-test"),
    {
      overMaxLimit: false,
      overMinLimit: true,
    },
  );

  assert.deepEqual(
    isContextOverLimits(
      buildConfig(FRESH_REPORTED_TOTAL - 1001),
      state,
      "anthropic",
      "claude-test",
    ),
    {
      overMaxLimit: true,
      overMinLimit: true,
    },
  );
});

test("isContextOverLimits skips the summary extension when summaryBuffer is disabled", () => {
  const state = createSessionState();
  state.currentTokenUsage = FRESH_REPORTED_TOTAL;
  const block = createActiveBlock(7, wrapCompressedSummary(7, repeatedWord("summary", 120)), 1000);
  state.prune.messages.blocksById.set(7, block);
  state.prune.messages.activeBlockIds.add(7);

  assert.deepEqual(
    isContextOverLimits(
      buildConfig(FRESH_REPORTED_TOTAL - 1, { summaryBuffer: false }),
      state,
      "anthropic",
      "claude-test",
    ),
    {
      overMaxLimit: true,
      overMinLimit: true,
    },
  );
});
