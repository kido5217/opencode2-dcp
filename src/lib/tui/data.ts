/**
 * Pure data layer for the `/dcp` TUI panel. No host imports: everything here
 * takes plain values and returns plain values, so it is unit-testable.
 *
 * The panel reads two durable documents through the TUI storage bridge
 * (`context.storage.store`, same plugin key space as the core plugin's
 * `ctx.storage`):
 *
 *   - `dcp/state/<sessionID>` — the core's `PersistedSessionState` document.
 *   - `dcp/panel/all-time` — the all-time aggregate the core refreshes after
 *     every session-state save (`ALL_TIME_KEY`).
 *
 * `buildPanelState` hydrates a live `SessionState` from the session document
 * using the exact same hydration helpers the core uses
 * (`loadPruneMap` / `loadPruneMessagesState`), so the panel's numbers always
 * agree with the pruning pipeline's.
 */

import type { ModelInfo, ModelRef, TokenUsageInfo } from "@opencode/client";
import { createSessionState } from "../state/state.ts";
import { loadPruneMap, loadPruneMessagesState } from "../state/utils.ts";
import type { AggregatedStats, PersistedPruneMessagesState } from "../state/persistence.ts";
import type { SessionState, SessionStats } from "../types.ts";

/** The `session.panel` slot content name this plugin registers. */
export const PANEL_NAME = "opencode-dcp.panel";

/**
 * Structural mirror of the persisted session document (loose enough to accept
 * both the core's `PersistedSessionState` and the empty initial value).
 */
export interface PanelDoc {
  sessionName?: string;
  manualMode?: boolean;
  prune?: {
    tools?: Record<string, number>;
    messages?: PersistedPruneMessagesState;
  };
  nudges?: {
    contextLimitAnchors?: string[];
    turnNudgeAnchors?: string[];
    iterationNudgeAnchors?: string[];
  };
  stats?: SessionStats;
  lastUpdated?: string;
  lastCompaction?: number;
}

/**
 * Initial value for the session store when the core has never saved one.
 * `manualMode` stays unset so the config default applies until the user
 * explicitly toggles it (an explicit persisted boolean always wins).
 */
export function emptyPanelDoc(): PanelDoc {
  return {
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
    nudges: { contextLimitAnchors: [] },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Hydrate a live `SessionState` from the persisted document.
 *
 * `manualMode` resolution (v1 parity with `refreshManualMode`): an explicit
 * persisted boolean wins; otherwise the config default applies.
 */
export function buildPanelState(
  doc: PanelDoc,
  sessionId: string,
  manualModeDefault: boolean,
): SessionState {
  const state = createSessionState();
  state.sessionId = sessionId;
  state.manualMode =
    typeof doc.manualMode === "boolean"
      ? doc.manualMode
        ? "active"
        : false
      : manualModeDefault
        ? "active"
        : false;
  state.prune.tools = loadPruneMap(doc.prune?.tools);
  state.prune.messages = loadPruneMessagesState(doc.prune?.messages);
  state.nudges.contextLimitAnchors = new Set(
    (doc.nudges?.contextLimitAnchors ?? []).filter(
      (entry): entry is string => typeof entry === "string",
    ),
  );
  state.stats = {
    pruneTokenCounter: doc.stats?.pruneTokenCounter ?? 0,
    totalPruneTokens: doc.stats?.totalPruneTokens ?? 0,
  };
  if (typeof doc.lastCompaction === "number" && Number.isFinite(doc.lastCompaction)) {
    state.lastCompaction = doc.lastCompaction;
  }
  return state;
}

/** Total tokens of a session usage snapshot (same sum as `TokenBreakdown.total`). */
export function currentUsageTokens(tokens: TokenUsageInfo | undefined): number {
  if (!tokens) return 0;
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  );
}

/** Structural mirror of the all-time aggregate document (`ALL_TIME_KEY`). */
export interface AllTimeDoc {
  totalTokens?: number;
  totalTools?: number;
  totalMessages?: number;
  sessionCount?: number;
}

/** Initial value for the all-time store when the core has never written one. */
export const zeroAllTime: AllTimeDoc = {
  totalTokens: 0,
  totalTools: 0,
  totalMessages: 0,
  sessionCount: 0,
};

export function allTimeStats(doc: AllTimeDoc): AggregatedStats {
  return {
    totalTokens: typeof doc.totalTokens === "number" ? doc.totalTokens : 0,
    totalTools: typeof doc.totalTools === "number" ? doc.totalTools : 0,
    totalMessages: typeof doc.totalMessages === "number" ? doc.totalMessages : 0,
    sessionCount: typeof doc.sessionCount === "number" ? doc.sessionCount : 0,
  };
}

/**
 * The model context limit for a session's model ref, matching the core's
 * `${providerID}/${id}` convention (`src/index.ts` `refreshModelContextLimits`).
 */
export function modelContextLimit(
  models: readonly ModelInfo[] | undefined,
  model: ModelRef | undefined,
): number | undefined {
  if (!models || !model) return undefined;
  const match = models.find(
    (entry) => entry.providerID === model.providerID && entry.id === model.id,
  );
  const limit = match?.limit?.context;
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}
