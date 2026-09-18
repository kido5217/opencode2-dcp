import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDcpConfig, SCHEMA_URL, type ConfigInput } from "../src/config.ts";

interface Fixture {
  root: string;
  globalDir: string;
  configDir: string;
  startDir: string;
  input: ConfigInput;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "dcp-config-"));
  const globalDir = join(root, "global");
  const configDir = join(root, "configdir");
  // startDir is nested two levels below the future .opencode dir to exercise the walk-up
  const startDir = join(root, "proj", "sub");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(startDir, { recursive: true });
  return {
    root,
    globalDir,
    configDir,
    startDir,
    input: {
      globalDir,
      configDir,
      startDir,
      writeDefault: false,
    },
  };
}

function cleanup(fx: Fixture): void {
  rmSync(fx.root, { recursive: true, force: true });
}

function write(fx: Fixture, dir: string, name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return path;
}

test("lookup order: global < configDir < project, jsonc preferred over json", () => {
  const fx = makeFixture();
  try {
    const globalJsonc = write(
      fx,
      fx.globalDir,
      "opencode-dcp.jsonc",
      '{"compress": {"minContextLimit": 111}}',
    );
    const globalJson = write(
      fx,
      fx.globalDir,
      "opencode-dcp.json",
      '{"compress": {"minContextLimit": 112}}',
    );
    const configDirJson = write(
      fx,
      fx.configDir,
      "opencode-dcp.json",
      '{"compress": {"minContextLimit": 222}}',
    );
    const projectJsonc = write(
      fx,
      join(fx.root, "proj", ".opencode"),
      "opencode-dcp.jsonc",
      '{"compress": {"minContextLimit": 333}}',
    );

    const resolved = resolveDcpConfig(fx.input);

    assert.equal(resolved.layers[0].path, globalJsonc);
    assert.equal(resolved.layers[1].path, configDirJson);
    assert.equal(resolved.layers[2].path, projectJsonc);
    assert.equal(resolved.config.compress.minContextLimit, 333);
  } finally {
    cleanup(fx);
  }
});

test("hard break: legacy dcp.jsonc is never read", () => {
  const fx = makeFixture();
  try {
    write(fx, fx.globalDir, "dcp.jsonc", '{"enabled": false}');
    const resolved = resolveDcpConfig(fx.input);
    assert.equal(resolved.layers[0].path, null);
    assert.equal(resolved.config.enabled, true);
  } finally {
    cleanup(fx);
  }
});

test("per-level override: scalars inherit or override, arrays union-merge", () => {
  const fx = makeFixture();
  try {
    write(
      fx,
      fx.globalDir,
      "opencode-dcp.jsonc",
      JSON.stringify({
        debug: true,
        compress: { maxContextLimit: 111111 },
        protectedFilePatterns: ["a.*"],
        manualMode: { enabled: false },
      }),
    );
    write(
      fx,
      join(fx.root, "proj", ".opencode"),
      "opencode-dcp.jsonc",
      JSON.stringify({
        compress: { maxContextLimit: 222222, protectedTools: ["my_tool"] },
        protectedFilePatterns: ["b.*", "a.*"],
      }),
    );

    const { config } = resolveDcpConfig(fx.input);

    assert.equal(config.debug, true);
    assert.equal(config.compress.maxContextLimit, 222222);
    assert.deepEqual(config.protectedFilePatterns, ["a.*", "b.*"]);
    assert.deepEqual(config.compress.protectedTools, [
      "task",
      "skill",
      "todowrite",
      "todoread",
      "my_tool",
    ]);
    assert.equal(config.manualMode.enabled, false);
    assert.equal(config.manualMode.automaticStrategies, true);
    assert.equal(config.pruneNotification, "detailed");
    assert.equal(config.turnProtection.turns, 4);
  } finally {
    cleanup(fx);
  }
});

test("strategy overrides union-merge protectedTools and override scalars", () => {
  const fx = makeFixture();
  try {
    write(
      fx,
      fx.globalDir,
      "opencode-dcp.jsonc",
      JSON.stringify({ strategies: { purgeErrors: { protectedTools: ["x"] } } }),
    );
    write(
      fx,
      join(fx.root, "proj", ".opencode"),
      "opencode-dcp.jsonc",
      JSON.stringify({ strategies: { purgeErrors: { protectedTools: ["y", "x"], turns: 7 } } }),
    );

    const { config } = resolveDcpConfig(fx.input);

    assert.deepEqual(config.strategies.purgeErrors.protectedTools, ["x", "y"]);
    assert.equal(config.strategies.purgeErrors.turns, 7);
    assert.equal(config.strategies.deduplication.enabled, true);
  } finally {
    cleanup(fx);
  }
});

test("schema validation: clean config produces no warnings", () => {
  const fx = makeFixture();
  try {
    write(fx, fx.globalDir, "opencode-dcp.jsonc", '{"compress": {"maxContextLimit": "80%"}}');
    const resolved = resolveDcpConfig(fx.input);
    assert.deepEqual(resolved.warnings, []);
    assert.equal(resolved.config.compress.maxContextLimit, "80%");
  } finally {
    cleanup(fx);
  }
});

test("schema validation: unknown keys are reported (root and nested, with +N more)", () => {
  const fx = makeFixture();
  try {
    write(
      fx,
      fx.globalDir,
      "opencode-dcp.jsonc",
      JSON.stringify({ bogus: 1, a: 1, b: 1, c: 1, d: 1, compress: { bogus: 1 } }),
    );
    const resolved = resolveDcpConfig(fx.input);
    assert.ok(resolved.warnings.some((w) => w.includes("Unknown keys: bogus, a, b (+2 more)")));
    assert.ok(resolved.warnings.some((w) => w.includes("Unknown keys: compress.bogus")));
    // validation warns but does not block the merge
    const fx2 = makeFixture();
    try {
      write(fx2, fx2.globalDir, "opencode-dcp.jsonc", '{"enabled": false, "bogus": 1}');
      const resolved2 = resolveDcpConfig(fx2.input);
      assert.ok(resolved2.warnings.length > 0);
      assert.equal(resolved2.config.enabled, false);
    } finally {
      cleanup(fx2);
    }
  } finally {
    cleanup(fx);
  }
});

test("schema validation: type, enum, limit-format, minimum and per-model limit errors", () => {
  const fx = makeFixture();
  try {
    write(
      fx,
      fx.globalDir,
      "opencode-dcp.jsonc",
      JSON.stringify({
        enabled: "yes",
        pruneNotification: "loud",
        compress: {
          maxContextLimit: "big",
          nudgeFrequency: 0,
          modelMaxLimits: { "anthropic/claude-sonnet": "big" },
        },
      }),
    );
    const resolved = resolveDcpConfig(fx.input);
    const all = resolved.warnings.join("\n");
    assert.ok(all.includes('enabled: expected boolean, got "yes"'));
    assert.ok(
      all.includes('pruneNotification: expected "off" | "minimal" | "detailed", got "loud"'),
    );
    assert.ok(all.includes('compress.maxContextLimit: expected number | "${number}%", got "big"'));
    assert.ok(all.includes("compress.nudgeFrequency: expected number >= 1, got 0"));
    assert.ok(
      all.includes(
        'compress.modelMaxLimits.anthropic/claude-sonnet: expected number | "${number}%", got "big"',
      ),
    );
  } finally {
    cleanup(fx);
  }
});

test("schema validation: parse error warns and falls back to previous layer", () => {
  const fx = makeFixture();
  try {
    // jsonc-parser leniently parses `{ invalid json` into `{}` (v1 parity: valid empty
    // layer, no parseError); `not json at all` yields undefined and hits the error branch.
    write(fx, fx.globalDir, "opencode-dcp.jsonc", "not json at all");
    write(fx, join(fx.root, "proj", ".opencode"), "opencode-dcp.jsonc", '{"enabled": false}');
    const resolved = resolveDcpConfig(fx.input);
    assert.ok(resolved.layers[0].parseError);
    assert.ok(
      resolved.warnings.some(
        (w) => w.startsWith("Invalid config: ") && w.includes("Using previous/default values"),
      ),
    );
    assert.equal(resolved.config.enabled, false);
  } finally {
    cleanup(fx);
  }
});

test("debug log: layers and resolved config are reported", () => {
  const fx = makeFixture();
  try {
    const globalJsonc = write(fx, fx.globalDir, "opencode-dcp.jsonc", '{"debug": true}');
    const resolved = resolveDcpConfig(fx.input);
    assert.ok(resolved.debugLines.length >= 2);
    const layersLine = resolved.debugLines[0];
    assert.ok(layersLine.startsWith("config layers: "));
    assert.ok(layersLine.includes(`config=${globalJsonc}`));
    assert.ok(layersLine.includes("configDir config=(absent)"));
    assert.ok(layersLine.includes("project config=(absent)"));
    const resolvedLine = resolved.debugLines[1];
    assert.ok(resolvedLine.startsWith("config resolved: "));
    const logged = JSON.parse(resolvedLine.slice("config resolved: ".length));
    assert.equal(logged.debug, true);
    assert.equal(logged.enabled, true);
    if (resolved.warnings.length > 0) {
      for (const warning of resolved.warnings) {
        assert.ok(resolved.debugLines.includes(`config warning: ${warning.replace(/\n/g, " | ")}`));
      }
    }
  } finally {
    cleanup(fx);
  }
});

test("default global config is created when missing and never overwritten", () => {
  const fx = makeFixture();
  try {
    const created = resolveDcpConfig({ ...fx.input, writeDefault: true });
    assert.ok(created.layers[0].path, "default config file should be created");
    const content = readFileSync(join(fx.globalDir, "opencode-dcp.jsonc"), "utf-8");
    assert.ok(content.includes(SCHEMA_URL));

    const again = resolveDcpConfig({ ...fx.input, writeDefault: true });
    assert.equal(again.layers[0].path, join(fx.globalDir, "opencode-dcp.jsonc"));
    assert.equal(readFileSync(join(fx.globalDir, "opencode-dcp.jsonc"), "utf-8"), content);
  } finally {
    cleanup(fx);
  }
});

test("no default file is written when writeDefault is false", () => {
  const fx = makeFixture();
  try {
    resolveDcpConfig(fx.input);
    assert.equal(existsSync(join(fx.globalDir, "opencode-dcp.jsonc")), false);
    assert.equal(existsSync(join(fx.globalDir, "opencode-dcp.json")), false);
  } finally {
    cleanup(fx);
  }
});

test("successive resolutions are independent (no shared references)", () => {
  const fx = makeFixture();
  try {
    const first = resolveDcpConfig(fx.input);
    first.config.compress.protectedTools.push("poison");
    const second = resolveDcpConfig(fx.input);
    assert.ok(!second.config.compress.protectedTools.includes("poison"));
  } finally {
    cleanup(fx);
  }
});
