import type { CompressToolInfo, ToolContext, ToolRunContext } from "./types.ts";
import { countTokens } from "../token-utils.ts";
import { RANGE_FORMAT_EXTENSION } from "../prompts/extensions/tool.ts";
import { finalizeSession, prepareSession, type NotificationEntry } from "./pipeline.ts";
import {
  appendProtectedPromptInfo,
  appendProtectedTools,
  appendProtectedUserMessages,
} from "./protected-content.ts";
import {
  appendMissingBlockSummaries,
  injectBlockPlaceholders,
  normalizeRangeArgs,
  parseBlockPlaceholders,
  resolveRanges,
  validateArgs,
  validateNonOverlapping,
  validateSummaryPlaceholders,
} from "./range-utils.ts";
import {
  COMPRESSED_BLOCK_HEADER,
  allocateBlockId,
  allocateRunId,
  applyCompressionState,
  wrapCompressedSummary,
} from "./state.ts";
import type { CompressRangeToolArgs } from "./types.ts";

function buildSchema() {
  // v2 hand-written JSON Schema (v1 built this with tool.schema).
  return {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Short label (3-5 words) for display - e.g., 'Auth System Exploration'",
      },
      content: {
        type: "array",
        description: "One or more ranges to compress, each with start/end boundaries and a summary",
        items: {
          type: "object",
          properties: {
            startId: {
              type: "string",
              description: "Message or block ID marking the beginning of range (e.g. m0001, b2)",
            },
            endId: {
              type: "string",
              description: "Message or block ID marking the end of range (e.g. m0012, b5)",
            },
            summary: {
              type: "string",
              description: "Complete technical summary replacing all content in range",
            },
          },
          required: ["startId", "endId", "summary"],
        },
      },
    },
    required: ["topic", "content"],
  };
}

export function createCompressRangeTool(ctx: ToolContext): CompressToolInfo {
  ctx.prompts.reload();
  const runtimePrompts = ctx.prompts.getRuntimePrompts();

  return {
    description: runtimePrompts.compressRange + RANGE_FORMAT_EXTENSION,
    input: buildSchema(),
    async execute(args, toolCtx: ToolRunContext) {
      try {
        const input = normalizeRangeArgs(args);
        validateArgs(input);
        const callId = typeof toolCtx.id === "string" ? toolCtx.id : undefined;

        const { rawMessages, searchContext } = await prepareSession(
          ctx,
          toolCtx,
          `Compress Range: ${input.topic}`,
        );
        const resolvedPlans = resolveRanges(input, searchContext, ctx.state);
        validateNonOverlapping(resolvedPlans);

        const notifications: NotificationEntry[] = [];
        const preparedPlans: Array<{
          entry: (typeof resolvedPlans)[number]["entry"];
          selection: (typeof resolvedPlans)[number]["selection"];
          anchorMessageId: string;
          finalSummary: string;
          consumedBlockIds: number[];
        }> = [];
        let totalCompressedMessages = 0;

        for (const plan of resolvedPlans) {
          const parsedPlaceholders = parseBlockPlaceholders(plan.entry.summary);
          const missingBlockIds = validateSummaryPlaceholders(
            parsedPlaceholders,
            plan.selection.requiredBlockIds,
            plan.selection.startReference,
            plan.selection.endReference,
            searchContext.summaryByBlockId,
          );

          const injected = injectBlockPlaceholders(
            plan.entry.summary,
            parsedPlaceholders,
            searchContext.summaryByBlockId,
            plan.selection.startReference,
            plan.selection.endReference,
          );

          const summaryWithUsers = appendProtectedUserMessages(
            injected.expandedSummary,
            plan.selection,
            searchContext,
            ctx.state,
            ctx.config.compress.protectUserMessages,
          );

          const summaryWithPromptInfo = appendProtectedPromptInfo(
            summaryWithUsers,
            plan.selection,
            searchContext,
            ctx.state,
            ctx.config.compress.protectTags,
          );

          const summaryWithTools = await appendProtectedTools(
            ctx.fetchDurableMessages,
            ctx.state,
            ctx.config.experimental.allowSubAgents,
            summaryWithPromptInfo,
            plan.selection,
            searchContext,
            ctx.config.compress.protectedTools,
            ctx.config.protectedFilePatterns,
          );

          const completedSummary = appendMissingBlockSummaries(
            summaryWithTools,
            missingBlockIds,
            searchContext.summaryByBlockId,
            injected.consumedBlockIds,
          );

          preparedPlans.push({
            entry: plan.entry,
            selection: plan.selection,
            anchorMessageId: plan.anchorMessageId,
            finalSummary: completedSummary.expandedSummary,
            consumedBlockIds: completedSummary.consumedBlockIds,
          });
        }

        const runId = allocateRunId(ctx.state);

        for (const preparedPlan of preparedPlans) {
          const blockId = allocateBlockId(ctx.state);
          const storedSummary = wrapCompressedSummary(blockId, preparedPlan.finalSummary);
          const summaryTokens = countTokens(storedSummary);

          const applied = applyCompressionState(
            ctx.state,
            {
              topic: input.topic,
              batchTopic: input.topic,
              startId: preparedPlan.entry.startId,
              endId: preparedPlan.entry.endId,
              mode: "range",
              runId,
              compressMessageId: toolCtx.messageID,
              compressCallId: callId,
              summaryTokens,
            },
            preparedPlan.selection,
            preparedPlan.anchorMessageId,
            blockId,
            storedSummary,
            preparedPlan.consumedBlockIds,
          );

          totalCompressedMessages += applied.messageIds.length;

          notifications.push({
            blockId,
            runId,
            summary: preparedPlan.finalSummary,
            summaryTokens,
          });
        }

        await finalizeSession(ctx, toolCtx, rawMessages, notifications, input.topic);

        return {
          content: `Compressed ${totalCompressedMessages} messages into ${COMPRESSED_BLOCK_HEADER}.`,
        };
      } catch (error) {
        // v2 promise plugins have no tool-error channel (decision #22): v1 surfaced
        // every compress failure to the model as a tool error; surface it as content.
        return { content: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
