import type { Logger } from "../logger.ts";
import type { SessionState } from "../types.ts";
import { loadAllSessionStats } from "../state/persistence.ts";
import type { DcpStorage, AggregatedStats } from "../state/persistence.ts";
import { getActiveCompressionTargets } from "./compression-targets.ts";

/**
 * v2 port of v1 `lib/commands/stats.ts::buildStatsReport`. Shape
 * adaptations: `loadAllSessionStats` takes the v2 `DcpStorage` adapter;
 * the v1 `formatStatsMessage` ASCII layout and `handleStatsCommand`
 * (client notification) are dropped — the v2 panel renders the report
 * fields directly (see `lib/tui`).
 */

/**
 * Session-side stats, computed purely from the live `SessionState` (no
 * storage access). Shared by `buildStatsReport` and the `/dcp` TUI panel
 * (which reads the all-time aggregate from the shared storage store
 * instead of scanning).
 */
export interface SessionStatsSummary {
  sessionTokens: number;
  sessionSummaryTokens: number;
  sessionTools: number;
  sessionMessages: number;
  sessionDurationMs: number;
}

export function buildSessionStatsSummary(state: SessionState): SessionStatsSummary {
  const sessionTokens = state.stats.totalPruneTokens;
  let sessionSummaryTokens = 0;

  for (const block of state.prune.messages.blocksById.values()) {
    if (block.active) {
      sessionSummaryTokens += block.summaryTokens;
    }
  }

  let sessionDurationMs = 0;
  for (const target of getActiveCompressionTargets(state.prune.messages)) {
    sessionDurationMs += target.durationMs;
  }

  const prunedToolIds = new Set(state.prune.tools.keys());
  for (const block of state.prune.messages.blocksById.values()) {
    if (!block.active) continue;
    for (const toolId of block.effectiveToolIds) {
      prunedToolIds.add(toolId);
    }
  }
  const sessionTools = prunedToolIds.size;

  let sessionMessages = 0;
  for (const entry of state.prune.messages.byMessageId.values()) {
    if (entry.activeBlockIds.length > 0) {
      sessionMessages += 1;
    }
  }

  return {
    sessionTokens,
    sessionSummaryTokens,
    sessionTools,
    sessionMessages,
    sessionDurationMs,
  };
}

export interface StatsReport extends SessionStatsSummary {
  allTime: AggregatedStats;
}

export async function buildStatsReport(
  state: SessionState,
  storage: DcpStorage,
  logger: Logger,
): Promise<StatsReport> {
  const allTime = await loadAllSessionStats(storage, logger);
  return { ...buildSessionStatsSummary(state), allTime };
}
