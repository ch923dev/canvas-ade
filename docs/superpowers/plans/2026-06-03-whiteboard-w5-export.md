# Whiteboard W5 (Export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PNG/SVG export of a single Planning board — render its elements to an offscreen SVG, serialize for SVG export, rasterize to PNG, and save via a MAIN-side dialog.

**Architecture:** A pure serializer (`whiteboardExport.ts`) turns a `PlanningBoard` + a resolved `assetId → data-URI` map into a standalone SVG string (reusing `arrowPath`/`strokeToPath` from `svgPaths.ts` and `elementBBox` from `elements.ts`). A thin renderer driver fetches image bytes (`asset.read`), base64-inlines them **into the export artifact only**, rasterizes the SVG via an offscreen `<canvas>` → `toBlob('image/png')`, and hands the bytes/string to MAIN. A new `export:save` IPC handler shows `dialog.showSaveDialog` and writes with `write-file-atomic`. The trigger is a calm Export button (download glyph → PNG/SVG popover) in the Planning board's existing action cluster.

**Tech Stack:** TypeScript · React 18 · Electron 33 (MAIN `dialog` + `write-file-atomic`) · Vitest · perfect-freehand (vendored, via `svgPaths.ts`).

---

## Constraints carried from the handoff (do not violate)

- **No native `.excalidraw` JSON.** SVG + PNG raster only (ADR 0001).
- **Base64 image inlining is allowed ONLY in the exported artifact**, never in `canvas.json` (the persistence rule is about the store, not a one-shot export).
- **Missing asset** (GC'd / restored from `.bak`) → draw the fallback tile, never throw.
- Calm aesthetic, one accent, **no options panel** beyond format choice.
- Export is **read-only**: it reads `board.elements`; it never writes the store, never serializes selection/tool/draft, and pushes NO undo checkpoint (and must not trip a `lastRecorded` phantom step — it touches no store action, so this is satisfied by construction).
- Exported bytes are produced in the renderer and handed to MAIN for the save dialog only — **never near the PTY**.
- IPC handler rejects foreign senders (reuse the `projectIpc` guard pattern).

## File Structure

**Create:**
- `src/renderer/src/canvas/boards/planning/exportColors.ts` — concrete hex/rgba values for every design token the SVG needs (an exported SVG can't resolve `var(--…)`).
- `src/renderer/src/canvas/boards/planning/whiteboardExport.ts` — PURE `boardToSvg(board, assets)` → `{ svg, width, height, imageCount, embeddedCount }`. No DOM.
- `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts` — unit tests for the serializer.
- `src/renderer/src/canvas/boards/planning/exportBoard.ts` — IMPURE renderer driver: gathers the asset map (`asset.read` → data URI), builds the SVG, rasterizes to a PNG `Uint8Array`. Exposes `buildExport(board, format)`.

**Modify:**
- `src/renderer/src/canvas/Icon.tsx` — add a `download` glyph.
- `src/main/projectIpc.ts` — add the `export:save` handler (save dialog + atomic write).
- `src/main/projectIpc.test.ts` — unit-test the handler (mocked dialog).
- `src/preload/index.ts` + `src/preload/index.d.ts` — expose `api.exportFile(...)`.
- `src/renderer/src/canvas/boards/PlanningBoard.tsx` — Export button + popover + `onExport` handler; an e2e hook on `window.__canvasE2E`.
- `src/main/e2e/probes/whiteboard.ts` + `src/main/e2e/index.ts` — `whiteboard-export` probe.

---

## Task 1: Export colour tokens (pure)

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/exportColors.ts`
- Test: `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts` (created in Task 2 covers usage; this task ships the constants only)

- [ ] **Step 1: Write the constants module**

Values mirror `src/renderer/src/index.css` (the `var(--…)` resolved). Keep names matching the token they replace.

```ts
/**
 * Concrete colour values for the whiteboard SVG export. An exported standalone SVG
 * has no access to the app's CSS custom properties, so every `var(--…)` the live
 * board uses must be resolved to a literal here. Values mirror src/renderer/src/index.css
 * (§ token block) — keep them in step if the palette changes.
 */
export const EXPORT_COLORS = {
  void: '#0a0a0b',
  surface: '#141416',
  surfaceRaised: '#1a1a1d',
  inset: '#0e0e10',
  borderSubtle: 'rgba(255,255,255,0.06)',
  border: 'rgba(255,255,255,0.1)',
  borderStrong: 'rgba(255,255,255,0.16)',
  text: '#ededee',
  text2: '#9b9ba1',
  text3: '#6a6a70',
  textFaint: '#46464b',
  accent: '#4f8cff'
} as const

/** Note tint fills/edges (tints.ts NOTE_TINTS with `plain` resolved to concrete tokens). */
export const EXPORT_NOTE_TINTS: Record<'yellow' | 'blue' | 'green' | 'plain', { fill: string; edge: string }> = {
  yellow: { fill: '#2a2818', edge: '#3d3a22' },
  blue: { fill: '#16202b', edge: '#22354a' },
  green: { fill: '#16241d', edge: '#21392c' },
  plain: { fill: EXPORT_COLORS.surfaceRaised, edge: EXPORT_COLORS.border }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/exportColors.ts
git commit -F - <<'EOF'
feat(whiteboard): export colour tokens (resolve CSS vars for SVG)
EOF
```

---

## Task 2: Pure SVG serializer — bounds + empty board

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/whiteboardExport.ts`
- Test: `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { boardToSvg } from './whiteboardExport'
import type { PlanningBoard } from '../../../lib/boardSchema'

const board = (elements: PlanningBoard['elements']): PlanningBoard => ({
  id: 'p1',
  type: 'planning',
  x: 0,
  y: 0,
  w: 516,
  h: 366,
  title: 'Plan',
  elements
})

describe('boardToSvg — frame', () => {
  it('an empty board exports a non-empty, well-formed svg with a background rect', () => {
    const { svg, width, height } = boardToSvg(board([]), {})
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.includes('xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.trim().endsWith('</svg>')).toBe(true)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    // Background fill present so the dark board reads on a viewer's white page.
    expect(svg).toContain('#141416')
  })

  it('sizes the viewport to the element union plus padding (origin-normalised)', () => {
    const { width, height } = boardToSvg(
      board([{ id: 's', kind: 'stroke', x: 0, y: 0, points: [100, 100, 140, 160] }]),
      {}
    )
    // union is 40×60 at (100,100); + 2*PAD(24) → 88×108
    expect(width).toBe(88)
    expect(height).toBe(108)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from the worktree): `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: FAIL — `boardToSvg` is not defined.

- [ ] **Step 3: Write the minimal implementation (frame + bounds only)**

```ts
/**
 * Pure SVG serializer for a Planning board (W5 export). Renders every element kind
 * to standalone SVG markup in board-local coordinates, normalised so the element
 * union sits at PAD from the origin. No DOM, no React, no store — the impure driver
 * (exportBoard.ts) supplies the resolved `assets` map and rasterizes to PNG.
 *
 * Geometry reuses the live vector builders (arrowPath/strokeToPath) and elementBBox
 * so the export matches what's on the board. Auto-sized kinds (text/checklist) use
 * their nominal sizes (no live DOM measurement at export time) — close enough for a
 * one-shot deliverable.
 */
import type { PlanningBoard, PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, unionBBox } from './elements'
import { arrowPath, strokeToPath } from './svgPaths'
import { EXPORT_COLORS } from './exportColors'

/** assetId → data-URI (base64) for image elements; missing ids are absent. */
export type ExportAssets = Record<string, string>

export interface ExportResult {
  svg: string
  width: number
  height: number
  /** number of image elements on the board. */
  imageCount: number
  /** number of image elements whose bitmap was embedded (asset present). */
  embeddedCount: number
}

const PAD = 24

/** XML-escape text content / attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function boardToSvg(board: PlanningBoard, assets: ExportAssets): ExportResult {
  const els = board.elements
  const boxes = els.map((e) => elementBBox(e))
  const union = boxes.length ? unionBBox(boxes) : { x: 0, y: 0, w: 240, h: 160 }
  const width = Math.max(1, Math.round(union.w + PAD * 2))
  const height = Math.max(1, Math.round(union.h + PAD * 2))
  // Translate so the union's top-left lands at (PAD, PAD).
  const ox = PAD - union.x
  const oy = PAD - union.y

  let imageCount = 0
  let embeddedCount = 0
  const body: string[] = []
  for (const el of els) {
    const r = renderElement(el, assets)
    body.push(r.markup)
    if (el.kind === 'image') {
      imageCount++
      if (r.embedded) embeddedCount++
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${EXPORT_COLORS.surface}"/>` +
    `<g transform="translate(${ox} ${oy})">${body.join('')}</g>` +
    `</svg>`

  return { svg, width, height, imageCount, embeddedCount }
}

// Placeholder; Tasks 3-5 flesh each kind out.
function renderElement(_el: PlanningElement, _assets: ExportAssets): { markup: string; embedded: boolean } {
  return { markup: '', embedded: false }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: PASS (both frame tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/whiteboardExport.ts src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts
git commit -F - <<'EOF'
feat(whiteboard): SVG export frame + bounds (empty board)
EOF
```

---

## Task 3: Serialize vectors — arrows + strokes

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/whiteboardExport.ts`
- Test: `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { ARROW_COLOR } from './whiteboardExport' // re-export of EXPORT_COLORS.borderStrong for the assertion

describe('boardToSvg — vectors', () => {
  it('emits a bezier path for an arrow and a fill path for a stroke', () => {
    const { svg } = boardToSvg(
      board([
        { id: 'a', kind: 'arrow', x: 10, y: 10, x2: 90, y2: 70 },
        { id: 's', kind: 'stroke', x: 0, y: 0, points: [10, 10, 40, 40, 70, 20] }
      ]),
      {}
    )
    // arrow → a path starting with a move+cubic; stroke → a filled path.
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(svg).toContain(' C ') // cubic bezier from arrowPath
    expect(svg).toContain(ARROW_COLOR)
  })

  it('renders an arrowhead marker so the arrow has a head', () => {
    const { svg } = boardToSvg(
      board([{ id: 'a', kind: 'arrow', x: 0, y: 0, x2: 50, y2: 0 }]),
      {}
    )
    expect(svg).toContain('<marker')
    expect(svg).toContain('marker-end="url(#wb-export-arrow)"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: FAIL — `ARROW_COLOR` undefined / no `<path>`/`<marker>` emitted.

- [ ] **Step 3: Implement arrow + stroke rendering**

Add the re-export and a `<defs>` marker, and fill in the arrow/stroke branches of `renderElement`.

In `whiteboardExport.ts`, add near the imports:

```ts
/** Re-exported so tests + callers can assert the vector ink colour. */
export const ARROW_COLOR = EXPORT_COLORS.borderStrong
const STROKE_FILL = EXPORT_COLORS.text2
const ARROW_MARKER_ID = 'wb-export-arrow'
```

Inject the marker `<defs>` into the svg string (before the background rect) inside `boardToSvg`:

```ts
  const defs =
    `<defs><marker id="${ARROW_MARKER_ID}" markerWidth="8" markerHeight="8" ` +
    `refX="6" refY="4" orient="auto"><path d="M0 0 L7 4 L0 8 z" fill="${ARROW_COLOR}"/></marker></defs>`
```

and change the `svg` assembly to insert `defs` right after the opening `<svg …>`:

```ts
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    defs +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${EXPORT_COLORS.surface}"/>` +
    `<g transform="translate(${ox} ${oy})">${body.join('')}</g>` +
    `</svg>`
```

Replace the placeholder `renderElement` arrow/stroke branches:

```ts
function renderElement(el: PlanningElement, assets: ExportAssets): { markup: string; embedded: boolean } {
  switch (el.kind) {
    case 'arrow':
      return {
        markup:
          `<path d="${arrowPath(el)}" fill="none" stroke="${ARROW_COLOR}" ` +
          `stroke-width="1.5" marker-end="url(#${ARROW_MARKER_ID})"/>`,
        embedded: false
      }
    case 'stroke': {
      const d = strokeToPath(el.points)
      return { markup: d ? `<path d="${d}" fill="${STROKE_FILL}"/>` : '', embedded: false }
    }
    default:
      return { markup: '', embedded: false }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/whiteboardExport.ts src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts
git commit -F - <<'EOF'
feat(whiteboard): SVG export of arrows + strokes
EOF
```

---

## Task 4: Serialize cards — note · text · checklist

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/whiteboardExport.ts`
- Test: `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('boardToSvg — cards', () => {
  it('renders a note as a tinted rounded rect with its text', () => {
    const { svg } = boardToSvg(
      board([{ id: 'n', kind: 'note', x: 0, y: 0, w: 156, h: 96, tint: 'yellow', text: 'hello', rotation: 0 }]),
      {}
    )
    expect(svg).toContain('<rect')
    expect(svg).toContain('#2a2818') // yellow tint fill
    expect(svg).toContain('hello')
  })

  it('escapes text content (no raw markup injection)', () => {
    const { svg } = boardToSvg(
      board([{ id: 't', kind: 'text', x: 0, y: 0, text: '<b>x</b> & y' }]),
      {}
    )
    expect(svg).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(svg).not.toContain('<b>x</b>')
  })

  it('renders a checklist with title, count, progress bar and item labels', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 'c',
          kind: 'checklist',
          x: 0,
          y: 0,
          w: 240,
          h: 0,
          title: 'Tasks',
          items: [
            { id: 'i1', label: 'done one', done: true },
            { id: 'i2', label: 'todo two', done: false }
          ]
        }
      ]),
      {}
    )
    expect(svg).toContain('Tasks')
    expect(svg).toContain('1/2') // done/total
    expect(svg).toContain('done one')
    expect(svg).toContain('todo two')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: FAIL — cards render empty markup.

- [ ] **Step 3: Implement note/text/checklist branches**

Add imports + helpers to `whiteboardExport.ts`:

```ts
import { nominalChecklistHeight, TEXT_NOMINAL } from './elements'
import { EXPORT_NOTE_TINTS } from './exportColors'

const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif'
const R_INNER = 6
const R_BOARD = 8

/** A multi-line <text> block: one <tspan> per source line, left-aligned at (x,y). */
function textBlock(x: number, y: number, raw: string, size: number, fill: string, weight = 400): string {
  const lines = raw.split('\n')
  const tspans = lines
    .map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size + 4}">${esc(ln)}</tspan>`)
    .join('')
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${tspans}</text>`
}
```

Replace the relevant `renderElement` branches (keep arrow/stroke from Task 3):

```ts
    case 'note': {
      const t = EXPORT_NOTE_TINTS[el.tint]
      const rot = el.rotation ?? 0
      const cx = el.x + el.w / 2
      const cy = el.y + el.h / 2
      return {
        markup:
          `<g transform="rotate(${rot} ${cx} ${cy})">` +
          `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${R_INNER}" ` +
          `fill="${t.fill}" stroke="${t.edge}" stroke-width="1"/>` +
          textBlock(el.x + 11, el.y + 20, el.text, 12, EXPORT_COLORS.text) +
          `</g>`,
        embedded: false
      }
    }
    case 'text':
      return {
        markup: textBlock(el.x, el.y + TEXT_NOMINAL.h - 6, el.text, 13, EXPORT_COLORS.text),
        embedded: false
      }
    case 'checklist': {
      const total = el.items.length
      const done = el.items.filter((i) => i.done).length
      const pct = total === 0 ? 0 : Math.round((done / total) * 100)
      const h = nominalChecklistHeight(total)
      const parts: string[] = []
      parts.push(
        `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${h}" rx="${R_BOARD}" ` +
          `fill="${EXPORT_COLORS.surfaceRaised}" stroke="${EXPORT_COLORS.border}" stroke-width="1"/>`
      )
      // header: title (left) + done/total (right)
      parts.push(textBlock(el.x + 12, el.y + 22, el.title, 12.5, EXPORT_COLORS.text, 600))
      parts.push(
        `<text x="${el.x + el.w - 12}" y="${el.y + 22}" text-anchor="end" font-family="${FONT}" ` +
          `font-size="11" fill="${EXPORT_COLORS.text3}">${esc(`${done}/${total}`)}</text>`
      )
      // 3px progress bar
      const barY = el.y + 30
      parts.push(
        `<rect x="${el.x + 12}" y="${barY}" width="${el.w - 24}" height="3" rx="1.5" fill="${EXPORT_COLORS.inset}"/>`
      )
      if (pct > 0) {
        parts.push(
          `<rect x="${el.x + 12}" y="${barY}" width="${((el.w - 24) * pct) / 100}" height="3" rx="1.5" fill="${EXPORT_COLORS.accent}"/>`
        )
      }
      // item rows
      el.items.forEach((it, idx) => {
        const ry = el.y + 30 + 24 + idx * 24
        const boxStroke = it.done ? EXPORT_COLORS.accent : EXPORT_COLORS.borderStrong
        const boxFill = it.done ? EXPORT_COLORS.accent : 'none'
        parts.push(
          `<rect x="${el.x + 12}" y="${ry - 12}" width="16" height="16" rx="5" fill="${boxFill}" stroke="${boxStroke}" stroke-width="1.5"/>`
        )
        if (it.done) {
          parts.push(
            `<path d="M${el.x + 15} ${ry - 4} l3 3 l5 -6" fill="none" stroke="${EXPORT_COLORS.void}" stroke-width="2"/>`
          )
        }
        const labelFill = it.done ? EXPORT_COLORS.textFaint : EXPORT_COLORS.text2
        const deco = it.done ? ` text-decoration="line-through"` : ''
        parts.push(
          `<text x="${el.x + 37}" y="${ry}" font-family="${FONT}" font-size="12" fill="${labelFill}"${deco}>${esc(it.label)}</text>`
        )
      })
      return { markup: parts.join(''), embedded: false }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/whiteboardExport.ts src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts
git commit -F - <<'EOF'
feat(whiteboard): SVG export of note/text/checklist cards
EOF
```

---

## Task 5: Serialize images — embed bitmap or fallback tile

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/whiteboardExport.ts`
- Test: `src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('boardToSvg — images', () => {
  const img = { id: 'im', kind: 'image' as const, x: 0, y: 0, w: 120, h: 80, assetId: 'abc.png' }

  it('embeds the bitmap as an <image> with the supplied data URI', () => {
    const dataUri = 'data:image/png;base64,AAAA'
    const res = boardToSvg(board([img]), { 'abc.png': dataUri })
    expect(res.svg).toContain('<image')
    expect(res.svg).toContain(dataUri)
    expect(res.imageCount).toBe(1)
    expect(res.embeddedCount).toBe(1)
  })

  it('draws a dashed fallback tile (no throw) when the asset is missing', () => {
    const res = boardToSvg(board([img]), {}) // asset absent
    expect(res.svg).not.toContain('<image')
    expect(res.svg).toContain('stroke-dasharray')
    expect(res.imageCount).toBe(1)
    expect(res.embeddedCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: FAIL — image branch returns empty markup.

- [ ] **Step 3: Implement the image branch**

Replace the `default` arm's image handling — add a `case 'image'` before `default`:

```ts
    case 'image': {
      const uri = assets[el.assetId]
      if (uri) {
        return {
          markup:
            `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" ` +
            `preserveAspectRatio="xMidYMid meet" href="${esc(uri)}"/>`,
          embedded: true
        }
      }
      return {
        markup:
          `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="${R_INNER}" ` +
          `fill="none" stroke="${EXPORT_COLORS.border}" stroke-width="1" stroke-dasharray="4 3"/>`,
        embedded: false
      }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts`
Expected: PASS (all serializer tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/whiteboardExport.ts src/renderer/src/canvas/boards/planning/whiteboardExport.test.ts
git commit -F - <<'EOF'
feat(whiteboard): SVG export embeds images + missing-asset fallback
EOF
```

---

## Task 6: MAIN `export:save` IPC handler

**Files:**
- Modify: `src/main/projectIpc.ts`
- Test: `src/main/projectIpc.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/projectIpc.test.ts`. The handler is registered through `registerProjectHandlers`; the existing test harness already captures handlers into a map — follow the file's existing pattern (find how it invokes e.g. `project:save`). The test mocks `dialog.showSaveDialog` to return a temp path and asserts the bytes land on disk.

```ts
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, existsSync, rmSync } from 'node:fs'
// NOTE: reuse the file's existing electron `dialog` mock + handler-capture harness.

describe('export:save', () => {
  it('writes the bytes to the chosen path and returns ok', async () => {
    const out = join(tmpdir(), `wb-export-${Date.now()}.svg`)
    // Arrange: mock dialog.showSaveDialog → { canceled:false, filePath: out }
    // (set this on the same electron mock the other tests use)
    const handlers = captureHandlers() // the file's existing helper
    const save = handlers.get('export:save')!
    const bytes = new TextEncoder().encode('<svg/>')
    const res = await save(syntheticEvent(), { bytes, ext: 'svg', defaultName: 'board' })
    expect(res).toEqual({ ok: true, path: out })
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe('<svg/>')
    rmSync(out, { force: true })
  })

  it('returns canceled when the user dismisses the dialog', async () => {
    // mock dialog.showSaveDialog → { canceled:true }
    const handlers = captureHandlers()
    const save = handlers.get('export:save')!
    const res = await save(syntheticEvent(), { bytes: new Uint8Array(), ext: 'png', defaultName: 'b' })
    expect(res).toEqual({ ok: false, canceled: true })
  })
})
```

> If the existing test file does not expose `captureHandlers`/`syntheticEvent` helpers, mirror exactly how the current `project:save` test obtains its handler + fake event; reuse those locals rather than inventing new ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/projectIpc.test.ts`
Expected: FAIL — no `export:save` handler.

- [ ] **Step 3: Implement the handler**

In `src/main/projectIpc.ts`, add `writeFile` import and a new handler inside `registerProjectHandlers` (after `asset:read`). Use `write-file-atomic` (already a dep).

```ts
import writeFileAtomic from 'write-file-atomic'
```

```ts
  ipcMain.handle(
    'export:save',
    async (
      e,
      args: { bytes: Uint8Array; ext: 'png' | 'svg'; defaultName: string }
    ): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      const win = getWin()
      const ext = args.ext === 'png' ? 'png' : 'svg'
      const safeName = (args.defaultName || 'whiteboard').replace(/[^\w.-]+/g, '_')
      const opts = {
        defaultPath: `${safeName}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      }
      const res = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try {
        await writeFileAtomic(res.filePath, Buffer.from(args.bytes))
        return { ok: true, path: res.filePath }
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) }
      }
    }
  )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/main/projectIpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/projectIpc.ts src/main/projectIpc.test.ts
git commit -F - <<'EOF'
feat(main): export:save IPC — save dialog + atomic write
EOF
```

---

## Task 7: Preload `exportFile` bridge

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/preload/index.d.ts`

- [ ] **Step 1: Add the bridge method**

In `src/preload/index.ts`, add to the `api` object (next to `asset` / `dialog`):

```ts
  export: {
    save: (args: {
      bytes: Uint8Array
      ext: 'png' | 'svg'
      defaultName: string
    }): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke('export:save', args)
  },
```

- [ ] **Step 2: Mirror the type in `index.d.ts`**

`CanvasApi` is `typeof api`, so the `.d.ts` global already tracks it if the project re-exports `CanvasApi`. Verify `src/preload/index.d.ts` exposes the `api` shape; if it hand-declares each method, add the matching `export.save` signature there too. (Read the file first — match its existing style.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no missing-member errors on `window.api.export`).

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/preload/index.d.ts
git commit -F - <<'EOF'
feat(preload): expose export.save bridge
EOF
```

---

## Task 8: Add the `download` icon

**Files:**
- Modify: `src/renderer/src/canvas/Icon.tsx`

- [ ] **Step 1: Add the name + path**

Add `| 'download'` to the `IconName` union (after `'globe'`), and in `PATHS`:

```ts
  download: 'M12 4v10M8 11l4 4 4-4M5 19h14',
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/Icon.tsx
git commit -F - <<'EOF'
feat(ui): add download glyph for whiteboard export
EOF
```

---

## Task 9: Renderer driver — build SVG + rasterize PNG

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/exportBoard.ts`

This module is impure (DOM `Image`/`canvas`, `window.api`) so it has no Vitest unit test (jsdom lacks canvas raster) — it is exercised by the e2e probe (Task 11). Keep it thin: orchestration only, all serialization logic lives in the tested `whiteboardExport.ts`.

- [ ] **Step 1: Write the module**

```ts
/**
 * Impure renderer-side driver for W5 whiteboard export. Resolves each image
 * element's bytes to a base64 data URI (asset.read — INTO THE ARTIFACT ONLY, never
 * canvas.json), builds the standalone SVG via the pure boardToSvg, and rasterizes
 * it to a PNG Uint8Array through an offscreen <canvas>. A missing asset is skipped
 * (boardToSvg draws the fallback tile) — never throws.
 */
import type { PlanningBoard } from '../../../lib/boardSchema'
import { boardToSvg, type ExportResult } from './whiteboardExport'

/** Bytes → `data:<mime>;base64,<…>` (chunked to avoid a call-stack blowup on large blobs). */
function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/** Gather assetId → data URI for every image element (missing → absent in the map). */
async function gatherAssets(board: PlanningBoard): Promise<Record<string, string>> {
  const ids = Array.from(
    new Set(board.elements.filter((e) => e.kind === 'image').map((e) => (e as { assetId: string }).assetId))
  )
  const map: Record<string, string> = {}
  await Promise.all(
    ids.map(async (id) => {
      try {
        const bytes = await window.api.asset.read(id)
        if (bytes && bytes.length) {
          const ext = id.split('.').pop() ?? ''
          map[id] = bytesToDataUri(bytes, MIME_BY_EXT[ext] ?? 'application/octet-stream')
        }
      } catch {
        /* missing/unreadable → leave absent so boardToSvg draws the fallback */
      }
    })
  )
  return map
}

/** Render the SVG into an offscreen canvas and return PNG bytes. */
async function rasterize(result: ExportResult): Promise<Uint8Array> {
  const { svg, width, height } = result
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg image load failed'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0, width, height)
    const pngBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!pngBlob) throw new Error('toBlob returned null')
    return new Uint8Array(await pngBlob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface BuiltExport {
  result: ExportResult
  /** SVG bytes (UTF-8) for `format:'svg'`; PNG bytes for `format:'png'`. */
  bytes: Uint8Array
  ext: 'png' | 'svg'
}

/** Build the export artifact bytes for a board in the requested format. */
export async function buildExport(board: PlanningBoard, format: 'png' | 'svg'): Promise<BuiltExport> {
  const assets = await gatherAssets(board)
  const result = boardToSvg(board, assets)
  if (format === 'svg') {
    return { result, bytes: new TextEncoder().encode(result.svg), ext: 'svg' }
  }
  return { result, bytes: await rasterize(result), ext: 'png' }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/exportBoard.ts
git commit -F - <<'EOF'
feat(whiteboard): renderer export driver (gather assets + rasterize)
EOF
```

---

## Task 10: Wire the Export button + popover into PlanningBoard

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`

- [ ] **Step 1: Add the export handler + popover state**

Near the top of the component body (with the other `useState`s), add:

```tsx
const [exportOpen, setExportOpen] = useState(false)
const runExport = useCallback(
  async (format: 'png' | 'svg') => {
    setExportOpen(false)
    try {
      const { buildExport } = await import('./planning/exportBoard')
      const { bytes, ext } = await buildExport(board, format)
      await window.api.export.save({ bytes, ext, defaultName: board.title || 'whiteboard' })
    } catch (err) {
      console.error('whiteboard export failed', err)
    }
  },
  [board]
)
```

> Adjust the relative import path if PlanningBoard.tsx lives one directory up from `planning/` (it imports cards as `'./planning/...'`? verify — it imports BoardFrame as `'../BoardFrame'` and is at `canvas/boards/PlanningBoard.tsx`, so the path is `'./planning/exportBoard'`).

- [ ] **Step 2: Add the Export button to the action cluster**

In the `actions` JSX (the selected-only cluster, after the snapping `magnet` IconBtn), add a relatively-positioned Export control with a small popover:

```tsx
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-subtle)', margin: '0 2px' }} />
      <div style={{ position: 'relative', display: 'inline-flex' }}>
        <IconBtn
          name="download"
          title="Export"
          size={15}
          active={exportOpen}
          onClick={() => setExportOpen((v) => !v)}
        />
        {exportOpen && (
          <div
            role="menu"
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 28,
              right: 0,
              zIndex: 5,
              display: 'flex',
              flexDirection: 'column',
              minWidth: 130,
              padding: 4,
              background: 'var(--surface-overlay)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-inner)',
              boxShadow: 'var(--shadow-pop)'
            }}
          >
            <button className="board-menu-item" onClick={() => void runExport('png')}>
              Export PNG
            </button>
            <button className="board-menu-item" onClick={() => void runExport('svg')}>
              Export SVG
            </button>
          </div>
        )}
      </div>
```

- [ ] **Step 3: Close the popover on outside press / Escape**

Add an effect (mirrors BoardMenu) so the popover dismisses:

```tsx
useEffect(() => {
  if (!exportOpen) return
  const close = (): void => setExportOpen(false)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') setExportOpen(false)
  }
  document.addEventListener('pointerdown', close)
  document.addEventListener('keydown', onKey)
  return () => {
    document.removeEventListener('pointerdown', close)
    document.removeEventListener('keydown', onKey)
  }
}, [exportOpen])
```

> The popover's own `onPointerDown` stops propagation so clicking inside it doesn't self-close before the button `onClick` fires.

- [ ] **Step 4: Ensure imports**

Confirm `useCallback`, `useEffect`, `useState` are imported in PlanningBoard.tsx (they are — it's a large component). `window.api.export` is typed from Task 7.

- [ ] **Step 5: Typecheck + lint + format**

Run:
```
pnpm typecheck
pnpm lint
pnpm exec prettier --write src/renderer/src/canvas/boards/PlanningBoard.tsx
```
Expected: PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -F - <<'EOF'
feat(whiteboard): Export button + PNG/SVG popover in the planning action cluster
EOF
```

---

## Task 11: e2e probe — `whiteboard-export`

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx` (add an e2e hook — or better, expose via the existing `window.__canvasE2E` surface; see Step 1)
- Modify: `src/main/e2e/probes/whiteboard.ts`
- Modify: `src/main/e2e/index.ts`

The OS save dialog can't run headless on CI, so the probe drives the **renderer build pipeline** (`buildExport`, sans dialog) through a test hook and asserts the artifact — it does NOT call `export:save`.

- [ ] **Step 1: Expose a test hook**

Find where `window.__canvasE2E` is assembled (grep `__canvasE2E` in the renderer — likely `src/renderer/src/smoke/` or a debug module). Add:

```ts
exportBoard: async (boardId: string, format: 'png' | 'svg') => {
  const b = getBoards().find((x) => x.id === boardId)
  if (!b || b.type !== 'planning') return null
  const { buildExport } = await import('../canvas/boards/planning/exportBoard')
  const { result, bytes } = await buildExport(b, format)
  return {
    svg: result.svg,
    byteLength: bytes.length,
    imageCount: result.imageCount,
    embeddedCount: result.embeddedCount
  }
}
```

> Match the actual module's import paths + how it already reaches `getBoards`. If the e2e hook object is built in a `.ts` that already imports store accessors, reuse those.

- [ ] **Step 2: Write the probe**

Append to `src/main/e2e/probes/whiteboard.ts` (mirror the existing `whiteboardPasteImage` structure for seeding an image asset + the `ctx.evalIn` pattern):

```ts
export const whiteboardExport: E2EProbe = {
  name: 'whiteboard-export',
  async run(ctx): Promise<E2EPart[]> {
    const planId = ctx.ids.planId
    if (!planId)
      return [{ name: 'whiteboard-export', ok: false, detail: 'planId not seeded' }]

    // Seed a note + a stroke + a checklist so the SVG has multiple element nodes.
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
        { id: 'ex-note', kind: 'note', x: 20, y: 20, w: 156, h: 96, tint: 'blue', text: 'export me', rotation: 0 },
        { id: 'ex-stroke', kind: 'stroke', x: 0, y: 0, points: [40,200,80,240,120,210] },
        { id: 'ex-check', kind: 'checklist', x: 220, y: 20, w: 240, h: 0, title: 'T', items: [{ id:'a', label:'one', done:true }, { id:'b', label:'two', done:false }] }
      ] })`
    )
    await ctx.delay(120)

    const svgOut = await ctx.evalIn<{ svg: string; byteLength: number } | null>(
      `window.__canvasE2E.exportBoard(${JSON.stringify(planId)}, 'svg')`
    )
    const pngOut = await ctx.evalIn<{ byteLength: number } | null>(
      `window.__canvasE2E.exportBoard(${JSON.stringify(planId)}, 'png')`
    )

    const parts: E2EPart[] = []
    const svgOk =
      !!svgOut &&
      svgOut.svg.startsWith('<svg') &&
      (svgOut.svg.match(/<path /g) ?? []).length >= 1 &&
      svgOut.svg.includes('export me') &&
      svgOut.byteLength > 100
    parts.push({
      name: 'whiteboard-export-svg',
      ok: svgOk,
      detail: svgOk ? `svg ${svgOut!.byteLength}B` : `bad svg: ${JSON.stringify(svgOut)?.slice(0, 120)}`
    })
    const pngOk = !!pngOut && pngOut.byteLength > 200
    parts.push({
      name: 'whiteboard-export-png',
      ok: pngOk,
      detail: pngOk ? `png ${pngOut!.byteLength}B` : `bad png: ${JSON.stringify(pngOut)}`
    })
    return parts
  }
}
```

- [ ] **Step 3: Add an image-embed assertion (reuse the paste-image seed)**

Extend the probe (or add a second `evalIn`) so after an image asset is written + an image element seeded, the SVG export contains `<image` and `embeddedCount === 1`; and a board whose image asset id is bogus exports with `embeddedCount === 0` and a `stroke-dasharray` fallback (no throw). Model the asset write on `whiteboardPasteImage`'s existing `asset.write` flow.

```ts
    // image-embed sub-check
    const embed = await ctx.evalIn<{ svg: string; imageCount: number; embeddedCount: number } | null>(
      `(async () => {
         const id = ${JSON.stringify(planId)};
         const bytes = new Uint8Array([137,80,78,71,13,10,26,10]); // PNG magic
         const w = await window.api.asset.write(bytes, 'png');
         if (!('assetId' in w)) return null;
         window.__canvasE2E.patchBoard(id, { elements: [{ id:'ex-img', kind:'image', x:10, y:10, w:64, h:64, assetId: w.assetId }] });
         await new Promise(r => setTimeout(r, 60));
         return window.__canvasE2E.exportBoard(id, 'svg');
       })()`
    )
    const embedOk = !!embed && embed.imageCount === 1 && embed.embeddedCount === 1 && embed.svg.includes('<image')
    parts.push({
      name: 'whiteboard-export-image-embed',
      ok: embedOk,
      detail: embedOk ? 'image embedded' : `bad embed: ${JSON.stringify(embed)?.slice(0, 120)}`
    })

    const missing = await ctx.evalIn<{ embeddedCount: number; svg: string } | null>(
      `(async () => {
         const id = ${JSON.stringify(planId)};
         window.__canvasE2E.patchBoard(id, { elements: [{ id:'ex-img2', kind:'image', x:10, y:10, w:64, h:64, assetId: 'does-not-exist.png' }] });
         await new Promise(r => setTimeout(r, 40));
         return window.__canvasE2E.exportBoard(id, 'svg');
       })()`
    )
    const missingOk = !!missing && missing.embeddedCount === 0 && missing.svg.includes('stroke-dasharray')
    parts.push({
      name: 'whiteboard-export-missing-asset',
      ok: missingOk,
      detail: missingOk ? 'fallback tile, no throw' : `bad: ${JSON.stringify(missing)?.slice(0, 120)}`
    })
```

- [ ] **Step 4: Register the probe**

In `src/main/e2e/index.ts`: add `whiteboardExport` to the import list from `./probes/whiteboard` and to the playlist array (place it among the other `whiteboard*` probes, before the final `seed` probe — it only mutates the planning board's `elements`, never the board COUNT `seed` asserts).

```ts
  whiteboardExport, // W5: SVG/PNG export of the planning board (sans OS dialog)
```

- [ ] **Step 5: Build + run e2e**

```
taskkill //F //IM electron.exe //T 2>$null
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: output contains `whiteboard-export-svg ok`, `whiteboard-export-png ok`, `whiteboard-export-image-embed ok`, `whiteboard-export-missing-asset ok`, and `E2E_DONE ok:true`.

- [ ] **Step 6: Commit**

```bash
git add src/main/e2e/probes/whiteboard.ts src/main/e2e/index.ts src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -F - <<'EOF'
test(e2e): whiteboard-export probe (svg/png/image-embed/missing-asset)
EOF
```

---

## Task 12: Full gate + roadmap update

**Files:**
- Modify: `docs/roadmap-whiteboard.md` (mark W5 done)

- [ ] **Step 1: Run the whole gate from the worktree**

```
pnpm typecheck
pnpm lint
pnpm exec prettier --check .
pnpm test
taskkill //F //IM electron.exe //T 2>$null
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: typecheck/lint/format/test green; `E2E_DONE ok:true` (the `whiteboard-fullview-add` CI-only flake noted in the handoff is unrelated — locally it passes; treat a green `E2E_DONE` as the gate).

- [ ] **Step 2: Mark W5 done in the roadmap**

Update `docs/roadmap-whiteboard.md` › Phase W5 to `shipped` with the branch/PR reference.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap-whiteboard.md
git commit -F - <<'EOF'
docs(whiteboard): mark W5 (export) shipped
EOF
```

- [ ] **Step 4: Open the squash PR → `feat/whiteboard`**

Per the handoff: land via squash PR into `feat/whiteboard` (NOT `main`), like W1–W4. Re-pull `feat/whiteboard` first.

```bash
git push -u origin feat/whiteboard-w5
gh pr create --base feat/whiteboard --head feat/whiteboard-w5 --title "feat(whiteboard): W5 — PNG/SVG export" --body "..."
```

---

## Self-Review

**Spec coverage (handoff → task):**
- SVG + PNG raster, no `.excalidraw` JSON → Tasks 2-5 (SVG), 9 (PNG raster). ✓
- Reuse `WhiteboardSvg` geometry (arrowPath/strokes/card rects) → Task 3 (arrowPath/strokeToPath), Task 4 (cards). ✓
- Rasterize via offscreen `<canvas>` + `toBlob('image/png')` → Task 9. ✓
- Image base64-inline in artifact only; missing asset fallback no-throw → Task 5 (serializer) + Task 9 (gather). ✓
- Export UI (action slot, PNG/SVG, no options panel) → Tasks 8, 10. ✓
- MAIN save dialog + `write-file-atomic`, foreign-sender guard → Task 6. ✓
- Read-only (no checkpoint / no phantom undo) → no store writes anywhere; export reads `board`. ✓
- Sandbox/PTY isolation → bytes flow renderer→MAIN via IPC only. ✓
- Unit test geometry serializer → Tasks 2-5. ✓
- e2e: PNG + SVG written, SVG node count, image embedded, missing-asset survives → Task 11. ✓
- Gate green → Task 12. ✓

**Open implementation choices (flagged, low-risk defaults chosen):**
1. **UI placement** → Export lives in the Planning **action cluster** (download glyph → tiny PNG/SVG popover), NOT the shared `⋯` BoardMenu — keeps the change inside the planning zone and off shared chrome that all board types render. (Handoff explicitly allows either.)
2. **Card text fidelity** → SVG `<text>` (line-split on `\n`), nominal sizes for auto-sized text/checklist (no live DOM measure at export). Faithful enough for a one-shot deliverable; not pixel-identical to the live DOM wrapping.

**Type consistency:** `boardToSvg(board, assets) → ExportResult{svg,width,height,imageCount,embeddedCount}` used identically in Tasks 2-5, 9, 11. `export:save` arg `{bytes,ext,defaultName}` matches across Tasks 6, 7, 10. `buildExport(board, format) → {result,bytes,ext}` consistent in Tasks 9, 10, 11.
