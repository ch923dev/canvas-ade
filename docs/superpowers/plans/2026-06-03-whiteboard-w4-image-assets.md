# Whiteboard W4 — Image element + assets pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste or drag-drop a screenshot onto a Planning board as a first-class `image` element, backed by a real `<projectDir>/assets/<sha1>.<ext>` blob pipeline (relative path stored, never base64).

**Architecture:** Renderer extracts the image Blob → `window.api.asset.write(bytes, ext)` → MAIN content-addresses + dedups on disk → element stores the relative path. ImageCard loads via `asset:read`→bytes→`URL.createObjectURL` (CSP already allows `blob:`). GC is mark-and-sweep, MAIN-side, at project open only (undo-safe — bytes never deleted mid-session). Image rides existing W2/W3 machinery (bbox/marquee/snap/align/lock/group/duplicate) via `elementBBox`.

**Tech Stack:** Electron 33 (MAIN: `crypto` sha1 + `write-file-atomic`), React 18 / TypeScript, Zustand store, vitest (`.test.ts`=node, `.test.tsx`=jsdom + `@testing-library/react`), `CANVAS_SMOKE=e2e` in-process harness.

**Worktree:** `Z:\canvas-ade-whiteboard-w4` (branch `feat/whiteboard-w4`). Run all commands with `-C` (never `cd`): e.g. `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run <file>`, `git -C "Z:\canvas-ade-whiteboard-w4" ...`.

**Spec:** `docs/superpowers/specs/2026-06-03-whiteboard-w4-image-assets-design.md`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/renderer/src/lib/boardSchema.ts` | `ImageElement` type + union; `SCHEMA_VERSION=4`; `MIGRATIONS[3]`; `assertPlanningElement` image case | Modify |
| `src/renderer/src/lib/boardSchema.test.ts` | migration + validation round-trip | Modify |
| `src/renderer/src/canvas/boards/planning/elements.ts` | `IMAGE_MAX`, `fitImageSize`, `makeImage`, `elementBBox` image case | Modify |
| `src/renderer/src/canvas/boards/planning/elements.test.ts` | factory/fit/bbox/shift coverage | Modify |
| `src/main/projectStore.ts` | `writeAsset`/`readAsset`/`collectAssetIds`/`gcAssets` | Modify |
| `src/main/projectStore.test.ts` | asset write/read/dedup/gc | Modify |
| `src/main/projectIpc.ts` | `asset:write`/`asset:read` handlers + GC hook in `project:open`/`project:current` | Modify |
| `src/main/projectIpc.test.ts` | (only if a unit seam fits; otherwise covered by e2e) | Maybe |
| `src/preload/index.ts` | `api.asset.{write,read}` (types flow via `CanvasApi`; `index.d.ts` unchanged) | Modify |
| `src/renderer/src/canvas/boards/planning/ImageCard.tsx` | image card + `useAssetUrl` hook (object-URL cache) | Create |
| `src/renderer/src/canvas/boards/planning/ImageCard.test.tsx` | renders img / fallback | Create |
| `src/renderer/src/canvas/boards/PlanningBoard.tsx` | `onPaste`/`onDrop`/`onDragOver` + `addImageFromBlob` + ImageCard render branch + imports | Modify |
| `src/main/e2e/probes/whiteboard.ts` | `whiteboardPasteImage` probe | Modify |
| `src/main/e2e/index.ts` | register probe in PLAYLIST before `seed` | Modify |
| `docs/roadmap-whiteboard.md` | fix STALE W4 schema note + status row | Modify |
| `.claude/coordination/ACTIVE-WORK.md` | refine W4 row (zone + claims v4) | Modify |

---

## Task 1: Schema — ImageElement + v4 migration + validation

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts`
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/lib/boardSchema.test.ts` (match the file's existing import style — it already imports `fromObject`, `migrate`, `SCHEMA_VERSION`, etc.; add any missing names to that import):

```ts
import { describe, it, expect } from 'vitest'
import { fromObject, SCHEMA_VERSION } from './boardSchema'

describe('W4 image element', () => {
  const imageBoard = (assetId: unknown, extra: Record<string, unknown> = {}) => ({
    schemaVersion: SCHEMA_VERSION,
    viewport: null,
    boards: [
      {
        id: 'p1', type: 'planning', x: 0, y: 0, w: 400, h: 300, title: 'P',
        elements: [{ id: 'i1', kind: 'image', x: 10, y: 20, w: 120, h: 90, assetId, ...extra }]
      }
    ]
  })

  it('SCHEMA_VERSION is 4', () => {
    expect(SCHEMA_VERSION).toBe(4)
  })

  it('round-trips a valid image element', () => {
    const doc = fromObject(imageBoard('assets/' + 'a'.repeat(40) + '.png'))
    const el = (doc.boards[0] as { elements: Array<{ kind: string; assetId: string }> }).elements[0]
    expect(el.kind).toBe('image')
    expect(el.assetId).toBe('assets/' + 'a'.repeat(40) + '.png')
  })

  it('rejects an empty assetId', () => {
    expect(() => fromObject(imageBoard(''))).toThrow(/assetId/)
  })

  it('rejects a non-string assetId', () => {
    expect(() => fromObject(imageBoard(123))).toThrow(/assetId/)
  })

  it('rejects non-positive w/h', () => {
    expect(() => fromObject(imageBoard('assets/x.png', { w: 0 }))).toThrow(/non-positive/)
  })

  it('migrates a v3 doc (with an image element) to v4', () => {
    const v3 = {
      schemaVersion: 3, viewport: null,
      boards: [{
        id: 'p1', type: 'planning', x: 0, y: 0, w: 400, h: 300, title: 'P',
        elements: [{ id: 'i1', kind: 'image', x: 1, y: 2, w: 50, h: 50, assetId: 'assets/y.png' }]
      }]
    }
    const doc = fromObject(v3)
    expect(doc.schemaVersion).toBe(4)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/renderer/src/lib/boardSchema.test.ts`
Expected: FAIL — `SCHEMA_VERSION` is 3, and the image element is rejected as "unknown kind image".

- [ ] **Step 3: Add the ImageElement type + union member**

In `src/renderer/src/lib/boardSchema.ts`, after the `ChecklistElement` interface (around line 106) add:

```ts
export interface ImageElement extends ElementCommon {
  kind: 'image'
  /** Display box (board-local px). */
  w: number
  h: number
  /** Relative POSIX path to the blob: `assets/<sha1>.<ext>` (never a base64 data URL). */
  assetId: string
}
```

Add `ImageElement` to the `PlanningElement` union:

```ts
export type PlanningElement =
  | NoteElement
  | TextElement
  | ArrowElement
  | StrokeElement
  | ChecklistElement
  | ImageElement
```

- [ ] **Step 4: Bump the version + add the migration**

Change `export const SCHEMA_VERSION = 3` to `4`. In `MIGRATIONS`, add the `3` key:

```ts
const MIGRATIONS: Record<number, Migration> = {
  1: (doc) => ({ ...doc, schemaVersion: 2, viewport: (doc as CanvasDoc).viewport ?? null }),
  2: (doc) => ({ ...doc, schemaVersion: 3 }),
  // v4 adds the OPTIONAL image element (W4). assetId lives only on new image elements,
  // so there is nothing to backfill — the migration only bumps the version.
  3: (doc) => ({ ...doc, schemaVersion: 4 })
}
```

- [ ] **Step 5: Validate the image kind**

In `assertPlanningElement`, add a `case` before `default:`:

```ts
    case 'image':
      if (!isPositiveNum(el.w) || !isPositiveNum(el.h)) fail('image element has non-positive w/h')
      if (typeof el.assetId !== 'string' || el.assetId.length === 0) {
        fail('image element has an empty/non-string assetId')
      }
      return
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/renderer/src/lib/boardSchema.test.ts`
Expected: PASS (all W4 cases green; existing schema tests still green).

- [ ] **Step 7: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
feat(schema): ImageElement + v3->v4 migration (W4)

Adds the 'image' planning element (kind/w/h/assetId), bumps
SCHEMA_VERSION to 4 with an additive no-op MIGRATIONS[3], and a deep
validation case (positive w/h, non-empty string assetId).
EOF
```

---

## Task 2: Element factory + transforms (`elements.ts`)

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/elements.ts`
- Test: `src/renderer/src/canvas/boards/planning/elements.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/src/canvas/boards/planning/elements.test.ts`:

```ts
import { makeImage, fitImageSize, elementBBox, shiftElement } from './elements'
import type { ImageElement } from '../../../lib/boardSchema'

describe('W4 image helpers', () => {
  it('fitImageSize scales down to the max longest side, preserving aspect', () => {
    expect(fitImageSize(720, 360, 360)).toEqual({ w: 360, h: 180 })
  })
  it('fitImageSize does not upscale a small image', () => {
    expect(fitImageSize(100, 50, 360)).toEqual({ w: 100, h: 50 })
  })
  it('fitImageSize floors degenerate input to a square', () => {
    expect(fitImageSize(0, 0, 360)).toEqual({ w: 360, h: 360 })
  })
  it('makeImage centers the box on the point', () => {
    const el = makeImage('i1', { x: 200, y: 100 }, 'assets/a.png', 120, 80)
    expect(el).toMatchObject({ id: 'i1', kind: 'image', x: 140, y: 60, w: 120, h: 80, assetId: 'assets/a.png' })
  })
  it('elementBBox returns the image box', () => {
    const el: ImageElement = { id: 'i1', kind: 'image', x: 5, y: 6, w: 30, h: 40, assetId: 'assets/a.png' }
    expect(elementBBox(el)).toEqual({ x: 5, y: 6, w: 30, h: 40 })
  })
  it('shiftElement translates an image by the top-left (default branch)', () => {
    const el: ImageElement = { id: 'i1', kind: 'image', x: 5, y: 6, w: 30, h: 40, assetId: 'assets/a.png' }
    expect(shiftElement(el, 10, -3)).toMatchObject({ x: 15, y: 3, w: 30, h: 40 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: FAIL — `makeImage`/`fitImageSize` are not exported; `elementBBox` has no `image` case (TS non-exhaustive switch may also surface).

- [ ] **Step 3: Add the import + factory + fit helper**

In `elements.ts`, add `ImageElement` to the type import from `'../../../lib/boardSchema'`. Then add near the other factories:

```ts
/** Max longest-side (board-local px) a pasted/dropped image is fit to. */
export const IMAGE_MAX = 360

/** Scale natural dimensions to fit `max` on the longest side (never upscale); floor 16. */
export function fitImageSize(natW: number, natH: number, max = IMAGE_MAX): { w: number; h: number } {
  if (!(natW > 0) || !(natH > 0)) return { w: max, h: max }
  const scale = Math.min(1, max / Math.max(natW, natH))
  return { w: Math.max(16, Math.round(natW * scale)), h: Math.max(16, Math.round(natH * scale)) }
}

/** A new image element centred on the drop/paste point (top-left like a note). */
export function makeImage(
  id: string,
  at: { x: number; y: number },
  assetId: string,
  w: number,
  h: number
): ImageElement {
  return { id, kind: 'image', x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h, assetId }
}
```

- [ ] **Step 4: Add the `elementBBox` image case**

In `elementBBox`'s `switch (el.kind)`, add (mirrors the `note` case):

```ts
    case 'image':
      return { x: el.x, y: el.y, w: el.w, h: el.h }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/renderer/src/canvas/boards/planning/elements.ts src/renderer/src/canvas/boards/planning/elements.test.ts
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
feat(planning): makeImage + fitImageSize + elementBBox image case (W4)

Image is top-left like a note, so shiftElement/translateElement need no
change (default branch). elementBBox gains the image case so marquee /
snap / align / duplicate all pick it up for free.
EOF
```

---

## Task 3: MAIN assets pipeline (`projectStore.ts`)

**Files:**
- Modify: `src/main/projectStore.ts`
- Test: `src/main/projectStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/projectStore.test.ts` (it already tests `readProject`/`writeProject` against a temp dir — reuse that `mkdtempSync` pattern):

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeAsset, readAsset, collectAssetIds, gcAssets } from './projectStore'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'w4-store-'))
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s))

describe('W4 assets pipeline', () => {
  it('writeAsset content-addresses + dedups identical bytes', async () => {
    const dir = tmp()
    try {
      const a = await writeAsset(dir, bytes('hello'), 'png')
      const b = await writeAsset(dir, bytes('hello'), 'png')
      expect(a.assetId).toBe(b.assetId)
      expect(a.assetId).toMatch(/^assets\/[a-f0-9]{40}\.png$/)
      expect(readdirSync(join(dir, 'assets'))).toHaveLength(1)
      expect(existsSync(join(dir, a.assetId))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writeAsset rejects an unsupported ext', async () => {
    const dir = tmp()
    try {
      await expect(writeAsset(dir, bytes('x'), 'exe')).rejects.toThrow(/ext/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readAsset returns bytes, null on missing, null on traversal', async () => {
    const dir = tmp()
    try {
      const { assetId } = await writeAsset(dir, bytes('data'), 'png')
      expect(readAsset(dir, assetId)).toEqual(bytes('data'))
      expect(readAsset(dir, 'assets/' + 'f'.repeat(40) + '.png')).toBeNull()
      expect(readAsset(dir, '../secret')).toBeNull()
      expect(readAsset(dir, 'assets/../../etc/passwd')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('collectAssetIds walks planning image elements across boards', () => {
    const doc = {
      schemaVersion: 4, viewport: null,
      boards: [
        { id: 'p1', type: 'planning', elements: [
          { id: 'i1', kind: 'image', assetId: 'assets/a.png' },
          { id: 'n1', kind: 'note', text: '' }
        ] },
        { id: 't1', type: 'terminal' },
        { id: 'p2', type: 'planning', elements: [{ id: 'i2', kind: 'image', assetId: 'assets/b.png' }] }
      ]
    }
    expect(collectAssetIds(doc)).toEqual(new Set(['assets/a.png', 'assets/b.png']))
  })

  it('gcAssets deletes orphans, keeps referenced, no-ops on absent assets/', async () => {
    const dir = tmp()
    try {
      const keep = await writeAsset(dir, bytes('keep'), 'png')
      const drop = await writeAsset(dir, bytes('drop'), 'png')
      gcAssets(dir, new Set([keep.assetId]))
      expect(existsSync(join(dir, keep.assetId))).toBe(true)
      expect(existsSync(join(dir, drop.assetId))).toBe(false)
      const empty = tmp()
      try {
        expect(() => gcAssets(empty, new Set())).not.toThrow()
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/main/projectStore.test.ts`
Expected: FAIL — the four `writeAsset`/`readAsset`/`collectAssetIds`/`gcAssets` exports do not exist.

- [ ] **Step 3: Implement the pipeline**

In `src/main/projectStore.ts`, extend the `fs` import and add `crypto`:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
```

Add at the end of the file:

```ts
// ── W4 assets pipeline ──────────────────────────────────────────────────────────
const ASSETS = 'assets'
/** A safe stored assetId: exactly `assets/<40-hex sha1>.<ext>`; blocks any traversal. */
const ASSET_RE = /^assets[/\\][a-f0-9]{40}\.[a-z0-9]+$/
const ASSET_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

/**
 * Content-address `bytes` (sha1) into `<dir>/assets/<sha1>.<ext>` and return the
 * RELATIVE POSIX path (the stored `assetId`). Dedups: identical bytes → identical
 * path; the write is skipped when the file already exists.
 */
export async function writeAsset(
  dir: string,
  bytes: Uint8Array,
  ext: string
): Promise<{ assetId: string }> {
  const e = String(ext).toLowerCase()
  if (!ASSET_EXTS.has(e)) throw new Error(`writeAsset: unsupported ext ${ext}`)
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  const assetId = `${ASSETS}/${sha1}.${e}`
  const abs = join(dir, ASSETS, `${sha1}.${e}`)
  if (!existsSync(abs)) {
    mkdirSync(join(dir, ASSETS), { recursive: true })
    await writeFileAtomic(abs, Buffer.from(bytes))
  }
  return { assetId }
}

/** Read a stored asset's bytes; null on a malformed assetId, missing file, or read error. */
export function readAsset(dir: string, assetId: string): Uint8Array | null {
  if (typeof assetId !== 'string' || !ASSET_RE.test(assetId)) return null
  const abs = join(dir, assetId)
  if (!existsSync(abs)) return null
  try {
    return new Uint8Array(readFileSync(abs))
  } catch {
    return null
  }
}

/** Every assetId referenced by a doc's planning image elements (version-independent). */
export function collectAssetIds(doc: unknown): Set<string> {
  const ids = new Set<string>()
  const boards = (doc as { boards?: unknown })?.boards
  if (!Array.isArray(boards)) return ids
  for (const b of boards) {
    const els = (b as { elements?: unknown })?.elements
    if (!Array.isArray(els)) continue
    for (const el of els) {
      if (el && (el as { kind?: unknown }).kind === 'image') {
        const a = (el as { assetId?: unknown }).assetId
        if (typeof a === 'string' && a.length > 0) ids.add(a)
      }
    }
  }
  return ids
}

/**
 * Mark-and-sweep: delete every file in `<dir>/assets/` whose `assets/<file>` path is
 * NOT in `referenced`. No-op when `assets/` is absent. Called ONLY at project open —
 * the undo stack is empty across sessions, so a swept blob is truly unreferenced.
 */
export function gcAssets(dir: string, referenced: Set<string>): void {
  const assetsDir = join(dir, ASSETS)
  if (!existsSync(assetsDir)) return
  let files: string[]
  try {
    files = readdirSync(assetsDir)
  } catch {
    return
  }
  for (const f of files) {
    if (!referenced.has(`${ASSETS}/${f}`)) {
      try {
        unlinkSync(join(assetsDir, f))
      } catch {
        /* a locked / already-removed file must not abort the sweep */
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/main/projectStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/main/projectStore.ts src/main/projectStore.test.ts
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
feat(main): assets pipeline — writeAsset/readAsset/collectAssetIds/gcAssets (W4)

Content-addressed sha1 blobs under <dir>/assets/, dedup on hash, strict
relative-path guard on read (no traversal), and a mark-and-sweep GC keyed
off referenced assetIds. GC is open-time only, so it is undo-safe.
EOF
```

---

## Task 4: IPC handlers + open-time GC (`projectIpc.ts`)

**Files:**
- Modify: `src/main/projectIpc.ts`

(No new unit test: the handlers are thin wrappers over Task-3 functions guarded by the existing `isForeignSender`; the behaviour is exercised end-to-end by the Task-8 e2e probe.)

- [ ] **Step 1: Extend the projectStore import**

In `src/main/projectIpc.ts`, add the four functions to the existing `./projectStore` import:

```ts
import {
  readProject,
  writeProject,
  createProject,
  getCurrentDir,
  setCurrentDir,
  projectName,
  writeAsset,
  readAsset,
  collectAssetIds,
  gcAssets,
  type ProjectResult
} from './projectStore'
```

- [ ] **Step 2: Add the asset handlers**

Inside `registerProjectHandlers`, after the `project:current` handler, add:

```ts
  ipcMain.handle(
    'asset:write',
    async (
      e,
      args: { bytes: Uint8Array; ext: string }
    ): Promise<{ assetId: string } | { error: string }> => {
      if (guard(e)) return { error: 'forbidden' }
      const dir = getCurrentDir()
      if (!dir) return { error: 'no project open' }
      try {
        return await writeAsset(dir, args.bytes, args.ext)
      } catch (err) {
        return { error: String((err as Error)?.message ?? err) }
      }
    }
  )

  ipcMain.handle('asset:read', (e, assetId: string): Uint8Array | null => {
    if (guard(e)) return null
    const dir = getCurrentDir()
    if (!dir) return null
    return readAsset(dir, assetId)
  })
```

- [ ] **Step 3: Hook GC into the read paths**

In the `project:open` handler, add the GC sweep before `return r`:

```ts
  ipcMain.handle('project:open', (e, dir: string): ProjectResult => {
    if (guard(e)) return { ok: false, error: 'forbidden' }
    if (isUnsafeProjectDir(dir)) return { ok: false, error: 'invalid path' }
    const r = readProject(dir)
    remember(r)
    if (r.ok) gcAssets(r.dir, collectAssetIds(r.doc))
    return r
  })
```

In the `project:current` handler, add the sweep inside the existing `if (r.ok)` block (after `touchRecent`):

```ts
    if (r.ok) {
      setCurrentDir(r.dir)
      touchRecent(userDataDir, r.dir, projectName(r.dir), now())
      gcAssets(r.dir, collectAssetIds(r.doc))
    }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" typecheck`
Expected: PASS (clean).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/main/projectIpc.ts
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
feat(ipc): asset:write/asset:read + open-time orphan GC (W4)

Frame-guarded handlers over the assets pipeline; project:open and
project:current sweep orphaned blobs (collectAssetIds -> gcAssets) once
the doc is read, which is the only undo-safe moment to GC.
EOF
```

---

## Task 5: Preload surface (`preload/index.ts`)

**Files:**
- Modify: `src/preload/index.ts` (`index.d.ts` needs NO edit — it re-exports `CanvasApi`)

- [ ] **Step 1: Add the asset API**

In the `api` object in `src/preload/index.ts`, after the `project: { ... }` block, add:

```ts
  // ── Phase 3 / W4 assets — write pasted/dropped bytes, read them back as bytes ──
  asset: {
    write: (bytes: Uint8Array, ext: string): Promise<{ assetId: string } | { error: string }> =>
      ipcRenderer.invoke('asset:write', { bytes, ext }),
    read: (assetId: string): Promise<Uint8Array | null> => ipcRenderer.invoke('asset:read', assetId)
  },
```

- [ ] **Step 2: Typecheck the preload**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" typecheck:preload`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/preload/index.ts
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
feat(preload): expose api.asset.{write,read} (W4)

Bytes cross the contextBridge as Uint8Array (structured-clone safe). Types
flow to the renderer via CanvasApi; index.d.ts needs no change.
EOF
```

---

## Task 6: ImageCard + useAssetUrl

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/ImageCard.tsx`
- Test: `src/renderer/src/canvas/boards/planning/ImageCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/canvas/boards/planning/ImageCard.test.tsx`:

```tsx
import { it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { ImageCard } from './ImageCard'
import type { ImageElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const image: ImageElement = {
  id: 'i1', kind: 'image', x: 0, y: 0, w: 120, h: 80, assetId: 'assets/' + 'a'.repeat(40) + '.png'
}

beforeEach(() => {
  // jsdom has no object-URL plumbing — stub it.
  ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:fake')
  ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn()
})

function setApi(read: () => Promise<Uint8Array | null>): void {
  ;(window as unknown as { api: unknown }).api = { asset: { read: vi.fn(read) } }
}

it('renders an <img> with the object URL when bytes load', async () => {
  setApi(async () => new Uint8Array([1, 2, 3]))
  render(<ImageCard image={image} interactive={true} onDragStart={() => {}} />)
  await waitFor(() => {
    const img = document.querySelector('img') as HTMLImageElement | null
    expect(img?.getAttribute('src')).toBe('blob:fake')
  })
})

it('renders a fallback when the asset is missing', async () => {
  setApi(async () => null)
  render(<ImageCard image={image} interactive={true} onDragStart={() => {}} />)
  await waitFor(() => expect(screen.getByText(/missing image/i)).toBeTruthy())
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/renderer/src/canvas/boards/planning/ImageCard.test.tsx`
Expected: FAIL — `./ImageCard` does not exist.

- [ ] **Step 3: Implement ImageCard + useAssetUrl**

Create `src/renderer/src/canvas/boards/planning/ImageCard.tsx`:

```tsx
/**
 * Image element (W4). Renders a pasted/dropped screenshot from the assets/ blob
 * pipeline. Bytes are fetched once via `window.api.asset.read` and wrapped in a
 * `blob:` object URL (CSP allows blob:; we never inline base64). The URL is shared
 * across cards with the same content-addressed assetId and revoked when the last
 * card unmounts. A missing blob (e.g. canvas.json restored from .bak after a sweep)
 * renders a dashed fallback tile rather than a broken <img>.
 *
 * Like NoteCard, the card body is the drag handle in select mode (the well captures
 * the pointer for the move) and falls through to the well in a draw mode so a stroke
 * can start over the image. Deletion is menu/eraser only — NO inline ×.
 */
import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import type { ImageElement } from '../../../lib/boardSchema'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/** assetId → shared object URL + refcount (content-addressed → dedup-shared). */
const assetUrlCache = new Map<string, { url: string; refs: number }>()

/** Resolve an assetId to a blob: URL (null while loading or when the blob is missing). */
function useAssetUrl(assetId: string): string | null {
  const [url, setUrl] = useState<string | null>(() => assetUrlCache.get(assetId)?.url ?? null)
  useEffect(() => {
    let cancelled = false
    const cached = assetUrlCache.get(assetId)
    if (cached) {
      cached.refs++
      setUrl(cached.url)
    } else {
      void window.api.asset
        .read(assetId)
        .then((bytes) => {
          if (cancelled) return
          if (!bytes) {
            setUrl(null)
            return
          }
          const again = assetUrlCache.get(assetId)
          if (again) {
            again.refs++
            setUrl(again.url)
            return
          }
          const ext = assetId.split('.').pop() ?? ''
          const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
          const objUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
          assetUrlCache.set(assetId, { url: objUrl, refs: 1 })
          setUrl(objUrl)
        })
        .catch(() => {
          if (!cancelled) setUrl(null)
        })
    }
    return () => {
      cancelled = true
      const entry = assetUrlCache.get(assetId)
      if (entry) {
        entry.refs--
        if (entry.refs <= 0) {
          URL.revokeObjectURL(entry.url)
          assetUrlCache.delete(assetId)
        }
      }
    }
  }, [assetId])
  return url
}

export interface ImageCardProps {
  image: ImageElement
  /** True when the `select` tool is active (enables drag + selection). */
  interactive: boolean
  /** Begin a board-local drag from a screen pointer-down on the card. */
  onDragStart: (e: ReactPointerEvent, id: string) => void
  /** True when this element is in the board selection set (draws the accent ring). */
  selected?: boolean
  /** Select this element on press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
}

export function ImageCard({
  image,
  interactive,
  onDragStart,
  selected,
  onSelect
}: ImageCardProps): ReactElement {
  const url = useAssetUrl(image.assetId)
  return (
    <div
      className="pl-image"
      style={{
        position: 'absolute',
        left: image.x,
        top: image.y,
        width: image.w,
        height: image.h,
        borderRadius: 'var(--r-inner)',
        overflow: 'hidden',
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
        cursor: interactive ? 'grab' : 'default'
      }}
      onPointerDown={(e) => {
        // In a draw mode let the press fall through to the well (a stroke can start
        // over the image); in select mode this is the drag handle.
        if (!interactive) return
        e.stopPropagation()
        onSelect?.(image.id, e.shiftKey)
        onDragStart(e, image.id)
      }}
    >
      {url ? (
        <img
          src={url}
          draggable={false}
          alt=""
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            pointerEvents: 'none'
          }}
        />
      ) : (
        <div
          className="pl-image-missing"
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed var(--border)',
            borderRadius: 'var(--r-inner)',
            color: 'var(--text-faint)',
            fontFamily: 'var(--ui)',
            fontSize: 11,
            pointerEvents: 'none'
          }}
        >
          missing image
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec vitest run src/renderer/src/canvas/boards/planning/ImageCard.test.tsx`
Expected: PASS (both the img and fallback cases).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/renderer/src/canvas/boards/planning/ImageCard.tsx src/renderer/src/canvas/boards/planning/ImageCard.test.tsx
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
feat(planning): ImageCard + useAssetUrl blob loader (W4)

Loads asset bytes via api.asset.read -> shared, refcounted blob: object
URL (revoked on last unmount); dashed fallback when the blob is missing.
Card body is the select-mode drag handle; no inline delete (W3 rule).
EOF
```

---

## Task 7: PlanningBoard wiring — paste / drop / render

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`

- [ ] **Step 1: Add imports**

Add `ImageElement` to the `boardSchema` type import (the `import type { ... } from '../../lib/boardSchema'` block):

```ts
import type {
  ArrowElement,
  ChecklistElement,
  ImageElement,
  NoteElement,
  PlanningElement,
  PlanningBoard as PlanningBoardData,
  StrokeElement,
  TextElement
} from '../../lib/boardSchema'
```

Add `type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent` to the `react` import block (alongside the existing `type PointerEvent` etc.).

Add `makeImage, fitImageSize, IMAGE_MAX` to the `'./planning/elements'` import.

Add the ImageCard import after the ChecklistCard import:

```ts
import { ImageCard } from './planning/ImageCard'
```

- [ ] **Step 2a: Add the module-scope MIME map**

At module scope (next to `const newId = ...` around line 92, OUTSIDE the component so it is not a
hook dependency), add:

```ts
/** Clipboard/file MIME → the ext the assets pipeline stores (undefined = not an image we accept). */
const imageExt = (type: string): string | undefined =>
  ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg'
  })[type]
```

- [ ] **Step 2b: Add `addImageFromBlob` + the paste/drop handlers**

Inside the `PlanningBoard` component, after the `commit` callback (around line 199), add:

```ts
  /** Persist an image blob and drop an image element at `at` (one undo step). */
  const addImageFromBlob = useCallback(
    async (blob: Blob, at: { x: number; y: number }): Promise<void> => {
      const ext = imageExt(blob.type)
      if (!ext) return
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const res = await window.api.asset.write(bytes, ext)
      if ('error' in res) return
      let w = IMAGE_MAX
      let h = IMAGE_MAX
      try {
        const bmp = await createImageBitmap(blob)
        const fit = fitImageSize(bmp.width, bmp.height)
        w = fit.w
        h = fit.h
        bmp.close()
      } catch {
        /* undecodable → keep the square fallback size */
      }
      beginChange()
      commit([...elements, makeImage(newId(), at, res.assetId, w, h)])
    },
    [beginChange, commit, elements]
  )

  /** Paste an image from the clipboard → board centre. */
  const onWellPaste = useCallback(
    (e: ReactClipboardEvent): void => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const file = it.getAsFile()
          if (file) {
            e.preventDefault()
            const r = wellRef.current?.getBoundingClientRect()
            const at = r
              ? toBoard({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
              : { x: board.w / 2, y: board.h / 2 }
            void addImageFromBlob(file, at)
            return
          }
        }
      }
    },
    [addImageFromBlob, toBoard, board.w, board.h]
  )

  /** Allow a file drag over the well (required for onDrop to fire). */
  const onWellDragOver = useCallback((e: ReactDragEvent): void => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  }, [])

  /** Drop an image file → at the cursor (board-local). */
  const onWellDrop = useCallback(
    (e: ReactDragEvent): void => {
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      const file = Array.from(files).find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      void addImageFromBlob(file, toBoard(e))
    },
    [addImageFromBlob, toBoard]
  )
```

- [ ] **Step 3: Wire the handlers onto the `.pl-well` div**

In the well `<div className="pl-well" ...>` (around line 807), add three props alongside the existing `onPointerDown`/`onDoubleClick`:

```tsx
        onPaste={onWellPaste}
        onDrop={onWellDrop}
        onDragOver={onWellDragOver}
```

- [ ] **Step 4: Add the ImageCard render branch**

In `viewElements.map`, after the `checklist` branch and before `return null`, add:

```tsx
          if (el.kind === 'image') {
            return (
              <ImageCard
                key={el.id}
                image={el}
                interactive={interactive}
                onDragStart={startElementDrag}
                selected={selectedIds.has(el.id)}
                onSelect={selectOnPress}
              />
            )
          }
```

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" typecheck:web`
Then: `pnpm -C "Z:\canvas-ade-whiteboard-w4" exec eslint src/renderer/src/canvas/boards/PlanningBoard.tsx`
Expected: both clean. (If `el` is not narrowed to `ImageElement` in the branch, confirm the union switch order — the `image` branch must read `el.assetId`/`el.w`/`el.h` only inside `if (el.kind === 'image')`.)

- [ ] **Step 6: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/renderer/src/canvas/boards/PlanningBoard.tsx
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
feat(planning): paste/drop image -> assets pipeline -> image element (W4)

onPaste (board centre) + onDrop/onDragOver (cursor via toBoard) on the
well; addImageFromBlob writes the blob, sizes via createImageBitmap +
fitImageSize, and commits one undo step. ImageCard renders in the map.
EOF
```

---

## Task 8: e2e probe — paste persists + reloads + dedups + GCs

**Files:**
- Modify: `src/main/e2e/probes/whiteboard.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Add the probe**

At the top of `src/main/e2e/probes/whiteboard.ts`, extend imports:

```ts
import { clipboard, nativeImage } from 'electron'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createProject,
  setCurrentDir,
  readProject,
  writeProject,
  collectAssetIds,
  gcAssets
} from '../../projectStore'
```

Append the probe (a tiny solid PNG as a data URL — `nativeImage` re-encodes it to clipboard PNG):

```ts
// ── W4 image paste: real clipboard paste persists a blob to assets/<sha1>, stores a
// RELATIVE path (not base64), survives a reload, dedups identical bytes to one file,
// and is swept by the open-time GC. MAIN-side: mints a temp project (e2e has no project
// dir), puts an image on the system clipboard, focuses the well, and fires a REAL
// webContents.paste() (memory e2e-sendinputevent-vs-dispatchevent: real input, not a
// synthetic ClipboardEvent, which can't carry a file image item).
const PNG_DATAURL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGNkYGD4z0AEYBpVSF+FALziAv1cR6KqAAAAAElFTkSuQmCC'

export const whiteboardPasteImage: E2EProbe = {
  name: 'whiteboard-paste-image',
  async run(ctx): Promise<E2EPart[]> {
    const planId = ctx.ids.planId
    if (!planId)
      return [{ name: 'whiteboard-paste-image', ok: false, detail: 'planId not seeded' }]

    const tmp = mkdtempSync(join(tmpdir(), 'canvas-w4-'))
    const id = JSON.stringify(planId)
    const imageCount = async (): Promise<number> =>
      ctx.evalIn<number>(
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${id});
                  return b && b.type === 'planning' ? b.elements.filter(e => e.kind === 'image').length : -1; })()`
      )
    const firstAssetId = async (): Promise<string | null> =>
      ctx.evalIn<string | null>(
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${id});
                  const img = (b && b.type === 'planning' ? b.elements : []).find(e => e.kind === 'image');
                  return img ? img.assetId : null; })()`
      )
    const focusWell = async (): Promise<void> => {
      await ctx.evalIn(
        `(() => { const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(
          id
        )} + ']'); const w = n && n.querySelector('.pl-well'); if (w) w.focus(); })()`
      )
    }
    const parts: E2EPart[] = []
    try {
      await createProject(tmp, 'w4', {})
      setCurrentDir(tmp)
      await ctx.evalIn(`window.__canvasE2E.patchBoard(${id}, { elements: [] })`)
      await ctx.delay(80)

      // (1) PASTE — real input.
      clipboard.writeImage(nativeImage.createFromDataURL(PNG_DATAURL))
      await focusWell()
      await ctx.delay(40)
      ctx.win.webContents.paste()
      const pasted = await ctx.poll(async () => (await imageCount()) === 1, 4000)
      const assetId = await firstAssetId()
      const relOk =
        !!assetId && /^assets[/\\][0-9a-f]{40}\.png$/.test(assetId) && !assetId.startsWith('data:')
      const fileOk = !!assetId && existsSync(join(tmp, assetId))
      parts.push({
        name: 'whiteboard-paste-image',
        ok: pasted && relOk && fileOk,
        detail:
          pasted && relOk && fileOk
            ? `paste wrote ${assetId} (relative path, blob on disk)`
            : JSON.stringify({ pasted, assetId, relOk, fileOk })
      })

      // (2) RELOAD — write the doc, read it back, assert the image + assetId survive.
      const docStr = await ctx.evalIn<string>(
        `JSON.stringify({ schemaVersion: 4, viewport: null, boards: window.__canvasE2E.getBoards() })`
      )
      await writeProject(tmp, JSON.parse(docStr))
      const reread = readProject(tmp)
      const reImg =
        reread.ok &&
        collectAssetIds((reread as { doc: unknown }).doc).has(assetId ?? '__none__') &&
        !!assetId &&
        existsSync(join(tmp, assetId))
      parts.push({
        name: 'whiteboard-paste-reload',
        ok: !!reImg,
        detail: reImg ? 'image element + blob survive a write/read round-trip' : JSON.stringify({ reread: reread.ok })
      })

      // (3) DEDUP — paste the SAME image again → 2 elements, ONE blob file.
      await focusWell()
      await ctx.delay(40)
      ctx.win.webContents.paste()
      const two = await ctx.poll(async () => (await imageCount()) === 2, 4000)
      const fileCount = existsSync(join(tmp, 'assets')) ? readdirSync(join(tmp, 'assets')).length : -1
      parts.push({
        name: 'whiteboard-asset-dedup',
        ok: two && fileCount === 1,
        detail: two && fileCount === 1 ? '2 image elements share 1 blob' : JSON.stringify({ two, fileCount })
      })

      // (4) GC — clear elements, sweep, assert the orphan blob is gone.
      await ctx.evalIn(`window.__canvasE2E.patchBoard(${id}, { elements: [] })`)
      gcAssets(tmp, collectAssetIds({ boards: [] }))
      const swept = !existsSync(join(tmp, 'assets')) || readdirSync(join(tmp, 'assets')).length === 0
      parts.push({
        name: 'whiteboard-asset-gc',
        ok: swept,
        detail: swept ? 'orphan blob swept at GC' : JSON.stringify({ remaining: readdirSync(join(tmp, 'assets')) })
      })
    } catch (err) {
      parts.push({
        name: 'whiteboard-paste-image',
        ok: false,
        detail: 'ERR: ' + String((err as Error)?.message ?? err)
      })
    } finally {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    }
    return parts
  }
}
```

- [ ] **Step 2: Register the probe in the playlist**

In `src/main/e2e/index.ts`, add `whiteboardPasteImage` to the `whiteboard` import block, then insert it into `PLAYLIST` immediately before `seed` (after `whiteboardFullviewAdd`):

```ts
import {
  whiteboardErase,
  whiteboardSelection,
  whiteboardFullviewAdd,
  whiteboardAltDup,
  whiteboardLock,
  whiteboardGroup,
  whiteboardAlign,
  whiteboardGroupAlign,
  whiteboardPasteImage
} from './probes/whiteboard'
```

```ts
  whiteboardFullviewAdd, // Option A: real-input add-note in Planning camera-full-view
  whiteboardPasteImage, // W4: real-paste image persists + reloads + dedups + GCs
  seed
```

- [ ] **Step 3: Build + run the e2e harness**

Kill any stray Electron first, then:

Run:
```
pnpm -C "Z:\canvas-ade-whiteboard-w4" build
$env:CANVAS_SMOKE='e2e'; pnpm -C "Z:\canvas-ade-whiteboard-w4" start
```
Expected: `E2E_WHITEBOARD-PASTE-IMAGE`, `E2E_WHITEBOARD-PASTE-RELOAD`, `E2E_WHITEBOARD-ASSET-DEDUP`, `E2E_WHITEBOARD-ASSET-GC` all `ok:true`, and `E2E_DONE ok:true`.

**Contingency (paste delivers 0 images):** if `whiteboard-paste-image` shows `pasted:false`, the focused `.pl-well` div is not receiving the paste command. Switch the PlanningBoard paste path (Task 7) from a React `onPaste` prop to a `window`-level `paste` listener registered in a `useEffect`, gated on `wellRef.current?.contains(document.activeElement)` so only the focused board handles it; re-run. (Drop is unaffected.)

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add src/main/e2e/probes/whiteboard.ts src/main/e2e/index.ts
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
test(e2e): real-paste image persists, reloads, dedups, GCs (W4)

MAIN-side probe mints a temp project, clipboard.writeImage + real
webContents.paste(), then asserts a relative-path blob on disk, a
write/read reload round-trip, identical-paste dedup to one file, and the
open-time GC sweeping the orphan.
EOF
```

---

## Task 9: Docs — roadmap + coordination board

**Files:**
- Modify: `docs/roadmap-whiteboard.md`
- Modify: `.claude/coordination/ACTIVE-WORK.md`

- [ ] **Step 1: Fix the STALE W4 schema note**

In `docs/roadmap-whiteboard.md`, the W4 "Persistence" bullet (around line 160) ends with
`Bump SCHEMA_VERSION 2→3 + MIGRATIONS[3].` — replace with:

```
Bump SCHEMA_VERSION 3→4 + add MIGRATIONS[3] (W3 already took v3).
```

In the same section's "📏" line (around line 168), replace `schema migrate 2→3 round-trip` with
`schema migrate 3→4 round-trip`.

- [ ] **Step 2: Flip the W4 status row**

In the Status table (around line 208), change the `W4 — Image + assets` row from `not started` to:

```
| W4 — Image + assets | ✅ done (2026-06-03) — paste/drop screenshot → `image` element backed by an `assets/<sha1>.<ext>` blob pipeline (relative path, dedup on hash, mark-and-sweep GC at open). Schema v3→v4. blob-via-preload load (CSP unchanged). Branch `feat/whiteboard-w4` → `feat/whiteboard`. |
```

- [ ] **Step 3: Refine the coordination-board row**

In `.claude/coordination/ACTIVE-WORK.md`, find the `canvas-ade-whiteboard-w4` row (added by `new-worktree.ps1`) and set its Notes to:

```
W4 image+assets. Schema **claims v4** (draw.io D2/D3 not started → rebases to v5). Zone: planning/* + PlanningBoard.tsx + boardSchema.ts(v4) + ImageCard.tsx(new) + projectStore.ts/projectIpc.ts (assets IPC) + preload/index.ts + e2e/probes/whiteboard.ts.
```

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" add docs/roadmap-whiteboard.md .claude/coordination/ACTIVE-WORK.md
git -C "Z:\canvas-ade-whiteboard-w4" commit -F - <<'EOF'
docs(w4): correct STALE schema note (2->3 becomes 3->4) + status/coord rows

W3 already took v3; W4 is first-to-land so it claims v4 (draw.io D2/D3 ->
v5). Flips the W4 status row and refines the coordination zone.
EOF
```

---

## Task 10: Full gate + e2e (handoff readiness)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" typecheck`
Expected: clean (node + preload + web).

- [ ] **Step 2: Lint**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" lint`
Expected: clean (no unused locals/params; strict).

- [ ] **Step 3: Format check**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" run format:check`
Expected: clean. If it flags the new/edited files, run `pnpm -C "Z:\canvas-ade-whiteboard-w4" format` and commit the reformat.

- [ ] **Step 4: Unit tests**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w4" test`
Expected: all green (prior baseline 560 + the new W4 specs).

- [ ] **Step 5: Board e2e**

Kill stray Electron, then:
```
pnpm -C "Z:\canvas-ade-whiteboard-w4" build
$env:CANVAS_SMOKE='e2e'; pnpm -C "Z:\canvas-ade-whiteboard-w4" start
```
Expected: `E2E_DONE ok:true`, including the four W4 parts. (browser/browser-gesture/focus-detach trio is a known live-`WebContentsView` env flake — rerun for a clean pass, not a regression; memory `e2e-browser-trio-flake`.)

- [ ] **Step 6: Final verification commit (if format reflowed anything)**

```bash
git -C "Z:\canvas-ade-whiteboard-w4" status
# commit any format-only changes if Step 3 reflowed files
```

---

## Done criteria (acceptance)

- Paste or drop a screenshot → an `image` element lands on the plan.
- Persists to `assets/<sha1>.<ext>` as a **relative path** (not base64); survives a write/read reload.
- Identical paste **dedups** to one blob.
- Deleting the image (menu/eraser) then reopening the project **GCs** the orphan blob.
- A missing asset renders the dashed fallback tile.
- Schema round-trips v3→v4.
- Gate: `typecheck` + `lint` + `format:check` + `test` green AND `CANVAS_SMOKE=e2e` → `E2E_DONE ok:true`.

## Then: finish the branch
Push `feat/whiteboard-w4`; open a squash PR → **`feat/whiteboard`** (NOT main); merge; tear down the worktree via `.claude/tools/remove-worktree.ps1`. Use `superpowers:finishing-a-development-branch`.
