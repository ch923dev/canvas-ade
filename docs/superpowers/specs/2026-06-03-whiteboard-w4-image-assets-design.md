# Whiteboard W4 — Image element + assets pipeline (design)

Date: 2026-06-03 · Branch: `feat/whiteboard-w4` (off `feat/whiteboard` @ `0ef7963`/W3) ·
Targets: `feat/whiteboard` (NOT main) via squash PR.

## Goal

Paste or drag-drop a screenshot onto a Planning board. The image becomes a first-class
`image` whiteboard element, backed by a real `assets/` blob pipeline on disk. Images are
HTML `<img>` (blob: URL) → **no `WebContentsView` occlusion concern** (advantage over Browser
boards). Bytes live in `<projectDir>/assets/<sha1>.<ext>`; the element stores only a **relative
path**, never a base64 data URL.

## Locked decisions (this design)

| Fork | Decision | Why |
|---|---|---|
| Asset load | **Preload `asset:read`→bytes → renderer `URL.createObjectURL` blob:** | CSP already allows `blob:` → zero `index.html`/bootstrap change, fully in-zone. No custom-protocol registration. |
| GC | **Mark-and-sweep at project OPEN (MAIN-side)** | Undo stack is empty across sessions → always safe. Never deletes mid-session → undo-of-delete always finds bytes. Leak bounded to one session. |
| Input | **Paste + drop both** | Acceptance says "paste OR drop". Drop reuses proven `screenToBoard`. |
| Schema | **v3 → v4** (W4 is first-to-land; draw.io D2/D3 not started → rebases to **v5**) | Coordination board row + no draw/mermaid branches exist (verified local+remote 2026-06-03). |
| assetId format | Relative POSIX path `assets/<sha1>.<ext>` | Literal "relative path" per CLAUDE.md; strict regex blocks traversal. |
| Dedup | Content-addressed: `assetId = sha1(bytes)`; write skips if file exists | Identical paste → one blob, referenced by many elements harmlessly. |

Deferred (carry-over): flip, resize handles, element clipboard.

## Architecture

### 1. Schema (`src/renderer/src/lib/boardSchema.ts`)

```ts
export interface ImageElement extends ElementCommon {
  kind: 'image'
  w: number
  h: number
  assetId: string // relative POSIX path: assets/<sha1>.<ext>
}
export type PlanningElement =
  | NoteElement | TextElement | ArrowElement | StrokeElement | ChecklistElement | ImageElement
```

- `SCHEMA_VERSION = 4`.
- `MIGRATIONS[3] = (doc) => ({ ...doc, schemaVersion: 4 })` — additive no-op; `assetId` lives only
  on new image elements, so there is nothing to backfill (same shape W3's `MIGRATIONS[2]` took).
- `assertPlanningElement` adds `case 'image'`: `isPositiveNum(el.w)` && `isPositiveNum(el.h)` &&
  `typeof el.assetId === 'string'` && `el.assetId.length > 0`. (x/y finiteness + locked/groupId are
  already checked by the common prefix.)
- `elementBBox` adds `case 'image': return { x: el.x, y: el.y, w: el.w, h: el.h }`. The switch has
  **no default** → adding `'image'` to the union forces this case at compile time (forcing function).

### 2. Element factory + transforms (`.../planning/elements.ts`)

```ts
export const IMAGE_MAX = 360 // longest side, board-local px, on paste/drop

export function makeImage(
  id: string, at: { x: number; y: number }, assetId: string, w: number, h: number
): ImageElement {
  return { id, kind: 'image', x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h, assetId }
}
```

- Centered on the point (drop point under cursor / board center on paste).
- `shiftElement` / `translateElement` need **NO** change — image is top-left like a note, so it falls
  through the default (non-arrow, non-stroke) branch already. Verified against the existing code.
- A `fitImageSize(natW, natH, max=IMAGE_MAX)` pure helper scales natural dimensions to fit `max` on the
  longest side (min floor ~16px), preserving aspect. Unit-tested.

### 3. ImageCard (`.../planning/ImageCard.tsx`, new)

Mirrors `NoteCard.tsx`'s structure minus the text affordances:

- Absolutely positioned at `left:x, top:y, width:w, height:h` (board-local).
- The whole card is the drag handle in **select** mode: `onPointerDown` → `stopPropagation` +
  `onSelect(id, shiftKey)` + `onDragStart(e, id)`; in a **draw** mode the press falls through to the
  well (parity with NoteCard's `interactive` gate, so a stroke/arrow can start over an image).
- Selected → `outline: 1.5px solid var(--accent)`.
- **No inline ×** (W3 rule: deletion = context menu / eraser only). **No empty-prune** (images are
  never empty). `onDelete` is NOT wired to the card.
- Renders `<img src={blobUrl} draggable={false}>`; on missing asset → dashed placeholder tile at the
  element's w/h with a faint "missing image" label.

```ts
// useAssetUrl(assetId): module-level cache, dedup-shared, refcount-revoked.
const cache = new Map<string, { url: string; refs: number }>()
function useAssetUrl(assetId: string): string | null {
  // mount: refs++, create object URL on first ref (await window.api.asset.read);
  //        null bytes → return null (fallback path).
  // unmount: refs--, URL.revokeObjectURL + delete entry at 0.
}
```

Content-addressed `assetId` means two cards with the same image share one object URL.

### 4. Paste / drop wiring (`PlanningBoard.tsx`, `.pl-well`)

```ts
onPaste(e):  image item in e.clipboardData → place at board CENTER
onDrop(e):   e.preventDefault(); image file in e.dataTransfer → place at toBoard(e)
onDragOver(e): e.preventDefault()  // required for onDrop to fire
```

Shared async path:

```ts
async function addImageFromBlob(blob: Blob, at: { x: number; y: number }) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const ext = MIME_EXT[blob.type]            // png|jpg|jpeg|gif|webp|svg; bail on unknown
  const { assetId } = await window.api.asset.write(bytes, ext)
  const bmp = await createImageBitmap(blob)  // natural dimensions
  const { w, h } = fitImageSize(bmp.width, bmp.height)
  beginChange()
  commit([...elements, makeImage(newId(), at, assetId, w, h)]) // ONE undo step
}
```

Primary listener is React `onPaste` on the focusable `.pl-well` div. If real-input e2e proves the
focused div does not receive the paste, the documented fallback is a `window` `paste` listener gated on
`document.activeElement` being inside this board's well (registered via `useEffect`). Decide off the e2e
result during implementation.

`viewElements.map` adds `if (el.kind === 'image') return <ImageCard ... />` alongside note/text/checklist.

### 5. MAIN pipeline (`src/main/projectStore.ts` + `src/main/projectIpc.ts`)

`projectStore.ts` (pure-ish helpers, unit-tested):

```ts
const ASSET_RE = /^assets[/\\][a-f0-9]{40}\.[a-z0-9]+$/
const ASSET_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])

writeAsset(dir, bytes, ext): { assetId }     // sha1(bytes); join(dir,'assets',sha1+'.'+ext);
                                             // mkdir assets/; skip write if exists (dedup);
                                             // write-file-atomic; return 'assets/<sha1>.<ext>'
readAsset(dir, assetId): Uint8Array | null   // ASSET_RE guard; existsSync → readFileSync; else null
collectAssetIds(doc): Set<string>            // walk boards[].elements[] kind==='image' → assetId
gcAssets(dir, referenced: Set<string>): void // readdir(assets/); unlink any file not referenced;
                                             // no-op if assets/ absent
```

`projectIpc.ts` — register in `registerProjectHandlers`, same foreign-sender `guard`:

```ts
ipcMain.handle('asset:write', (e, { bytes, ext }) => {
  if (guard(e)) return { error: 'forbidden' }
  const dir = getCurrentDir(); if (!dir) return { error: 'no project' }
  if (!ASSET_EXTS.has(ext)) return { error: 'bad ext' }
  return writeAsset(dir, bytes, ext)
})
ipcMain.handle('asset:read', (e, assetId) => {
  if (guard(e)) return null
  const dir = getCurrentDir(); if (!dir) return null
  return readAsset(dir, assetId)
})
```

GC hooks into the existing read handlers (no renderer change, no cross-zone):

```ts
// inside project:open and project:current, after a successful readProject(...):
if (r.ok) gcAssets(r.dir, collectAssetIds(r.doc))
```

`r.doc` is the raw (pre-migration) doc — `assetId` sits on the element regardless of `schemaVersion`,
so the scan is version-independent.

### 6. Preload (`src/preload/index.ts` + `index.d.ts`)

```ts
asset: {
  write: (bytes: Uint8Array, ext: string): Promise<{ assetId: string } | { error: string }> =>
    ipcRenderer.invoke('asset:write', { bytes, ext }),
  read: (assetId: string): Promise<Uint8Array | null> =>
    ipcRenderer.invoke('asset:read', assetId)
}
```

`Uint8Array` structured-clones across `invoke` cleanly. Add matching types to `index.d.ts`'s `CanvasApi`.

## Persistence + undo invariants

- **Relative path only** — `assetId = 'assets/<sha1>.<ext>'`. Never a base64 data URL (violates the
  locked "heavy blobs in `assets/` by path, not inlined" rule; bloats every autosave; defeats dedup).
- **One undo checkpoint per gesture** — `beginChange()` then a single `commit([...])`. Uses the existing
  `beginChange`/`updateBoard` gesture rail; `lastRecorded` is synced by `beginChange` (no phantom step;
  memory `undo-lastrecorded-phantom`). No `trackedChange` direct calls.
- **Undo-of-delete is byte-safe** — bytes are never deleted mid-session; GC runs only at the next
  project open, when the undo stack is gone. Delete an image → autosave → undo → bytes still on disk.
- **`.bak` covers `canvas.json` only, not `assets/`** → ImageCard must render a missing-asset fallback
  (a restored backup can reference a since-swept blob).
- **Untrusted bytes** — pasted/dropped image data stays in renderer DOM + the assets file. It never
  reaches the PTY write channel (sandbox/isolation locked).

## Testing

### Unit (vitest)
- `boardSchema.test.ts`: v3→v4 migration round-trip; `assertPlanningElement` accepts a valid image,
  rejects non-positive w/h, empty/non-string assetId; `fromObject` round-trips an image element.
- `elements.test.ts`: `makeImage` centering; `fitImageSize` aspect/clamp; `elementBBox` image case;
  `shiftElement`/`duplicateElements`/`translateMany` move an image (default branch).
- `projectStore.test.ts`: `writeAsset` content-addresses + dedups (same bytes → same path, one file);
  `readAsset` returns bytes / null on missing / null on traversal-shaped assetId; `collectAssetIds`
  walks multi-board docs; `gcAssets` deletes orphans, keeps referenced, no-ops on absent `assets/`.
- Drop point→board mapping is covered by the existing `screenToBoard` tests (reused, not duplicated).

### e2e (`CANVAS_SMOKE=e2e`, `probes/whiteboard.ts`, registered before `seed`)
`whiteboard-paste-image` (MAIN-side probe):
1. `mkdtemp` temp project dir; `createProject` + `setCurrentDir`.
2. `clipboard.writeImage(nativeImage.createFromBuffer(pngBytes))` (a tiny known PNG).
3. `evalIn` focus the planning well; `ctx.win.webContents.paste()` (**real input**).
4. Poll `getBoards()` until the planning board has an `image` element.
5. Assert: `assetId` matches `^assets[/\\][0-9a-f]{40}\.png$` (NOT `data:`); the file exists on disk.
6. Build `{schemaVersion:4, viewport:null, boards}` from `getBoards()`; `writeProject` then
   `readProject` (reload) → image element + assetId persist; file still present.
7. Paste the same image again → 2 image elements; assert `assets/` holds exactly **one** file (dedup).
8. Clear the planning board's elements; `gcAssets(dir, collectAssetIds(emptyDoc))` → the file is swept.
9. Cleanup: remove the temp dir; `setCurrentDir(null)`.

Order-bound: runs after `tidy`/`tile`, before `seed`; mutates only the planning board's elements +
its own temp dir (never the board COUNT `seed` asserts).

## Docs to update (in-zone)
- `docs/roadmap-whiteboard.md` — W4 section's STALE "bump 2→3" becomes "bump 3→4 + add
  `MIGRATIONS[3]`, `SCHEMA_VERSION=4`"; flip the W4 status-table row.
- `.claude/coordination/ACTIVE-WORK.md` — refine the W4 row: zone + "claims **v4**; draw.io D2/D3 → v5".

## Gate before handoff
`pnpm typecheck && pnpm lint && pnpm run format:check && pnpm test` all green AND `CANVAS_SMOKE=e2e`
→ `E2E_DONE ok:true` (kill stray electron first; browser-trio is a known env flake — rerun for clean).

## Out of scope / non-goals
- Flip, resize handles, element clipboard (deferred).
- Custom URL protocol (chose blob-via-preload).
- Backfilling `assets/` into `.bak` rotation (fallback render covers the gap).
- Image editing / cropping / filters.
