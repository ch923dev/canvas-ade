# Design — Phase 3 Slice A: Persistence (projects + canvas.json + autosave)

**Date:** 2026-05-30
**Phase/slice:** Phase 3 · Slice A (Project create/open + persistence). Focus/Full view, Duplicate,
git worktrees + per-board ports are **separate later slices** of Phase 3 — out of scope here.
**Branch:** `phase-3-persistence` off `main`.

## Goal

Make a Canvas ADE project durable. A project = a user-chosen folder holding one `canvas.json`. The
app opens, creates, switches, and autosaves projects so the full canvas (boards, geometry, configs,
planning elements, **and camera**) survives restart. Live ephemeral state (PTY sessions/scrollback,
browser live page) is intentionally NOT persisted.

**Roadmap acceptance (✅📏):** full reopen fidelity — zoom/pan/positions/contents/checklist state
survive restart (integration test).

## Decisions (locked this session)

- **Startup:** auto-reopen the most-recent project; first launch / missing folder → welcome screen.
- **Switching:** in-session switch (flush-save current → dispose previews + PTYs → load new).
- **Camera:** add `viewport` to `canvas.json`, bump `SCHEMA_VERSION` 1→2 with a real `migrate(1→2)`.
- **Terminal on reopen:** restore **idle** (config preserved, no auto-spawn, no auto-run). Run = fresh
  shell + `launchCommand`. Never auto-execute a stored command on load.
- **Save orchestration:** renderer-driven, main = atomic writer (Approach A). Store stays the single
  source of truth.
- **Project name:** the folder basename. No separate metadata file.
- **Corrupt recovery:** `canvas.json` parse-fail → try `canvas.json.bak` → both fail → error, never
  clobber.
- **Session resume:** **deferred** to its own post-Phase-3 slice (see roadmap note). Idle-restore now.

## Architecture

### Save orchestration (Approach A — renderer-driven, main = dumb writer)

```
Zustand store (boards + viewport)  ── single source of truth
   │  subscribe + debounce 1s
   ▼
useAutosave hook ── window.api.project.save(toObject())   (IPC invoke)
   │  + flush on window 'blur' and 'beforeunload'
   ▼
main: projectStore.writeProject(currentDir, doc)  ── write-file-atomic + .bak rotation
```

Rejected: main-driven shadow doc (duplicates state); Node-in-preload writer (violates the locked
security model — no Node in renderer).

## Components

### 1. Schema — `src/renderer/src/lib/boardSchema.ts` (edit)

- `CanvasDoc` gains `viewport: Viewport | null` (`{x:number,y:number,zoom:number}`); `null` = "fit on
  load".
- `SCHEMA_VERSION` 1 → 2.
- `migrate(doc)` implements the first real step: `1→2` sets `viewport ??= null` (and stamps
  `schemaVersion = 2`).
- `toObject(boards, viewport)` — new second param; embeds viewport.
- **BUG-027 fix:** `fromObject` / `migrate` deep-clone so the returned doc never aliases the input
  (`structuredClone` on the owned doc; migrations mutate the clone only). Symmetric with `toObject`.
- Validation: `viewport`, when present, must have finite numeric `x/y/zoom` and `zoom > 0`; invalid →
  coerce to `null` (fit on load) rather than throw (corrupt-but-recoverable, consistent with the
  existing MIN_BOARD_SIZE clamp / BUG-025 handling).

### 2. Main — `src/main/projectStore.ts` (new)

Pure-ish file I/O, no Electron app logic. Holds module-level `currentDir: string | null`.

- `readProject(dir): { doc: CanvasDoc } | { error: string }` — read `canvas.json`; on parse/read
  fail, try `canvas.json.bak`; on both-fail return `{error}` (never write).
- `writeProject(dir, doc): Promise<void>` — if a valid `canvas.json` exists, copy it to
  `canvas.json.bak` first (rotation), then `write-file-atomic` the new `canvas.json`.
- `createProject(dir, name, opts: { gitInit?: boolean }): { doc }` — ensure folder exists; if a
  `canvas.json` already exists, **open it** (reuse, don't overwrite); else write a fresh empty doc
  (`{schemaVersion:2, viewport:null, boards:[]}`). `gitInit` is accepted but **inert this slice**
  (git wiring = Slice C); recorded so the create dialog's toggle is forward-compatible.
- `setCurrentDir(dir)` / `getCurrentDir()`.

The doc is validated through `boardSchema.fromObject` at the read boundary so malformed files are
caught before they reach the store.

### 3. Main — `src/main/recentProjects.ts` (new)

- File: `recent-projects.json` in `app.getPath('userData')` — NEVER in a project folder.
- Shape: `{ projects: Array<{ path: string; name: string; lastOpenedAt: number }> }`, MRU-ordered,
  capped at 10.
- `list()` — read + prune entries whose folder no longer exists.
- `touch(path, name)` — move/insert to front, stamp `lastOpenedAt`, cap.
- `lastOpenedAt` is supplied by the caller (timestamp passed in) — keeps the module pure/testable and
  avoids `Date.now()` inside it.

### 4. Main — IPC (`src/main/index.ts` edit + preload bridge)

All handlers keep the existing **sender-frame validation** (BUG-033 defense-in-depth pattern already
applied to pty/preview handlers).

| Channel | Direction | Behavior |
|---|---|---|
| `dialog:openFolder` | invoke | native folder picker → `dir \| null` |
| `project:create` | invoke | `(dir,name,opts)` → createProject → setCurrentDir → touch recents → `{doc,name,dir}` |
| `project:open` | invoke | `(dir)` → readProject → on ok setCurrentDir + touch recents → `{doc,name,dir} \| {error}` |
| `project:save` | invoke | `(doc)` → writeProject(currentDir, doc); no-op if no currentDir |
| `project:recents` | invoke | → recentProjects.list() |
| `project:current` | invoke | boot helper: recents[0] exists? open it → `{doc,name,dir}` : `null` |

Preload (`src/preload/index.ts` + `index.d.ts`): expose `window.api.project.{create,open,save,recents,
current}` and `window.api.dialog.openFolder` via `contextBridge`. No Node leaks; invoke-only.

### 5. Store — `src/renderer/src/store/canvasStore.ts` (edit)

- State adds `viewport: Viewport | null` and a `project: { dir: string|null; name: string|null;
  status: 'welcome'|'loading'|'open'|'error'; error?: string }`.
- `setViewport(vp)` — **untracked** (not undoable; mirrors `growBoardHeight`).
- `toObject()` now embeds `viewport`; `loadObject(doc)` restores `boards` + `viewport`, resets
  selection + history (existing behavior) and the camera is applied by `Canvas.tsx` on load.
- Project actions thin-wrap IPC then `loadObject`: `openProject(dir)`, `createProject(dir,name,opts)`,
  `openRecent`, set `status`. Switching first calls a `disposeLiveResources()` seam (below).

### 6. Renderer — `src/renderer/src/store/useAutosave.ts` (new hook)

- Subscribe to store `boards` + `viewport`; debounce 1s; call `window.api.project.save(toObject())`.
- Flush immediately on `window` `blur` and `beforeunload`.
- Guards: only when `project.status === 'open'`; skip while `loading` (never clobber a project
  mid-load). Cancel a pending debounce on unmount/switch.

### 7. Renderer — camera capture (`src/renderer/src/canvas/Canvas.tsx` edit)

- Hook React Flow viewport changes → `setViewport(vp)` (throttled; reuse the existing
  `useOnViewportChange`/rAF machinery — no new pump, no per-render writes).
- On load: if `viewport === null` → `fitView`; else `setViewport(stored)`.

### 8. Renderer — switch teardown seam (`disposeLiveResources()`)

Before `loadObject` on a project switch: dispose all native `WebContentsView`s and kill all PTY
process trees, reusing the **existing** per-board teardown paths (BrowserPreviewLayer close +
`pty:kill`). Critical: skipping this leaks renderers/processes across switches.

### 9. Renderer — Welcome + switcher UI

- `WelcomeScreen.tsx` (new) — shown when `status === 'welcome'` or `'error'`: Create / Open buttons +
  recent-projects list (name + path, click to open). Error state shows the `error` string + the same
  actions (no clobber).
- Project switcher: wire the existing top-left placeholder in `AppChrome.tsx` → dropdown (current
  name, recents, Open…, Create…). Switch = flush-save → `disposeLiveResources()` → `openProject`.
- Create dialog: name + parent folder + an (inert, Slice C) "Initialize git" checkbox.

### 10. Boot — `src/renderer/src/App.tsx` (edit)

On mount: `project.current()` → doc present? `loadObject` + `status='open'` : `status='welcome'`.

### 11. Terminal cwd (`pty.ts` already `cwd || homedir`; thread project dir)

When a Terminal board has no explicit `cwd`, the renderer passes the **current project dir** as the
spawn cwd (so new terminals start in project root). Explicit per-board `cwd` (worktrees, Slice C)
overrides. One-line change at the spawn call site + thread `project.dir` through the spawn opts.

## Data flow

- **Boot:** App mount → `project.current()` → `loadObject(doc)` → Canvas applies `viewport` (or fits)
  → `status='open'` → `useAutosave` arms.
- **Edit:** store mutates → autosave debounce 1s → `project.save(toObject())` → main rotates `.bak` +
  atomic-writes `canvas.json`.
- **Switch:** flush-save → `disposeLiveResources()` → `project.open(newDir)` → `loadObject` → camera
  applied → recents touched.
- **Quit/blur:** flush pending save synchronously-ish (also covered by the `blur` flush so
  `beforeunload` isn't the sole safety net).

## Error handling

- Read: parse-fail → `.bak` → both-fail → `{error}` surfaced on the welcome/error screen; **never
  overwrite** a corrupt file.
- Write: `write-file-atomic` (temp + rename) so a crash mid-write can't truncate `canvas.json`; prior
  good file preserved as `.bak`.
- Missing recent folder: pruned from the list on `list()`; if it was `recents[0]`, boot falls through
  to welcome.
- Mid-load save suppression: autosave skips while `status==='loading'`.

## Testing

- `src/main/projectStore.test.ts` — write→read round-trip; `.bak` rotation; corrupt `canvas.json` →
  `.bak` fallback; both-corrupt → `{error}` and no write; create reuses existing `canvas.json`.
- `src/main/recentProjects.test.ts` — MRU order, cap at 10, prune-missing, `touch` move-to-front.
- `src/renderer/src/lib/boardSchema.test.ts` (extend) — `migrate` v1→v2 adds `viewport:null` + stamps
  version; invalid viewport coerces to null; **clone-not-alias** (BUG-027) for both `fromObject` and a
  no-op migrate.
- `src/renderer/src/store/useAutosave.test.ts` — debounce coalesces bursts to one save; `blur` flushes
  immediately; suppressed while `loading`.
- Reopen-fidelity integration — seed boards (all 3 types incl. planning elements) + camera →
  `toObject` → `fromObject` → deep-equal (the roadmap ✅📏).

## Out of scope (this slice)

- Focus / Full view / Duplicate (later Phase 3 slices).
- Git worktrees + git-init wiring + per-board ports (Slice C; the create toggle is inert here).
- Agentic session resume (deferred — own slice; roadmap note added 2026-05-30).
- Multi-window projects (decided: in-session switch).

## Risks

- **Switch teardown leaks** — native views / PTY trees must be disposed before `loadObject`. Mitigation:
  the `disposeLiveResources()` seam over existing teardown paths; assert no orphaned views/processes.
- **`beforeunload` flush may not complete** — IPC invoke during unload is unreliable. Mitigation: also
  flush on `blur`; keep the autosave window short (1s) so at most ~1s of edits is at risk.
- **Double-clamp on re-save (BUG-025)** — load clamps sub-MIN geometry; re-saving the clamped value is
  idempotent (already ≥ MIN), so no drift. Confirmed safe by reasoning; covered by round-trip test.
