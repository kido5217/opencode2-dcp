import { compressPermission } from "./compress-permission.ts";
import type { DcpConfig, LimitValue } from "../config.ts";
import type { Logger } from "./logger.ts";
import { getLastUserMessage, isIgnoredUserMessage, messageHasCompress } from "./messages/query.ts";
import {
  type CompressionPriorityMap,
  type MessagePriority,
  listPriorityRefsBeforeIndex,
} from "./messages/priority.ts";
import { isTextPart } from "./messages/shape.ts";
import {
  appendToLastTextPart,
  appendToTextPart,
  createSyntheticTextPart,
  hasContent,
} from "./messages/utils.ts";
import type { RuntimePrompts } from "./prompts/store.ts";
import {
  appendGuidanceToDcpTag,
  buildCompressedBlockGuidance,
  renderMessagePriorityGuidance,
} from "./prompts/extensions/nudge.ts";
import { saveSessionState, type DcpStorage } from "./state/persistence.ts";
import { getActiveSummaryTokenUsage } from "./state/utils.ts";
import type { DcpMessage, SessionState } from "./types.ts";
import { getCurrentTokenUsage } from "./token-utils.ts";

/**
 * v2 port of v1 `lib/messages/inject/inject.ts` + `lib/messages/inject/utils.ts`
 * (context-limit / turn / iteration nudges and context token limits). Shape
 * adaptations: v1 `WithParts` (`info`/`parts`) -> v2 `DcpMessage`
 * (`id`/`role`/`content`); the model comes from the hook payload instead of
 * the last user message; token usage is event-derived (`state.currentTokenUsage`).
 */

const MESSAGE_MODE_NUDGE_PRIORITY: MessagePriority = "high";

interface LastNonIgnoredMessage {
  message: DcpMessage;
  index: number;
}

export interface NudgeModelRef {
  providerId?: string;
  modelId?: string;
}

export function getNudgeFrequency(config: DcpConfig): number {
  return Math.max(1, Math.floor(config.compress.nudgeFrequency || 1));
}

export function getIterationNudgeThreshold(config: DcpConfig): number {
  return Math.max(1, Math.floor(config.compress.iterationNudgeThreshold || 1));
}

export function findLastNonIgnoredMessage(messages: DcpMessage[]): LastNonIgnoredMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isIgnoredUserMessage(message)) {
      continue;
    }
    return { message, index: i };
  }

  return null;
}

function countMessagesAfterIndex(messages: DcpMessage[], index: number): number {
  let count = 0;

  for (let i = index + 1; i < messages.length; i++) {
    if (isIgnoredUserMessage(messages[i])) {
      continue;
    }
    count++;
  }

  return count;
}

function resolveContextTokenLimit(
  config: DcpConfig,
  state: SessionState,
  providerId: string | undefined,
  modelId: string | undefined,
  threshold: "max" | "min",
): number | undefined {
  const parseLimitValue = (limit: LimitValue | undefined): number | undefined => {
    if (limit === undefined) {
      return undefined;
    }

    if (typeof limit === "number") {
      return limit;
    }

    if (!limit.endsWith("%") || state.modelContextLimit === undefined) {
      return undefined;
    }

    const parsedPercent = parseFloat(limit.slice(0, -1));
    if (isNaN(parsedPercent)) {
      return undefined;
    }

    const roundedPercent = Math.round(parsedPercent);
    const clampedPercent = Math.max(0, Math.min(100, roundedPercent));
    return Math.round((clampedPercent / 100) * state.modelContextLimit);
  };

  const modelLimits =
    threshold === "max" ? config.compress.modelMaxLimits : config.compress.modelMinLimits;
  if (modelLimits && providerId !== undefined && modelId !== undefined) {
    const providerModelId = `${providerId}/${modelId}`;
    const modelLimit = modelLimits[providerModelId];
    if (modelLimit !== undefined) {
      return parseLimitValue(modelLimit);
    }
  }

  const globalLimit =
    threshold === "max" ? config.compress.maxContextLimit : config.compress.minContextLimit;
  return parseLimitValue(globalLimit);
}

export function isContextOverLimits(
  config: DcpConfig,
  state: SessionState,
  providerId: string | undefined,
  modelId: string | undefined,
): { overMaxLimit: boolean; overMinLimit: boolean } {
  const summaryTokenExtension = config.compress.summaryBuffer
    ? getActiveSummaryTokenUsage(state)
    : 0;
  const resolvedMaxContextLimit = resolveContextTokenLimit(
    config,
    state,
    providerId,
    modelId,
    "max",
  );
  const maxContextLimit =
    resolvedMaxContextLimit === undefined
      ? undefined
      : resolvedMaxContextLimit + summaryTokenExtension;
  const minContextLimit = resolveContextTokenLimit(config, state, providerId, modelId, "min");
  const currentTokens = getCurrentTokenUsage(state);

  return {
    overMaxLimit: maxContextLimit === undefined ? false : currentTokens > maxContextLimit,
    overMinLimit: minContextLimit === undefined ? true : currentTokens >= minContextLimit,
  };
}

function addAnchor(
  anchorMessageIds: Set<string>,
  anchorMessageId: string,
  anchorMessageIndex: number,
  messages: DcpMessage[],
  interval: number,
): boolean {
  if (anchorMessageIndex < 0) {
    return false;
  }

  let latestAnchorMessageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i].id;
    if (id !== undefined && anchorMessageIds.has(id)) {
      latestAnchorMessageIndex = i;
      break;
    }
  }

  const shouldAdd =
    latestAnchorMessageIndex < 0 || anchorMessageIndex - latestAnchorMessageIndex >= interval;
  if (!shouldAdd) {
    return false;
  }

  const previousSize = anchorMessageIds.size;
  anchorMessageIds.add(anchorMessageId);
  return anchorMessageIds.size !== previousSize;
}

function buildMessagePriorityGuidance(
  messages: DcpMessage[],
  compressionPriorities: CompressionPriorityMap | undefined,
  anchorIndex: number,
  priority: MessagePriority,
): string {
  if (!compressionPriorities || compressionPriorities.size === 0) {
    return "";
  }

  const refs = listPriorityRefsBeforeIndex(messages, compressionPriorities, anchorIndex, priority);
  const priorityLabel = `${priority[0].toUpperCase()}${priority.slice(1)}`;

  return renderMessagePriorityGuidance(priorityLabel, refs);
}

function injectAnchoredNudge(message: DcpMessage, nudgeText: string, messages: DcpMessage[]): void {
  if (!nudgeText.trim()) {
    return;
  }

  if (message.role === "user") {
    if (appendToLastTextPart(message, nudgeText)) {
      return;
    }

    message.content.push(createSyntheticTextPart(message, nudgeText));
    return;
  }

  if (message.role !== "assistant") {
    return;
  }

  if (!hasContent(message, messages)) {
    return;
  }

  for (const part of message.content) {
    if (isTextPart(part)) {
      if (appendToTextPart(part, nudgeText)) {
        return;
      }
    }
  }

  const syntheticPart = createSyntheticTextPart(message, nudgeText);
  const firstToolIndex = message.content.findIndex((p) => p.type === "tool-call");
  if (firstToolIndex === -1) {
    message.content.push(syntheticPart);
  } else {
    message.content.splice(firstToolIndex, 0, syntheticPart);
  }
}

function collectAnchoredMessages(
  anchorMessageIds: Set<string>,
  messages: DcpMessage[],
): Array<{ message: DcpMessage; index: number }> {
  const anchoredMessages: Array<{ message: DcpMessage; index: number }> = [];

  for (const anchorMessageId of anchorMessageIds) {
    const index = messages.findIndex((message) => message.id === anchorMessageId);
    if (index === -1) {
      continue;
    }

    anchoredMessages.push({ message: messages[index], index });
  }

  return anchoredMessages;
}

function collectTurnNudgeAnchors(
  state: SessionState,
  config: DcpConfig,
  messages: DcpMessage[],
): Set<string> {
  const turnNudgeAnchors = new Set<string>();
  const targetRole = config.compress.nudgeForce === "strong" ? "user" : "assistant";

  for (const message of messages) {
    const id = message.id;
    if (id === undefined || !state.nudges.turnNudgeAnchors.has(id)) {
      continue;
    }

    if (message.role === targetRole) {
      turnNudgeAnchors.add(id);
    }
  }

  return turnNudgeAnchors;
}

function applyRangeModeAnchoredNudge(
  anchorMessageIds: Set<string>,
  messages: DcpMessage[],
  baseNudgeText: string,
  compressedBlockGuidance: string,
): void {
  const nudgeText = appendGuidanceToDcpTag(baseNudgeText, compressedBlockGuidance);
  if (!nudgeText.trim()) {
    return;
  }

  for (const { message } of collectAnchoredMessages(anchorMessageIds, messages)) {
    injectAnchoredNudge(message, nudgeText, messages);
  }
}

function applyMessageModeAnchoredNudge(
  anchorMessageIds: Set<string>,
  messages: DcpMessage[],
  baseNudgeText: string,
  compressionPriorities?: CompressionPriorityMap,
): void {
  for (const { message, index } of collectAnchoredMessages(anchorMessageIds, messages)) {
    const priorityGuidance = buildMessagePriorityGuidance(
      messages,
      compressionPriorities,
      index,
      MESSAGE_MODE_NUDGE_PRIORITY,
    );
    const nudgeText = appendGuidanceToDcpTag(baseNudgeText, priorityGuidance);
    injectAnchoredNudge(message, nudgeText, messages);
  }
}

export function applyAnchoredNudges(
  state: SessionState,
  config: DcpConfig,
  messages: DcpMessage[],
  prompts: RuntimePrompts,
  compressionPriorities?: CompressionPriorityMap,
): void {
  const turnNudgeAnchors = collectTurnNudgeAnchors(state, config, messages);

  if (config.compress.mode === "message") {
    applyMessageModeAnchoredNudge(
      state.nudges.contextLimitAnchors,
      messages,
      prompts.contextLimitNudge,
      compressionPriorities,
    );
    applyMessageModeAnchoredNudge(
      turnNudgeAnchors,
      messages,
      prompts.turnNudge,
      compressionPriorities,
    );
    applyMessageModeAnchoredNudge(
      state.nudges.iterationNudgeAnchors,
      messages,
      prompts.iterationNudge,
      compressionPriorities,
    );
    return;
  }

  const compressedBlockGuidance = buildCompressedBlockGuidance(state);
  applyRangeModeAnchoredNudge(
    state.nudges.contextLimitAnchors,
    messages,
    prompts.contextLimitNudge,
    compressedBlockGuidance,
  );
  applyRangeModeAnchoredNudge(
    turnNudgeAnchors,
    messages,
    prompts.turnNudge,
    compressedBlockGuidance,
  );
  applyRangeModeAnchoredNudge(
    state.nudges.iterationNudgeAnchors,
    messages,
    prompts.iterationNudge,
    compressedBlockGuidance,
  );
}

export const injectCompressNudges = (
  state: SessionState,
  config: DcpConfig,
  logger: Logger,
  messages: DcpMessage[],
  prompts: RuntimePrompts,
  compressionPriorities: CompressionPriorityMap | undefined,
  model: NudgeModelRef,
  storage: DcpStorage,
): void => {
  if (compressPermission(state, config) === "deny") {
    return;
  }

  if (state.manualMode) {
    return;
  }

  const lastMessage = findLastNonIgnoredMessage(messages);
  const lastAssistantMessage = messages.findLast((message) => message.role === "assistant");

  if (lastAssistantMessage && messageHasCompress(lastAssistantMessage, messages)) {
    state.nudges.contextLimitAnchors.clear();
    state.nudges.turnNudgeAnchors.clear();
    state.nudges.iterationNudgeAnchors.clear();
    void saveSessionState(state, storage, logger);
    return;
  }

  const { providerId, modelId } = model;
  let anchorsChanged = false;

  const { overMaxLimit, overMinLimit } = isContextOverLimits(config, state, providerId, modelId);

  if (!overMinLimit) {
    const hadTurnAnchors = state.nudges.turnNudgeAnchors.size > 0;
    const hadIterationAnchors = state.nudges.iterationNudgeAnchors.size > 0;

    if (hadTurnAnchors || hadIterationAnchors) {
      state.nudges.turnNudgeAnchors.clear();
      state.nudges.iterationNudgeAnchors.clear();
      anchorsChanged = true;
    }
  }

  if (overMaxLimit) {
    if (lastMessage) {
      const added = addAnchor(
        state.nudges.contextLimitAnchors,
        lastMessage.message.id ?? "",
        lastMessage.index,
        messages,
        getNudgeFrequency(config),
      );
      if (added) {
        anchorsChanged = true;
      }
    }
  } else if (overMinLimit) {
    const isLastMessageUser = lastMessage?.message.role === "user";

    if (isLastMessageUser && lastAssistantMessage) {
      const previousSize = state.nudges.turnNudgeAnchors.size;
      if (lastMessage.message.id !== undefined) {
        state.nudges.turnNudgeAnchors.add(lastMessage.message.id);
      }
      if (lastAssistantMessage.id !== undefined) {
        state.nudges.turnNudgeAnchors.add(lastAssistantMessage.id);
      }
      if (state.nudges.turnNudgeAnchors.size !== previousSize) {
        anchorsChanged = true;
      }
    }

    const lastUserMessage = getLastUserMessage(messages);
    if (lastUserMessage && lastMessage) {
      const lastUserMessageIndex = messages.findIndex(
        (message) => message.id === lastUserMessage.id,
      );
      if (lastUserMessageIndex >= 0) {
        const messagesSinceUser = countMessagesAfterIndex(messages, lastUserMessageIndex);
        const iterationThreshold = getIterationNudgeThreshold(config);

        if (lastMessage.index > lastUserMessageIndex && messagesSinceUser >= iterationThreshold) {
          const added = addAnchor(
            state.nudges.iterationNudgeAnchors,
            lastMessage.message.id ?? "",
            lastMessage.index,
            messages,
            getNudgeFrequency(config),
          );

          if (added) {
            anchorsChanged = true;
          }
        }
      }
    }
  }

  applyAnchoredNudges(state, config, messages, prompts, compressionPriorities);

  if (anchorsChanged) {
    void saveSessionState(state, storage, logger);
  }
};
