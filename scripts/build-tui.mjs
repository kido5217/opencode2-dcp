// Precompile the TUI sources with the host's universal Solid transform.
//
// The OpenTUI host only applies its JSX transform to plugin files located
// outside node_modules. This package is installed under node_modules (git
// and npm installs alike), so raw TSX would be compiled by the generic
// JSX transform, which evaluates prop/child expressions eagerly: the panel
// would render once and never update. Precompiling with babel-preset-solid
// ("universal" output) emits reactive bindings, and rewriting the runtime
// imports to the host's virtual runtime modules keeps a single Solid/OpenTUI
// runtime instance for the process.
//
// Run with: npm run build:tui
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSolidSource } from "../node_modules/@opentui/solid/scripts/solid-transform.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = path.join(root, "dist", "tui-compiled");

// JSX-bearing sources. Pure-TS modules (data.ts, bridge.ts, the core lib)
// are loaded natively by the host (Bun loads .ts) and are imported by their
// original source paths.
const SOURCES = ["src/tui.tsx", "src/lib/tui/panel.tsx"];

// Host runtime specifiers served by the host's virtual module registry.
function virtualize(spec) {
  if (spec === "solid-js" || spec === "solid-js/store" || spec.startsWith("@opentui/")) {
    return "opentui:runtime-module:" + encodeURIComponent(spec);
  }
  return null;
}

const sourceToOutput = new Map();
for (const rel of SOURCES) {
  const source = path.join(root, rel);
  sourceToOutput.set(source, path.join(outDir, path.basename(rel).replace(/\.tsx$/, ".js")));
}

function rewriteSpecifier(spec, fromDir) {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const resolved = path.resolve(fromDir, spec);
    const precompiled = sourceToOutput.get(resolved);
    let rel = path.relative(outDir, precompiled ?? resolved);
    if (!rel.startsWith("../")) rel = "./" + rel;
    return rel;
  }
  return virtualize(spec) ?? spec;
}

function rewriteImports(code, fromDir) {
  // Side-effect imports: import "specifier";
  let out = code.replace(/(^|\n)(import\s+)(["'])((?:(?!\3).)+)\3/g, (_m, pre, imp, q, spec) => {
    return pre + imp + q + rewriteSpecifier(spec, fromDir) + q;
  });
  // import ... from "specifier" / export ... from "specifier"
  out = out.replace(
    /(^|\n)((?:import|export)\b[^;]*?from\s+)(["'])((?:(?!\3).)+)\3/g,
    (_m, pre, mid, q, spec) => {
      return pre + mid + q + rewriteSpecifier(spec, fromDir) + q;
    },
  );
  return out;
}

await mkdir(outDir, { recursive: true });
for (const [source, output] of sourceToOutput) {
  const code = await readFile(source, "utf8");
  const compiled = await transformSolidSource(code, {
    filename: path.relative(root, source),
    moduleName: "@opentui/solid",
  });
  const rewritten = rewriteImports(compiled, path.dirname(source));
  await writeFile(output, rewritten);
  console.log(`compiled ${path.relative(root, source)} -> ${path.relative(root, output)}`);
}
