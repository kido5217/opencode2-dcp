# Research: v2 native plugin update vs DCP v1 `autoUpdate`

Ticket: [kido5217/opencode2-dcp#7](https://github.com/kido5217/opencode2-dcp/issues/7) — part of wayfinder map
[#2](https://github.com/kido5217/opencode2-dcp/issues/2), decision #9.

**Question.** Does opencode v2's native plugin-update mechanism cover what DCP's v1 `autoUpdate` did, so the
custom feature can be dropped entirely?

**Verdict (short).** Yes — decision #9 stands. v2 natively covers detection and pin-skip semantics for both npm
and git specs; the only behavioral differences are (a) v2 never auto-*applies* updates (manual `plugin update`
or the TUI `/plugins` dialog) and (b) v2 has no proactive toast — updates are discoverable only via the `/plugins`
dialog footer or `opencode plugin check`. Both are consistent with v2's design (check without changing the
installed package) and acceptable for a git-branch-distributed plugin.

## Sources

| Source | What it provides |
| --- | --- |
| `opencode2` 2.0.7 binary, `plugin --help` / `plugin check --help` / `plugin update --help` (read-only) | CLI surface: "Check package plugins for updates", "Update package plugins", optional `target` arg, "omit to update all outdated plugins" |
| https://opencode.ai/v2/docs/plugins (live; identical to `services/www/src/docs/content/plugins.mdx` at source tag `v2.0.7`, lines 81–114) | Authoritative doc statements on `plugin add/list/check/update/remove`, git spec support, startup check behavior, pinning |
| `anomalyco/opencode` source at tag `v2.0.7` | Implementation: `packages/util/src/npm.ts`, `packages/core/src/plugin/update.ts`, `packages/core/src/plugin/supervisor.ts`, `packages/server/src/handlers/plugin.ts`, `packages/cli/src/commands/handlers/plugin/{check,update,inventory}.ts`, `packages/tui/src/feature-plugins/system/plugins.tsx`, `packages/client/src/promise/generated/client.ts` |
| `Opencode-DCP/opencode-dynamic-context-pruning` @ `11f6517` | v1 baseline: `lib/update.ts` (full autoUpdate implementation), `index.ts:46`, `lib/config.ts:60,658,935` |

Note: the v2 docs have **no** `cli/notifications` page — `https://opencode.ai/v2/docs/cli/notifications` is a 404
and the in-repo docs content tree (`services/www/src/docs/content/`) contains no notifications page. Plugin-update
documentation lives on the plugins page.

## 1. What `opencode2 plugin update` does

### Spec kinds

Specs are parsed with `npm-package-arg` (`packages/util/src/npm.ts:61-83`, v2.0.7):

- **Registry specs** (`name`, `name@1.2.0`, `name@latest`, `name@^1.2.0`, tags, ranges): checkable/updatable.
  `mutable = result.type !== "version"` — i.e. **exact versions are pinned**, everything else (bare name →
  `latest` dist-tag, tags, semver ranges) is mutable.
- **Git specs** (`github:owner/repo`, `https://…`, `git+ssh://git@github.com:…#main`,
  `github:acme/plugins#main::path:packages/plugin`): checkable/updatable. `mutable = !isCommit(gitCommittish)`
  (v2.0.7 `isCommit` = full 40/64-hex SHA) — i.e. **full commit hashes are pinned; branch/tag refs are mutable**.
  npm's `::path:` subdirectory selectors pass through (docs: "Branches, tags, complete commit hashes, and npm's
  `::path:` repository-subdirectory selectors are supported").
- **Local/path specs** (`./…`, absolute, `file://…`): not supported by check/update — `Npm.check`/`Npm.update`
  fail with "Package checks only support registry and Git package specs" (`npm.ts:364,392`). This is the docs
  statement "Local plugins and exact package revisions are skipped".

### Check semantics (`Npm.check`, `npm.ts:360-384`)

1. Pinned spec → immediately `false` (never outdated).
2. Otherwise compare installed revision vs. available revision:
   - registry: available = `pacote.manifest(pkg).version` (the version the spec's tag/range currently resolves to).
   - git: available = `gitRevision(await pacote.resolve(pkg, { preferOnline: true, noGitRevCache: true }))` —
     resolves the ref to its **current commit SHA** and compares with the installed commit
     (`gitRevision`, `npm.ts:488-490`).
3. `installed !== available` → outdated.

**For a git branch spec, "update available" means: the branch HEAD moved past the installed commit.** This is
exactly the right semantic for DCP's `git+ssh://git@github.com:kido5217/opencode2-dcp.git#main`.

### Update semantics (`Npm.update`, `npm.ts:386-398`)

- Pinned spec → plain re-`add` (no-op if already at that revision).
- Mutable spec → fresh `install(pkg, …, update=true)`: pacote/arborist reify with `preferOnline: true,
  noGitRevCache: true` (a new "generation" dir), then `collect(dir)` prunes old generations. **For a git spec this
  re-resolves the ref (pulls the branch's latest commit) and installs it.**

So `plugin update` = "for each outdated package plugin, reinstall at the spec's currently-resolved revision".
It is strictly a manual command (CLI or TUI action); nothing in the server auto-installs.

### Check cache

`PluginUpdate.check` (`packages/core/src/plugin/update.ts:9,39`) caches the per-target result for **24 hours**
(`interval = 24*60*60*1_000`) unless called with `refresh: true`. The server API `plugin.check` handler always
passes `refresh: true` (`packages/server/src/handlers/plugin.ts`), so CLI/TUI-triggered checks are always fresh;
the 24h cache applies to the startup/ambient path.

## 2. When checks run & how updates are discovered

### Startup and ambient checks (no changes made)

`packages/core/src/plugin/supervisor.ts` (v2.0.7): on server startup, on config/plugin-module changes, on bus
`Updated` events, **and every 24 hours** (`Stream.fromEffectRepeat(Effect.sleep("24 hours"))`), the supervisor
re-activates plugins and then runs `updates.check(target)` for every package target — "checks unpinned npm and
Git plugins for updates **without changing the installed package**. Exact npm versions and full Git commit hashes
stay pinned." (docs, plugins page). Results feed the `outdated`/`updating` sets, which are stamped onto each
plugin's `source.outdated` / `source.updating` fields in the `plugin.list` API response; flag changes emit a
`plugin.updated` event.

### User-facing discovery mechanisms

1. **CLI `opencode plugin check [target]`** (`packages/cli/src/commands/handlers/plugin/check.ts`, `inventory.ts`):
   prints per plugin `update available` / `current` / `check failed` — server plugins via the server API
   (fresh check), TUI-only plugins via local `npm.check`. Manual only.
2. **CLI `opencode plugin update [target]`** (`…/plugin/update.ts`): filters the same inventory to
   `outdated` items and runs the update (server plugins via `POST /api/plugin/update`, TUI plugins via local
   `npm.update`). Manual only.
3. **TUI `/plugins` dialog** (`packages/tui/src/feature-plugins/system/plugins.tsx`):
   - footer shows `update available` (info-colored) for any server package plugin with `source.outdated === true`,
     spinner while `source.updating`;
   - dialog actions: **"check for updates"** (fresh `plugin.check`) and **"update"** (applies for the focused
     outdated plugin); refetches on `plugin.updated`.
   - Code comment in that file (lines 160–164) states the design intent: "The server only re-checks package
     sources on startup and then caches the result for a day, so a merge pushed after launch stays invisible
     until the user asks."
4. **No proactive toast/banner**: the TUI plugin panel only shows toasts for *errors* (check failed, update
   failed). There is no startup "update ready" notification. The web app lists plugins (name/status/error) but
   does not display `outdated`.
5. **Programmatic access**: the v2 plugin context "is essentially an OpenCode server client" (docs,
   `build/plugins`); the generated client exposes `plugin.check/list/update` (`packages/client/src/promise/
   generated/client.ts:497`, `POST /api/plugin/update`), and a `plugin.updated` event type exists. So a server
   plugin *can* self-trigger check/update if ever desired — but nothing does so by default.

## 3. v1 DCP `autoUpdate` baseline (Opencode-DCP/opencode-dynamic-context-pruning @ `11f6517`)

From `lib/update.ts`, `index.ts:46`, `lib/config.ts`:

1. **When**: at plugin load (i.e. each server startup), `startAutoUpdate(ctx, config.autoUpdate)`; config option
   `autoUpdate: boolean`, **default `true`** (`config.ts:658`). 10s timeout, all errors swallowed.
2. **Check**: `GET https://registry.npmjs.org/@tarquinen/opencode-dcp/latest` vs the installed package's
   `package.json` version (semver incl. prerelease comparison). Hardcoded to the npm package name — it only
   functions for the npm-published DCP, not for a git-checkout install.
3. **Skip (version lock)**: `isAutoUpdatableSpec` allows only `latest`, `*`, `~`/`^` prefixes, `>= > <= <`
   ranges, and compound specs — an exact version pin disables auto-update.
4. **Apply**: does *not* install the new version. It **deletes the installed package directory** from
   `node_modules` so that the next OpenCode start/reinstall pulls latest; if the delete fails it silently does
   nothing (`remove_failed`).
5. **Notification**: 5s after load, pushes a TUI toast via `ctx.client.tui.showToast`: *"DCP update ready —
   Updated @tarquinen/opencode-dcp from X to Y. Restart OpenCode to finish."* (info variant, 7s duration).

Net v1 behavior: **startup npm-latest check → soft-update (delete + reinstall-on-next-start) → proactive
in-session toast; exact-version installs are left alone.**

## 4. Side-by-side

| v1 DCP `autoUpdate` | v2 native | Covered? |
| --- | --- | --- |
| Check at startup | Supervisor checks all package plugins at startup **and every 24 h** (fresh per process; `refresh` on demand via CLI/TUI) | ✅ superset (also covers git specs; v1 was npm-registry-only with a hardcoded package name) |
| Pin-skip (exact version → no auto-update) | `mutable=false` for exact npm versions **and full git commit hashes** → never checked/updated; branch/tag/range/bare specs are checked | ✅ same semantics, broader |
| Auto-apply update (delete dir → reinstall on next start) | **Never auto-applies.** Applying is manual: `opencode plugin update [target]` or TUI `/plugins` → "update". Check deliberately "without changing the installed package" (docs) | ❌ gap — manual-only in v2 |
| Proactive in-session notification (toast at startup) | Passive: `/plugins` dialog footer "update available" + info color, "check for updates" action; no toast, no docs page on plugin notifications (the `cli/notifications` URL is a 404; no such page in the v2 docs tree) | ⚠️ partial — discoverable only if the user looks |
| Applies to git-spec installs | First-class: branch ref resolution, SHA comparison, ref re-resolve on update; git specs supported incl. `#ref::path:` subpaths | ✅ (v1 only worked for the npm package) |
| Restart required to finish | Same: a new generation is installed; the running server picks it up on the next plugin reload/restart | ✅ equivalent |

## 5. Verdict & recommendation

**Decision #9 stands: drop the custom `autoUpdate` entirely.**

- Every *mechanical* piece of v1 autoUpdate (latest check, pin-skip semantics, version comparison, restart-based
  apply) is replaced by the v2 native mechanism, and v2 is strictly broader: it also works for DCP's actual
  distribution spec (a git branch ref), whereas v1 only worked for the npm-published package.
- The two differences are **design choices of v2, not missing functionality**:
  1. *No auto-apply.* v2 intentionally checks "without changing the installed package" and leaves installation to
     an explicit `plugin update` / `/plugins` "update" action. For a branch-distributed plugin this is arguably
     safer than v1's silent soft-update (a push to `main` no longer changes plugin behavior without user action).
  2. *No proactive toast.* Discovery is via the `/plugins` dialog footer or `opencode plugin check`. A user who
     never opens `/plugins` will not see "update available" — but this matches how opencode treats all package
     plugins (providers, TUI, server) and there is no v2 API for a plugin to push a global startup banner.

**Port-time action items (not functional gaps):**

- Document the update path in the DCP README: `opencode plugin update <spec>` or TUI `/plugins` → "check for
  updates" → "update".
- If a proactive nudge is later wanted, it is feasible without reviving v1's machinery: the v2 plugin context is
  a server client, so DCP could call `client.plugin.check`/`client.plugin.update` for its own target and toast
  via its TUI surface. That would be a ~50-line optional sliver — a product choice, not a requirement.

**Decision question for the user:** Accept v2's manual-only update flow (drop custom `autoUpdate` with no
replacement), or keep a thin DCP-side nudge (toast when `source.outdated` is true for the DCP target) — and if
the latter, notify-only or also offer one-key auto-apply?
