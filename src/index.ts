import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin";
import { resolveDcpConfig } from "./config.ts";

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
    for (const line of resolved.debugLines) {
      await log(line);
    }
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await log(`event ${event.type}`);
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
