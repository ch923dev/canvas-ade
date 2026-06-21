# ADR 0009 — Project files isolated under `.canvas/`

**Status:** Proposed · **Date:** 2026-06-21 · (0008 = packaging/signing/auto-update gate.)

## Context

A project is a user-chosen folder, and that folder is very often **also the user's code repo**
(Terminal boards run agents in it, the File Tree walks it, Browser boards preview it). Yet Canvas
ADE scatters its own data across that folder's root:

```
<project>/
  canvas.json          ← the whole-canvas document
  canvas.json.bak      ← parse-fail fallback
  assets/              ← content-addressed image/video blobs
  .canvas/             ← context-memory subsystem (memory/ audit/ tmp/ .gitignore)
  <the user's own repo files…>
```

Three of those four entries are top-level clutter in a directory the user also owns. The
`.canvas/` dir already exists as Canvas ADE's private data home (memory engine, terminal image
staging `tmp/`, audit log) and already carries its own `.gitignore`. The natural fix: pull the
remaining project files **into `.canvas/`** so a project root holds a single, isolated Canvas
data directory.

Two facts make this cheap:

1. **The renderer is path-agnostic.** It calls `window.api.project.save(doc, dir)` and
   `project:open`; MAIN (`projectStore.ts`) is the *only* code that knows the on-disk filenames.
   The IPC contract, the autosaver, and the corrupt-doc recovery cascade never name a path.
2. **Asset ids are logical, not physical.** The stored `assetId` (`assets/<sha1>.<ext>`) is an
   opaque identifier the renderer round-trips through IPC; it never builds a filesystem path. So
   the blob store can move on disk **without changing a single byte of any `canvas.json`** —
   only MAIN's resolution base changes.

## Decision

**Relocate every Canvas-ADE-owned project file under `<project>/.canvas/`:**

```
<project>/
  .canvas/
    canvas.json
    canvas.json.bak
    assets/<sha1>.<ext>
    memory/ · audit/ · tmp/      (already here)
    .gitignore
  <the user's own repo files…>   ← untouched
```

### Path resolution (MAIN, `projectStore.ts`)

- **Write** always targets `.canvas/` (primary, `.bak` rotation, and `assets/`). The
  envelope-guard + atomic-write + BUG-007 rotation order are unchanged — only the base moves.
- **Read** prefers `.canvas/`, then **falls back to the legacy root** (`<project>/canvas.json`,
  `<project>/canvas.json.bak`, `<project>/assets/`). The fallback is **permanent**, not a
  deprecation window — it is one cheap `existsSync` per read and it makes the readers resilient
  to a partial/failed migration.
- **`assetId` is unchanged** — it stays `assets/<sha1>.<ext>`. `ASSET_RE`, `collectAssetIds`,
  and the doc schema are untouched; `readAsset`/`writeAsset`/`gcAssets` simply root at
  `join(dir, '.canvas', 'assets')` (with `readAsset` also falling back to the legacy
  `<dir>/assets/` location).

### Migration (move-on-open, one-way)

`migrateProjectLayout(dir)` runs at `project:open` / `project:current` (before the read),
best-effort and **idempotent**:

- If `.canvas/canvas.json` is absent but a legacy root `canvas.json` exists, **move**
  `canvas.json`, `canvas.json.bak`, and the `assets/` directory into `.canvas/` (`rename` with a
  recursive-copy fallback for cross-volume; content-addressed blobs merge safely on collision).
- **Move = rename-aside, never delete.** A locked/failed move never aborts the open — the
  permanent read-fallback covers a project that didn't fully migrate.
- The migration also **upgrades a recognized old `.gitignore`** (see below); a user-customised
  ignore file is left untouched.

This is **one-way**: after a project opens once in a build with this change, an *older* build
(which only reads the root) will not find the project. Accepted — see Consequences.

### Git tracking (`.canvas/.gitignore`)

`canvas.json` is human-meaningful, text, and diffable, so it stays **trackable by default**.
Everything else under `.canvas/` is volatile or binary and stays **private by default**, with an
opt-in to also version the durable content:

| Mode | `.gitignore` body | Tracks | Ignores |
|---|---|---|---|
| **Private** (default) | `*`<br>`!canvas.json` | `canvas.json` | `assets/`, `canvas.json.bak`, `memory/`, `audit/`, `tmp/` |
| **Committed** (opt-in, `setCommitOptIn(true)`) | `audit/`<br>`tmp/`<br>`canvas.json.bak` | `canvas.json`, `assets/`, `memory/` | `audit/`, `tmp/`, `canvas.json.bak` |

**Assets are ignored by default** (content-hash-named binary blobs bloat git and are not
diffable; `ImageCard`/`BackdropLayer` already degrade gracefully when a blob is missing). The
**commit opt-in is the user's option** to version assets + memory alongside the canvas for a
shared/checked-in project.

### File-tree visibility

`.canvas/` is Canvas ADE's private dir; its sha1-named blobs and volatile logs are noise in the
user's tree. **Hide `.canvas/` from the File Tree** by adding an ignore set to `file:listDir`
(today the listing filters nothing — `.git`/`node_modules` show too; this change is consistent
with the chokidar watcher already special-casing those names).

### Not a schema change

This is a **location** migration, orthogonal to ADR 0007's schema versioning. No `schemaVersion`
bump and no `minReaderVersion` change: doc *content* (including every `assetId`) is byte-identical
before and after. ADR 0007 governs schema skew across versions; this ADR governs file *layout*.

## Consequences

- **A project root holds one isolated `.canvas/` dir** for Canvas data — clean for folders that
  are also code repos.
- **Existing projects keep working**: migrate-on-open relocates them once; the permanent
  legacy-root read-fallback covers any project that hasn't (or couldn't) migrate.
- **Downgrade is unsupported**: an older build run against a migrated project won't find it. This
  is accepted because the app is **pre-release** (Phase 5 packaging is the open blocker) — there
  is effectively no installed base of older builds opening shared projects. Documented here so the
  decision is explicit, mirroring ADR 0007's version-skew reasoning for the *schema* axis.
- **`canvas.json` stays git-trackable**; assets/memory are private until the commit opt-in. The
  migration upgrades the old default ignore (`*`) so a migrated project's `canvas.json` is not
  silently un-tracked.
- **Blast radius is one module.** `projectStore.ts` owns the path change + migration;
  `projectIpc.ts` adds one migration call; `canvasMemory.ts` updates the ignore templates;
  `fileWatch.ts` needs no change (`IGNORED_BASENAMES` already matches `canvas.json.bak` by
  basename, so `.canvas/canvas.json.bak` stays ignored); `fileIpc.ts` gains the tree ignore. The
  renderer, the IPC contract, and the schema are untouched.
- **Follow-up:** the commit opt-in (`canvasMemory.setCommitOptIn`) exists as an API but may not be
  surfaced in any settings UI — exposing it is a small, separate add.
