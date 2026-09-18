import type { SessionState } from "../types.ts";
import type { SessionDeps } from "../state/state.ts";
import { resetSessionState } from "../state/state.ts";
import { applyPendingCompressionDurations } from "./timing.ts";
import { loadSessionState, saveSessionState, loadManualModeSetting } from "../state/persistence.ts";
import { loadPruneMap, loadPruneMessagesState } from "../state/utils.ts";
import {
  collectTurnNudgeAnchors,
  countTurns,
  findLastCompactionTimestamp,
  getLastUserMessage,
  type WithParts,
} from "./withparts.ts";

/**
 * v1 `lib/state/state.ts` session lifecycle, re-expressed over the
 * WithParts durable shape for the compress pipeline (the #12
 * request-shape `ensureSessionInitialized` serves the context hook;
 * this one serves the compress tool. Both share the same `SessionState`
 * and persistence, and both call the shared `resetSessionState`).
 *
 * Deltas vs v1:
 * - `client` replaced by `SessionDeps` (storage + injected sub-agent
 *   check), matching the #12 DI pattern.
 * - `state.lastCompaction` comes from the durable summary markers (the
 *   adapter maps durable `compaction` entries onto
 *   `info.summary === true`); the persisted event-driven value (set by
 *   the `session.compaction.ended` handler in the request pipeline) is
 *   kept when it is newer.
 */

export const checkSession = async (
  state: SessionState,
  deps: SessionDeps,
  messages: WithParts[],
  manualModeDefault: boolean,
): Promise<void> => {
  const lastUserMessage = getLastUserMessage(messages);
  if (!lastUserMessage) {
    return;
  }

  const lastSessionId = lastUserMessage.info.sessionID;

  if (state.sessionId === null || state.sessionId !== lastSessionId) {
    deps.logger.info(`Session changed: ${state.sessionId} -> ${lastSessionId}`);
    try {
      await ensureSessionInitialized(deps, state, lastSessionId, messages, manualModeDefault);
    } catch (err: unknown) {
      deps.logger.error("Failed to initialize session state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const lastCompactionTimestamp = findLastCompactionTimestamp(messages);
  if (lastCompactionTimestamp > state.lastCompaction) {
    state.lastCompaction = lastCompactionTimestamp;
    resetSessionState(state);
    deps.logger.info("Detected compaction - reset stale state", {
      timestamp: lastCompactionTimestamp,
    });

    saveSessionState(state, deps.storage, deps.logger).catch((error: unknown) => {
      deps.logger.warn("Failed to persist state reset after compaction", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  state.currentTurn = countTurns(state, messages);
  await refreshManualMode(state, deps, lastSessionId, manualModeDefault);
};

export async function ensureSessionInitialized(
  deps: SessionDeps,
  state: SessionState,
  sessionId: string,
  messages: WithParts[],
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

  state.lastCompaction = findLastCompactionTimestamp(messages);
  state.currentTurn = countTurns(state, messages);
  state.nudges.turnNudgeAnchors = collectTurnNudgeAnchors(messages);

  const persisted = await loadSessionState(sessionId, deps.storage, deps.logger);
  if (persisted === null) {
    return;
  }

  if (typeof persisted.manualMode === "boolean") {
    state.manualMode = persisted.manualMode ? "active" : false;
  }

  if (
    typeof persisted.lastCompaction === "number" &&
    Number.isFinite(persisted.lastCompaction) &&
    persisted.lastCompaction > state.lastCompaction
  ) {
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
  deps: SessionDeps,
  sessionId: string,
  manualModeDefault: boolean,
): Promise<void> {
  if (state.manualMode === "compress-pending") {
    return;
  }

  const persisted = await loadManualModeSetting(sessionId, deps.storage, deps.logger);
  const enabled = persisted ?? manualModeDefault;
  state.manualMode = enabled ? "active" : false;
}

export { assignMessageRefs } from "./withparts.ts";
