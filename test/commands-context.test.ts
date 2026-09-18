import assert from "node:assert/strict";
import test from "node:test";
import { analyzeContextTokens } from "../src/lib/commands/context.ts";
import type { WithPart, WithParts } from "../src/lib/compress/withparts.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import { countTokens } from "../src/lib/token-utils.ts";

function textMessage(id: string, role: "user" | "assistant", text: string): WithParts {
  return {
    info: { id, sessionID: "ses_test", role, time: { created: 1 } },
    parts: [{ type: "text", text }],
  };
}

function assistantWithTokens(
  id: string,
  text: string,
  tokens: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  },
): WithParts {
  return {
    info: { id, sessionID: "ses_test", role: "assistant", time: { created: 2 }, tokens },
    parts: [{ type: "text", text }],
  };
}

function toolPart(
  id: string,
  callID: string,
  status: string,
  input?: unknown,
  output?: unknown,
): WithPart {
  return { type: "tool", tool: "bash", callID, state: { status, input, output } } as WithPart;
}

test("analyzeContextTokens computes the API-based breakdown", () => {
  const state = createSessionState();
  const messages: WithParts[] = [
    textMessage("msg-user-1", "user", "alpha"),
    assistantWithTokens("msg-assistant-1", "first reply", {
      input: 1000,
      output: 500,
      cache: { read: 100, write: 50 },
    }),
    textMessage("msg-user-2", "user", "beta"),
    assistantWithTokens("msg-assistant-2", "second reply", {
      input: 2000,
      output: 1000,
      cache: { read: 200, write: 100 },
    }),
  ];

  const breakdown = analyzeContextTokens(state, messages);

  assert.equal(breakdown.total, 3300);
  assert.equal(breakdown.user, countTokens("alpha\nbeta"));
  assert.equal(breakdown.system, 1150 - countTokens("alpha"));
  assert.equal(breakdown.tools, 0);
  assert.equal(
    breakdown.assistant,
    breakdown.total - breakdown.system - breakdown.user - breakdown.tools,
  );
  assert.equal(breakdown.toolCount, 0);
  assert.equal(breakdown.toolsInContextCount, 0);
  assert.equal(breakdown.prunedToolCount, 0);
  assert.equal(breakdown.prunedMessageCount, 0);
  assert.equal(breakdown.prunedTokens, 0);
});

test("analyzeContextTokens tokenizes tool inputs and completed outputs", () => {
  const state = createSessionState();
  const messages: WithParts[] = [
    textMessage("msg-user-1", "user", "alpha"),
    {
      info: {
        id: "msg-assistant-1",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: 2 },
        tokens: { input: 1000, output: 400 },
      },
      parts: [
        { type: "text", text: "working" },
        toolPart("part-tool-1", "call-1", "completed", { command: "ls" }, "file1\nfile2"),
      ],
    },
  ];

  const breakdown = analyzeContextTokens(state, messages);

  assert.equal(breakdown.toolCount, 1);
  assert.equal(breakdown.toolsInContextCount, 1);
  assert.equal(
    breakdown.tools,
    countTokens(JSON.stringify({ command: "ls" })) + countTokens("file1\nfile2"),
  );
  assert.equal(breakdown.total, 1400);
});

test("analyzeContextTokens excludes pruned tools from tokens and in-context count", () => {
  const state = createSessionState();
  state.prune.tools.set("call-1", 400);
  const messages: WithParts[] = [
    textMessage("msg-user-1", "user", "alpha"),
    {
      info: {
        id: "msg-assistant-1",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: 2 },
        tokens: { input: 1000, output: 400 },
      },
      parts: [
        { type: "text", text: "working" },
        toolPart("part-tool-1", "call-1", "completed", { command: "ls" }, "file1\nfile2"),
      ],
    },
  ];

  const breakdown = analyzeContextTokens(state, messages);

  assert.equal(breakdown.toolCount, 1);
  assert.equal(breakdown.toolsInContextCount, 0);
  assert.equal(breakdown.tools, 0);
  assert.equal(breakdown.prunedToolCount, 1);
  assert.equal(breakdown.prunedTokens, 0);
});

test("analyzeContextTokens skips compacted messages for tools and user text", () => {
  const state = createSessionState();
  state.prune.messages.byMessageId.set("msg-user-1", {
    tokenCount: 10,
    allBlockIds: [1],
    activeBlockIds: [1],
  });
  state.prune.messages.byMessageId.set("msg-assistant-1", {
    tokenCount: 20,
    allBlockIds: [1],
    activeBlockIds: [1],
  });
  const messages: WithParts[] = [
    textMessage("msg-user-1", "user", "compacted user text"),
    {
      info: {
        id: "msg-assistant-1",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: 2 },
      },
      parts: [toolPart("part-tool-1", "call-1", "completed", { command: "ls" }, "output")],
    },
    textMessage("msg-user-2", "user", "visible user text"),
    assistantWithTokens("msg-assistant-2", "reply", { input: 900, output: 100 }),
  ];

  const breakdown = analyzeContextTokens(state, messages);

  assert.equal(breakdown.user, countTokens("visible user text"));
  assert.equal(breakdown.tools, 0);
  assert.equal(breakdown.toolCount, 1);
  assert.equal(breakdown.toolsInContextCount, 0);
  assert.equal(breakdown.prunedMessageCount, 2);
});

test("analyzeContextTokens uses the placeholder for compacted tool outputs", () => {
  const state = createSessionState();
  const messages: WithParts[] = [
    textMessage("msg-user-1", "user", "alpha"),
    {
      info: {
        id: "msg-assistant-1",
        sessionID: "ses_test",
        role: "assistant" as const,
        time: { created: 2 },
        tokens: { input: 1000, output: 400 },
      },
      parts: [
        {
          type: "tool",
          tool: "bash",
          callID: "call-1",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "long output",
            time: { compacted: true },
          },
        } as WithPart,
      ],
    },
  ];

  const breakdown = analyzeContextTokens(state, messages);

  assert.equal(
    breakdown.tools,
    countTokens(JSON.stringify({ command: "ls" })) +
      countTokens("[Old tool result content cleared]"),
  );
});

test("analyzeContextTokens carries state totalPruneTokens into prunedTokens", () => {
  const state = createSessionState();
  state.stats.totalPruneTokens = 777;

  const breakdown = analyzeContextTokens(state, [textMessage("msg-user-1", "user", "alpha")]);

  assert.equal(breakdown.prunedTokens, 777);
});
