import assert from "node:assert/strict";
import test from "node:test";
import { isIgnoredUserMessage } from "../src/lib/messages/query.ts";
import type { DcpMessage } from "../src/lib/types.ts";

test("isIgnoredUserMessage only ignores user messages", () => {
  const ignoredUserMessage: DcpMessage = { id: "msg-user", role: "user", content: [] };
  const assistantMessage: DcpMessage = { id: "msg-assistant", role: "assistant", content: [] };

  assert.equal(isIgnoredUserMessage(ignoredUserMessage), true);
  assert.equal(isIgnoredUserMessage(assistantMessage), false);
});

test("isIgnoredUserMessage ignores user messages whose parts are all ignored", () => {
  const ignoredParts: DcpMessage = {
    id: "msg-user-ignored-parts",
    role: "user",
    content: [
      { type: "text", text: "hidden", metadata: {} } as DcpMessage["content"][number] & {
        ignored?: unknown;
      },
    ],
  };
  (ignoredParts.content[0] as { ignored?: unknown }).ignored = true;
  const realUser: DcpMessage = {
    id: "msg-user-real",
    role: "user",
    content: [{ type: "text", text: "visible" }],
  };

  assert.equal(isIgnoredUserMessage(ignoredParts), true);
  assert.equal(isIgnoredUserMessage(realUser), false);
});
