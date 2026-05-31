# Phase 3 Slice A — Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Canvas ADE project durable — open/create/switch projects and autosave the full canvas (boards + configs + planning elements + camera) to `canvas.json` so it survives restart.

**Architecture:** Renderer-driven save (Approach A). Zustand store is the single source of truth; a `useAutosave` hook debounces and sends the full `CanvasDoc` over IPC; MAIN is a dumb atomic writer (`write-file-atomic` + `.bak` rotation). Boot auto-reopens the most-recent project (welcome screen if none). In-session project switching disposes live previews + PTYs before loading. Schema bumps 1→2 to add a persisted camera `viewport`.

**Tech Stack:** Electron 33 main/preload/renderer, TypeScript strict, Zustand, React Flow v12, `write-file-atomic` 5.0.1, Vitest. Spec: `docs/superpowers/specs/2026-05-30-persistence-design.md`.

**Conventions:** TS strict, no unused locals/params. Run `pnpm test` (Vitest) for tests, `pnpm typecheck` before each commit. Branch `phase-3-persistence` (already created). Commit per task.

**Cross-task type contract (defined in Task 1, referenced everywhere):**
```ts
// lib/boardSchema.ts
export interface CanvasViewport { x: number; y: number; zoom: number }
export interface CanvasDoc {
  schemaVersion: number
  viewport: CanvasViewport | null   // null = "fit on load"
  boards: Board[]
}
export const SCHEMA_VERSION = 2
export function toObject(boards: Board[], viewport: CanvasViewport | null): CanvasDoc
export function fromObject(doc: unknown): CanvasDoc   // validates + migrates + deep-clones
```
```ts
// preload — doc crosses as `unknown` (preload stays decoupled; renderer re-validates)
export interface RecentProject { path: string; name: string; lastOpenedAt: number }
export type ProjectResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }
window.api.project.create(dir: string, name: string, opts: { gitInit?: boolean }): Promise<ProjectResult>
window.api.project.open(dir: string): Promise<ProjectResult>
window.api.project.save(doc: unknown): Promise<boolean>
window.api.project.recents(): Promise<RecentProject[]>
window.api.project.current(): Promise<ProjectResult | null>
window.api.dialog.openFolder(): Promise<string | null>
```

---

### Task 1: Schema v2 — persisted camera `viewport` + real migration 1→2

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts`
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/renderer/src/lib/boardSchema.test.ts` (append inside the existing `describe`, or a new one):

```ts
import {
  SCHEMA_VERSION,
  toObject,
  fromObject,
  type CanvasDoc,
  type CanvasViewport
} from './boardSchema'

describe('schema v2 — viewport', () => {
  const vp: CanvasViewport = { x: -120, y: 40, zoom: 0.75 }

  it('SCHEMA_VERSION is 2', () => {
    expect(SCHEMA_VERSION).toBe(2)
  })

  it('toObject embeds the viewport and version', () => {
    const doc = toObject([], vp)
    expect(doc).toEqual({ schemaVersion: 2, viewport: vp, boards: [] })
  })

  it('toObject accepts a null viewport (fit-on-load)', () => {
    expect(toObject([], null).viewport).toBeNull()
  })

  it('migrates a v1 doc (no viewport) to v2 with viewport=null', () => {
    const v1 = { schemaVersion: 1, boards: [] } as unknown
    const out = fromObject(v1)
    expect(out.schemaVersion).toBe(2)
    expect(out.viewport).toBeNull()
  })

  it('coerces an invalid viewport to null rather than throwing', () => {
    const bad = { schemaVersion: 2, viewport: { x: 0, y: 0, zoom: 0 }, boards: [] } as unknown
    expect(fromObject(bad).viewport).toBeNull()
    const nan = { schemaVersion: 2, viewport: { x: NaN, y: 0, zoom: 1 }, boards: [] } as unknown
    expect(fromObject(nan).viewport).toBeNull()
  })

  it('round-trips a valid viewport', () => {
    const doc = toObject([], vp)
    const back = fromObject(JSON.parse(JSON.stringify(doc)))
    expect(back.viewport).toEqual(vp)
  })

  it('fromObject deep-clones — returned doc never aliases input (BUG-027)', () => {
    const input: CanvasDoc = { schemaVersion: 2, viewport: { ...vp }, boards: [] }
    const out = fromObject(input)
    expect(out).not.toBe(input)
    expect(out.viewport).not.toBe(input.viewport)
  })

  it('migrate result is a fresh object, not the input ref (BUG-027)', () => {
    const input = { schemaVersion: 1, boards: [] } as unknown as CanvasDoc
    const out = fromObject(input)
    expect(out).not.toBe(input)
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- boardSchema`
Expected: FAIL — `SCHEMA_VERSION` is 1; `toObject` takes one arg; no viewport field.

- [ ] **Step 3: Implement schema v2**

In `src/renderer/src/lib/boardSchema.ts`:

Change the version constant (line 15):
```ts
/** Bump on any breaking change to the persisted shape and add a migration below. */
export const SCHEMA_VERSION = 2
```

Add the viewport type and extend `CanvasDoc` (replace the `CanvasDoc` interface at lines 116–120):
```ts
/** Persisted camera transform. `null` in a doc means "fit on load". */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/** The whole-canvas serialized document (root of `canvas.json`). */
export interface CanvasDoc {
  schemaVersion: number
  viewport: CanvasViewport | null
  boards: Board[]
}
```

Replace `toObject` (lines 186–188) to embed the viewport:
```ts
/** Boards + camera → a versioned document. Deep-clones so the doc owns its data. */
export function toObject(boards: Board[], viewport: CanvasViewport | null): CanvasDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    viewport: viewport ? { ...viewport } : null,
    boards: structuredClone(boards)
  }
}
```

Register the 1→2 migration (replace the empty `MIGRATIONS` at line 193):
```ts
/** Keyed by the FROM version. Each step returns a doc one version higher. */
const MIGRATIONS: Record<number, Migration> = {
  // v1 had no camera. v2 adds `viewport` (null = fit on load).
  1: (doc) => ({ ...doc, schemaVersion: 2, viewport: (doc as CanvasDoc).viewport ?? null })
}
```

Add a viewport validator near the other guards (after `isPositiveNum`, ~line 246):
```ts
/** A valid persisted viewport: finite x/y and a finite, strictly-positive zoom. */
function isValidViewport(v: unknown): v is CanvasViewport {
  return (
    isRecord(v) &&
    isFiniteNum(v.x) &&
    isFiniteNum(v.y) &&
    isFiniteNum(v.zoom) &&
    (v.zoom as number) > 0
  )
}
```

In `fromObject` (lines 346–364), after `migrate(owned)`, coerce an invalid viewport to `null` (corrupt-but-recoverable, consistent with the MIN_BOARD_SIZE clamp). Replace the final `return migrate(owned)`:
```ts
  const migrated = migrate(owned)
  // A corrupt camera shouldn't fail the whole load — drop to fit-on-load.
  if (!isValidViewport(migrated.viewport)) migrated.viewport = null
  return migrated
```

> Note: `isCanvasDoc` (lines 218–225) intentionally does NOT require `viewport` — a v1 doc has none, and the migration adds it. Leave it unchanged.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm test -- boardSchema`
Expected: PASS (all existing + 8 new).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (Will surface the two-arg `toObject` callsite in `canvasStore.ts` — fixed in Task 2. If typecheck fails ONLY on `canvasStore.ts:234`, that's expected; proceed.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git commit -m "feat(schema): v2 — persisted camera viewport + migrate(1->2); coerce invalid viewport"
```

---

### Task 2: Store — viewport state + `setViewport` + updated `toObject`/`loadObject`

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/renderer/src/store/canvasStore.test.ts`:

```ts
import { useCanvasStore } from './canvasStore'

describe('canvasStore — viewport', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], viewport: null, selectedId: null, past: [], future: [] })
  })

  it('setViewport stores the camera', () => {
    useCanvasStore.getState().setViewport({ x: 10, y: 20, zoom: 1.5 })
    expect(useCanvasStore.getState().viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
  })

  it('setViewport is untracked — does not push undo history', () => {
    const before = useCanvasStore.getState().past.length
    useCanvasStore.getState().setViewport({ x: 1, y: 2, zoom: 1 })
    expect(useCanvasStore.getState().past.length).toBe(before)
  })

  it('toObject embeds the current viewport', () => {
    useCanvasStore.getState().setViewport({ x: 5, y: 6, zoom: 0.5 })
    expect(useCanvasStore.getState().toObject().viewport).toEqual({ x: 5, y: 6, zoom: 0.5 })
  })

  it('loadObject restores boards and viewport', () => {
    const doc = {
      schemaVersion: 2,
      viewport: { x: 7, y: 8, zoom: 2 },
      boards: [{ id: 'b1', type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }]
    }
    useCanvasStore.getState().loadObject(doc)
    const s = useCanvasStore.getState()
    expect(s.boards).toHaveLength(1)
    expect(s.viewport).toEqual({ x: 7, y: 8, zoom: 2 })
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test -- canvasStore`
Expected: FAIL — `setViewport` is not a function; `viewport` undefined.

- [ ] **Step 3: Implement**

In `src/renderer/src/store/canvasStore.ts`:

Add the import (extend the boardSchema import block at lines 12–21):
```ts
import {
  type Board,
  type BoardType,
  type CanvasDoc,
  type CanvasViewport,
  createBoard,
  fromObject,
  toObject,
  MIN_BOARD_SIZE,
  DEFAULT_BOARD_SIZE
} from '../lib/boardSchema'
```

Add `viewport` to the state interface (after `future: Board[][]`, ~line 33):
```ts
  /** Persisted camera transform (null = not yet captured / fit on load). */
  viewport: CanvasViewport | null
```

Add the `setViewport` action signature (after `growBoardHeight`, ~line 49):
```ts
  /** Set the camera transform. UNTRACKED — never touches undo/redo (like growBoardHeight). */
  setViewport: (vp: CanvasViewport) => void
```

Add `viewport: null` to the initial state (after `future: []`, ~line 134):
```ts
  viewport: null,
```

Add the `setViewport` implementation (after the `growBoardHeight` impl, ~line 205):
```ts
  setViewport: (vp) => set({ viewport: vp }),
```

Update `toObject` and `loadObject` (lines 234–236):
```ts
  toObject: () => toObject(get().boards, get().viewport),
  loadObject: (doc) => {
    const d = fromObject(doc)
    set({ boards: d.boards, viewport: d.viewport, selectedId: null, past: [], future: [] })
  }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm test -- canvasStore`
Expected: PASS.

- [ ] **Step 5: Typecheck + full test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (clears the Task 1 expected callsite error).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -m "feat(store): persist camera viewport (untracked setViewport); toObject/loadObject carry it"
```

---

### Task 3: MAIN — `recentProjects.ts` (userData MRU list)

**Files:**
- Create: `src/main/recentProjects.ts`
- Test: `src/main/recentProjects.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/recentProjects.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listRecents, touchRecent, RECENT_LIMIT } from './recentProjects'

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'canvas-recents-'))
})
afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('recentProjects', () => {
  it('returns [] when the file is absent', () => {
    expect(listRecents(userData)).toEqual([])
  })

  it('touchRecent inserts, then move-to-front on re-touch', () => {
    const a = mkdtempSync(join(tmpdir(), 'proj-a-'))
    const b = mkdtempSync(join(tmpdir(), 'proj-b-'))
    touchRecent(userData, a, 'a', 1000)
    touchRecent(userData, b, 'b', 2000)
    expect(listRecents(userData).map((r) => r.path)).toEqual([b, a])
    touchRecent(userData, a, 'a', 3000)
    expect(listRecents(userData).map((r) => r.path)).toEqual([a, b])
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  })

  it('caps the list at RECENT_LIMIT', () => {
    const dirs: string[] = []
    for (let i = 0; i < RECENT_LIMIT + 5; i++) {
      const d = mkdtempSync(join(tmpdir(), `proj-${i}-`))
      dirs.push(d)
      touchRecent(userData, d, `p${i}`, i)
    }
    expect(listRecents(userData).length).toBe(RECENT_LIMIT)
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
  })

  it('prunes entries whose folder no longer exists', () => {
    const gone = join(tmpdir(), 'definitely-not-here-' + Math.random())
    const live = mkdtempSync(join(tmpdir(), 'proj-live-'))
    touchRecent(userData, gone, 'gone', 1)
    touchRecent(userData, live, 'live', 2)
    expect(listRecents(userData).map((r) => r.path)).toEqual([live])
    rmSync(live, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test -- recentProjects`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/recentProjects.ts`:

```ts
/**
 * Recent-projects list, stored in the app's userData dir (NEVER in a project folder).
 * Pure file I/O keyed by an explicit userDataDir + caller-supplied timestamp, so it's
 * fully testable without Electron's `app`. MRU-ordered, capped, prunes dead folders.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export const RECENT_LIMIT = 10

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'recent-projects.json')
}

/** Read the list, pruning any entry whose folder no longer exists. */
export function listRecents(userDataDir: string): RecentProject[] {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown }
    const raw = Array.isArray(parsed.projects) ? (parsed.projects as RecentProject[]) : []
    return raw.filter(
      (r) =>
        r &&
        typeof r.path === 'string' &&
        typeof r.name === 'string' &&
        typeof r.lastOpenedAt === 'number' &&
        existsSync(r.path)
    )
  } catch {
    return []
  }
}

/** Insert/move `path` to the front, stamp `at`, cap to RECENT_LIMIT, persist. */
export function touchRecent(userDataDir: string, path: string, name: string, at: number): void {
  mkdirSync(userDataDir, { recursive: true })
  const others = listRecents(userDataDir).filter((r) => r.path !== path)
  const next = [{ path, name, lastOpenedAt: at }, ...others].slice(0, RECENT_LIMIT)
  writeFileSync(fileFor(userDataDir), JSON.stringify({ projects: next }, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- recentProjects`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/recentProjects.ts src/main/recentProjects.test.ts
git commit -m "feat(main): recent-projects MRU list in userData (capped, prune-missing)"
```

---

### Task 4: MAIN — `projectStore.ts` (canvas.json read/write + .bak)

**Files:**
- Create: `src/main/projectStore.ts`
- Test: `src/main/projectStore.test.ts`

> Design note: MAIN treats `canvas.json` as opaque JSON — it validates only the *envelope* (object · numeric `schemaVersion` · `boards` is an array) and falls back to `.bak` on a parse/envelope failure. Deep per-board validation + migration + clone happen in the renderer's `loadObject` (`fromObject`). This keeps MAIN decoupled from the renderer's schema module.

- [ ] **Step 1: Write failing tests**

Create `src/main/projectStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readProject, writeProject, createProject } from './projectStore'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-proj-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const doc = { schemaVersion: 2, viewport: null, boards: [] }

describe('projectStore', () => {
  it('createProject writes a fresh empty doc', () => {
    const r = createProject(dir, 'My Proj', {})
    expect(r.ok).toBe(true)
    expect(existsSync(join(dir, 'canvas.json'))).toBe(true)
  })

  it('createProject reuses an existing canvas.json (no overwrite)', () => {
    writeFileSync(
      join(dir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ keep: true }] })
    )
    const r = createProject(dir, 'My Proj', {})
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.doc as { boards: unknown[] }).boards).toHaveLength(1)
  })

  it('write then read round-trips', async () => {
    await writeProject(dir, doc)
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.doc).toEqual(doc)
  })

  it('rotates the prior good file to canvas.json.bak on write', async () => {
    await writeProject(dir, { schemaVersion: 2, viewport: null, boards: [{ v: 1 }] })
    await writeProject(dir, { schemaVersion: 2, viewport: null, boards: [{ v: 2 }] })
    const bak = JSON.parse(readFileSync(join(dir, 'canvas.json.bak'), 'utf8'))
    expect(bak.boards[0].v).toBe(1)
  })

  it('falls back to .bak when canvas.json is corrupt', async () => {
    await writeProject(dir, doc) // valid
    writeFileSync(join(dir, 'canvas.json.bak'), JSON.stringify({ schemaVersion: 2, viewport: null, boards: [{ ok: true }] }))
    writeFileSync(join(dir, 'canvas.json'), '{ this is not json')
    const r = readProject(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.doc as { boards: { ok: boolean }[] }).boards[0].ok).toBe(true)
  })

  it('returns an error (never writes) when both files are corrupt', () => {
    writeFileSync(join(dir, 'canvas.json'), 'nope')
    writeFileSync(join(dir, 'canvas.json.bak'), 'also nope')
    const r = readProject(dir)
    expect(r.ok).toBe(false)
  })

  it('returns an error when no canvas.json exists', () => {
    expect(readProject(dir).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test -- projectStore`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/main/projectStore.ts`:

```ts
/**
 * Project file I/O: read/write `canvas.json` (+ `.bak` fallback) in a project folder.
 * MAIN is a dumb atomic writer — it validates only the document envelope; deep
 * validation + migration happen in the renderer (`boardSchema.fromObject`). Holds the
 * single "current open dir" so `project:save` knows where to write.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

const CANVAS = 'canvas.json'
const CANVAS_BAK = 'canvas.json.bak'

export type ProjectResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }

let currentDir: string | null = null
export function getCurrentDir(): string | null {
  return currentDir
}
export function setCurrentDir(dir: string | null): void {
  currentDir = dir
}

/** Folder basename = the project's display name. */
export function projectName(dir: string): string {
  const parts = dir.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || dir
}

/** Envelope-only check — deep validation is the renderer's job. */
function isEnvelope(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { schemaVersion?: unknown }).schemaVersion === 'number' &&
    Array.isArray((v as { boards?: unknown }).boards)
  )
}

function tryParse(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return isEnvelope(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** Read canvas.json; on parse/envelope failure try canvas.json.bak; else error. */
export function readProject(dir: string): ProjectResult {
  const primary = tryParse(join(dir, CANVAS))
  if (primary !== undefined) return { ok: true, dir, name: projectName(dir), doc: primary }
  const backup = tryParse(join(dir, CANVAS_BAK))
  if (backup !== undefined) return { ok: true, dir, name: projectName(dir), doc: backup }
  return { ok: false, error: `No readable canvas.json in ${dir}` }
}

/** Rotate the prior good canvas.json → .bak, then atomic-write the new doc. */
export async function writeProject(dir: string, doc: unknown): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const primary = join(dir, CANVAS)
  if (tryParse(primary) !== undefined) {
    try {
      copyFileSync(primary, join(dir, CANVAS_BAK))
    } catch {
      /* a missing/locked prior file must not block the new write */
    }
  }
  await writeFileAtomic(primary, JSON.stringify(doc, null, 2), 'utf8')
}

/** Ensure the folder; reuse an existing canvas.json, else write a fresh empty doc. */
export function createProject(
  dir: string,
  _name: string,
  _opts: { gitInit?: boolean }
): ProjectResult {
  // `gitInit` is accepted for forward-compat with Slice C (worktrees) but is inert here.
  mkdirSync(dir, { recursive: true })
  const existing = readProject(dir)
  if (existing.ok) return existing
  const fresh = { schemaVersion: 2, viewport: null, boards: [] }
  writeFileAtomic.sync(join(dir, CANVAS), JSON.stringify(fresh, null, 2), 'utf8')
  return { ok: true, dir, name: projectName(dir), doc: fresh }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- projectStore`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (If `write-file-atomic` lacks types, add `@types/write-file-atomic` as a devDep: `pnpm add -D @types/write-file-atomic`, then re-run.)

- [ ] **Step 6: Commit**

```bash
git add src/main/projectStore.ts src/main/projectStore.test.ts package.json pnpm-lock.yaml
git commit -m "feat(main): projectStore — canvas.json read/write, .bak rotation, atomic write"
```

---

### Task 5: MAIN — IPC handlers (`projectIpc.ts`) + wire into `index.ts`

**Files:**
- Create: `src/main/projectIpc.ts`
- Modify: `src/main/index.ts`

> No new unit test — covered by the renderer integration test (Task 13) and manual verify. The handlers are thin glue over the already-tested `projectStore` + `recentProjects`.

- [ ] **Step 1: Implement the handler module**

Create `src/main/projectIpc.ts`:

```ts
/**
 * Project IPC: folder picker + canvas.json open/create/save + recent-projects.
 * MAIN owns the "current dir"; the renderer drives saves (Approach A). All handlers
 * reject foreign senders (BUG-033 defense-in-depth), matching pty/preview.
 */
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  readProject,
  writeProject,
  createProject,
  getCurrentDir,
  setCurrentDir,
  projectName,
  type ProjectResult
} from './projectStore'
import { listRecents, touchRecent, type RecentProject } from './recentProjects'

function isForeignSender(e: IpcMainInvokeEvent, getWin: () => BrowserWindow | null): boolean {
  const main = getWin()?.webContents.mainFrame
  return !!main && !!e.senderFrame && e.senderFrame !== main
}

export function registerProjectHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  now: () => number = () => Date.now()
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('dialog:openFolder', async (e): Promise<string | null> => {
    if (guard(e)) return null
    const win = getWin()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  const remember = (r: ProjectResult): void => {
    if (r.ok) {
      setCurrentDir(r.dir)
      touchRecent(userDataDir, r.dir, r.name, now())
    }
  }

  ipcMain.handle('project:open', (e, dir: string): ProjectResult => {
    if (guard(e)) return { ok: false, error: 'forbidden' }
    const r = readProject(dir)
    remember(r)
    return r
  })

  ipcMain.handle(
    'project:create',
    (e, args: { dir: string; name: string; opts: { gitInit?: boolean } }): ProjectResult => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      const r = createProject(args.dir, args.name, args.opts ?? {})
      remember(r)
      return r
    }
  )

  ipcMain.handle('project:save', async (e, doc: unknown): Promise<boolean> => {
    if (guard(e)) return false
    const dir = getCurrentDir()
    if (!dir) return false
    await writeProject(dir, doc)
    return true
  })

  ipcMain.handle('project:recents', (e): RecentProject[] => {
    if (guard(e)) return []
    return listRecents(userDataDir)
  })

  ipcMain.handle('project:current', (e): ProjectResult | null => {
    if (guard(e)) return null
    const recents = listRecents(userDataDir)
    if (recents.length === 0) return null
    const r = readProject(recents[0].path)
    if (r.ok) {
      setCurrentDir(r.dir)
      touchRecent(userDataDir, r.dir, projectName(r.dir), now())
    }
    return r.ok ? r : null
  })
}
```

- [ ] **Step 2: Wire into `index.ts`**

In `src/main/index.ts`, add the import (after the preview import block, ~line 11):
```ts
import { registerProjectHandlers } from './projectIpc'
```

Register the handlers next to the others (after line 158 `registerPreviewHandlers(...)`):
```ts
  registerProjectHandlers(ipcMain, () => mainWindow, app.getPath('userData'))
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS — main bundles with the new handler module.

- [ ] **Step 4: Commit**

```bash
git add src/main/projectIpc.ts src/main/index.ts
git commit -m "feat(main): project IPC — openFolder/open/create/save/recents/current (frame-guarded)"
```

---

### Task 6: PRELOAD — expose `window.api.project` + `window.api.dialog`

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts` (no change needed — `CanvasApi = typeof api` flows through)

- [ ] **Step 1: Implement the bridge**

In `src/preload/index.ts`, add the shared types near the top (after the `PreviewEvent` union, ~line 47):
```ts
// ── Phase 3 persistence — project I/O (doc crosses as `unknown`; renderer validates) ──
export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}
export type ProjectResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }
```

Add the `project` + `dialog` groups to the `api` object (inside `const api = { ... }`, after `onPreviewEvent`, ~line 99 — add a comma after the `onPreviewEvent` block):
```ts
,

  // ── Phase 3 persistence ──
  project: {
    create: (dir: string, name: string, opts: { gitInit?: boolean }): Promise<ProjectResult> =>
      ipcRenderer.invoke('project:create', { dir, name, opts }),
    open: (dir: string): Promise<ProjectResult> => ipcRenderer.invoke('project:open', dir),
    save: (doc: unknown): Promise<boolean> => ipcRenderer.invoke('project:save', doc),
    recents: (): Promise<RecentProject[]> => ipcRenderer.invoke('project:recents'),
    current: (): Promise<ProjectResult | null> => ipcRenderer.invoke('project:current')
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder')
  }
```

- [ ] **Step 2: Typecheck (preload + web)**

Run: `pnpm typecheck`
Expected: PASS — `window.api.project` now typed in the renderer via `CanvasApi`.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): bridge window.api.project + window.api.dialog (invoke-only)"
```

---

### Task 7: RENDERER — `useAutosave` hook

**Files:**
- Create: `src/renderer/src/store/useAutosave.ts`
- Test: `src/renderer/src/store/useAutosave.test.ts`

> The save trigger logic (debounce + status gate) is extracted into a pure `createAutosaver` so it can be unit-tested without React. The hook is a thin React wrapper around it + window event listeners.

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/store/useAutosave.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosaver } from './useAutosave'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createAutosaver', () => {
  it('debounces bursts into a single save', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.schedule()
    a.schedule()
    a.schedule()
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('does not save while status !== "open"', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'loading', delayMs: 1000 })
    a.schedule()
    vi.advanceTimersByTime(1000)
    expect(save).not.toHaveBeenCalled()
  })

  it('flush() saves immediately and cancels the pending timer', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.schedule()
    a.flush()
    expect(save).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1) // timer was cancelled, no double save
  })

  it('flush() is a no-op when nothing is scheduled', () => {
    const save = vi.fn().mockResolvedValue(true)
    const a = createAutosaver({ save, getStatus: () => 'open', delayMs: 1000 })
    a.flush()
    expect(save).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test -- useAutosave`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/src/store/useAutosave.ts`:

```ts
/**
 * Autosave: debounce store mutations and write the canvas to disk via IPC. MAIN is the
 * atomic writer (Approach A). Only saves while a project is open; flushes immediately on
 * window blur + beforeunload so at most ~1s of edits is ever at risk.
 */
import { useEffect } from 'react'
import { useCanvasStore } from './canvasStore'

type ProjectStatus = 'welcome' | 'loading' | 'open' | 'error'

interface AutosaverOpts {
  save: () => Promise<boolean>
  getStatus: () => ProjectStatus
  delayMs?: number
}

export interface Autosaver {
  schedule: () => void
  flush: () => void
  cancel: () => void
}

/** Pure debounce+gate engine (no React) — unit-tested directly. */
export function createAutosaver(opts: AutosaverOpts): Autosaver {
  const delay = opts.delayMs ?? 1000
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false

  const run = (): void => {
    timer = null
    if (!dirty || opts.getStatus() !== 'open') return
    dirty = false
    void opts.save()
  }
  return {
    schedule: () => {
      dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, delay)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      run()
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      dirty = false
    }
  }
}

/** React hook: arms autosave against the canvas store + window lifecycle. */
export function useAutosave(): void {
  useEffect(() => {
    const saver = createAutosaver({
      save: async () => window.api.project.save(useCanvasStore.getState().toObject()),
      getStatus: () => useCanvasStore.getState().project.status
    })

    // Save when boards or camera change (skip pure selection/tool churn).
    let prevBoards = useCanvasStore.getState().boards
    let prevViewport = useCanvasStore.getState().viewport
    const unsub = useCanvasStore.subscribe((s) => {
      if (s.boards !== prevBoards || s.viewport !== prevViewport) {
        prevBoards = s.boards
        prevViewport = s.viewport
        saver.schedule()
      }
    })

    const onBlur = (): void => saver.flush()
    const onUnload = (): void => saver.flush()
    window.addEventListener('blur', onBlur)
    window.addEventListener('beforeunload', onUnload)

    return () => {
      saver.flush()
      saver.cancel()
      unsub()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- useAutosave`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/useAutosave.ts src/renderer/src/store/useAutosave.test.ts
git commit -m "feat(store): useAutosave — debounced save + flush on blur/beforeunload"
```

---

### Task 8: RENDERER — `project` slice + dispose-on-switch seam

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

> Adds project lifecycle state + actions to the store. The actions call IPC then `loadObject`. `disposeLiveResources` tears down native previews + PTYs via the existing preload APIs before a switch.

- [ ] **Step 1: Write failing tests**

Append to `src/renderer/src/store/canvasStore.test.ts`:

```ts
describe('canvasStore — project lifecycle', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      boards: [],
      viewport: null,
      selectedId: null,
      past: [],
      future: [],
      project: { dir: null, name: null, status: 'welcome' }
    })
  })

  it('defaults to welcome status', () => {
    expect(useCanvasStore.getState().project.status).toBe('welcome')
  })

  it('applyOpenResult(ok) loads the doc and marks open', () => {
    useCanvasStore.getState().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: { schemaVersion: 2, viewport: { x: 1, y: 2, zoom: 1 }, boards: [] }
    })
    const s = useCanvasStore.getState()
    expect(s.project).toEqual({ dir: 'C:/p', name: 'p', status: 'open' })
    expect(s.viewport).toEqual({ x: 1, y: 2, zoom: 1 })
  })

  it('applyOpenResult(error) sets error status without clobbering boards', () => {
    useCanvasStore.setState({ boards: [{ id: 'x', type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }] as never })
    useCanvasStore.getState().applyOpenResult({ ok: false, error: 'bad' })
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    expect(s.project.error).toBe('bad')
    expect(s.boards).toHaveLength(1) // untouched
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test -- canvasStore`
Expected: FAIL — `project` undefined; `applyOpenResult` not a function.

- [ ] **Step 3: Implement**

In `src/renderer/src/store/canvasStore.ts`:

Add types above `CanvasState` (~line 26):
```ts
export type ProjectStatus = 'welcome' | 'loading' | 'open' | 'error'
export interface ProjectState {
  dir: string | null
  name: string | null
  status: ProjectStatus
  error?: string
}
/** Result of a project open/create IPC call (mirrors preload `ProjectResult`). */
export type OpenResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }
```

Add to `CanvasState` (after `viewport`):
```ts
  /** Current project lifecycle (welcome/loading/open/error). */
  project: ProjectState
  /** Apply an open/create IPC result: load on ok, set error otherwise (no clobber). */
  applyOpenResult: (r: OpenResult) => void
  /** Mark the project as loading (suppresses autosave mid-switch). */
  setProjectLoading: () => void
```

Add to the initial state (after `viewport: null,`):
```ts
  project: { dir: null, name: null, status: 'welcome' },
```

Add the implementations (after `loadObject`, before the closing `}))`):
```ts
  ,
  setProjectLoading: () => set((s) => ({ project: { ...s.project, status: 'loading' } })),
  applyOpenResult: (r) => {
    if (!r.ok) {
      set((s) => ({ project: { ...s.project, status: 'error', error: r.error } }))
      return
    }
    const d = fromObject(r.doc)
    set({
      boards: d.boards,
      viewport: d.viewport,
      selectedId: null,
      past: [],
      future: [],
      project: { dir: r.dir, name: r.name, status: 'open' }
    })
  }
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- canvasStore`
Expected: PASS.

- [ ] **Step 5: Create the dispose seam**

Create `src/renderer/src/store/disposeLiveResources.ts`:

```ts
/**
 * Tear down all live native resources before a project switch: close every preview
 * WebContentsView and kill every Terminal PTY tree. Without this, switching projects
 * leaks renderers + orphans node-pty child trees. Idempotent / best-effort.
 */
import { useCanvasStore } from './canvasStore'

export async function disposeLiveResources(): Promise<void> {
  const boards = useCanvasStore.getState().boards
  // Close all preview views in one shot (cheaper than per-id).
  await window.api.closeAllPreviews().catch(() => false)
  // Kill each terminal's PTY tree.
  await Promise.all(
    boards
      .filter((b) => b.type === 'terminal')
      .map((b) => window.api.killTerminal(b.id).catch(() => false))
  )
}
```

- [ ] **Step 6: Typecheck + full test**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts src/renderer/src/store/disposeLiveResources.ts
git commit -m "feat(store): project lifecycle slice (applyOpenResult) + disposeLiveResources seam"
```

---

### Task 9: RENDERER — camera capture + apply in `Canvas.tsx`

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

> Capture the live camera into the store (throttled via the existing rAF/viewport machinery) and apply a stored viewport on load. Reuses `useOnViewportChange` + `useReactFlow` already imported in this file.

- [ ] **Step 1: Read the current camera wiring**

Run: `grep -n "useOnViewportChange\|useReactFlow\|const rf\|setViewport\|fitView" src/renderer/src/canvas/Canvas.tsx`
Confirm `rf` (from `useReactFlow()`) and `useOnViewportChange` are available. (They are — used for the preview pump and Focus.)

- [ ] **Step 2: Capture the camera into the store**

In `Canvas.tsx`, add the store selector near the other store reads:
```ts
const setViewport = useCanvasStore((s) => s.setViewport)
```

Add a viewport-change subscription (alongside the existing `useOnViewportChange` usage — if one already exists, add `setViewport(vp)` into its callback; otherwise add):
```ts
useOnViewportChange({
  onChange: (vp) => setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom })
})
```
> `onChange` already fires on the rAF-coalesced camera updates React Flow emits — no new pump. Writing to the untracked `setViewport` won't pollute undo history.

- [ ] **Step 3: Apply a stored viewport on load**

Add an effect that runs when the project becomes `open`, applying the stored camera or fitting:
```ts
const projectStatus = useCanvasStore((s) => s.project.status)
useEffect(() => {
  if (projectStatus !== 'open') return
  const vp = useCanvasStore.getState().viewport
  if (vp) void rf.setViewport(vp)
  else void rf.fitView(FIT_OPTIONS)
  // Run once per open (status flips welcome/loading → open on each project load).
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [projectStatus, rf])
```
> `FIT_OPTIONS` is the existing fit config in this file. If the ReactFlow element already has the `fitView` prop, that handles the very first empty mount; this effect handles loaded projects + switches.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: PASS (the one `exhaustive-deps` disable is intentional + commented).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(canvas): capture camera into store + restore stored viewport on project load"
```

---

### Task 10: RENDERER — `WelcomeScreen` + boot wiring in `App.tsx`

**Files:**
- Create: `src/renderer/src/canvas/WelcomeScreen.tsx`
- Modify: `src/renderer/src/App.tsx`

> On boot, `project.current()` decides: load the last project, or show the welcome screen. The welcome screen offers Create / Open + a recent list. Autosave is armed only here (after a project is open).

- [ ] **Step 1: Implement the welcome screen**

Create `src/renderer/src/canvas/WelcomeScreen.tsx`:

```tsx
/**
 * Welcome / project-picker screen — shown when no project is open (status welcome|error).
 * Create a project (pick a folder + name = folder basename), open an existing folder, or
 * pick from the recent list. On success the store flips to `open` and the canvas mounts.
 */
import { useEffect, useState } from 'react'
import { useCanvasStore } from '../store/useStoreShims' // see note
import type { RecentProject } from '../../../preload'

export default function WelcomeScreen(): React.ReactElement {
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)
  const setProjectLoading = useCanvasStore((s) => s.setProjectLoading)
  const error = useCanvasStore((s) => s.project.error)
  const [recents, setRecents] = useState<RecentProject[]>([])

  useEffect(() => {
    void window.api.project.recents().then(setRecents)
  }, [])

  const openDir = async (dir: string): Promise<void> => {
    setProjectLoading()
    applyOpenResult(await window.api.project.open(dir))
  }

  const onOpen = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (dir) await openDir(dir)
  }

  const onCreate = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (!dir) return
    setProjectLoading()
    const name = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || dir
    applyOpenResult(await window.api.project.create(dir, name, {}))
  }

  return (
    <div className="welcome">
      <h1>Canvas ADE</h1>
      {error && <p className="welcome-error">Could not open project: {error}</p>}
      <div className="welcome-actions">
        <button onClick={onCreate}>Create project…</button>
        <button onClick={onOpen}>Open folder…</button>
      </div>
      {recents.length > 0 && (
        <ul className="welcome-recents">
          {recents.map((r) => (
            <li key={r.path}>
              <button onClick={() => openDir(r.path)} title={r.path}>
                <span className="recent-name">{r.name}</span>
                <span className="recent-path">{r.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

> **Import note:** import `useCanvasStore` from `'../store/canvasStore'` (the shim path above is illustrative — use the real path). Import `RecentProject` from the preload types via the path your tsconfig allows; if the relative `../../../preload` import is awkward, re-export `RecentProject` from `canvasStore.ts` (it already declares the matching `OpenResult`) and import it from there instead.

- [ ] **Step 2: Add minimal welcome styles**

In `src/renderer/src/index.css`, append (match existing dark tokens — neutral surfaces, one blue accent `#4f8cff`):
```css
.welcome {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: var(--bg, #0a0a0b);
  color: #e6e6e6;
  font: 14px/1.5 system-ui, sans-serif;
}
.welcome h1 { font-size: 22px; font-weight: 600; margin: 0; }
.welcome-error { color: #ff6b6b; }
.welcome-actions { display: flex; gap: 12px; }
.welcome-actions button {
  padding: 8px 16px; border-radius: 8px; border: 1px solid #2a2a2e;
  background: #161618; color: #e6e6e6; cursor: pointer;
}
.welcome-actions button:first-child { background: #4f8cff; border-color: #4f8cff; color: #fff; }
.welcome-recents { list-style: none; padding: 0; margin: 0; width: 420px; max-width: 80vw; }
.welcome-recents button {
  width: 100%; text-align: left; display: flex; flex-direction: column;
  padding: 8px 12px; border: 0; background: transparent; color: inherit;
  border-radius: 6px; cursor: pointer;
}
.welcome-recents button:hover { background: #161618; }
.recent-name { font-weight: 500; }
.recent-path { font-size: 12px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **Step 3: Wire boot + gate the canvas in `App.tsx`**

Replace `src/renderer/src/App.tsx`:

```tsx
import { useEffect } from 'react'
import Canvas from './canvas/Canvas'
import WelcomeScreen from './canvas/WelcomeScreen'
import { useRendererSmoke } from './smoke/useRendererSmoke'
import { useCanvasStore } from './store/canvasStore'
import { useAutosave } from './store/useAutosave'

/**
 * App root. On boot, ask MAIN for the most-recent project (auto-reopen); fall back to
 * the welcome screen. The canvas mounts only when a project is open; autosave is armed
 * globally and self-gates on project status.
 */
function App(): React.ReactElement {
  useRendererSmoke()
  useAutosave()

  const status = useCanvasStore((s) => s.project.status)
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)

  useEffect(() => {
    void window.api.project.current().then((r) => {
      if (r && r.ok) applyOpenResult(r)
      // null → stay on the welcome screen (initial status is 'welcome').
    })
  }, [applyOpenResult])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {status === 'open' ? <Canvas /> : <WelcomeScreen />}
    </div>
  )
}

export default App
```

> **Smoke/e2e guard:** the `CANVAS_SMOKE=e2e` harness seeds boards directly into the store and never opens a project. To keep it green, the e2e harness must set `project.status` to `'open'` (or seed a project) before asserting. In `src/renderer/src/smoke/e2eHooks.ts` (or wherever the harness seeds the store), set `useCanvasStore.setState({ project: { dir: null, name: 'e2e', status: 'open' } })` as part of seeding. Verify this in Task 13's build run.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Manual verify**

Run: `pnpm dev`
Expected: First launch (no recents) → welcome screen with Create / Open. Click Create → pick a folder → canvas mounts, `canvas.json` appears in the folder. Quit + relaunch → auto-reopens that project.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/WelcomeScreen.tsx src/renderer/src/App.tsx src/renderer/src/index.css src/renderer/src/smoke/e2eHooks.ts
git commit -m "feat(renderer): welcome screen + boot auto-reopen; arm autosave; gate canvas on project open"
```

---

### Task 11: RENDERER — project switcher in `AppChrome`

**Files:**
- Modify: `src/renderer/src/canvas/AppChrome.tsx`
- Modify: `src/renderer/src/index.css`

> Wire the existing top-left project-switcher placeholder to a dropdown: shows the current project name; lets the user open a recent, open a folder, or create. On switch: flush-save → dispose live resources → load. Switching sets status to `loading` so autosave is suppressed mid-swap.

- [ ] **Step 1: Locate the placeholder**

Run: `grep -n "project\|switcher\|top-left\|placeholder" src/renderer/src/canvas/AppChrome.tsx`
Identify the top-left cluster element to replace with the switcher.

- [ ] **Step 2: Implement the switcher**

Add to `AppChrome.tsx` (a self-contained component within the file, or a small new component imported into the top-left slot):

```tsx
import { useState } from 'react'
import { useCanvasStore } from '../store/useStoreShims' // use real path '../store/canvasStore'
import { disposeLiveResources } from '../store/disposeLiveResources'
import type { RecentProject } from '../../../preload' // or re-exported from canvasStore

function ProjectSwitcher(): React.ReactElement {
  const name = useCanvasStore((s) => s.project.name)
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)
  const setProjectLoading = useCanvasStore((s) => s.setProjectLoading)
  const toObject = useCanvasStore((s) => s.toObject)
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])

  const toggle = async (): Promise<void> => {
    if (!open) setRecents(await window.api.project.recents())
    setOpen((v) => !v)
  }

  const switchTo = async (load: () => Promise<unknown>): Promise<void> => {
    setOpen(false)
    // 1. Flush the current project to disk before tearing it down.
    await window.api.project.save(toObject())
    // 2. Suppress autosave + dispose native views/PTYs.
    setProjectLoading()
    await disposeLiveResources()
    // 3. Load the new project.
    applyOpenResult((await load()) as Parameters<typeof applyOpenResult>[0])
  }

  const openRecent = (dir: string): Promise<void> =>
    switchTo(() => window.api.project.open(dir))
  const openFolder = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (dir) await switchTo(() => window.api.project.open(dir))
    else setOpen(false)
  }
  const createNew = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (!dir) return setOpen(false)
    const pname = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || dir
    await switchTo(() => window.api.project.create(dir, pname, {}))
  }

  return (
    <div className="project-switcher">
      <button className="project-switcher-trigger" onClick={toggle} title="Switch project">
        {name ?? 'Project'} ▾
      </button>
      {open && (
        <div className="project-switcher-menu" role="menu">
          {recents.map((r) => (
            <button key={r.path} onClick={() => openRecent(r.path)} title={r.path}>
              {r.name}
            </button>
          ))}
          <div className="project-switcher-divider" />
          <button onClick={openFolder}>Open folder…</button>
          <button onClick={createNew}>Create project…</button>
        </div>
      )}
    </div>
  )
}
```

Place `<ProjectSwitcher />` into the existing top-left slot (replacing the placeholder markup).

- [ ] **Step 3: Add switcher styles**

Append to `src/renderer/src/index.css`:
```css
.project-switcher { position: relative; }
.project-switcher-trigger {
  padding: 6px 10px; border-radius: 6px; border: 1px solid #2a2a2e;
  background: #161618; color: #e6e6e6; font-size: 13px; cursor: pointer;
}
.project-switcher-menu {
  position: absolute; top: 100%; left: 0; margin-top: 6px; min-width: 220px;
  background: #161618; border: 1px solid #2a2a2e; border-radius: 8px; padding: 4px;
  display: flex; flex-direction: column; z-index: 50;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.project-switcher-menu button {
  text-align: left; padding: 7px 10px; border: 0; background: transparent;
  color: #e6e6e6; border-radius: 5px; cursor: pointer; font-size: 13px;
}
.project-switcher-menu button:hover { background: #222226; }
.project-switcher-divider { height: 1px; background: #2a2a2e; margin: 4px 0; }
```

- [ ] **Step 4: Typecheck + build + lint**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 5: Manual verify**

Run: `pnpm dev`
Open a project, add a board. Open the switcher → Create a second project. Confirm: first project's `canvas.json` updated (flush-save), canvas resets to the new project, no orphaned preview/terminal from the first. Switch back via the recent list → first project's boards return.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/AppChrome.tsx src/renderer/src/index.css
git commit -m "feat(chrome): project switcher — flush-save + dispose live resources + load on switch"
```

---

### Task 12: RENDERER — Terminal cwd defaults to the project folder

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts` (add a `projectDir` selector — already present as `project.dir`)
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

> A restored/new Terminal board with no explicit `cwd` should spawn in the project folder, not `os.homedir()`. Thread `project.dir` into the two `spawnTerminal` calls. No `pty.ts` change — it already does `cwd: opts.cwd || os.homedir()`.

- [ ] **Step 1: Read the spawn callsites**

Run: `grep -n "spawnTerminal\|board.cwd" src/renderer/src/canvas/boards/TerminalBoard.tsx`
Confirm two `spawnTerminal({ ... cwd: board.cwd ... })` callsites (~lines 203 and 327).

- [ ] **Step 2: Read the project dir + pass it as the cwd fallback**

In `TerminalBoard.tsx`, add the store read near the top of the component (next to other `useCanvasStore` reads):
```ts
const projectDir = useCanvasStore((s) => s.project.dir)
```

At BOTH `spawnTerminal` callsites, change:
```ts
cwd: board.cwd,
```
to:
```ts
cwd: board.cwd ?? projectDir ?? undefined,
```

Add `projectDir` to BOTH `useCallback`/`useEffect` dependency arrays that wrap these spawns (the arrays at ~line 223 and ~line 402). Example for the first:
```ts
}, [board.id, board.shell, board.cwd, board.launchCommand, projectDir])
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS (no react-hooks/exhaustive-deps warning — `projectDir` is now in deps).

- [ ] **Step 4: Manual verify**

Run: `pnpm dev`
Open a project, add a Terminal board, Run. In the shell type `pwd` (or `cd` on Windows pwsh) → it reports the project folder, not your home dir.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): default new-board cwd to the open project folder"
```

---

### Task 13: Reopen-fidelity integration test + e2e harness guard

**Files:**
- Create: `src/renderer/src/store/persistence.integration.test.ts`
- Verify: `src/renderer/src/smoke/e2eHooks.ts` (the Task 10 status guard)

> The roadmap ✅📏 acceptance: seed all 3 board types + planning elements + camera → serialize → deserialize → identical. This is the in-memory round-trip across the real store, the gap the live harness can't cover.

- [ ] **Step 1: Write the integration test**

Create `src/renderer/src/store/persistence.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import type { Board } from '../lib/boardSchema'

const seed: Board[] = [
  { id: 't1', type: 'terminal', x: 0, y: 0, w: 420, h: 340, title: 'T', shell: 'pwsh', launchCommand: 'claude', cwd: 'C:/x', port: 5180 },
  { id: 'b1', type: 'browser', x: 500, y: 0, w: 700, h: 500, title: 'B', url: 'http://localhost:5173', viewport: 'tablet' },
  {
    id: 'p1', type: 'planning', x: 0, y: 400, w: 516, h: 366, title: 'P',
    elements: [
      { id: 'n1', kind: 'note', x: 10, y: 10, w: 160, h: 120, text: 'hi', tint: 'yellow' },
      { id: 'c1', kind: 'checklist', x: 200, y: 10, w: 240, h: 0, title: 'Tasks', items: [{ id: 'i1', label: 'a', done: true }] },
      { id: 'a1', kind: 'arrow', x: 0, y: 0, x2: 50, y2: 60 },
      { id: 's1', kind: 'stroke', x: 0, y: 0, points: [0, 0, 1, 1, 2, 2] },
      { id: 'tx', kind: 'text', x: 5, y: 5, text: 'label' }
    ]
  }
]

describe('persistence — full reopen fidelity', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], viewport: null, selectedId: null, past: [], future: [] })
  })

  it('boards + planning elements + camera survive a serialize→deserialize cycle', () => {
    useCanvasStore.setState({ boards: seed })
    useCanvasStore.getState().setViewport({ x: -300, y: 120, zoom: 0.85 })

    // Simulate writing to disk and reading back (what canvas.json does).
    const onDisk = JSON.parse(JSON.stringify(useCanvasStore.getState().toObject()))

    // Wipe + reload as if reopening the app.
    useCanvasStore.setState({ boards: [], viewport: null })
    useCanvasStore.getState().loadObject(onDisk)

    const s = useCanvasStore.getState()
    expect(s.boards).toEqual(seed)
    expect(s.viewport).toEqual({ x: -300, y: 120, zoom: 0.85 })
  })

  it('loaded boards do not alias the on-disk object (BUG-027)', () => {
    useCanvasStore.setState({ boards: seed })
    const onDisk = useCanvasStore.getState().toObject()
    useCanvasStore.getState().loadObject(onDisk)
    expect(useCanvasStore.getState().boards).not.toBe(onDisk.boards)
  })
})
```

- [ ] **Step 2: Run, verify pass**

Run: `pnpm test -- persistence.integration`
Expected: PASS. (If `toEqual(seed)` fails on `w`/`h`, check the MIN_BOARD_SIZE clamp — all seed sizes are ≥ MIN, so it should match exactly; the checklist `h:0` is exempt from the clamp only via the validator, but `fromObject` clamps `b.h = max(MIN.h, b.h)` on BOARD h, not element h — element h:0 is preserved. Confirm the seed planning board `h:366` ≥ MIN.)

- [ ] **Step 3: Verify the e2e harness still boots green**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_DONE` markers, exit 0. If it hangs on the welcome screen, confirm the Task 10 guard set `project.status='open'` in the harness seed. Fix if needed, then re-run.

- [ ] **Step 4: Full green sweep**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
Expected: ALL PASS. (Run `pnpm format` first if `format:check` flags the new files.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/persistence.integration.test.ts
git commit -m "test(persistence): full reopen fidelity — boards + elements + camera round-trip"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` — all green.
- [ ] `pnpm dev` manual run of the spec's data flows:
  - Boot with no recents → welcome; Create → canvas + `canvas.json` written.
  - Add boards of each type, pan/zoom, edit a checklist → quit → relaunch → everything (incl. camera) restored; terminals idle (no auto-spawn), browser reconnects URL.
  - Corrupt `canvas.json` by hand (break the JSON) → relaunch → loads from `.bak` (or welcome+error if both broken), original NOT clobbered.
  - Switch projects via the switcher → first project flush-saved, no orphaned previews/PTYs, second loads.
- [ ] Update `CLAUDE.md` **Status** line + roadmap (mark Phase 3 persistence slice landed) in a final docs commit.
- [ ] Open a PR from `phase-3-persistence` → `main`.

## Out of scope (later Phase 3 slices)

Focus/Full view, Duplicate, git worktrees + git-init wiring + per-board ports, agentic session resume. The `gitInit` create-dialog toggle is intentionally inert this slice.

## Self-review notes (addressed)

- **Spec coverage:** schema v2 (T1) · store viewport (T2) · recents (T3) · projectStore + .bak (T4) · IPC (T5) · preload (T6) · autosave (T7) · project slice + dispose seam (T8) · camera capture/restore (T9) · welcome + boot (T10) · switcher (T11) · terminal cwd (T12) · reopen fidelity + BUG-027 (T13). All spec sections mapped.
- **Type consistency:** `CanvasViewport`, `CanvasDoc {schemaVersion, viewport, boards}`, `ProjectResult`/`OpenResult` ({ok,dir,name,doc}), `RecentProject {path,name,lastOpenedAt}`, `ProjectStatus` used identically across tasks.
- **Known soft spots flagged inline:** the `WelcomeScreen`/`ProjectSwitcher` `RecentProject` import path (re-export from `canvasStore` if the relative preload path is awkward); the e2e harness status guard (T10/T13); `@types/write-file-atomic` may be needed (T4).
