# Port detect → push to preview (+ link arrow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Terminal board's **Preview** button parses the dev-server URL out of its PTY output and one click opens (or re-points) a Browser board at it, drawing a persistent connector arrow Terminal → preview.

**Architecture:** A pure MAIN parser reads the existing 256 KB PTY ring buffer over a frame-guarded IPC. The renderer resolves a target Browser board (follow-link → selected → sole → spawn-near) via a pure helper, sets its `url` + `previewSourceId` (new optional `BrowserBoard` field, no schema bump), and React Flow renders a floating connector edge derived from that field. Read-only, agent-agnostic, no git.

**Tech Stack:** Electron 33 (MAIN), TypeScript strict, React 18, `@xyflow/react` v12 (edges), Zustand, Vitest (node env). Spec: `docs/superpowers/specs/2026-05-30-port-detect-preview-design.md`.

---

## File structure

- **Create** `src/main/portDetect.ts` — pure `parsePortsFromOutput(raw)` (ANSI-strip + URL regex + dedupe + order). No Electron imports.
- **Create** `src/main/portDetect.test.ts` — parser unit tests.
- **Modify** `src/main/pty.ts` — register `terminal:detectPorts` IPC handler (frame-guarded; reads the session/parked ring buffer; delegates to the parser).
- **Modify** `src/preload/index.ts` — `DetectedUrl` type + `detectPorts(boardId)` invoke bridge.
- **Modify** `src/renderer/src/lib/boardSchema.ts` — `BrowserBoard.previewSourceId?: string`; validate it; prune dangling on load.
- **Modify** `src/renderer/src/lib/boardSchema.test.ts` — field round-trip + prune tests.
- **Create** `src/renderer/src/lib/previewTarget.ts` — pure `resolvePreviewTarget(boards, selectedId, fromId)`.
- **Create** `src/renderer/src/lib/previewTarget.test.ts`.
- **Create** `src/renderer/src/lib/previewEdges.ts` — pure `previewEdges(boards)` → edge descriptors.
- **Create** `src/renderer/src/lib/previewEdges.test.ts`.
- **Modify** `src/renderer/src/store/canvasStore.ts` — add `previewSourceId` to browser `PATCHABLE_KEYS`; clear dangling link on `removeBoard`; drop link on browser `duplicateBoard`.
- **Modify** `src/renderer/src/store/canvasStore.test.ts` — link cleanup tests.
- **Modify** `src/renderer/src/canvas/Icon.tsx` — add a `globe` icon.
- **Create** `src/renderer/src/canvas/edges/PreviewEdge.tsx` — RF floating edge component.
- **Modify** `src/renderer/src/canvas/BoardNode.tsx` — hidden edge-anchor handles + `onPushPreview` wiring.
- **Modify** `src/renderer/src/canvas/boardActions.ts` — `pushPreview` on the context.
- **Modify** `src/renderer/src/canvas/Canvas.tsx` — implement `pushPreview`; register `edgeTypes` + derived `edges`.
- **Modify** `src/renderer/src/canvas/boards/TerminalBoard.tsx` — Preview button + detect → toast/picker → `onPushPreview`.

**Verification commands** (this repo): targeted `pnpm vitest run <path>`; full gate `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`.

---

### Task 1: Add the `globe` icon

**Files:**
- Modify: `src/renderer/src/canvas/Icon.tsx:9-36` (IconName union) and `:41-69` (PATHS)

- [ ] **Step 1: Add `'globe'` to the `IconName` union**

In `src/renderer/src/canvas/Icon.tsx`, add the member to the union (after `'settings'`):

```ts
  | 'settings'
  | 'globe'
```

- [ ] **Step 2: Add the `globe` path to `PATHS`**

Add to the `PATHS` record (after the `settings` entry — remember to add a comma after the existing `settings` line):

```ts
  settings: 'M4 8h7M15 8h5M4 16h5M13 16h7M13 6v4M9 14v4',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18'
```

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS (no missing `IconName` key — `PATHS` is `Record<IconName, string>`, so a missing path would error).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/Icon.tsx
git commit -m "feat(icons): add globe icon for the preview action"
```

---

### Task 2: Pure port parser (`portDetect.ts`)

**Files:**
- Create: `src/main/portDetect.ts`
- Test: `src/main/portDetect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/portDetect.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parsePortsFromOutput } from './portDetect'

describe('parsePortsFromOutput', () => {
  it('returns [] for empty/garbage input', () => {
    expect(parsePortsFromOutput('')).toEqual([])
    expect(parsePortsFromOutput('no url here')).toEqual([])
  })

  it('parses a vite Local line with ANSI codes', () => {
    const raw = '\x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   http://localhost:5173/\r\n'
    expect(parsePortsFromOutput(raw)).toEqual([
      { url: 'http://localhost:5173', host: 'localhost', port: 5173 }
    ])
  })

  it('parses Next (3000), Django (127.0.0.1:8000), Flask (5000)', () => {
    expect(parsePortsFromOutput('- Local:  http://localhost:3000')[0].port).toBe(3000)
    expect(parsePortsFromOutput('Starting development server at http://127.0.0.1:8000/')[0]).toEqual(
      { url: 'http://127.0.0.1:8000', host: '127.0.0.1', port: 8000 }
    )
    expect(parsePortsFromOutput('Running on http://127.0.0.1:5000')[0].port).toBe(5000)
  })

  it('normalizes 0.0.0.0 / [::] to localhost', () => {
    expect(parsePortsFromOutput('listening http://0.0.0.0:4000')[0]).toEqual({
      url: 'http://localhost:4000',
      host: 'localhost',
      port: 4000
    })
  })

  it('dedupes by host:port and orders most-recent (latest in stream) first', () => {
    const raw = 'http://localhost:5173\nrebuild...\nhttp://localhost:5173\nhttp://localhost:4321'
    const out = parsePortsFromOutput(raw)
    expect(out.map((u) => u.port)).toEqual([4321, 5173])
  })

  it('rejects out-of-range ports', () => {
    expect(parsePortsFromOutput('http://localhost:99999')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/portDetect.test.ts`
Expected: FAIL — `Failed to resolve import './portDetect'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/portDetect.ts`:

```ts
/**
 * Pure dev-server URL detector (Slice C′). Reads raw PTY output (with ANSI codes)
 * and extracts the localhost URLs a dev server printed (`Local: http://...`). No
 * Electron/Node imports → unit-testable in the node env. Read-only by nature.
 */
export interface DetectedUrl {
  url: string
  host: string
  port: number
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const URL_RE = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{1,5}))?/gi

/** A host you can actually point a browser at — wildcard/any-address → localhost. */
function browsableHost(host: string): string {
  const h = host.toLowerCase()
  if (h === '0.0.0.0' || h === '[::]' || h === '[::1]') return 'localhost'
  return h
}

export function parsePortsFromOutput(raw: string): DetectedUrl[] {
  if (!raw) return []
  const text = raw.replace(ANSI, '')
  const found: { host: string; port: number; scheme: string; idx: number }[] = []
  for (const m of text.matchAll(URL_RE)) {
    const scheme = m[1].toLowerCase()
    const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    found.push({ host: browsableHost(m[2]), port, scheme, idx: m.index ?? 0 })
  }
  // Dedupe by host:port, keeping the LAST (most-recent) occurrence.
  const byKey = new Map<string, { host: string; port: number; scheme: string; idx: number }>()
  for (const f of found) {
    const key = `${f.host}:${f.port}`
    const prev = byKey.get(key)
    if (!prev || f.idx > prev.idx) byKey.set(key, f)
  }
  return [...byKey.values()]
    .sort((a, b) => b.idx - a.idx) // most-recent first
    .map((f) => ({ url: `${f.scheme}://${f.host}:${f.port}`, host: f.host, port: f.port }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/portDetect.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/portDetect.ts src/main/portDetect.test.ts
git commit -m "feat(main): pure dev-server URL parser (port detect)"
```

---

### Task 3: Schema field `BrowserBoard.previewSourceId`

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts` (BrowserBoard `:42-46`, assertBoard browser `:356-361`, fromObject `:372-393`)
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/renderer/src/lib/boardSchema.test.ts` (append inside the existing top-level `describe` or as new `describe` blocks; import helpers already present in that file — reuse its existing `toObject`/`fromObject` imports):

```ts
describe('BrowserBoard.previewSourceId (preview link)', () => {
  it('round-trips a valid previewSourceId through toObject/fromObject', () => {
    const term = createBoard('terminal', { id: 't1', x: 0, y: 0 })
    const browser = { ...createBoard('browser', { id: 'b1', x: 800, y: 0 }), previewSourceId: 't1' }
    const doc = toObject([term, browser], null)
    const back = fromObject(doc)
    const b = back.boards.find((x) => x.id === 'b1')
    expect(b && b.type === 'browser' ? b.previewSourceId : 'MISSING').toBe('t1')
  })

  it('prunes a dangling previewSourceId (source board absent) on load', () => {
    const browser = { ...createBoard('browser', { id: 'b1', x: 0, y: 0 }), previewSourceId: 'gone' }
    const back = fromObject(toObject([browser], null))
    const b = back.boards.find((x) => x.id === 'b1')
    expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBeUndefined()
  })

  it('rejects a non-string previewSourceId', () => {
    const bad = {
      schemaVersion: 2,
      viewport: null,
      boards: [{ ...createBoard('browser', { id: 'b1', x: 0, y: 0 }), previewSourceId: 7 }]
    }
    expect(() => fromObject(bad)).toThrow(/previewSourceId/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/renderer/src/lib/boardSchema.test.ts`
Expected: FAIL — round-trip returns `undefined`/`MISSING` (field stripped or not preserved) and the reject case does not throw.

- [ ] **Step 3: Add the field to the `BrowserBoard` interface**

In `src/renderer/src/lib/boardSchema.ts`, extend `BrowserBoard`:

```ts
export interface BrowserBoard extends BoardCommon {
  type: 'browser'
  url: string
  viewport: BrowserViewport
  /** Slice C′: the Terminal board id that pushed this preview (the link/arrow source). */
  previewSourceId?: string
}
```

- [ ] **Step 4: Validate the field in `assertBoard` (browser case)**

In the `case 'browser':` branch of `assertBoard`, add the check before `return`:

```ts
    case 'browser':
      if (typeof b.url !== 'string') fail('browser board is missing a string url')
      if (!VIEWPORTS.includes(b.viewport as BrowserViewport)) {
        fail(`browser board has an invalid viewport ${String(b.viewport)}`)
      }
      if (b.previewSourceId !== undefined && typeof b.previewSourceId !== 'string') {
        fail('browser previewSourceId is not a string')
      }
      return
```

- [ ] **Step 5: Prune dangling links in `fromObject`**

In `fromObject`, after the existing `MIN_BOARD_SIZE` clamp loop and before `const migrated = migrate(owned)`, add:

```ts
  // Drop a preview link whose source board is no longer present (Slice C′) — a
  // dangling link must not render a half-edge; clear it rather than fail the load.
  const ids = new Set(owned.boards.map((b) => b.id))
  for (const b of owned.boards) {
    if (b.type === 'browser' && b.previewSourceId && !ids.has(b.previewSourceId)) {
      delete b.previewSourceId
    }
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/lib/boardSchema.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git commit -m "feat(schema): BrowserBoard.previewSourceId (preview link) + validate + prune dangling"
```

---

### Task 4: Detect IPC + preload bridge

**Files:**
- Modify: `src/main/pty.ts` (`registerPtyHandlers` `:291`)
- Modify: `src/preload/index.ts` (`:54` types area, `:69` api terminal block)

- [ ] **Step 1: Add the `terminal:detectPorts` handler in MAIN**

In `src/main/pty.ts`, add at the top of `registerPtyHandlers` (next to `pty:shells`), and import the parser at the top of the file:

```ts
import { parsePortsFromOutput } from './portDetect'
```

```ts
  ipcMain.handle('terminal:detectPorts', (e, id: string) => {
    if (isForeignSender(e, getWin)) return []
    // Read whichever buffer holds this board's output — live session or parked.
    const raw = sessions.get(id)?.buf.data ?? parked.get(id)?.buf.data ?? ''
    return parsePortsFromOutput(raw)
  })
```

- [ ] **Step 2: Add the `DetectedUrl` type + bridge in preload**

In `src/preload/index.ts`, add the type near the other Phase-2.1 types (after `SpawnTerminalResult`, around `:33`):

```ts
/** A localhost URL detected from a terminal's dev-server output (Slice C′). */
export interface DetectedUrl {
  url: string
  host: string
  port: number
}
```

Then add the method inside the terminal block of `const api` (after `listShells`, around `:69`):

```ts
  // Slice C′: parse the dev-server URL(s) out of a board's PTY output (read-only).
  detectPorts: (id: string): Promise<DetectedUrl[]> =>
    ipcRenderer.invoke('terminal:detectPorts', id),
```

- [ ] **Step 3: Verify the parser test still passes and types compile**

Run: `pnpm vitest run src/main/portDetect.test.ts && pnpm typecheck`
Expected: PASS. (`window.api.detectPorts` is now typed via `CanvasApi = typeof api`.)

- [ ] **Step 4: Build to confirm MAIN + preload bundle**

Run: `pnpm build`
Expected: build succeeds (main + preload + renderer bundles emitted).

- [ ] **Step 5: Commit**

```bash
git add src/main/pty.ts src/preload/index.ts
git commit -m "feat(ipc): terminal:detectPorts (frame-guarded) + preload detectPorts bridge"
```

---

### Task 5: Pure target resolver + store link cleanup

**Files:**
- Create: `src/renderer/src/lib/previewTarget.ts`
- Test: `src/renderer/src/lib/previewTarget.test.ts`
- Modify: `src/renderer/src/store/canvasStore.ts` (`PATCHABLE_KEYS` `:161`, `removeBoard` `:187-193`, `duplicateBoard` `:204`)
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write the failing resolver test**

Create `src/renderer/src/lib/previewTarget.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createBoard, type Board } from './boardSchema'
import { resolvePreviewTarget } from './previewTarget'

const term = (id: string): Board => createBoard('terminal', { id, x: 0, y: 0 })
const browser = (id: string, src?: string): Board => ({
  ...createBoard('browser', { id, x: 0, y: 0 }),
  ...(src ? { previewSourceId: src } : {})
})

describe('resolvePreviewTarget', () => {
  it('follows an existing link from the source terminal', () => {
    const boards = [term('t1'), browser('b1'), browser('b2', 't1')]
    expect(resolvePreviewTarget(boards, 'b1', 't1')).toEqual({ kind: 'existing', id: 'b2' })
  })

  it('uses the selected browser when no link exists', () => {
    const boards = [term('t1'), browser('b1'), browser('b2')]
    expect(resolvePreviewTarget(boards, 'b2', 't1')).toEqual({ kind: 'existing', id: 'b2' })
  })

  it('uses the sole browser when none selected', () => {
    const boards = [term('t1'), browser('b1')]
    expect(resolvePreviewTarget(boards, null, 't1')).toEqual({ kind: 'existing', id: 'b1' })
  })

  it('spawns when there are zero or multiple unselected browsers', () => {
    expect(resolvePreviewTarget([term('t1')], null, 't1')).toEqual({ kind: 'spawn' })
    const many = [term('t1'), browser('b1'), browser('b2')]
    expect(resolvePreviewTarget(many, null, 't1')).toEqual({ kind: 'spawn' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/previewTarget.test.ts`
Expected: FAIL — cannot resolve `./previewTarget`.

- [ ] **Step 3: Implement the resolver**

Create `src/renderer/src/lib/previewTarget.ts`:

```ts
/**
 * Pure push-target resolution for the preview link (Slice C′): decide which Browser
 * board a terminal's "push to preview" should target. Order: follow an existing
 * link → currently-selected browser → the sole browser → spawn a fresh one.
 */
import type { Board } from './boardSchema'

export type PreviewTarget = { kind: 'existing'; id: string } | { kind: 'spawn' }

export function resolvePreviewTarget(
  boards: Board[],
  selectedId: string | null,
  fromId: string
): PreviewTarget {
  const linked = boards.find((b) => b.type === 'browser' && b.previewSourceId === fromId)
  if (linked) return { kind: 'existing', id: linked.id }

  const selected = boards.find((b) => b.id === selectedId && b.type === 'browser')
  if (selected) return { kind: 'existing', id: selected.id }

  const browsers = boards.filter((b) => b.type === 'browser')
  if (browsers.length === 1) return { kind: 'existing', id: browsers[0].id }

  return { kind: 'spawn' }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/previewTarget.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing store-cleanup test**

Add to `src/renderer/src/store/canvasStore.test.ts` (it already imports `useCanvasStore` and uses `get()`/`getState()` patterns — match the file's existing style):

```ts
describe('preview link cleanup', () => {
  it('keeps previewSourceId through updateBoard, and clears it when the source terminal is removed', () => {
    const { addBoard, updateBoard, removeBoard } = useCanvasStore.getState()
    // reset
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const termId = addBoard('terminal', { x: 0, y: 0 })
    const browserId = addBoard('browser', { x: 800, y: 0 })
    updateBoard(browserId, { previewSourceId: termId } as never)
    let b = useCanvasStore.getState().boards.find((x) => x.id === browserId)
    expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBe(termId)

    removeBoard(termId)
    b = useCanvasStore.getState().boards.find((x) => x.id === browserId)
    expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBeUndefined()
  })

  it('drops the link when a linked Browser board is duplicated', () => {
    const { addBoard, updateBoard, duplicateBoard } = useCanvasStore.getState()
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const termId = addBoard('terminal', { x: 0, y: 0 })
    const browserId = addBoard('browser', { x: 800, y: 0 })
    updateBoard(browserId, { previewSourceId: termId } as never)
    const cloneId = duplicateBoard(browserId)!
    const clone = useCanvasStore.getState().boards.find((x) => x.id === cloneId)
    expect(clone && clone.type === 'browser' ? clone.previewSourceId : 'X').toBeUndefined()
  })
})
```

- [ ] **Step 6: Run to verify the store tests fail**

Run: `pnpm vitest run src/renderer/src/store/canvasStore.test.ts`
Expected: FAIL — `previewSourceId` is stripped by `updateBoard` (not in `PATCHABLE_KEYS`), so the first assertion fails.

- [ ] **Step 7: Add `previewSourceId` to the browser patch allow-list**

In `src/renderer/src/store/canvasStore.ts`, extend the browser entry of `PATCHABLE_KEYS`:

```ts
  browser: [...COMMON_KEYS, 'url', 'viewport', 'previewSourceId'],
```

- [ ] **Step 8: Clear dangling links in `removeBoard`**

Replace the `removeBoard` action body:

```ts
  removeBoard: (id) =>
    set((s) => ({
      past: recordPast(s.past, s.boards),
      future: [],
      boards: s.boards
        .filter((b) => b.id !== id)
        // Clear a preview link whose source terminal was just removed (Slice C′).
        .map((b) =>
          b.type === 'browser' && b.previewSourceId === id
            ? { ...b, previewSourceId: undefined }
            : b
        ),
      selectedId: s.selectedId === id ? null : s.selectedId
    })),
```

- [ ] **Step 9: Drop the link when a Browser clone is made**

In `duplicateBoard`, change the browser-clone branch:

```ts
    if (clone.type === 'browser') {
      clone.viewport = nextViewport(clone.viewport)
      delete clone.previewSourceId // a copy starts unlinked (Slice C′)
    }
```

- [ ] **Step 10: Run store tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/store/canvasStore.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/lib/previewTarget.ts src/renderer/src/lib/previewTarget.test.ts src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -m "feat(store): preview target resolver + link cleanup on remove/duplicate"
```

---

### Task 6: Pure edge derivation (`previewEdges.ts`)

**Files:**
- Create: `src/renderer/src/lib/previewEdges.ts`
- Test: `src/renderer/src/lib/previewEdges.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/previewEdges.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createBoard, type Board } from './boardSchema'
import { previewEdges } from './previewEdges'

const term = (id: string): Board => createBoard('terminal', { id, x: 0, y: 0 })
const linkedBrowser = (id: string, src?: string): Board => ({
  ...createBoard('browser', { id, x: 0, y: 0 }),
  ...(src ? { previewSourceId: src } : {})
})

describe('previewEdges', () => {
  it('emits one edge per linked browser with a present source', () => {
    const boards = [term('t1'), linkedBrowser('b1', 't1'), linkedBrowser('b2')]
    expect(previewEdges(boards)).toEqual([
      { id: 'preview-b1', source: 't1', target: 'b1', type: 'preview' }
    ])
  })

  it('omits edges for a dangling source', () => {
    expect(previewEdges([linkedBrowser('b1', 'gone')])).toEqual([])
  })

  it('returns [] when nothing is linked', () => {
    expect(previewEdges([term('t1'), linkedBrowser('b1')])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/previewEdges.test.ts`
Expected: FAIL — cannot resolve `./previewEdges`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/lib/previewEdges.ts`:

```ts
/**
 * Pure derivation of preview-link edges (Slice C′) from board state: one edge per
 * Browser board that has a present `previewSourceId`. DOM/React-Flow free so it is
 * unit-testable; Canvas decorates these with a marker and the custom edge type.
 */
import type { Board } from './boardSchema'

export interface PreviewEdgeDesc {
  id: string
  source: string
  target: string
  type: 'preview'
}

export function previewEdges(boards: Board[]): PreviewEdgeDesc[] {
  const ids = new Set(boards.map((b) => b.id))
  const edges: PreviewEdgeDesc[] = []
  for (const b of boards) {
    if (b.type !== 'browser') continue
    const src = b.previewSourceId
    if (src && ids.has(src)) {
      edges.push({ id: `preview-${b.id}`, source: src, target: b.id, type: 'preview' })
    }
  }
  return edges
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/previewEdges.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/previewEdges.ts src/renderer/src/lib/previewEdges.test.ts
git commit -m "feat(lib): pure preview-edge derivation from board links"
```

---

### Task 7: Floating edge component + anchors + Canvas wiring

> RF v12 reliably renders an edge only when its source/target nodes expose handles. We add hidden, non-connectable anchor handles to every BoardNode render path and a custom **floating** edge that computes a border-to-border bezier from node geometry (so the line doesn't pass through board bodies). Spike note: if a handleless floating edge renders in your RF build, the hidden handles can be dropped — ship with them for reliability.

**Files:**
- Create: `src/renderer/src/canvas/edges/PreviewEdge.tsx`
- Modify: `src/renderer/src/canvas/BoardNode.tsx` (imports `:11-13`, LOD return `:111-124`, main return `:143-169`)
- Modify: `src/renderer/src/canvas/Canvas.tsx` (imports `:1-48`, `nodeTypes` `:49`, derived edges in `CanvasInner`, `<ReactFlow>` props `:311-328`)

- [ ] **Step 1: Create the floating edge component**

Create `src/renderer/src/canvas/edges/PreviewEdge.tsx`:

```tsx
/**
 * Preview-link connector (Slice C′): a calm accent bezier from a Terminal board to
 * the Browser board it pushed a preview into. "Floating" — endpoints are computed
 * from the two nodes' live geometry (border intersection), so the arrow touches the
 * board edges and reroutes for free when either board moves. No handle UX.
 *
 * Occlusion (ADR 0002): where this SVG crosses a Browser's native WebContentsView it
 * paints under it; endpoints land on board borders (HTML chrome), and native views
 * detach→snapshot during motion, so the arrow shows while dragging. Accepted.
 */
import { BaseEdge, getBezierPath, useInternalNode, Position, type EdgeProps } from '@xyflow/react'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function box(positionAbsolute: { x: number; y: number }, w: number, h: number): Box {
  return { x: positionAbsolute.x + w / 2, y: positionAbsolute.y + h / 2, w, h }
}

/** Point on `from`'s border along the line toward `to`'s center. */
function borderPoint(from: Box, to: Box): { x: number; y: number } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y }
  const sx = from.w / 2
  const sy = from.h / 2
  const scale = 1 / Math.max(Math.abs(dx) / sx, Math.abs(dy) / sy)
  return { x: from.x + dx * scale, y: from.y + dy * scale }
}

export function PreviewEdge({ id, source, target, markerEnd, style }: EdgeProps): React.ReactElement | null {
  const s = useInternalNode(source)
  const t = useInternalNode(target)
  if (!s || !t) return null
  const sBox = box(s.internals.positionAbsolute, s.measured.width ?? 0, s.measured.height ?? 0)
  const tBox = box(t.internals.positionAbsolute, t.measured.width ?? 0, t.measured.height ?? 0)
  const sp = borderPoint(sBox, tBox)
  const tp = borderPoint(tBox, sBox)
  const [path] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    targetX: tp.x,
    targetY: tp.y,
    sourcePosition: Position.Right,
    targetPosition: Position.Left
  })
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={{ stroke: 'var(--accent)', strokeWidth: 1.5, opacity: 0.9, ...style }}
    />
  )
}
```

- [ ] **Step 2: Add hidden anchor handles to BoardNode (both render paths)**

In `src/renderer/src/canvas/BoardNode.tsx`, add `Handle` + `Position` to the existing `@xyflow/react` import (`:13`):

```ts
import { NodeResizer, useStore, Handle, Position, type Node, type NodeProps } from '@xyflow/react'
```

Add this module-level constant + component after the imports (before `BoardNodeData`):

```tsx
/** Hidden, non-connectable anchor handles so RF can attach the preview edge to any
 *  board without exposing a connection UX or stealing pointer events (Slice C′). */
const HIDDEN_HANDLE = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 'none',
  background: 'transparent',
  pointerEvents: 'none' as const
}
function EdgeAnchors(): ReactElement {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
    </>
  )
}
```

In the LOD early-return (the `<div>` returned when `lod && board.type !== 'terminal' && !fullView`), add `<EdgeAnchors />` as the first child inside that div:

```tsx
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <EdgeAnchors />
        <BoardFrame
          type={board.type}
          title={board.title}
          selected={selected}
          dimmed={dimmed}
          lod
          status={lodStatus(board.type)}
        />
      </div>
```

In the main return fragment, add `<EdgeAnchors />` alongside the `NodeResizer` (so it's present in the non-portaled node body):

```tsx
  return (
    <>
      <EdgeAnchors />
      {/* Hidden in LOD: the design shows no resize handles on LOD cards. */}
      {!lod && (
        <NodeResizer
```

- [ ] **Step 3: Register edge type + derive edges in Canvas**

In `src/renderer/src/canvas/Canvas.tsx`, add imports near the other canvas imports (`:40-48` area):

```ts
import { MarkerType, type EdgeTypes } from '@xyflow/react'
import { PreviewEdge } from './edges/PreviewEdge'
import { previewEdges } from '../lib/previewEdges'
```

Add the edge-types map next to `nodeTypes` (`:49`):

```ts
const nodeTypes: NodeTypes = { board: BoardNode }
const edgeTypes: EdgeTypes = { preview: PreviewEdge }
```

Inside `CanvasInner`, after the `nodes` `useMemo` (`:104-...`), derive edges:

```tsx
  // Preview-link arrows (Slice C′): one accent connector per Browser board linked to
  // a Terminal. Decorated here with an arrowhead; the path is computed by PreviewEdge.
  const edges = useMemo(
    () =>
      previewEdges(boards).map((e) => ({
        ...e,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#4f8cff', width: 16, height: 16 }
      })),
    [boards]
  )
```

Pass `edges` + `edgeTypes` to `<ReactFlow>` (add the two props alongside `nodes`/`nodeTypes`):

```tsx
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onPaneClick={clearSelection}
```

- [ ] **Step 4: Verify typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS. (Edges render is verified manually in Task 10 / the gate; the derivation logic is unit-tested in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/edges/PreviewEdge.tsx src/renderer/src/canvas/BoardNode.tsx src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(canvas): floating preview-link edge + hidden anchors + RF edges wiring"
```

---

### Task 8: `pushPreview` board action

**Files:**
- Modify: `src/renderer/src/canvas/boardActions.ts:5-9`
- Modify: `src/renderer/src/canvas/BoardNode.tsx` (BoardViewProps `:56-61`, actions wiring `:82-85`)
- Modify: `src/renderer/src/canvas/Canvas.tsx` (imports + `boardActions` memo `:192-209`)

- [ ] **Step 1: Add `pushPreview` to the BoardActions interface**

In `src/renderer/src/canvas/boardActions.ts`:

```ts
export interface BoardActions {
  requestFullView: (id: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
  /** Slice C′: open/point a Browser board at `url` and link it to the source board. */
  pushPreview: (fromBoardId: string, url: string) => void
}
```

- [ ] **Step 2: Add `onPushPreview` to BoardViewProps + wire it in BoardNode**

In `src/renderer/src/canvas/BoardNode.tsx`, add to `BoardViewProps`:

```ts
  /** Terminal "Preview" action → open/point a linked Browser board at `url`. */
  onPushPreview?: (url: string) => void
```

In the `BoardNode` body where the other callbacks are built (`:82-85`):

```ts
  const onFull = acts ? (): void => acts.requestFullView(board.id) : undefined
  const onDuplicate = acts ? (): void => acts.duplicate(board.id) : undefined
  const onDelete = acts ? (): void => acts.remove(board.id) : undefined
  const onPushPreview = acts ? (url: string): void => acts.pushPreview(board.id, url) : undefined
  const actions = { onFull, onDuplicate, onDelete, onPushPreview }
```

(`actions` is spread to all three board components; Browser/Planning ignore the extra optional prop.)

- [ ] **Step 3: Implement `pushPreview` in Canvas**

In `src/renderer/src/canvas/Canvas.tsx`, add imports:

```ts
import { resolvePreviewTarget } from '../lib/previewTarget'
import type { Board } from '../lib/boardSchema'
```

Extend the `boardActions` `useMemo` object (add the method; keep the existing `requestFullView`/`duplicate`/`remove`):

```tsx
      pushPreview: (fromBoardId, url) => {
        const st = useCanvasStore.getState()
        const from = st.boards.find((b) => b.id === fromBoardId)
        if (!from) return
        const target = resolvePreviewTarget(st.boards, st.selectedId, fromBoardId)
        const patch = { url, previewSourceId: fromBoardId } as Partial<Board>
        if (target.kind === 'existing') {
          st.updateBoard(target.id, patch)
          st.selectBoard(target.id)
        } else {
          const id = st.addBoard('browser', { x: from.x + from.w + 40, y: from.y })
          st.updateBoard(id, patch)
          st.selectBoard(id)
        }
        setFullViewId(null)
      }
```

Add `selectBoard`/`addBoard` are read via `useCanvasStore.getState()` above (no new hook subscriptions needed); the memo's dependency array stays as-is (it already closes over `duplicateBoard`/`removeBoard`; `getState()` is always current). Ensure `setFullViewId` is in scope (it is — defined in `CanvasInner`). Leave the dep array unchanged.

- [ ] **Step 4: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boardActions.ts src/renderer/src/canvas/BoardNode.tsx src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(canvas): pushPreview action — resolve target + set url/link"
```

---

### Task 9: Terminal Preview button (detect → toast/picker → push)

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx` (props destructure, `actions` JSX `:463-473`, content)

- [ ] **Step 1: Accept the `onPushPreview` prop**

In `src/renderer/src/canvas/boards/TerminalBoard.tsx`, add `onPushPreview` to the component's destructured `BoardViewProps` (find where `onFull`, `onDuplicate`, `onDelete` are destructured from props and add it alongside).

- [ ] **Step 2: Add detect state + handler**

Add near the other `useState`/`useCallback` hooks in the component (and ensure `useState`/`useCallback` are imported — they already are at `:16`):

```tsx
  // Slice C′: detected dev-server URLs (picker when >1) + a transient "not found" note.
  type DetectedUrl = { url: string; host: string; port: number }
  const [portChoices, setPortChoices] = useState<DetectedUrl[]>([])
  const [previewNote, setPreviewNote] = useState<string | null>(null)

  const onPreview = useCallback(async () => {
    setPreviewNote(null)
    const urls = await window.api.detectPorts(board.id)
    if (urls.length === 0) {
      setPreviewNote('No dev server detected yet — start it, then try again.')
      return
    }
    if (urls.length === 1) {
      onPushPreview?.(urls[0].url)
      return
    }
    setPortChoices(urls)
  }, [board.id, onPushPreview])
```

- [ ] **Step 3: Add the Preview button to the title-bar actions**

In the `actions` JSX block (`:463-473`), add the Preview button (before Configure):

```tsx
  const actions = (
    <>
      {running && <IconBtn name="stop" title="Interrupt (Ctrl-C)" onClick={interrupt} />}
      <IconBtn name="globe" title="Open preview from this server" onClick={() => void onPreview()} />
      <IconBtn
        name="settings"
        title="Configure terminal"
        onClick={() => setConfigOpen((v) => !v)}
      />
      <IconBtn name="restart" title="Restart" onClick={restart} />
    </>
  )
```

- [ ] **Step 4: Render the picker + note**

Inside the content well (inside the `<div style={lod ? shellHidden : shell}>` block, alongside `{configOpen && <TerminalConfig .../>}`), add a small overlay. Place it right after the `TerminalConfig` line:

```tsx
          {previewNote && (
            <div className="ca-preview-note" role="status" onMouseDown={(e) => e.stopPropagation()}>
              {previewNote}
              <button className="ca-preview-dismiss" onClick={() => setPreviewNote(null)}>
                Dismiss
              </button>
            </div>
          )}
          {portChoices.length > 1 && (
            <div className="ca-port-picker nodrag" onMouseDown={(e) => e.stopPropagation()}>
              <div className="ca-port-picker-title">Multiple servers — choose one:</div>
              {portChoices.map((u) => (
                <button
                  key={u.url}
                  className="ca-port-choice"
                  onClick={() => {
                    setPortChoices([])
                    onPushPreview?.(u.url)
                  }}
                >
                  {u.host}:{u.port}
                </button>
              ))}
              <button className="ca-preview-dismiss" onClick={() => setPortChoices([])}>
                Cancel
              </button>
            </div>
          )}
```

- [ ] **Step 5: Add styles for the note + picker**

Append to `src/renderer/src/index.css` (calm Linear-Raycast tokens, match existing classes):

```css
/* Slice C′ — preview port note + picker (Terminal board overlay). */
.ca-preview-note,
.ca-port-picker {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  z-index: 4;
  background: var(--surface-overlay);
  border: 1px solid var(--border);
  border-radius: var(--r-ctl);
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-2);
  box-shadow: var(--shadow-board);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ca-port-picker-title {
  color: var(--text-3);
  font-size: 11px;
}
.ca-port-choice {
  text-align: left;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-ctl);
  padding: 6px 8px;
  cursor: pointer;
}
.ca-port-choice:hover {
  border-color: var(--accent);
}
.ca-preview-dismiss {
  align-self: flex-end;
  font-size: 11px;
  color: var(--text-3);
  background: transparent;
  border: none;
  cursor: pointer;
}
```

- [ ] **Step 6: Verify typecheck + build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx src/renderer/src/index.css
git commit -m "feat(terminal): Preview button — detect ports, toast/picker, push to linked preview"
```

---

### Task 10: Full verification gate + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
Expected: all PASS. If `format:check` fails, run `pnpm format` (or `pnpm exec prettier --write .`) on the changed files and re-run; commit the formatting.

- [ ] **Step 2: Manual smoke (dev)**

Run: `pnpm dev`. Then:
- Add a Terminal board; in it run a dev server (e.g. `python -m http.server 8000`, or any `npm run dev`).
- Click the **Preview** (globe) button → a Browser board opens/points at `http://localhost:8000` (or the detected port) and a connector arrow appears Terminal → Browser.
- Drag either board → the arrow reroutes live.
- Click Preview again → it re-points the **same** Browser (follows the link).
- Click Preview on a terminal with no server → the "not detected yet" note shows.
- Delete the Terminal → the arrow disappears; delete/duplicate the Browser → clone is unlinked.
- Reload/reopen the project → the Browser keeps its URL + the arrow (link persisted).

- [ ] **Step 3: Final commit (if any formatting/cleanup)**

```bash
git add -A
git commit -m "chore(phase-3): Slice C' port-detect preview — gate green"
```

---

## Self-review checklist (completed by plan author)

- **Spec coverage:** detect (Task 2/4) · Preview button + 0/1/many (Task 9) · target follow-link/reuse/spawn (Task 5/8) · `previewSourceId` + no bump + prune (Task 3) · arrow render + reroute (Task 6/7) · cleanup on delete/duplicate (Task 5) · security frame-guard (Task 4) · tests for parser/resolver/edges/schema/store (Tasks 2,3,5,6) · full gate (Task 10). All spec sections map to a task.
- **Placeholders:** none — every code/test step shows complete content.
- **Type consistency:** `DetectedUrl` (preload + mirrored in TerminalBoard) ↔ `parsePortsFromOutput` return ✓; `PreviewTarget`/`resolvePreviewTarget` ✓; `PreviewEdgeDesc`/`previewEdges` ✓; `pushPreview(fromBoardId, url)` identical in `BoardActions`, `BoardNode` wiring, Canvas impl, TerminalBoard call ✓; `previewSourceId` field/key/patch consistent across schema + `PATCHABLE_KEYS` + store ✓.
