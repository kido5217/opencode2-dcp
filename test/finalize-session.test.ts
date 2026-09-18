import assert from "node:assert/strict";
import test from "node:test";
import { finalizeSession } from "../src/lib/compress/pipeline.ts";
import type { DcpConfig } from "../src/config.ts";
import type { ToolContext as CompressToolContext } from "../src/lib/compress/types.ts";
import { Logger } from "../src/lib/logger.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import { loadManualModeSetting, saveManualModeSetting } from "../src/lib/state/persistence.ts";
import type { WithParts } from "../src/lib/compress/withparts.ts";

const mockStorageMap = new Map<string, unknown>();
const mockStorage = {
  get: async (key: string) => mockStorageMap.get(key),
  set: async (key: string, value: unknown) => {
    mockStorageMap.set(key, value);
  },
  scan: async () => [],
};

function buildConfig(manualMode = false): DcpConfig {
  return {
    enabled: true,
    debug: false,
    pruneNotification: "off",
    pruneNotificationType: "chat",
    commands: { enabled: true, protectedTools: [] },
    manualMode: { enabled: manualMode, automaticStrategies: true },
    turnProtection: { enabled: false, turns: 4 },
    experimental: { allowSubAgents: false, customPrompts: false },
    protectedFilePatterns: [],
    compress: {
      mode: "message",
      permission: "allow",
      showCompression: false,
      maxContextLimit: 150000,
      minContextLimit: 50000,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      protectedTools: ["task"],
      protectTags: false,
      protectUserMessages: false,
      summaryBuffer: true,
    },
    strategies: {
      deduplication: { enabled: true, protectedTools: [] },
      purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
    },
  } as DcpConfig;
}

function buildToolContext(state: ReturnType<typeof createSessionState>, manualMode = false) {
  return {
    deps: { storage: mockStorage, logger: new Logger(false), isSubAgentSession: async () => false },
    fetchDurableMessages: async () => [],
    state,
    logger: new Logger(false),
    config: buildConfig(manualMode),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return {} as any;
      },
    },
  };
}

test("finalizeSession resets compress-pending to auto mode", async () => {
  const sessionId = `finalize-compress-pending-${Date.now()}`;
  const state = createSessionState();
  state.sessionId = sessionId;
  state.manualMode = "compress-pending";

  await finalizeSession(
    buildToolContext(state) as unknown as CompressToolContext,
    {
      sessionID: sessionId,
      messageID: "msg-finalize",
      id: "call-finalize",
      progress: async () => {},
    },
    [] as WithParts[],
    [],
    undefined,
  );

  assert.equal(state.manualMode, false);

  const persisted = await loadManualModeSetting(sessionId, mockStorage, new Logger(false));
  assert.equal(persisted, false);
});

test("finalizeSession restores persisted manual mode after compression", async () => {
  const sessionId = `finalize-persisted-manual-${Date.now()}`;
  const logger = new Logger(false);
  await saveManualModeSetting(sessionId, true, mockStorage, logger);

  const state = createSessionState();
  state.sessionId = sessionId;
  state.manualMode = "compress-pending";

  await finalizeSession(
    buildToolContext(state) as unknown as CompressToolContext,
    {
      sessionID: sessionId,
      messageID: "msg-finalize",
      id: "call-finalize",
      progress: async () => {},
    },
    [] as WithParts[],
    [],
    undefined,
  );

  assert.equal(state.manualMode, "active");

  const persisted = await loadManualModeSetting(sessionId, mockStorage, logger);
  assert.equal(persisted, true);
});

test("finalizeSession restores configured manual mode after compression", async () => {
  const sessionId = `finalize-configured-manual-${Date.now()}`;
  const state = createSessionState();
  state.sessionId = sessionId;
  state.manualMode = "compress-pending";

  await finalizeSession(
    buildToolContext(state, true) as any,
    {
      sessionID: sessionId,
      messageID: "msg-finalize",
      id: "call-finalize",
      progress: async () => {},
    },
    [] as WithParts[],
    [],
    undefined,
  );

  assert.equal(state.manualMode, "active");

  const persisted = await loadManualModeSetting(sessionId, mockStorage, new Logger(false));
  assert.equal(persisted, true);
});
