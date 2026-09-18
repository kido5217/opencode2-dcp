import assert from "node:assert/strict";
import test from "node:test";
import type { DcpConfig } from "../src/config.ts";
import { Logger } from "../src/lib/logger.ts";
import { assignMessageRefs } from "../src/lib/message-ids.ts";
import { injectMessageIds } from "../src/lib/inject-message-ids.ts";
import { prune } from "../src/lib/messages/prune.ts";
import { buildPriorityMap } from "../src/lib/messages/priority.ts";
import { stripHallucinationsFromString } from "../src/lib/messages/utils.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import type { DcpContentPart, DcpMessage, DcpToolResultPart } from "../src/lib/types.ts";

function textOf(part: DcpContentPart): string {
  return (part as { text?: string }).text ?? "";
}

// The v1 message-priority suite also covered the anchored nudge injection
// (applyAnchoredNudges: message-mode/range-mode nudge placement). That
// mechanism ports with ticket #15 (nudges + context limits); its seven test
// cases are deliberately excluded here.

function buildConfig(mode: "message" | "range" = "message"): DcpConfig {
  return {
    enabled: true,
    debug: false,
    pruneNotification: "off",
    pruneNotificationType: "chat",
    commands: {
      enabled: true,
      protectedTools: [],
    },
    manualMode: {
      enabled: false,
      automaticStrategies: true,
    },
    turnProtection: {
      enabled: false,
      turns: 4,
    },
    experimental: {
      allowSubAgents: false,
      customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
      mode,
      permission: "allow",
      showCompression: false,
      maxContextLimit: 150000,
      minContextLimit: 50000,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      summaryBuffer: true,
      protectedTools: ["task"],
      protectTags: false,
      protectUserMessages: false,
    },
    strategies: {
      deduplication: {
        enabled: true,
        protectedTools: [],
      },
      purgeErrors: {
        enabled: true,
        turns: 4,
        protectedTools: [],
      },
    },
  };
}

function repeatedWord(word: string, count: number): string {
  return Array.from({ length: count }, () => word).join(" ");
}

function buildMessage(id: string, role: "user" | "assistant", text: string): DcpMessage {
  return { id, role, content: [{ type: "text", text }] };
}

function toolResultMessage(
  id: string,
  callID: string,
  tool: string,
  value: unknown,
  type: "text" | "json" | "error" = "text",
): DcpMessage {
  return {
    id,
    role: "tool",
    content: [{ type: "tool-result", id: callID, name: tool, result: { type, value } }],
  };
}

test("injectMessageIds injects ID into every tool output for assistant messages", () => {
  const messages: DcpMessage[] = [
    {
      id: "msg-user-1",
      role: "user",
      content: [
        { type: "text", text: repeatedWord("investigate", 6000) },
        { type: "text", text: "Trailing note." },
      ],
    },
    {
      id: "msg-assistant-1",
      role: "assistant",
      content: [
        { type: "text", text: "Short follow-up note." },
        { type: "tool-call", id: "call-task-1", name: "task", input: { description: "demo" } },
        { type: "text", text: "Second text chunk." },
        { type: "tool-call", id: "call-task-2", name: "bash", input: { description: "demo" } },
      ],
    },
    toolResultMessage("msg-tool-1", "call-task-1", "task", "task output body"),
    toolResultMessage("msg-tool-2", "call-task-2", "bash", "second tool output body"),
  ];
  const state = createSessionState();
  const config = buildConfig();

  assignMessageRefs(state, messages);
  const compressionPriorities = buildPriorityMap(config, state, messages);

  injectMessageIds(state, config, messages, compressionPriorities);

  const userContent = messages[0].content;
  const assistantContent = messages[1].content;
  const toolOne = messages[2].content[0] as DcpToolResultPart;
  const toolTwo = messages[3].content[0] as DcpToolResultPart;

  assert.equal(userContent.length, 2);
  assert.equal(assistantContent.length, 4);
  // User messages: still injected into all text parts
  assert.match(
    textOf(userContent[0]),
    /\n\n<dcp-message-id priority="high">m0001<\/dcp-message-id>/,
  );
  assert.match(
    textOf(userContent[1]),
    /\n\n<dcp-message-id priority="high">m0001<\/dcp-message-id>/,
  );
  // Assistant messages: ID injected into every tool output, not the text parts
  assert.doesNotMatch(textOf(assistantContent[0]), /dcp-message-id/);
  assert.match(toolOne.result.value as string, /m0002<\/dcp-message-id>/);
  assert.doesNotMatch(textOf(assistantContent[2]), /dcp-message-id/);
  assert.match(toolTwo.result.value as string, /m0002<\/dcp-message-id>/);
});

test("injectMessageIds marks every protected user text part as BLOCKED in message mode", () => {
  const messages: DcpMessage[] = [
    {
      id: "msg-user-1",
      role: "user",
      content: [
        { type: "text", text: repeatedWord("investigate", 6000) },
        { type: "text", text: "Trailing note." },
      ],
    },
    buildMessage("msg-assistant-1", "assistant", "Short follow-up note."),
  ];
  const state = createSessionState();
  const config = buildConfig();
  config.compress.protectUserMessages = true;

  assignMessageRefs(state, messages);
  const compressionPriorities = buildPriorityMap(config, state, messages);

  injectMessageIds(state, config, messages, compressionPriorities);

  const userContent = messages[0].content;
  const assistantText = textOf(messages[1].content[0]);

  assert.match(textOf(userContent[0]), /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/);
  assert.match(textOf(userContent[1]), /\n\n<dcp-message-id>BLOCKED<\/dcp-message-id>/);
  assert.doesNotMatch(textOf(userContent[0]), /priority=/);
  assert.doesNotMatch(textOf(userContent[1]), /priority=/);
  assert.match(assistantText, /\n\n<dcp-message-id priority="low">m0002<\/dcp-message-id>/);
});

test("injectMessageIds injects ID into every tool output in range mode", () => {
  const messages: DcpMessage[] = [
    buildMessage("msg-user-1", "user", repeatedWord("investigate", 6000)),
    {
      id: "msg-assistant-1",
      role: "assistant",
      content: [
        { type: "text", text: "First chunk." },
        {
          type: "tool-call",
          id: "call-task-range-1",
          name: "task",
          input: { description: "demo" },
        },
        { type: "text", text: "Second chunk." },
        {
          type: "tool-call",
          id: "call-task-range-2",
          name: "bash",
          input: { description: "demo" },
        },
      ],
    },
    toolResultMessage("msg-tool-1", "call-task-range-1", "task", "first output"),
    toolResultMessage("msg-tool-2", "call-task-range-2", "bash", "second output"),
  ];
  const state = createSessionState();
  const config = buildConfig("range");

  assignMessageRefs(state, messages);
  injectMessageIds(state, config, messages);

  const assistantContent = messages[1].content;
  const toolOne = messages[2].content[0] as DcpToolResultPart;
  const toolTwo = messages[3].content[0] as DcpToolResultPart;

  // Every tool output gets the ID
  assert.doesNotMatch(textOf(assistantContent[0]), /dcp-message-id/);
  assert.match(toolOne.result.value as string, /m0002<\/dcp-message-id>/);
  assert.doesNotMatch(textOf(assistantContent[2]), /dcp-message-id/);
  assert.match(toolTwo.result.value as string, /m0002<\/dcp-message-id>/);
});

test("message mode marks compress tool messages as high priority even when short", () => {
  const messages: DcpMessage[] = [
    buildMessage("msg-user-1", "user", "Please compress this chunk."),
    {
      id: "msg-assistant-1",
      role: "assistant",
      content: [
        { type: "text", text: "Done." },
        {
          type: "tool-call",
          id: "call-compress-1",
          name: "compress",
          input: { topic: "Compression topic", content: [] },
        },
      ],
    },
    toolResultMessage(
      "msg-tool-compress",
      "call-compress-1",
      "compress",
      "[Compressed conversation section]",
    ),
  ];
  const state = createSessionState();
  const config = buildConfig();

  assignMessageRefs(state, messages);
  const compressionPriorities = buildPriorityMap(config, state, messages);

  assert.equal(compressionPriorities.get("msg-assistant-1")?.priority, "high");

  injectMessageIds(state, config, messages, compressionPriorities);

  const assistantText = textOf(messages[1].content[0]);
  const toolValue = (messages[2].content[0] as DcpToolResultPart).result.value as string;

  // ID injected into tool output, not the text part
  assert.doesNotMatch(assistantText, /dcp-message-id/);
  assert.match(toolValue, /m0002<\/dcp-message-id>/);
  assert.match(toolValue, /<dcp-message-id priority="high">m0002<\/dcp-message-id>/);
});

test("message-mode rendered compressed summaries mark block IDs as BLOCKED", () => {
  const messages: DcpMessage[] = [
    buildMessage("msg-user-1", "user", "Original request"),
    buildMessage("msg-assistant-1", "assistant", "Follow-up"),
  ];
  const state = createSessionState();
  const config = buildConfig("message");
  const logger = new Logger(false);
  state.prune.messages.byMessageId.set("msg-user-1", {
    tokenCount: 20,
    allBlockIds: [7],
    activeBlockIds: [7],
  });
  state.prune.messages.blocksById.set(7, {
    blockId: 7,
    runId: 1,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens: 0,
    durationMs: 0,
    mode: "range",
    topic: "Earlier notes",
    batchTopic: "Earlier notes",
    startId: "m0001",
    endId: "m0001",
    anchorMessageId: "msg-user-1",
    compressMessageId: "msg-origin",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: ["msg-user-1"],
    directToolIds: [],
    effectiveMessageIds: ["msg-user-1"],
    effectiveToolIds: [],
    createdAt: 1,
    summary:
      "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
  });
  state.prune.messages.activeBlockIds.add(7);
  state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7);

  prune(state, logger, config, messages);

  const summaryText = (messages[0].content[0] as { text?: string }).text ?? "";
  assert.match(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/);
  assert.doesNotMatch(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/);
});

test("range-mode rendered compressed summaries keep block IDs", () => {
  const messages: DcpMessage[] = [
    buildMessage("msg-user-1", "user", "Original request"),
    buildMessage("msg-assistant-1", "assistant", "Follow-up"),
  ];
  const state = createSessionState();
  const config = buildConfig("range");
  const logger = new Logger(false);
  state.prune.messages.byMessageId.set("msg-user-1", {
    tokenCount: 20,
    allBlockIds: [7],
    activeBlockIds: [7],
  });
  state.prune.messages.blocksById.set(7, {
    blockId: 7,
    runId: 1,
    active: true,
    deactivatedByUser: false,
    compressedTokens: 0,
    summaryTokens: 0,
    durationMs: 0,
    mode: "range",
    topic: "Earlier notes",
    batchTopic: "Earlier notes",
    startId: "m0001",
    endId: "m0001",
    anchorMessageId: "msg-user-1",
    compressMessageId: "msg-origin",
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: ["msg-user-1"],
    directToolIds: [],
    effectiveMessageIds: ["msg-user-1"],
    effectiveToolIds: [],
    createdAt: 1,
    summary:
      "[Compressed conversation section]\nEarlier summary\n\n<dcp-message-id>b7</dcp-message-id>",
  });
  state.prune.messages.activeBlockIds.add(7);
  state.prune.messages.activeByAnchorMessageId.set("msg-user-1", 7);

  prune(state, logger, config, messages);

  const summaryText = (messages[0].content[0] as { text?: string }).text ?? "";
  assert.match(summaryText, /<dcp-message-id>b7<\/dcp-message-id>/);
  assert.doesNotMatch(summaryText, /<dcp-message-id>BLOCKED<\/dcp-message-id>/);
});

test("hallucination stripping removes all dcp-prefixed XML tags including variants", async () => {
  const text =
    "alpha" +
    '<dcp-message-id priority="low">m0008</dcp-message-id>' +
    '<dcp-message-id-extra priority="high">m0008</dcp-message-id-extra>' +
    "<dcp-system-reminder>strip this</dcp-system-reminder>" +
    "<dcp-system-reminder-extra>strip this too</dcp-system-reminder-extra>" +
    "omega";

  assert.equal(stripHallucinationsFromString(text), "alphaomega");
});

test("hallucination stripping removes colon and underscore dcp tag variants", async () => {
  assert.equal(stripHallucinationsFromString("beforeafter"), "beforeafter");
  assert.equal(stripHallucinationsFromString("startend"), "startend");
});

test("hallucination stripping removes orphan opening tags", async () => {
  assert.equal(
    stripHallucinationsFromString("narration\n\n<dcp:function_calls>\n\n"),
    "narration\n\n\n\n",
  );
  assert.equal(stripHallucinationsFromString('text <dcp:invoke name="edit"> more'), "text  more");
});

test("hallucination stripping removes orphan closing tags", async () => {
  assert.equal(stripHallucinationsFromString("text</dcp:function_calls> more"), "text more");
  assert.equal(stripHallucinationsFromString("before</dcp-message-id>after"), "beforeafter");
});

test("hallucination stripping handles nested dcp tags", async () => {
  assert.equal(
    stripHallucinationsFromString(
      'before<dcp:function_calls>\n<dcp:invoke name="edit">content</dcp:invoke>\n</dcp:function_calls>after',
    ),
    "before\nafter",
  );
});

test("hallucination stripping handles mixed paired and orphan tags", async () => {
  assert.equal(
    stripHallucinationsFromString(
      'text\n<dcp-message-id priority="low">m0045</dcp-message-id>\n<dcp:function_calls>\n',
    ),
    "text\n\n\n",
  );
});

test("hallucination stripping does not affect non-dcp tags", async () => {
  assert.equal(
    stripHallucinationsFromString("<div>hello</div> <system-reminder>keep</system-reminder>"),
    "<div>hello</div> <system-reminder>keep</system-reminder>",
  );
});

test("hallucination stripping preserves content when dcp-message-id is mentioned in text (issue #556)", () => {
  const input =
    "The tag called `<dcp-message-id>` is used to track messages. " +
    "This text should survive.\n\n" +
    "<dcp-message-id>m0369</dcp-message-id>";

  assert.equal(
    stripHallucinationsFromString(input),
    "The tag called `` is used to track messages. This text should survive.\n\n",
  );
});

test("hallucination stripping handles priority on injected message-id suffixes", () => {
  const input =
    "The tag called `<dcp-message-id>` is used to track messages. " +
    "This text should survive.\n\n" +
    '<dcp-message-id priority="low">m0370</dcp-message-id>';

  assert.equal(
    stripHallucinationsFromString(input),
    "The tag called `` is used to track messages. This text should survive.\n\n",
  );
});

test("hallucination stripping removes trailing mXXXX</parameter> artifact (issue #555)", () => {
  assert.equal(
    stripHallucinationsFromString("Total: maybe 20 lines changed.\n\nm0340</parameter>\n\n"),
    "Total: maybe 20 lines changed.\n\n",
  );
});
test("injectMessageIds skips empty assistant messages to avoid prefill (issue #463)", () => {
  const messages: DcpMessage[] = [
    buildMessage("msg-user-1", "user", "Hello"),
    { id: "msg-assistant-empty", role: "assistant", content: [] },
    buildMessage("msg-user-2", "user", "continue"),
  ];
  const state = createSessionState();
  const config = buildConfig("range");

  assignMessageRefs(state, messages);
  injectMessageIds(state, config, messages);

  assert.equal(messages[1].content.length, 0, "empty assistant should get no synthetic parts");
});

test("injectMessageIds skips assistant with only pending tool parts (issue #463)", () => {
  const messages: DcpMessage[] = [
    buildMessage("msg-user-1", "user", "Hello"),
    {
      id: "msg-assistant-pending",
      role: "assistant",
      content: [
        { type: "tool-call", id: "call-pending-1", name: "bash", input: { command: "ls" } },
      ],
    },
    buildMessage("msg-user-2", "user", "continue"),
  ];
  const state = createSessionState();
  const config = buildConfig("range");

  assignMessageRefs(state, messages);
  injectMessageIds(state, config, messages);

  assert.equal(
    messages[1].content.length,
    1,
    "assistant with only pending tools should not get a synthetic text part",
  );
  assert.equal(messages[1].content[0].type, "tool-call");
});

test("injectMessageIds skips assistant with empty text part (issue #463)", () => {
  const messages: DcpMessage[] = [
    buildMessage("msg-user-1", "user", "Hello"),
    { id: "msg-assistant-empty-text", role: "assistant", content: [{ type: "text", text: "" }] },
    buildMessage("msg-user-2", "user", "continue"),
  ];
  const state = createSessionState();
  const config = buildConfig("range");

  assignMessageRefs(state, messages);
  injectMessageIds(state, config, messages);

  assert.equal(messages[1].content.length, 1, "should not add a synthetic part");
  assert.equal(
    (messages[1].content[0] as { text?: string }).text,
    "",
    "empty text part should remain untouched",
  );
});
