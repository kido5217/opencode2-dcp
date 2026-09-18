import type { SessionState, ToolParameterEntry } from "../types.ts";
import type { DcpMessage } from "../types.ts";
import type { Logger } from "../logger.ts";
import { applyPendingCompressionDurations } from "../compress/timing.ts";
import {
  loadManualModeSetting,
  loadSessionState,
  saveSessionState,
  type DcpStorage,
} from "./persistence.ts";
import {
  countTurns,
  createPruneMessagesState,
  isSubAgentSession,
  loadPruneMap,
  loadPruneMessagesState,
  collectTurnNudgeAnchors,
} from "./utils.ts";
import { getLastUserMessage } from "../messages/query.ts";

/**
 * v2 port of v1 `lib/state/state.ts`.
 *
 * v2 deltas:
 * - The session ID comes from the `context` event payload (v1 derived it
 *   from the last user message).
 * - Compaction detection is event-driven: `session.compaction.ended` sets
 *   `state.lastCompaction` and calls `resetOnCompaction` (the v2 request
 *   shape carries no message timestamps or summary flags). `lastCompaction`
 *   is persisted so a mid-session restart keeps it.
 * - Dependencies (storage, sub-agent check) are injected for testability.
 */

export interface SessionDeps {
  storage: DcpStorage;
  logger: Logger;
  isSubAgentSession: (sessionID: string) => Promise<boolean>;
}

export const checkSession = async (
  state: SessionState,
  deps: SessionDeps,
  sessionID: string,
  messages: DcpMessage[],
  manualModeDefault: boolean,
): Promise<void> => {
  const lastUserMessage = getLastUserMessage(messages);
  if (!lastUserMessage) {
    return;
  }

  if (state.sessionId === null || state.sessionId !== sessionID) {
    deps.logger.info(`Session changed: ${state.sessionId} -> ${sessionID}`);
    try {
      await ensureSessionInitialized(deps, state, sessionID, messages, manualModeDefault);
    } catch (err: unknown) {
      deps.logger.error("Failed to initialize session state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  state.currentTurn = countTurns(state, messages);
  await refreshManualMode(state, sessionID, deps, manualModeDefault);
};

export function createSessionState(): SessionState {
  return {
    sessionId: null,
    isSubAgent: false,
    manualMode: false,
    compressPermission: undefined,
    pendingManualTrigger: null,
    prune: {
      tools: new Map<string, number>(),
      messages: createPruneMessagesState(),
    },
    nudges: {
      contextLimitAnchors: new Set<string>(),
      turnNudgeAnchors: new Set<string>(),
      iterationNudgeAnchors: new Set<string>(),
    },
    stats: {
      pruneTokenCounter: 0,
      totalPruneTokens: 0,
    },
    compressionTiming: {
      startsByCallId: new Map<string, number>(),
      pendingByCallId: new Map(),
    },
    toolParameters: new Map<string, ToolParameterEntry>(),
    subAgentResultCache: new Map<string, string>(),
    toolIdList: [],
    messageIds: {
      byRawId: new Map<string, string>(),
      byRef: new Map<string, string>(),
      nextRef: 1,
    },
    lastCompaction: 0,
    currentTurn: 0,
    modelContextLimit: undefined,
    systemPromptTokens: undefined,
    currentTokenUsage: 0,
    firstStepInput: undefined,
  };
}

export function resetSessionState(state: SessionState): void {
  state.sessionId = null;
  state.isSubAgent = false;
  state.manualMode = false;
  state.compressPermission = undefined;
  state.pendingManualTrigger = null;
  state.prune = {
    tools: new Map<string, number>(),
    messages: createPruneMessagesState(),
  };
  state.nudges = {
    contextLimitAnchors: new Set<string>(),
    turnNudgeAnchors: new Set<string>(),
    iterationNudgeAnchors: new Set<string>(),
  };
  state.stats = {
    pruneTokenCounter: 0,
    totalPruneTokens: 0,
  };
  state.compressionTiming = {
    startsByCallId: new Map<string, number>(),
    pendingByCallId: new Map(),
  };
  state.toolParameters.clear();
  state.subAgentResultCache.clear();
  state.toolIdList = [];
  state.messageIds = {
    byRawId: new Map<string, string>(),
    byRef: new Map<string, string>(),
    nextRef: 1,
  };
  state.lastCompaction = 0;
  state.currentTurn = 0;
  state.modelContextLimit = undefined;
  state.systemPromptTokens = undefined;
  state.currentTokenUsage = 0;
  state.firstStepInput = undefined;
}

export async function ensureSessionInitialized(
  deps: SessionDeps,
  state: SessionState,
  sessionId: string,
  messages: DcpMessage[],
  manualModeEnabled: boolean,
): Promise<void> {
  if (state.sessionId === sessionId) {
    return;
  }

  resetSessionState(state);
  state.manualMode = manualModeEnabled ? "active" : false;
  state.sessionId = sessionId;

  const isSubAgent = await deps.isSubAgentSession(sessionId);
  state.isSubAgent = isSubAgent;

  state.currentTurn = countTurns(state, messages);
  state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages);

  const persisted = await loadSessionState(sessionId, deps.storage, deps.logger);
  if (persisted === null) {
    return;
  }

  if (typeof persisted.manualMode === "boolean") {
    state.manualMode = persisted.manualMode ? "active" : false;
  }

  if (typeof persisted.lastCompaction === "number" && Number.isFinite(persisted.lastCompaction)) {
    state.lastCompaction = persisted.lastCompaction;
  }

  state.prune.tools = loadPruneMap(persisted.prune.tools);
  state.prune.messages = loadPruneMessagesState(persisted.prune.messages);
  state.nudges.contextLimitAnchors = new Set<string>(persisted.nudges.contextLimitAnchors || []);
  state.nudges.turnNudgeAnchors = new Set<string>([
    ...state.nudges.turnNudgeAnchors,
    ...(persisted.nudges.turnNudgeAnchors || []),
  ]);
  state.nudges.iterationNudgeAnchors = new Set<string>(
    persisted.nudges.iterationNudgeAnchors || [],
  );
  state.stats = {
    pruneTokenCounter: persisted.stats?.pruneTokenCounter || 0,
    totalPruneTokens: persisted.stats?.totalPruneTokens || 0,
  };

  const applied = applyPendingCompressionDurations(state);
  if (applied > 0) {
    await saveSessionState(state, deps.storage, deps.logger);
  }
}

export async function refreshManualMode(
  state: SessionState,
  sessionId: string,
  deps: SessionDeps,
  manualModeDefault: boolean,
): Promise<void> {
  if (state.manualMode === "compress-pending") {
    return;
  }

  const persisted = await loadManualModeSetting(sessionId, deps.storage, deps.logger);
  const enabled = persisted ?? manualModeDefault;
  state.manualMode = enabled ? "active" : false;
}
