/**
 * State persistence module for the v2 DCP plugin.
 * Persists pruned tool IDs and compression blocks so they survive host
 * restarts. v2 storage: the host plugin storage (`ctx.storage`), one JSON
 * document per session under `dcp/state/<sessionId>`.
 *
 * v1 stored one file per session under
 * `~/.local/share/opencode/storage/plugin/dcp/`; the persisted shape and the
 * load-time validation are ported verbatim.
 */

import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "../types.ts";
import type { Logger } from "../logger.ts";
import { serializePruneMessagesState } from "./utils.ts";

export interface DcpStorage {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /** Optional: used by `loadAllSessionStats` (panel scope). The host `ctx.storage.scan` satisfies this. */
  scan?(prefix: string): Promise<{ key: string; value: unknown }[]>;
}

const STATE_KEY_PREFIX = "dcp/state/";

/** Prune state as stored */
export interface PersistedPruneMessagesState {
  byMessageId: Record<string, PrunedMessageEntry>;
  blocksById: Record<string, CompressionBlock>;
  activeBlockIds: number[];
  activeByAnchorMessageId: Record<string, number>;
  nextBlockId: number;
  nextRunId: number;
}

export interface PersistedPrune {
  tools?: Record<string, number>;
  messages?: PersistedPruneMessagesState;
}

export interface PersistedNudges {
  contextLimitAnchors: string[];
  turnNudgeAnchors?: string[];
  iterationNudgeAnchors?: string[];
}

export interface PersistedSessionState {
  sessionName?: string;
  manualMode?: boolean;
  prune: PersistedPrune;
  nudges: PersistedNudges;
  stats: SessionStats;
  lastUpdated: string;
  /** v2-only: persisted so event-driven compaction reset survives restarts. */
  lastCompaction?: number;
}

async function writePersistedSessionState(
  storage: DcpStorage,
  sessionId: string,
  state: PersistedSessionState,
  logger: Logger,
): Promise<void> {
  await storage.set(`${STATE_KEY_PREFIX}${sessionId}`, state);
  logger.info("Saved session state", {
    sessionId,
    totalTokensSaved: state.stats.totalPruneTokens,
  });
}

export async function saveSessionState(
  sessionState: SessionState,
  storage: DcpStorage,
  logger: Logger,
  sessionName?: string,
): Promise<void> {
  try {
    if (!sessionState.sessionId) {
      return;
    }

    const state: PersistedSessionState = {
      sessionName,
      manualMode: !!sessionState.manualMode,
      prune: {
        tools: Object.fromEntries(sessionState.prune.tools),
        messages: serializePruneMessagesState(sessionState.prune.messages),
      },
      nudges: {
        contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
        turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
        iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
      },
      stats: sessionState.stats,
      lastUpdated: new Date().toISOString(),
      lastCompaction: sessionState.lastCompaction,
    };

    await writePersistedSessionState(storage, sessionState.sessionId, state, logger);
  } catch (error: unknown) {
    logger.error("Failed to save session state", {
      sessionId: sessionState.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function loadSessionState(
  sessionId: string,
  storage: DcpStorage,
  logger: Logger,
): Promise<PersistedSessionState | null> {
  try {
    const stored = await storage.get(`${STATE_KEY_PREFIX}${sessionId}`);
    if (stored === undefined || stored === null) {
      return null;
    }
    const state = stored as PersistedSessionState;

    const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object";
    const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object";
    const hasNudgeFormat = state?.nudges && typeof state.nudges === "object";
    if (
      !state ||
      !state.prune ||
      !hasPruneTools ||
      !hasPruneMessages ||
      !state.stats ||
      !hasNudgeFormat
    ) {
      logger.warn("Invalid session state, ignoring", {
        sessionId,
      });
      return null;
    }

    const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
      ? state.nudges.contextLimitAnchors
      : [];
    const validAnchors = rawContextLimitAnchors.filter(
      (entry): entry is string => typeof entry === "string",
    );
    const dedupedAnchors = [...new Set(validAnchors)];
    if (validAnchors.length !== rawContextLimitAnchors.length) {
      logger.warn("Filtered out malformed contextLimitAnchors entries", {
        sessionId,
        original: rawContextLimitAnchors.length,
        valid: validAnchors.length,
      });
    }
    state.nudges.contextLimitAnchors = dedupedAnchors;

    const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors)
      ? state.nudges.turnNudgeAnchors
      : [];
    const validSoftAnchors = rawTurnNudgeAnchors.filter(
      (entry): entry is string => typeof entry === "string",
    );
    const dedupedSoftAnchors = [...new Set(validSoftAnchors)];
    if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
      logger.warn("Filtered out malformed turnNudgeAnchors entries", {
        sessionId,
        original: rawTurnNudgeAnchors.length,
        valid: validSoftAnchors.length,
      });
    }
    state.nudges.turnNudgeAnchors = dedupedSoftAnchors;

    const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
      ? state.nudges.iterationNudgeAnchors
      : [];
    const validIterationAnchors = rawIterationNudgeAnchors.filter(
      (entry): entry is string => typeof entry === "string",
    );
    const dedupedIterationAnchors = [...new Set(validIterationAnchors)];
    if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
      logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
        sessionId,
        original: rawIterationNudgeAnchors.length,
        valid: validIterationAnchors.length,
      });
    }
    state.nudges.iterationNudgeAnchors = dedupedIterationAnchors;

    logger.info("Loaded session state", {
      sessionId,
    });

    return state;
  } catch (error: unknown) {
    logger.warn("Failed to load session state", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
  return {
    manualMode,
    prune: {
      tools: {},
      messages: {
        byMessageId: {},
        blocksById: {},
        activeBlockIds: [],
        activeByAnchorMessageId: {},
        nextBlockId: 1,
        nextRunId: 1,
      },
    },
    nudges: {
      contextLimitAnchors: [],
      turnNudgeAnchors: [],
      iterationNudgeAnchors: [],
    },
    stats: {
      pruneTokenCounter: 0,
      totalPruneTokens: 0,
    },
    lastUpdated: new Date().toISOString(),
  };
}

export async function loadManualModeSetting(
  sessionId: string,
  storage: DcpStorage,
  logger: Logger,
): Promise<boolean | undefined> {
  const state = await loadSessionState(sessionId, storage, logger);
  return typeof state?.manualMode === "boolean" ? state.manualMode : undefined;
}

export async function saveManualModeSetting(
  sessionId: string,
  manualMode: boolean,
  storage: DcpStorage,
  logger: Logger,
): Promise<void> {
  const existing = await loadSessionState(sessionId, storage, logger);
  const state = existing ?? emptyPersistedState(manualMode);
  state.manualMode = manualMode;
  state.lastUpdated = new Date().toISOString();
  await writePersistedSessionState(storage, sessionId, state, logger);
}

export interface AggregatedStats {
  totalTokens: number;
  totalTools: number;
  totalMessages: number;
  sessionCount: number;
}

export async function loadAllSessionStats(
  storage: DcpStorage,
  logger: Logger,
): Promise<AggregatedStats> {
  const result: AggregatedStats = {
    totalTokens: 0,
    totalTools: 0,
    totalMessages: 0,
    sessionCount: 0,
  };

  try {
    if (!storage.scan) {
      return result;
    }

    const entries = await storage.scan(STATE_KEY_PREFIX);

    for (const entry of entries) {
      try {
        const state = entry.value as PersistedSessionState;
        if (state?.stats?.totalPruneTokens && state?.prune) {
          result.totalTokens += state.stats.totalPruneTokens;
          result.totalTools += state.prune.tools ? Object.keys(state.prune.tools).length : 0;
          result.totalMessages += state.prune.messages?.byMessageId
            ? Object.keys(state.prune.messages.byMessageId).length
            : 0;
          result.sessionCount++;
        }
      } catch {
        // Skip invalid entries
      }
    }

    logger.debug("Loaded all-time stats", { ...result });
  } catch (error: unknown) {
    logger.warn("Failed to load all-time stats", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}
