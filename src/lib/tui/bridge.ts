/**
 * TUI panel <-> core bridge.
 *
 * The v2 host gives the TUI entry (`context.storage`) and the core entry
 * (`ctx.storage`) DIFFERENT backends, so the panel cannot share the core's
 * storage keys through `context.storage`:
 *
 *   - core `ctx.storage`    → the `kv` table of `<datadir>/opencode.db`;
 *                             keys are `plugin:<utf16hex(pluginID)>:<key>`,
 *                             values are JSON strings.
 *   - TUI `context.storage` → per-app JSON files under
 *                             `<datadir>/<channel>/tui/<key>.json`, whose
 *                             keys may not contain slashes or underscores
 *                             (session IDs do).
 *
 * The bridge therefore:
 *   - READS the core's `kv` rows directly: the panel opens the host DB
 *     read-only through the host runtime's `bun:sqlite` builtin. If the
 *     builtin is unavailable the panel degrades to empty docs.
 *   - WRITES a small mirror file for the panel's manual-mode toggle:
 *     `<datadir>/opencode/dcp-mirror/manual-<sessionID>.json`, re-read by the
 *     core on every context hook. The mirror file is the only panel→core
 *     write path; the `kv` table stays owned by the core.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The plugin id both entries register under (shared `kv` namespace). */
export const DCP_PLUGIN_ID = "opencode-dcp";

/** The host data directory (mirrors the binary's XDG logic). */
export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

/**
 * The `kv` key the core writes a value under. The host encodes the plugin id
 * as one 2-byte big-endian char code per character, hex-encoded, e.g.
 * `opencode-dcp` → `006f00700065006e0063006f00640065002d006400630070`.
 */
export function kvKey(pluginID: string, key: string): string {
  const hex = Array.from(pluginID)
    .map((char) => char.codePointAt(0)!.toString(16).padStart(4, "0"))
    .join("");
  return `plugin:${hex}:${key}`;
}

/** Path of the host's SQLite database (the `kv` table lives here). */
export function kvDbPath(): string {
  return join(dataDir(), "opencode.db");
}

/**
 * Read one `kv` row's JSON value for this plugin. Read-only and best-effort:
 * returns `undefined` when the row is absent or the DB cannot be opened
 * (e.g. the `bun:sqlite` builtin is unavailable in this process).
 */
export async function loadKvDoc(pluginID: string, key: string): Promise<unknown | undefined> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(kvDbPath(), { readonly: true });
    try {
      const rows = db
        .query("select value from kv where key = ? limit 1")
        .all(kvKey(pluginID, key)) as { value: unknown }[];
      const value = rows[0]?.value;
      return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** Directory holding the panel→core mirror files. */
export function mirrorDir(): string {
  return join(dataDir(), "dcp-mirror");
}

/** Mirror file name for a session (session IDs contain `_`; file names don't). */
export function manualMirrorName(sessionID: string): string {
  return `manual-${sessionID.replace(/[^a-zA-Z0-9.-]/g, "-")}.json`;
}

export interface ManualMirrorDoc {
  manualMode: boolean;
  at: string;
}

/** Panel→core: persist a manual-mode toggle so the core picks it up. */
export async function writeManualMirror(sessionID: string, manualMode: boolean): Promise<void> {
  const dir = mirrorDir();
  await mkdir(dir, { recursive: true });
  const doc: ManualMirrorDoc = { manualMode, at: new Date().toISOString() };
  await writeFile(join(dir, manualMirrorName(sessionID)), JSON.stringify(doc));
}

/** Core→panel read: the latest toggle the panel wrote, if any. */
export async function readManualMirror(sessionID: string): Promise<ManualMirrorDoc | undefined> {
  try {
    const raw = await readFile(join(mirrorDir(), manualMirrorName(sessionID)), "utf8");
    const doc = JSON.parse(raw) as ManualMirrorDoc;
    if (typeof doc.manualMode === "boolean" && typeof doc.at === "string") {
      return doc;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
