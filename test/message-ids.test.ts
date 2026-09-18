import assert from "node:assert/strict";
import test from "node:test";
import { assignMessageRefs } from "../src/lib/message-ids.ts";
import { createSessionState } from "../src/lib/state/state.ts";
import { resetOnCompaction } from "../src/lib/state/utils.ts";
import type { DcpMessage } from "../src/lib/types.ts";

test("resetOnCompaction clears message id aliases (v2: event-driven reset)", () => {
  const state = createSessionState();
  state.sessionId = "ses_message_ids_after_compaction";
  state.messageIds.byRawId.set("old-message-9998", "m9998");
  state.messageIds.byRawId.set("old-message-9999", "m9999");
  state.messageIds.byRef.set("m9998", "old-message-9998");
  state.messageIds.byRef.set("m9999", "old-message-9999");
  state.messageIds.nextRef = 9999;

  resetOnCompaction(state);

  assert.equal(state.messageIds.byRawId.size, 0);
  assert.equal(state.messageIds.byRef.size, 0);
  assert.equal(state.messageIds.nextRef, 1);
});

test("assignMessageRefs assigns sequential refs to v2 request messages", () => {
  const state = createSessionState();
  state.sessionId = "ses_message_ids_assign";
  const messages: DcpMessage[] = [
    {
      id: "msg-assistant-summary",
      role: "assistant",
      content: [{ type: "text", text: "Compaction summary" }],
    },
    {
      id: "msg-user-follow-up",
      role: "user",
      content: [{ type: "text", text: "Continue after compaction" }],
    },
  ];

  const assigned = assignMessageRefs(state, messages);

  assert.equal(assigned, 2);
  assert.equal(state.messageIds.byRawId.get("msg-assistant-summary"), "m0001");
  assert.equal(state.messageIds.byRawId.get("msg-user-follow-up"), "m0002");
  assert.equal(state.messageIds.byRef.get("m0001"), "msg-assistant-summary");
  assert.equal(state.messageIds.byRef.get("m0002"), "msg-user-follow-up");
  assert.equal(state.messageIds.nextRef, 3);
});

test("assignMessageRefs skips ignored user messages", () => {
  const state = createSessionState();
  state.sessionId = "ses_message_ids_ignored";
  const messages: DcpMessage[] = [
    { id: "msg-user-empty", role: "user", content: [] },
    {
      id: "msg-user-real",
      role: "user",
      content: [{ type: "text", text: "First real user message" }],
    },
  ];

  const assigned = assignMessageRefs(state, messages);

  assert.equal(assigned, 1);
  assert.equal(state.messageIds.byRawId.get("msg-user-real"), "m0001");
});
