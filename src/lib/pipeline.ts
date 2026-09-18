import type { DcpConfig } from "../config.ts";
import type { Logger } from "./logger.ts";
import type { DcpMessage, DcpModelRef, DcpSystemPart, SessionState } from "./types.ts";
import type { PromptStore } from "./prompts/store.ts";
import { renderSystemPrompt } from "./prompts/index.ts";
import { buildProtectedToolsExtension } from "./prompts/extensions/system.ts";
import { type HostPermissionSnapshot } from "./host-permissions.ts";
import { compressPermission, syncCompressPermissionState } from "./compress-permission.ts";
import type { DcpStorage } from "./state/persistence.ts";
import { checkSession } from "./state/state.ts";
import { syncToolCache } from "./state/tool-cache.ts";
import { isMessageCompacted } from "./state/utils.ts";
import { filterMessagesInPlace, isIgnoredPart, isTextPart } from "./messages/shape.ts";
import { isIgnoredUserMessage } from "./messages/query.ts";
import { buildToolIdList, stripHallucinations } from "./messages/utils.ts";
import { prune } from "./messages/prune.ts";
import { syncCompressionBlocks } from "./messages/sync.ts";
import { buildPriorityMap, type CompressionPriorityMap } from "./messages/priority.ts";
import {
  injectExtendedSubAgentResults,
  type FetchSubAgentMessages,
} from "./messages/inject/subagent-results.ts";
import { injectMessageIds } from "./inject-message-ids.ts";
import { injectCompressNudges } from "./nudges.ts";
import { assignMessageRefs } from "./message-ids.ts";
import { applyPendingManualTrigger } from "./manual.ts";
import { countTokens } from "./token-utils.ts";

/**
 * v2 port of the v1 `experimental.chat.messages.transform` pipeline
 * (`lib/hooks.ts` `createChatMessageTransformHandler`) and the system prompt
 * handler (`createSystemPromptHandler`), re-expressed over the v2 `context`
 * hook's mutable request shape.
 *
 * Deliberate v2 deltas (documented on ticket #12):
 * - `hostPermissions` is an empty snapshot: v2 exposes no host config API to
 *   plugins, so `compressDisabledByOpencode` is always false and DCP's own
 *   `compress.permission` is the only input to the effective permission.
 * - `stripStaleMetadata` (v1 model-switch metadata stripping) is skipped:
 *   the v2 host handles different-model parts natively.
 * - Token usage / compaction are event-driven (see index.ts) instead of
 *   re-derived from message tokens.
 * - `session.step.ended`-derived `state.firstStepInput` replaces v1's
 *   first-assistant-message token read in `cacheSystemPromptTokens`.
 */

/**
 * v2 exposes no way to read the host's permission configuration; the snapshot
 * stays empty (parity gap, documented). DCP's `compress.permission` still
 * fully governs the effective permission.
 */
const HOST_PERMISSIONS: HostPermissionSnapshot = {
  global: undefined,
  agents: {},
};

const INTERNAL_AGENT_SIGNATURES = [
  "You are a title generator",
  "You are a helpful AI assistant tasked with summarizing conversations",
  "You are an anchored context summarization assistant for coding sessions",
  "Summarize what was done in this conversation",
];

function isInternalAgentCall(systemPrompts: string[]): boolean {
  const primaryPrompt = systemPrompts[0];
  if (typeof primaryPrompt !== "string" || primaryPrompt.length === 0) {
    return false;
  }

  return INTERNAL_AGENT_SIGNATURES.some((signature) => primaryPrompt.includes(signature));
}

export interface ContextPipelinePayload {
  sessionID: string;
  model: DcpModelRef;
  agent?: string;
  system: DcpSystemPart[];
  messages: DcpMessage[];
}

export interface ContextPipelineDeps {
  state: SessionState;
  config: DcpConfig;
  logger: Logger;
  prompts: PromptStore;
  storage: DcpStorage;
  isSubAgentSession: (sessionID: string) => Promise<boolean>;
  fetchSubAgentMessages: FetchSubAgentMessages;
}

export const runContextPipeline = async (
  payload: ContextPipelinePayload,
  deps: ContextPipelineDeps,
): Promise<void> => {
  const { state, config, logger, prompts } = deps;
  const messages = payload.messages;

  const receivedMessages = Array.isArray(messages) ? messages.length : 0;
  filterMessagesInPlace(messages);
  if (messages.length !== receivedMessages) {
    logger.warn("Skipping messages with unexpected shape during context pipeline", {
      received: receivedMessages,
      usable: messages.length,
    });
  }

  await checkSession(state, deps, payload.sessionID, messages, config.manualMode.enabled);

  syncCompressPermissionState(state, config, HOST_PERMISSIONS, payload.agent);

  if (state.isSubAgent && !config.experimental.allowSubAgents) {
    return;
  }

  stripHallucinations(messages);
  cacheSystemPromptTokens(state, messages);
  assignMessageRefs(state, messages);
  syncCompressionBlocks(state, logger, messages);
  syncToolCache(state, config, logger, messages);
  buildToolIdList(state, messages);
  prune(state, logger, config, messages);
  await injectExtendedSubAgentResults(
    state,
    logger,
    messages,
    config.experimental.allowSubAgents,
    deps.fetchSubAgentMessages,
  );
  const compressionPriorities: CompressionPriorityMap = buildPriorityMap(config, state, messages);
  prompts.reload();
  injectCompressNudges(
    state,
    config,
    logger,
    messages,
    prompts.getRuntimePrompts(),
    compressionPriorities,
  );
  injectMessageIds(state, config, messages, compressionPriorities);
  applyPendingManualTrigger(state, messages, logger);
  // v1's stripStaleMetadata is skipped: the v2 host strips different-model
  // metadata natively.

  if (state.sessionId) {
    await logger.saveContext(state.sessionId, messages);
  }
};

/**
 * v2 port of v1's `createSystemPromptHandler`: appends the rendered DCP
 * system prompt (prompt overrides, protected-tools extension, manual-mode and
 * subagent extensions) to the last system part of the outgoing request.
 */
export function applySystemPrompt(
  system: DcpSystemPart[],
  state: SessionState,
  config: DcpConfig,
  prompts: PromptStore,
  logger: Logger,
  sessionID?: string,
): void {
  if (state.isSubAgent && !config.experimental.allowSubAgents) {
    return;
  }

  if (isInternalAgentCall(system.map((part) => part.text))) {
    logger.info("Skipping DCP system prompt injection for internal agent");
    return;
  }

  const effectivePermission =
    sessionID && state.sessionId === sessionID
      ? compressPermission(state, config)
      : config.compress.permission;

  if (effectivePermission === "deny") {
    return;
  }

  prompts.reload();
  const runtimePrompts = prompts.getRuntimePrompts();
  const newPrompt = renderSystemPrompt(
    runtimePrompts,
    buildProtectedToolsExtension(config.compress.protectedTools),
    !!state.manualMode,
    state.isSubAgent && config.experimental.allowSubAgents,
  );
  if (system.length > 0) {
    system[system.length - 1].text += "\n\n" + newPrompt;
  } else {
    system.push({ type: "text", text: newPrompt });
  }
}

/**
 * v2 adaptation of v1 `ui/utils.ts` `cacheSystemPromptTokens`: the v2 request
 * carries no per-message tokens, so the input-side token total of the first
 * step after session init/compaction (event-derived, `state.firstStepInput`)
 * stands in for v1's first-assistant-message read.
 */
export function cacheSystemPromptTokens(state: SessionState, messages: DcpMessage[]): void {
  const firstInputTokens = state.firstStepInput ?? 0;

  if (firstInputTokens <= 0) {
    state.systemPromptTokens = undefined;
    return;
  }

  let firstUserText = "";
  for (const msg of messages) {
    if (msg.role !== "user" || isIgnoredUserMessage(msg)) {
      continue;
    }
    for (const part of msg.content) {
      if (isTextPart(part) && !isIgnoredPart(part)) {
        firstUserText += part.text;
      }
    }
    break;
  }

  const estimatedSystemTokens = Math.max(0, firstInputTokens - countTokens(firstUserText));
  state.systemPromptTokens = estimatedSystemTokens > 0 ? estimatedSystemTokens : undefined;
}
