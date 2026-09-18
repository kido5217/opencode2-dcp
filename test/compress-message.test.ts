import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { createCompressMessageTool } from "../src/lib/compress/message.ts";
import { normalizeMessageArgs, validateArgs } from "../src/lib/compress/message-utils.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import type { WithParts } from "../src/lib/compress/withparts.ts";
import type { DcpConfig } from "../src/config.ts";
import type { ToolContext as CompressToolContext } from "../src/lib/compress/types.ts";
import { Logger } from "../src/lib/logger.ts";

const testDataHome = join(tmpdir(), `opencode-dcp-message-tests-${process.pid}`);
const testConfigHome = join(tmpdir(), `opencode-dcp-message-config-tests-${process.pid}`);

process.env.XDG_DATA_HOME = testDataHome;
process.env.XDG_CONFIG_HOME = testConfigHome;

mkdirSync(testDataHome, { recursive: true });
mkdirSync(testConfigHome, { recursive: true });

const mockStorageMap = new Map<string, unknown>();
const mockStorage = {
  get: async (key: string) => mockStorageMap.get(key),
  set: async (key: string, value: unknown) => {
    mockStorageMap.set(key, value);
  },
  scan: async () => [],
};

function buildConfig(): DcpConfig {
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
      mode: "message",
      permission: "allow",
      showCompression: false,
      maxContextLimit: 150000,
      minContextLimit: 50000,
      nudgeFrequency: 5,
      iterationNudgeThreshold: 15,
      nudgeForce: "soft",
      protectedTools: ["task"],
      protectTags: false,
      protectUserMessages: false,
      summaryBuffer: true,
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

function textPart(messageID: string, sessionID: string, id: string, text: string) {
  return {
    id,
    messageID,
    sessionID,
    type: "text" as const,
    text,
  };
}

function toolPart(
  messageID: string,
  sessionID: string,
  callID: string,
  toolName: string,
  output: string,
) {
  return {
    id: `${callID}-part`,
    messageID,
    sessionID,
    type: "tool" as const,
    tool: toolName,
    callID,
    state: {
      status: "completed" as const,
      input: { description: "demo" },
      output,
    },
  };
}

function buildMessages(sessionID: string): WithParts[] {
  return [
    {
      info: {
        id: "msg-user-1",
        role: "user",
        sessionID,
        agent: "assistant",
        model: {
          providerID: "anthropic",
          modelID: "claude-test",
        },
        time: { created: 1 },
      } as WithParts["info"],
      parts: [textPart("msg-user-1", sessionID, "part-1", "Investigate the issue")],
    },
    {
      info: {
        id: "msg-assistant-1",
        role: "assistant",
        sessionID,
        agent: "assistant",
        time: { created: 2 },
      } as WithParts["info"],
      parts: [textPart("msg-assistant-1", sessionID, "part-2", "I mapped the code path")],
    },
    {
      info: {
        id: "msg-assistant-2",
        role: "assistant",
        sessionID,
        agent: "assistant",
        time: { created: 3 },
      } as WithParts["info"],
      parts: [
        textPart("msg-assistant-2", sessionID, "part-3", "I also ran a task tool"),
        toolPart("msg-assistant-2", sessionID, "call-task-1", "task", "task output body"),
      ],
    },
  ];
}

test("compress message tool appends non-editable format extension", () => {
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger: new Logger(false),
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => [],
    state: createSessionState(),
    logger: new Logger(false),
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  assert.match(tool.description, /THE FORMAT OF COMPRESS/);
  assert.match(tool.description, /messageId: string/);
  assert.match(tool.description, /Raw message ID only: mNNNN/);
});

test("compress message mode batches individual message summaries", async () => {
  const sessionID = `ses_message_compress_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "Batch stale notes",
      content: [
        {
          messageId: "m0002",
          topic: "Code path note",
          summary: "Captured the assistant's code-path findings.",
        },
        {
          messageId: "m0003",
          topic: "Task output note",
          summary: "Captured the assistant's task-backed follow-up.",
        },
      ],
    },
    {
      id: "call-1",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message",
    },
  );

  assert.equal(result.content, "Compressed 2 messages into [Compressed conversation section].");
  assert.equal(state.prune.messages.blocksById.size, 2);

  const blocks = Array.from(state.prune.messages.blocksById.values()).sort(
    (a, b) => a.blockId - b.blockId,
  );

  assert.equal(blocks[0]?.startId, "m0002");
  assert.equal(blocks[0]?.endId, "m0002");
  assert.equal(blocks[0]?.topic, "Code path note");
  assert.equal(blocks[1]?.startId, "m0003");
  assert.equal(blocks[1]?.endId, "m0003");
  assert.match(
    blocks[1]?.summary || "",
    /The following protected tools were used in this conversation as well:/,
  );
  assert.match(blocks[1]?.summary || "", /Tool: task/);
  assert.match(blocks[1]?.summary || "", /task output body/);
});

test("compress message mode appends protected prompt info", async () => {
  const sessionID = `ses_message_protect_tag_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const user = rawMessages.find((message) => message.info.id === "msg-user-1");
  const part = user?.parts[0];
  if (part?.type === "text") {
    part.text = "Investigate the issue. <protect>Always preserve release checklist.</protect>";
  }

  const state = createSessionState();
  const logger = new Logger(false);
  const config = buildConfig();
  config.compress.protectTags = true;
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config,
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  await tool.execute(
    {
      topic: "Protected note",
      content: [
        {
          messageId: "m0001",
          topic: "User request note",
          summary: "Captured the user's investigation request.",
        },
      ],
    },
    {
      id: "call-2",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-protect-tag",
    },
  );

  const block = Array.from(state.prune.messages.blocksById.values())[0];
  assert.match(
    block?.summary || "",
    /The following protected prompt information was included in this conversation verbatim:/,
  );
  assert.match(block?.summary || "", /Always preserve release checklist\./);
});

test("compress message mode ignores protect tags on ignored user messages", async () => {
  const sessionID = `ses_message_ignored_protect_tag_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const user = rawMessages.find((message) => message.info.id === "msg-user-1");
  const part = user?.parts[0] as any;
  if (part?.type === "text") {
    part.text = "Ignored notification. <protect>Do not preserve ignored note.</protect>";
    part.ignored = true;
  }

  const state = createSessionState();
  const logger = new Logger(false);
  const config = buildConfig();
  config.compress.protectTags = true;
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config,
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  await tool.execute(
    {
      topic: "Ignored protected note",
      content: [
        {
          messageId: "m0001",
          topic: "Ignored note",
          summary: "Captured the ignored user message.",
        },
      ],
    },
    {
      id: "call-3",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-ignored-protect-tag",
    },
  );

  const block = Array.from(state.prune.messages.blocksById.values())[0];
  assert.doesNotMatch(
    block?.summary || "",
    /The following protected prompt information was included in this conversation verbatim:/,
  );
  assert.doesNotMatch(block?.summary || "", /Do not preserve ignored note\./);
});

test("compress message mode stores call id for later duration attachment", async () => {
  const sessionID = `ses_message_compress_duration_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);

  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  await tool.execute(
    {
      topic: "Batch stale notes",
      content: [
        {
          messageId: "m0002",
          topic: "Code path note",
          summary: "Captured the assistant's code-path findings.",
        },
      ],
    },
    {
      id: "call-1",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message",
    },
  );

  const block = Array.from(state.prune.messages.blocksById.values())[0];
  assert.equal(block?.compressCallId, "call-1");
  assert.equal(block?.durationMs, 0);
});

test("compress message mode does not partially apply when preparation fails", async () => {
  const sessionID = `ses_message_compress_prepare_fail_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const config = buildConfig();
  config.experimental.allowSubAgents = true;

  state.subAgentResultCache.get = (() => {
    throw new Error("cache failure");
  }) as typeof state.subAgentResultCache.get;

  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config,
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "Batch stale notes",
      content: [
        {
          messageId: "m0002",
          topic: "Code path note",
          summary: "Captured the assistant's code-path findings.",
        },
        {
          messageId: "m0003",
          topic: "Task output note",
          summary: "Captured the assistant's task-backed follow-up.",
        },
      ],
    },
    {
      id: "call-5",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-prepare-fail",
    },
  );

  assert.match(result.content, /cache failure/);

  assert.equal(state.prune.messages.blocksById.size, 0);
});

test("compress message mode rejects compressed block ids", async () => {
  const sessionID = `ses_message_compress_reject_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "Reject block ids",
      content: [
        {
          messageId: "b1",
          topic: "Invalid target",
          summary: "Should not be accepted.",
        },
      ],
    },
    {
      id: "call-6",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-reject",
    },
  );

  assert.match(result.content, /Unable to compress any messages\. Found 1 issue:/);
});

test("compress message mode skips protected user message references", async () => {
  const sessionID = `ses_message_compress_protected_user_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const config = buildConfig();
  config.compress.protectUserMessages = true;

  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config,
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "Protected user entries",
      content: [
        {
          messageId: "BLOCKED",
          topic: "Protected marker",
          summary: "Should be skipped.",
        },
        {
          messageId: "m0001",
          topic: "Hidden protected ref",
          summary: "Should also be skipped.",
        },
        {
          messageId: "m0002",
          topic: "Valid note",
          summary: "Captured the assistant's code-path findings.",
        },
      ],
    },
    {
      id: "call-7",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-protected-user",
    },
  );

  assert.equal(state.prune.messages.blocksById.size, 1);
  assert.match(result.content, /^Compressed 1 message into \[Compressed conversation section\]\./);
  assert.match(result.content, /Skipped 2 issues:/);
  assert.match(result.content, /messageId BLOCKED refers to a protected message/);
  assert.match(result.content, /messageId m0001 refers to a protected message/);
});

test("compress message mode allows messages containing compress tool parts", async () => {
  const sessionID = `ses_message_compress_tool_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  rawMessages.push({
    info: {
      id: "msg-assistant-compress",
      role: "assistant",
      sessionID,
      agent: "assistant",
      time: { created: 4 },
    } as WithParts["info"],
    parts: [
      {
        id: "compress-part",
        messageID: "msg-assistant-compress",
        sessionID,
        type: "tool" as const,
        tool: "compress",
        callID: "call-compress-1",
        state: {
          status: "completed" as const,
          input: { topic: "Earlier compression" },
          output: "done",
        },
      },
    ],
  });

  const state = createSessionState();
  const logger = new Logger(false);
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "Compress compress call",
      content: [
        {
          messageId: "m0004",
          topic: "Compress tool message",
          summary: "Captured the earlier compress tool call.",
        },
      ],
    },
    {
      id: "call-8",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-allow-compress-tool",
    },
  );

  assert.equal(result.content, "Compressed 1 message into [Compressed conversation section].");
  assert.equal(state.prune.messages.blocksById.size, 1);
  const block = Array.from(state.prune.messages.blocksById.values())[0];
  assert.equal(block?.startId, "m0004");
});

test("compress message mode aggregates batched messages into one tool call", async () => {
  const sessionID = `ses_message_compress_notify_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const config = buildConfig();
  config.pruneNotification = "detailed";
  config.pruneNotificationType = "toast";

  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config,
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  await tool.execute(
    {
      topic: "Batch stale notes",
      content: [
        {
          messageId: "m0002",
          topic: "Code path note",
          summary: "Captured the assistant's code-path findings.",
        },
        {
          messageId: "m0003",
          topic: "Task output note",
          summary: "Captured the assistant's task-backed follow-up.",
        },
      ],
    },
    {
      id: "call-9",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-notify",
    },
  );

  assert.equal(state.prune.messages.blocksById.size, 2);
  const blocks = [...state.prune.messages.blocksById.values()];
  assert.equal(blocks[0]?.runId, blocks[1]?.runId);
  assert.equal(blocks[0]?.batchTopic, "Batch stale notes");
  assert.equal(blocks[1]?.batchTopic, "Batch stale notes");
});

test("compress message mode skips messages that are already actively compressed", async () => {
  const sessionID = `ses_message_compress_reuse_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  await tool.execute(
    {
      topic: "First pass",
      content: [
        {
          messageId: "m0002",
          topic: "Code path note",
          summary: "Captured the assistant's code-path findings.",
        },
      ],
    },
    {
      id: "call-10",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-first-pass",
    },
  );

  const result = await tool.execute(
    {
      topic: "Second pass",
      content: [
        {
          messageId: "m0002",
          topic: "Already compressed note",
          summary: "Should be skipped because it is already compressed.",
        },
        {
          messageId: "m0003",
          topic: "Task output note",
          summary: "Captured the assistant's task-backed follow-up.",
        },
      ],
    },
    {
      id: "call-11",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-second-pass",
    },
  );

  assert.equal(state.prune.messages.blocksById.size, 2);
  assert.match(result.content, /^Compressed 1 message into \[Compressed conversation section\]\./);
  assert.match(result.content, /Skipped 1 issue:/);
  assert.match(result.content, /messageId m0002 is already part of an active compression\./);
});

test("compress message mode skips invalid batch entries and reports issues", async () => {
  const sessionID = `ses_message_compress_partial_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "Mixed entries",
      content: [
        {
          messageId: "b1",
          topic: "Invalid block id",
          summary: "Should be skipped.",
        },
        {
          messageId: "m0002",
          topic: "Valid note",
          summary: "Captured the assistant's code-path findings.",
        },
        {
          messageId: "m9999",
          topic: "Missing message",
          summary: "Should also be skipped.",
        },
        {
          messageId: "m0002",
          topic: "Duplicate valid note",
          summary: "Duplicate entry should be skipped.",
        },
      ],
    },
    {
      id: "call-12",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-partial",
    },
  );

  assert.equal(state.prune.messages.blocksById.size, 1);
  assert.match(result.content, /^Compressed 1 message into \[Compressed conversation section\]\./);
  assert.match(result.content, /Skipped 3 issues:/);
  assert.match(result.content, /Block IDs like bN are not allowed/);
  assert.match(
    result.content,
    /messageId m9999 is not available in the current conversation context/,
  );
  assert.match(result.content, /messageId m0002 was selected more than once in this batch\./);
});

test("compress message mode reports issues when every batch entry is skipped", async () => {
  const sessionID = `ses_message_compress_all_invalid_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);
  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "All invalid",
      content: [
        {
          messageId: "b1",
          topic: "Invalid block id",
          summary: "Should be skipped.",
        },
        {
          messageId: "m9999",
          topic: "Missing message",
          summary: "Should also be skipped.",
        },
      ],
    },
    {
      id: "call-13",
      progress: async () => {},
      sessionID,
      messageID: "msg-compress-message-all-invalid",
    },
  );

  assert.match(result.content, /Unable to compress any messages\. Found 2 issues:/);

  assert.equal(state.prune.messages.blocksById.size, 0);
});

test("compress message normalizes single-object content into an array", () => {
  const input = normalizeMessageArgs({
    topic: "Message fix",
    content: { messageId: "m0001", topic: "Label", summary: "Summary text." },
  });
  assert.deepEqual(input.content, [
    { messageId: "m0001", topic: "Label", summary: "Summary text." },
  ]);
  assert.doesNotThrow(() => validateArgs(input));
});

test("compress message rejects plain-string content with re-send guidance", () => {
  assert.throws(
    () =>
      normalizeMessageArgs({
        topic: "Message fix",
        content: "A plain summary without a message id.",
      }),
    (err: Error) => err.message.includes("JSON array") && err.message.includes("messageId"),
  );
});

test("compress message still rejects empty content arrays", () => {
  const input = normalizeMessageArgs({ topic: "Message fix", content: [] });
  assert.throws(() => validateArgs(input), /content is required and must be a non-empty array/);
});

test("compress message rejects a JSON-encoded empty content array with the non-empty error", () => {
  assert.throws(
    () => normalizeMessageArgs({ topic: "Message fix", content: "[]" }),
    /content is required and must be a non-empty array/,
  );
});

test("compress message execute accepts a JSON-string content payload", async () => {
  const sessionID = `ses_message_json_string_${Date.now()}`;
  const rawMessages = buildMessages(sessionID);
  const state = createSessionState();
  const logger = new Logger(false);

  const tool = createCompressMessageTool({
    deps: {
      storage: mockStorage,
      logger,
      isSubAgentSession: async () => false,
    },
    fetchDurableMessages: async () => rawMessages,
    state,
    logger,
    config: buildConfig(),
    prompts: {
      reload() {},
      getRuntimePrompts() {
        return { compressMessage: "", compressRange: "" };
      },
    },
  } as unknown as CompressToolContext);

  const result = await tool.execute(
    {
      topic: "JSON string batch",
      content: JSON.stringify([
        { messageId: "m0002", topic: "JSON note", summary: "Captured via a JSON-string payload." },
      ]),
    },
    {
      sessionID,
      messageID: "msg-compress-json-string",
      id: "call-json-string",
      progress: async () => {},
    },
  );

  assert.match(result.content, /^Compressed 1 message into \[Compressed conversation section\]\./);
  assert.equal(state.prune.messages.blocksById.size, 1);
});
