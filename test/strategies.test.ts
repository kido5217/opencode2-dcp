import assert from "node:assert/strict";
import test from "node:test";
import { deduplicate, purgeErrors } from "../src/lib/strategies.ts";
import type { DcpConfig } from "../src/config.ts";
import { Logger } from "../src/lib/logger.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import type { SessionState, ToolParameterEntry } from "../src/lib/types.ts";

function buildConfig(
  overrides: {
    deduplicationEnabled?: boolean;
    purgeErrorsTurns?: number;
    deduplicationProtected?: string[];
    purgeErrorsProtected?: string[];
    automaticStrategies?: boolean;
  } = {},
): DcpConfig {
  return {
    enabled: true,
    debug: false,
    pruneNotification: "off",
    pruneNotificationType: "chat",
    commands: { enabled: true, protectedTools: [] },
    manualMode: { enabled: false, automaticStrategies: overrides.automaticStrategies ?? true },
    turnProtection: { enabled: false, turns: 4 },
    experimental: { allowSubAgents: false, customPrompts: false },
    protectedFilePatterns: [],
    compress: {
      mode: "range",
      permission: "allow",
      showCompression: false,
      maxContextLimit: 150000,
      minContextLimit: 50000,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      protectedTools: [],
      protectTags: false,
      protectUserMessages: false,
      summaryBuffer: true,
    },
    strategies: {
      deduplication: {
        enabled: overrides.deduplicationEnabled ?? true,
        protectedTools: overrides.deduplicationProtected ?? [],
      },
      purgeErrors: {
        enabled: true,
        turns: overrides.purgeErrorsTurns ?? 4,
        protectedTools: overrides.purgeErrorsProtected ?? [],
      },
    },
  } as DcpConfig;
}

function toolEntry(
  tool: string,
  parameters: Record<string, unknown>,
  turn: number,
  tokenCount: number,
  status: ToolParameterEntry["status"] = "completed",
): ToolParameterEntry {
  return { tool, parameters, status, turn, tokenCount };
}

function stateWithTools(entries: Array<[string, ToolParameterEntry]>): SessionState {
  const state = createSessionState();
  for (const [id, entry] of entries) {
    state.toolParameters.set(id, entry);
    state.toolIdList.push(id);
  }
  return state;
}

const logger = new Logger(false);

test("deduplicate prunes older duplicates and keeps the most recent", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("search", { query: "auth" }, 1, 100)],
    ["call-b", toolEntry("search", { query: "auth" }, 3, 120)],
    ["call-c", toolEntry("read", { path: "a.ts" }, 4, 50)],
  ]);

  deduplicate(state, logger, buildConfig(), []);

  assert.equal(state.prune.tools.has("call-a"), true);
  assert.equal(state.prune.tools.has("call-b"), false);
  assert.equal(state.prune.tools.has("call-c"), false);
  assert.equal(state.stats.totalPruneTokens, 100);
  assert.equal(state.prune.tools.get("call-a"), 100);
});

test("deduplicate treats parameters with different key order as the same signature", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("edit", { path: "a.ts", x: 1, y: 2 }, 1, 10)],
    ["call-b", toolEntry("edit", { y: 2, x: 1, path: "a.ts" }, 2, 20)],
  ]);

  deduplicate(state, logger, buildConfig(), []);

  assert.equal(state.prune.tools.has("call-a"), true);
  assert.equal(state.prune.tools.has("call-b"), false);
});

test("deduplicate skips protected tools", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("search", { query: "auth" }, 1, 100)],
    ["call-b", toolEntry("search", { query: "auth" }, 3, 120)],
  ]);

  deduplicate(state, logger, buildConfig({ deduplicationProtected: ["search"] }), []);

  assert.equal(state.prune.tools.size, 0);
});

test("deduplicate is a no-op when disabled in config", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("search", { query: "auth" }, 1, 100)],
    ["call-b", toolEntry("search", { query: "auth" }, 3, 120)],
  ]);

  deduplicate(state, logger, buildConfig({ deduplicationEnabled: false }), []);

  assert.equal(state.prune.tools.size, 0);
});

test("deduplicate is a no-op in manual mode without automatic strategies", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("search", { query: "auth" }, 1, 100)],
    ["call-b", toolEntry("search", { query: "auth" }, 3, 120)],
  ]);
  state.manualMode = "active";

  deduplicate(state, logger, buildConfig({ automaticStrategies: false }), []);

  assert.equal(state.prune.tools.size, 0);
});

test("purgeErrors prunes errored tools older than the turn threshold", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("bash", { command: "npm test" }, 3, 200, "error")],
    ["call-b", toolEntry("bash", { command: "npm run build" }, 9, 80, "completed")],
  ]);
  state.currentTurn = 10;

  purgeErrors(state, logger, buildConfig(), []);

  assert.equal(state.prune.tools.has("call-a"), true);
  assert.equal(state.prune.tools.has("call-b"), false);
  assert.equal(state.stats.totalPruneTokens, 200);
});

test("purgeErrors keeps errored tools newer than the turn threshold", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("bash", { command: "npm test" }, 9, 200, "error")],
  ]);
  state.currentTurn = 10;

  purgeErrors(state, logger, buildConfig(), []);

  assert.equal(state.prune.tools.size, 0);
});

test("purgeErrors respects the configured turn threshold", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("bash", { command: "npm test" }, 3, 200, "error")],
  ]);
  state.currentTurn = 10;

  purgeErrors(state, logger, buildConfig({ purgeErrorsTurns: 8 }), []);

  assert.equal(state.prune.tools.size, 0);
});

test("purgeErrors skips tools that are already pruned", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("bash", { command: "npm test" }, 3, 200, "error")],
  ]);
  state.currentTurn = 10;
  state.prune.tools.set("call-a", 200);

  purgeErrors(state, logger, buildConfig(), []);

  assert.equal(state.stats.totalPruneTokens, 0);
});

test("purgeErrors skips protected tools", () => {
  const state = stateWithTools([
    ["call-a", toolEntry("bash", { command: "npm test" }, 3, 200, "error")],
  ]);
  state.currentTurn = 10;

  purgeErrors(state, logger, buildConfig({ purgeErrorsProtected: ["bash"] }), []);

  assert.equal(state.prune.tools.size, 0);
});
