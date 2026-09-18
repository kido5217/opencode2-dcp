import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { resolveDcpConfig } from "./config.ts";
import { Logger } from "./lib/logger.ts";
import { PromptStore } from "./lib/prompts/store.ts";
import { createSessionState } from "./lib/state/state.ts";
import { resetOnCompaction } from "./lib/state/utils.ts";
import { saveSessionState, type DcpStorage } from "./lib/state/persistence.ts";
import { isSubAgentSession } from "./lib/state/utils.ts";
import {
  applySystemPrompt,
  runContextPipeline,
  type ContextPipelineDeps,
  type ContextPipelinePayload,
} from "./lib/pipeline.ts";
import type { DcpStepTokens } from "./lib/types.ts";
import type { DurableSessionMessage } from "./lib/subagents/subagent-results.ts";

/** Structural mirror of the host JSON value type (for the storage adapter). */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const LOG_DIR = join(homedir(), ".config", "opencode", "logs", "dcp");
const LOG_FILE = join(LOG_DIR, "plugin.log");

async function log(line: string) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never fail plugin load.
  }
}

export default Plugin.define({
  id: "opencode-dcp",
  async setup(ctx) {
    const controller = new AbortController();
    const resolved = resolveDcpConfig({ startDir: ctx.location.directory });
    const config = resolved.config;
    for (const line of resolved.debugLines) {
      await log(line);
    }

    const logger = new Logger(true);
    const prompts = new PromptStore(
      logger,
      ctx.location.directory,
      config.experimental.customPrompts,
    );
    const state = createSessionState();

    const storage: DcpStorage = {
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value as JsonValue),
      scan: (prefix) =>
        ctx.storage
          .scan({ prefix })
          .then((result) =>
            result.entries.map((entry) => ({ key: entry.key, value: entry.value })),
          ),
    };

    const deps: ContextPipelineDeps = {
      state,
      config,
      logger,
      prompts,
      storage,
      isSubAgentSession: (sessionID) =>
        isSubAgentSession(async (id) => {
          const session = await ctx.session.get({ sessionID: id });
          return { parentID: session.parentID };
        }, sessionID),
      fetchSubAgentMessages: async (sessionID) => {
        const entries = await ctx.session.context({ sessionID });
        return entries as unknown as DurableSessionMessage[];
      },
    };

    const modelContextLimits = new Map<string, number>();
    const refreshModelContextLimits = async () => {
      try {
        const { data: models } = await ctx.model.list();
        for (const model of models) {
          const limit = model.limit?.context;
          if (typeof limit === "number" && limit > 0) {
            modelContextLimits.set(`${model.providerID}/${model.id}`, limit);
          }
        }
      } catch (error) {
        logger.warn("Failed to load model context limits", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    await refreshModelContextLimits();

    // The v2 `context` hook fires before every agent-loop model request with
    // a MUTABLE payload; edits apply to the outgoing request only.
    ctx.session.hook("context", async (payload) => {
      const p = payload as unknown as ContextPipelinePayload;
      const limit = modelContextLimits.get(`${p.model.providerID}/${p.model.id}`);
      if (typeof limit === "number" && limit > 0) {
        // v1 parity: only overwrite when the host value is truthy.
        state.modelContextLimit = limit;
      }
      try {
        await runContextPipeline(p, deps);
        applySystemPrompt(p.system, state, config, prompts, logger, p.sessionID);
      } catch (error) {
        logger.error("DCP context pipeline failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        await log(`pipeline failed: ${String(error)}`);
      }
    });

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = (event as { data?: Record<string, unknown> }).data ?? {};
        const sessionID = data.sessionID;
        const matchesSession = typeof sessionID === "string" && sessionID === state.sessionId;

        if (event.type === "session.step.ended" && matchesSession) {
          const tokens = (data as { tokens?: DcpStepTokens }).tokens;
          if (tokens) {
            state.currentTokenUsage =
              tokens.input +
              tokens.output +
              tokens.reasoning +
              tokens.cache.read +
              tokens.cache.write;
            if (state.firstStepInput === undefined) {
              state.firstStepInput = tokens.input + tokens.cache.read + tokens.cache.write;
            }
          }
        } else if (event.type === "session.compaction.ended" && matchesSession) {
          // v2: request shapes carry no compaction markers, so the reset is
          // event-driven and the timestamp persisted (documented delta).
          state.lastCompaction = Date.now();
          state.firstStepInput = undefined;
          resetOnCompaction(state);
          void saveSessionState(state, storage, logger);
          await log(`compaction reset (${sessionID})`);
        } else if (event.type === "model.updated") {
          void refreshModelContextLimits();
        } else {
          await log(`event ${event.type}`);
        }
      }
    })().catch((error) => {
      void log(`event subscription failed: ${String(error)}`);
    });

    await log(`loaded (opencode ${ctx.app.version})`);
    return async () => {
      controller.abort();
      await log("unloaded");
    };
  },
});
