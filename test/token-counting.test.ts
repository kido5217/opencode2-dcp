import assert from "node:assert/strict";
import test from "node:test";
import {
  countAllMessageTokens,
  countToolTokens,
  estimateTokensBatch,
  extractCompletedToolOutput,
  extractToolContent,
  getCurrentTokenUsage,
} from "../src/lib/token-utils.ts";
import type { DcpMessage, DcpToolCallPart, DcpToolResultPart } from "../src/lib/types.ts";

function buildCall(tool: string, input: unknown): DcpToolCallPart {
  return { type: "tool-call", id: `call-${tool}`, name: tool, input };
}

function buildResult(
  tool: string,
  value: unknown,
  type: "text" | "json" | "error" = "text",
): DcpToolResultPart {
  return { type: "tool-result", id: `call-${tool}`, name: tool, result: { type, value } };
}

/** v2 request shape: the call lives in an assistant message, the result in a tool message. */
function buildPair(call: DcpToolCallPart, result?: DcpToolResultPart): DcpMessage[] {
  const messages: DcpMessage[] = [{ id: "msg-assistant", role: "assistant", content: [call] }];
  if (result) {
    messages.push({ id: "msg-tool", role: "tool", content: [result] });
  }
  return messages;
}

function assertCounted(
  call: DcpToolCallPart,
  result: DcpToolResultPart | undefined,
  expectedContents: string[],
) {
  const messages = buildPair(call, result);
  assert.deepEqual(extractToolContent(call, result), expectedContents);
  assert.equal(countToolTokens(call, result), estimateTokensBatch(expectedContents));
  assert.equal(countAllMessageTokens(messages[0], messages), estimateTokensBatch(expectedContents));
}

test("counting includes input for large built-in tool calls", () => {
  const cases = [
    {
      tool: "compress",
      input: {
        topic: "Compression topic",
        content: [{ messageId: "m0001", topic: "Prior work", summary: "Compressed summary" }],
      },
      output: "compressed",
    },
    {
      tool: "apply_patch",
      input: {
        patchText: [
          "*** Begin Patch",
          "*** Update File: src/example.ts",
          "@@",
          "-oldLine()",
          "+newLine()",
          "*** End Patch",
        ].join("\n"),
      },
      output: "Success. Updated the following files:\nM src/example.ts",
    },
    {
      tool: "task",
      input: {
        description: "Research bug",
        prompt: "Investigate the failing workflow and summarize root cause.",
        subagent_type: "general",
        command: "/investigate",
      },
      output: "Queued task ses_123",
    },
    {
      tool: "bash",
      input: {
        command: "python - <<'PY'\nprint(\"hello\")\nPY",
        description: "Runs inline Python script",
        workdir: "/tmp/project",
      },
      output: "hello",
    },
    {
      tool: "batch",
      input: {
        calls: [
          { tool: "read", parameters: { filePath: "/tmp/a.txt" } },
          { tool: "grep", parameters: { pattern: "TODO", path: "/tmp" } },
        ],
      },
      output: [
        { tool: "read", ok: true },
        { tool: "grep", ok: true },
      ],
    },
    {
      tool: "todowrite",
      input: {
        todos: [
          { content: "Inspect bug", status: "in_progress", priority: "high" },
          { content: "Write fix", status: "pending", priority: "high" },
        ],
      },
      output: [{ content: "Inspect bug", status: "completed", priority: "high" }],
    },
    {
      tool: "question",
      input: {
        questions: [
          {
            question: "Use the safer option?",
            header: "Confirm",
            options: [{ label: "Yes", description: "Proceed safely" }],
          },
        ],
      },
      output: ["Yes"],
    },
  ];

  for (const testCase of cases) {
    const call = buildCall(testCase.tool, testCase.input);
    const result = buildResult(
      testCase.tool,
      testCase.output,
      typeof testCase.output === "string" ? "text" : "json",
    );
    const expectedContents = [
      JSON.stringify(testCase.input),
      typeof testCase.output === "string" ? testCase.output : JSON.stringify(testCase.output),
    ];

    assertCounted(call, result, expectedContents);
  }
});

test("counting includes input for errored custom tools", () => {
  const customInput = {
    payload: "some large custom tool payload",
    options: { mode: "deep" },
  };
  const call = buildCall("custom_tool", customInput);
  const result = buildResult("custom_tool", "Tool execution failed", "error");

  assertCounted(call, result, [JSON.stringify(customInput), "Tool execution failed"]);
});

test("counting includes only the input for pending tool calls", () => {
  const input = { filePath: "/tmp/large.log" };
  const call = buildCall("read", input);

  assert.equal(extractCompletedToolOutput(undefined), undefined);
  assertCounted(call, undefined, [JSON.stringify(input)]);
});

test("getCurrentTokenUsage reports the event-derived usage", () => {
  const state = { currentTokenUsage: 0 } as never;
  assert.equal(getCurrentTokenUsage(state), 0);
  (state as { currentTokenUsage: number }).currentTokenUsage = 1234;
  assert.equal(getCurrentTokenUsage(state), 1234);
});
