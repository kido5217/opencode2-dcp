import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.ts";

test("entrypoint exports the opencode-dcp plugin definition", () => {
  assert.equal(plugin.id, "opencode-dcp");
  assert.equal(typeof plugin.setup, "function");
});
