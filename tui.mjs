/**
 * Package-root TUI entry.
 *
 * Probes the host runtime-module registry first so this plugin's bare
 * imports (solid-js, @opentui/solid) bind to the host's single Solid/OpenTUI
 * runtime instance instead of the copies under node_modules. Plugin files
 * located under node_modules are not specifier-rewritten by the host, so
 * without this probe the plugin would run on a second Solid runtime: the
 * initial mount renders, but reactive updates never reach the terminal.
 * The probe is tolerated when the host does not provide the registry.
 */
const runtimeProbe = "opentui:runtime-module:" + encodeURIComponent("@opentui/solid");
let probeOk = false;
try {
  await import(runtimeProbe);
  probeOk = true;
} catch (error) {
  const message = String(error);
  if (!message.includes("opentui:runtime-module:")) throw error;
}

import { writeFile } from "node:fs/promises";
void writeFile(
  "/tmp/dcp-entry-probe.json",
  JSON.stringify({ probeOk, entry: "tui.mjs", at: new Date().toISOString() }) + "\n",
).catch(() => {});

const mod = await import("./src/tui.tsx");
export default mod.default;
