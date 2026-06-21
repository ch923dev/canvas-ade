# Spec — Isolate project files under `.canvas/`

**Branch:** `feat/canvas-isolation` · **ADR:** `docs/decisions/0009-project-files-under-canvas-dir.md`
· **Date:** 2026-06-21

Move `canvas.json`, `canvas.json.bak`, and `assets/` from the project root into `<project>/.canvas/`
so a project root holds a single, isolated Canvas data directory. Renderer, IPC contract, and doc
schema are untouched (see ADR 0009 for rationale + the locked decisions).

## Target layout

```
<project>/.canvas/
  canvas.json · canvas.json.bak · assets/<sha1>.<ext> · memory/ · audit/ · tmp/ · .gitignore
```

## Invariants (do not regress)

- Atomic write + BUG-007 rotation order (new primary durable BEFORE prior→.bak).
- PERSIST-1 envelope guard before any disk touch.
- Asset GC (`gcAssets`) mark-and-sweep to `.trash`, never hard-delete.
- BUG-042 corrupt-on-create files renamed aside, never overwritten.
- `assetId` string stays `assets/<sha1>.<ext>` — **no schema bump, no `minReaderVersion` change.**

---

## 1. `src/main/projectStore.ts` — core path + migration

### Path helpers
Replace the bare `CANVAS`/`CANVAS_BAK` joins with `.canvas/`-rooted derivations; keep legacy
root paths for the read-fallback + migration source.

```ts
const CANVAS_DIR = '.canvas'
const CANVAS = 'canvas.json'
const CANVAS_BAK = 'canvas.json.bak'
const ASSETS = 'assets'

const canvasRoot   = (dir: string) => join(dir, CANVAS_DIR)
const primaryPath  = (dir: string) => join(dir, CANVAS_DIR, CANVAS)
const bakPath      = (dir: string) => join(dir, CANVAS_DIR, CANVAS_BAK)
const assetsDirOf  = (dir: string) => join(dir, CANVAS_DIR, ASSETS)
// legacy (pre-0009) — read-fallback + migration source only
const legacyPrimary = (dir: string) => join(dir, CANVAS)
const legacyBak     = (dir: string) => join(dir, CANVAS_BAK)
const legacyAssets  = (dir: string) => join(dir, ASSETS)
```

### Reads (prefer `.canvas/`, fall back to legacy root)
- `readProject(dir)`: `tryParse(primaryPath)` → `tryParse(legacyPrimary)` → `tryParse(bakPath)`
  → `tryParse(legacyBak)` → error.
- `readBak(dir)`: `tryParse(bakPath)` → `tryParse(legacyBak)` → `{ok:false}`. (Keeps the T5
  recovery contract: read ONLY the backup, skip the primary.)

### Writes (always `.canvas/`)
- `writeProject(dir, doc)`: `mkdirSync(canvasRoot(dir), {recursive:true})`; write `primaryPath`;
  rotate prior `primaryPath` → `bakPath`. Envelope-guard + atomic-write + rotation order unchanged.
- `createProject`: reuse-if-exists checks the new + legacy locations (via `readProject`);
  corrupt-rename-aside (BUG-042) repointed to `primaryPath`/`bakPath`; fresh-doc write through
  `writeProject` (already routed). `scaffoldProjectMemory(dir)` already ensures `.canvas/`.

### Assets (resolution base → `.canvas/assets/`, id unchanged)
- `writeAsset`: `abs = join(assetsDirOf(dir), <sha1>.<ext>)`; `mkdirSync(assetsDirOf(dir))`.
  Return value `{ assetId: 'assets/<sha1>.<ext>' }` **unchanged**.
- `readAsset`: `ASSET_RE` unchanged; resolve `join(canvasRoot(dir), assetId)`; **fall back** to
  `join(dir, assetId)` (legacy) if the `.canvas/` copy is absent.
- `gcAssets`: operate on `assetsDirOf(dir)` (canonical post-migration). The `referenced` keys stay
  `assets/<f>`; `.trash` handling unchanged.

### New: `migrateProjectLayout(dir)` — best-effort, idempotent
```ts
export function migrateProjectLayout(dir: string): void {
  try {
    // Only migrate when the canonical primary is absent AND a legacy primary exists.
    if (existsSync(primaryPath(dir)) || !existsSync(legacyPrimary(dir))) {
      upgradeGitignoreIfLegacy(dir) // still upgrade ignore on an already-migrated/new tree
      return
    }
    mkdirSync(canvasRoot(dir), { recursive: true })
    moveAside(legacyPrimary(dir), primaryPath(dir))   // rename, copy-fallback cross-volume
    moveAside(legacyBak(dir), bakPath(dir))            // best-effort; absent is fine
    moveDir(legacyAssets(dir), assetsDirOf(dir))       // merge content-addressed on collision
    upgradeGitignoreIfLegacy(dir)
  } catch (err) {
    console.warn('[projectStore] migrateProjectLayout failed (non-fatal)', err)
  }
}
```
- `moveAside`: `renameSync`; on `EXDEV`/failure `copyFileSync` + best-effort `unlinkSync`.
- `moveDir`: `renameSync` whole dir; on failure, per-file copy into the target (skip existing —
  identical sha = identical bytes), then best-effort remove the source.
- `upgradeGitignoreIfLegacy`: see §3 (maps a recognized OLD ignore body to the new one; leaves a
  user-customised file untouched).

---

## 2. `src/main/projectIpc.ts` — wire the migration

Call `migrateProjectLayout(dir)` at the **start** of `project:open` and `project:current`,
immediately before `readProject`. `scaffoldProjectMemory` continues to run after a successful read.
No IPC contract change. (The `asset:write`/`asset:read` handlers are unchanged — they delegate to
the repointed `writeAsset`/`readAsset`.)

---

## 3. `src/main/canvasMemory.ts` — `.gitignore` templates

```ts
const IGNORE_PRIVATE   = '*\n!canvas.json\n'                 // track only the canvas doc
const IGNORE_COMMITTED = 'audit/\ntmp/\ncanvas.json.bak\n'   // also track assets/ + memory/
```
- `ensureScaffold` still writes `IGNORE_PRIVATE` only when the file is absent.
- `isCommitted()` stays symmetric (`raw.trim() === IGNORE_COMMITTED.trim()`).
- New exported `upgradeGitignoreIfLegacy(dir)` (or a helper here that `projectStore` calls):
  - current body `=== '*'` (old private) → rewrite to `IGNORE_PRIVATE`
  - current body `=== 'audit/'` (old committed) → rewrite to `IGNORE_COMMITTED`
  - anything else (user-customised / already-new) → leave untouched.
- `setCommitOptIn` unchanged (writes the new constants).

---

## 4. `src/main/fileWatch.ts` — no change required

`shouldIgnore` matches `IGNORED_BASENAMES` against the **last path segment**, so
`.canvas/canvas.json.bak` is still ignored. `.canvas/canvas.json` change-events on save mirror
today's root-`canvas.json` behavior (collapsed by `atomic:true` + `awaitWriteFinish`). *(Optional:
add `.canvas` to an ignore set here too once §5 hides it from the tree, to drop tmp/audit churn
events — not required for correctness.)*

---

## 5. `src/main/fileIpc.ts` — hide `.canvas/` from the File Tree

In `file:listDir`, skip Canvas-internal entries so the tree shows the user's project, not Canvas's
data dir:

```ts
const TREE_HIDDEN = new Set(['.canvas'])   // consider also '.git', 'node_modules' (separate scope)
// in the readdir loop:
if (ent.isSymbolicLink()) continue
if (relPath === '' && TREE_HIDDEN.has(ent.name)) continue
```
Scope decision for review: hide **only `.canvas`** (tight, matches this feature) vs. also
`.git`/`node_modules` (broader tree-noise cleanup, arguably its own change). Recommend `.canvas`
only here.

---

## 6. Tests

- **`projectStore.test.ts`**
  - Repoint every `join(dir, 'canvas.json')` assertion to `join(dir, '.canvas', 'canvas.json')`
    (and `.bak`, and `assets/` → `.canvas/assets/`).
  - New: `migrateProjectLayout` moves a legacy-root `canvas.json`/`.bak`/`assets/` into `.canvas/`,
    is idempotent (second call no-ops), and is a no-op when `.canvas/canvas.json` already exists.
  - New: `readProject`/`readAsset` legacy-root fallback (file only at root → still read).
  - New: gitignore upgrade (`*` → `*\n!canvas.json`; `audit/` → committed body; custom → untouched).
  - Keep BUG-007 / PERSIST-1 / BUG-042 / BUG-016 tests (repointed paths).
- **`src/main/e2eMain.ts`** — `writeProjectFile`: allow a single known `.canvas/` prefix (still
  reject `..` and arbitrary separators) so recovery probes can seed `.canvas/canvas.json[.bak]`.
- **`e2e/recovery.e2e.ts`, `e2e/reset-isolation.e2e.ts`** — seed `'.canvas/canvas.json'` /
  `'.canvas/canvas.json.bak'`.
- **New e2e** — open a legacy-layout temp project (root `canvas.json` + `assets/`) → opens AND the
  files now live under `.canvas/` (assert via a MAIN `fileExists` probe).
- **`canvasMemory.test.ts`** — new ignore-template values + `upgradeGitignoreIfLegacy` mapping.

## 7. Docs

- ADR 0009 (this branch) — already written.
- **CLAUDE.md** › Persistence: "single `canvas.json` at root + `canvas.json.bak`" → "under
  `<project>/.canvas/` (canvas.json + .bak + assets/), with legacy-root read-fallback + migrate-on-
  open (ADR 0009)". Add a Locked-decisions row.
- This spec is ephemeral (deleted on merge per the doc-lifecycle policy); the build-history line is
  the residue.

---

## Risks → mitigations

| Risk | Mitigation |
|---|---|
| Existing project opens empty after update | migrate-on-open + permanent legacy-root read-fallback |
| Crash / lock mid-migration | idempotent + best-effort; rename-aside (never delete); readers fall back to legacy |
| Asset breakage | `assetId` unchanged (no schema migration); `readAsset` dual-location fallback |
| Migrated canvas silently git-ignored | `upgradeGitignoreIfLegacy` (old `*` → `!canvas.json`) |
| Downgrade to older build | **Accepted** (pre-release) — documented in ADR 0009 |
| Cross-volume move (rare) | copy-then-unlink fallback in `moveAside`/`moveDir` |

## Sequencing (each step keeps the app runnable)

1. `projectStore.ts` — path helpers + reads/writes/assets repoint + `migrateProjectLayout` (+ unit tests).
2. `projectIpc.ts` — wire the migration call.
3. `canvasMemory.ts` — ignore templates + `upgradeGitignoreIfLegacy` (+ unit tests).
4. `fileIpc.ts` — hide `.canvas/` from the tree.
5. e2e + `e2eMain.ts` helper updates (+ new migration e2e).
6. CLAUDE.md update.

**Gate before push:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`, then the
e2e gate (Windows leg + the full matrix once at the pre-merge gate, per CLAUDE.md). Manual dev check
with a title-stamped build (`$env:CANVAS_DEV_TITLE='PR#NNN canvas-isolation'`): create a project,
add a Planning image + a wallpaper, reopen, and confirm everything lives under `.canvas/` and the
root is clean. Also open a *pre-0009* project to verify migrate-on-open.
```
