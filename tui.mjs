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
 *
 * Then prefers the precompiled TUI (`dist/tui-compiled`). The host only
 * applies its Solid JSX transform to plugin files outside node_modules, so
 * raw TSX installed under node_modules would be compiled with the generic
 * JSX transform (eager prop/child evaluation) and the panel would render
 * once and never update. The precompiled output (`npm run build:tui`)
 * carries reactive bindings and the host's virtual runtime specifiers.
 */
const runtimeProbe = "opentui:runtime-module:" + encodeURIComponent("@opentui/solid");
try {
  await import(runtimeProbe);
} catch (error) {
  const message = String(error);
  if (!message.includes("opentui:runtime-module:")) throw error;
}

const mod = await (async () => {
  try {
    return await import("./dist/tui-compiled/tui.js");
  } catch (error) {
    if (String(error).includes("opentui:runtime-module:")) return await import("./src/tui.tsx");
    throw error;
  }
})();
export default mod.default;
