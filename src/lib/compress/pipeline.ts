import type { WithParts } from "./withparts.ts";
import { ensureSessionInitialized, refreshManualMode } from "./session.ts";
import { saveSessionState } from "../state/persistence.ts";
import { assignMessageRefs } from "./withparts.ts";
import { isIgnoredUserMessage } from "./withparts.ts";
import { deduplicate, purgeErrors } from "../strategies.ts";
import { getCurrentParams } from "./withparts.ts";
import { sendCompressNotification } from "../ui/notification.ts";
import type { ToolContext, ToolRunContext } from "./types.ts";
import { buildSearchContext } from "./search.ts";
import type { SearchContext } from "./types.ts";
import { applyPendingCompressionDurations } from "./timing.ts";

export interface NotificationEntry {
  blockId: number;
  runId: number;
  summary: string;
  summaryTokens: number;
}

export interface PreparedSession {
  rawMessages: WithParts[];
  searchContext: SearchContext;
}

export async function prepareSession(
  ctx: ToolContext,
  toolCtx: ToolRunContext,
  title: string,
): Promise<PreparedSession> {
  await refreshManualMode(ctx.state, ctx.deps, toolCtx.sessionID, ctx.config.manualMode.enabled);

  if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
    throw new Error(
      "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
    );
  }

  // v1 toolCtx.ask (permission "compress"): v2 declares options { permission: "compress" }
  // at registration; the host enforces it before execute runs.
  void toolCtx.progress?.({ title });

  const rawMessages = await ctx.fetchDurableMessages(toolCtx.sessionID);

  await ensureSessionInitialized(
    ctx.deps,
    ctx.state,
    toolCtx.sessionID,
    rawMessages,
    ctx.config.manualMode.enabled,
  );

  assignMessageRefs(ctx.state, rawMessages);

  deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages);
  purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages);

  return {
    rawMessages,
    searchContext: buildSearchContext(ctx.state, rawMessages),
  };
}

export async function finalizeSession(
  ctx: ToolContext,
  toolCtx: ToolRunContext,
  rawMessages: WithParts[],
  entries: NotificationEntry[],
  batchTopic: string | undefined,
): Promise<void> {
  if (ctx.state.manualMode === "compress-pending") {
    ctx.state.manualMode = false;
    await refreshManualMode(ctx.state, ctx.deps, toolCtx.sessionID, ctx.config.manualMode.enabled);
  }
  applyPendingCompressionDurations(ctx.state);
  await saveSessionState(ctx.state, ctx.deps.storage, ctx.logger);

  const params = getCurrentParams(ctx.state, rawMessages, ctx.logger);
  const sessionMessageIds = rawMessages
    .filter((msg) => !isIgnoredUserMessage(msg))
    .map((msg) => msg.info.id);

  await sendCompressNotification(
    ctx.logger,
    ctx.config,
    ctx.state,
    toolCtx.sessionID,
    entries,
    batchTopic,
    sessionMessageIds,
    params,
  );
}
