/**
 * In-process E2E renderer hook. When the page is in e2e mode this installs
 * `window.__canvasE2E` — a tiny imperative surface the Playwright `_electron` harness
 * drives via `page.evaluate` (T4): seed boards through the real Zustand store, read
 * board/runtime state back, read a terminal's framebuffer, fit the camera, and reset
 * the canvas between tests. All return values are JSON-serializable so they survive the
 * evaluate bridge.
 *
 * Installed from CanvasInner (which owns the React Flow instance) and guarded by
 * isE2E(); a no-op in every normal run.
 */
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { useTerminalRuntimeStore } from '../store/terminalRuntimeStore'
import { boardStatusBucket, bucketToPill } from '../store/boardStatus'
import {
  fromObject,
  type Board,
  type BoardType,
  type Connector,
  type ConnectorKind
} from '../lib/boardSchema'
import type { Tool } from '../store/canvasStore'
import { resolveConnectTarget } from '../lib/resolveConnectTarget'
import type { TidyMode } from '../lib/tidyLayout'
import type { TileTemplate } from '../lib/tileLayout'
import { makeChecklist } from '../canvas/boards/planning/elements'
import { e2eTerminals, e2eTerminalInput } from './e2eRegistry'
import { disposeLiveResources } from '../store/disposeLiveResources'

/** Per-board runtime fields the harness asserts on (subset of PreviewRuntime). */
interface RuntimeProbe {
  status: string
  live: boolean
}

export interface CanvasE2E {
  /** Add a board at an auto-incremented world x; optionally patch durable props. */
  seedBoard: (type: BoardType, patch?: Partial<Board>) => string
  /** Current boards (plain data — serializable). */
  getBoards: () => Board[]
  /** Browser preview runtime for a board id, or null if none yet. */
  getRuntime: (id: string) => RuntimeProbe | null
  /** Whole xterm framebuffer for a terminal board id, or null if not registered. */
  readTerminal: (id: string) => string | null
  /** Concatenated bytes the terminal posted to its PTY since the last clear (e2e). */
  readTerminalInput: (id: string) => string
  /** Drop a terminal's recorded input log (call before driving a key probe). */
  clearTerminalInput: (id: string) => void
  /** Focus a terminal's xterm so real key input lands on it. */
  focusTerminal: (id: string) => void
  /**
   * Dispatch a synthetic keydown on a terminal's xterm helper-textarea, with explicit
   * modifier flags. xterm's customKeyEventHandler does not check isTrusted, so this
   * reliably drives chord probes (Shift+Enter / Ctrl+C / Ctrl+V) — unlike sendInputEvent
   * keyboard modifiers, which are flaky for chords (memory e2e-modifier-keys-synthetic).
   */
  dispatchTerminalKey: (
    id: string,
    init: { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }
  ) => boolean
  /** Programmatically select `length` cells from (col,row) in a terminal (copy sliver). */
  selectTerminal: (id: string, col: number, row: number, length: number) => void
  /** The terminal's current selection text (assert against the clipboard). */
  terminalSelection: (id: string) => string
  /** Reset a terminal's buffer and write known text (selection-shim sliver). */
  resetTerminalWrite: (id: string, text: string) => void
  /**
   * Screen-pixel point inside cell (col,row) for a terminal, from the SCALED screen rect.
   * `fx`/`fy` are the intra-cell fractions (0..1, default 0.5 = center). Use a non-center
   * fraction to land UNAMBIGUOUSLY inside a cell — xterm rounds at the exact half-cell
   * boundary (ceil), so a cell-center start can resolve to either neighbouring cell.
   */
  terminalCellPoint: (
    id: string,
    col: number,
    row: number,
    fx?: number,
    fy?: number
  ) => { x: number; y: number } | null
  /** Append a checklist element (one starter item) to a planning board. */
  addChecklist: (id: string) => void
  /** Patch durable props on any board — e.g. change a terminal's launchCommand to force a respawn. */
  patchBoard: (id: string, patch: Partial<Board>) => void
  /** Fit the camera to one board (id) or all boards — forces zoom ≥ LOD for capture. */
  fitView: (id?: string) => void
  /** Auto-tidy: repack every board with `mode` (default smart); `aspect` steers grid. */
  tidy: (mode?: TidyMode, aspect?: number) => void
  /** Tile: resize + move every board to fill zones of `area` with `template`. */
  tile: (template: TileTemplate, area: { x: number; y: number; w: number; h: number }) => void
  /**
   * T1.6 — the LIVE coarse status bucket for a board (the SAME value `buildBoardSnapshot`
   * pushes to MCP `canvas://boards`), or null if the board is gone. Lets the board-chrome
   * probe assert the on-canvas pill agrees with the agent-facing bucket.
   */
  boardBucket: (id: string) => string | null
  /** T1.6 — the pill dot colour token for a bucket (the `bucketToPill` dot, or null). */
  bucketPillDot: (bucket: string) => string | null
  /** Set the active dock tool (arms a board type or returns to 'select'). */
  setTool: (tool: Tool) => void
  /** Get the active dock tool. */
  getTool: () => Tool
  /** Set the absolute camera zoom (z < LOD_ZOOM forces LOD on every board). */
  setZoom: (z: number) => void
  /** Pan the camera by a screen-pixel delta (used to push a board's chrome past a window edge). Bug 14. */
  panBy: (dx: number, dy: number) => void
  /** True if a terminal board's xterm instance is currently mounted (registered). */
  terminalMounted: (id: string) => boolean
  /** True if the live store round-trips through toObject→fromObject without throwing. */
  roundTripOk: () => boolean
  /** M2: add a connector between two boards; returns its id (null if rejected). */
  addConnector: (sourceId: string, targetId: string, kind?: ConnectorKind) => string | null
  /** M2: the live in-memory connectors (plain data — serializable). */
  getConnectors: () => Connector[]
  /** M2: remove a connector by id (probe cleanup). */
  removeConnector: (id: string) => void
  /** M2: connector count that survives a toObject→fromObject round-trip. */
  serializedConnectorCount: () => number
  /** M2: arm a connector drag from `fromId` (mirrors the title-bar handle's pointer-down). */
  startConnect: (fromId: string) => void
  /**
   * M2: complete the armed connector drag at a FLOW (world) point — runs the SAME
   * resolution path as the real pointer-up (resolveConnectTarget → addConnector). Returns
   * the new connector id, or null if the point hit no (other) board.
   */
  completeConnectAt: (flowX: number, flowY: number) => string | null
  /** M2: select an orchestration connector (drives the ✕ affordance + Delete-key path). */
  selectConnector: (id: string | null) => void
  /** Flag a node drag/resize gesture (drives the preview layer detach/reattach). */
  setGesture: (active: boolean) => void
  /** Delete a board the way the canvas does (parks a terminal's session first). */
  deleteBoard: (id: string) => void
  /** Duplicate a board (store path); returns the clone id (null if the source is gone). */
  duplicateBoard: (id: string) => string | null
  /** Undo the last store change (restores a deleted board → adopt path). */
  undo: () => void
  /** Open/close the full-view modal for a board id (null clears). Bug 1/4 harness. */
  setFullView: (id: string | null) => void
  /**
   * Open full view via the REAL animated path (sets `fullViewEntering` → `fullViewMotion`),
   * unlike `setFullView` which jumps the raw id setter and never triggers motion. The
   * full-view motion branch is where a Browser view is held across the tween — exercising
   * it is the only way the harness reaches the close-vs-detach-during-motion path.
   */
  openFullViewAnimated: (id: string) => void
  /** Close full view via the real animated exit path (sets `fullViewClosing`). */
  closeFullViewAnimated: () => void
  /** Mark a terminal's PTY as exited in the runtime store (drives stale preview edge, bug 3). */
  setTerminalDown: (id: string) => void
  /** Focus a board (dim others) or clear focus (null) — the double-click focus path. Bug 2. */
  setFocus: (id: string | null) => void
  /** Open the digest panel (T-D2). */
  openDigest(): void
  /** Close the digest panel (T-D2). */
  closeDigest(): void
  /** Enter Planning camera-full-view (Option A: fitView the board, no portal/2nd transform). */
  enterCameraFullView: (id: string) => void
  /** Exit Planning camera-full-view (restore the prior viewport). */
  exitCameraFullView: () => void
  /** W5: build the export artifact (SVG + PNG bytes) for a planning board WITHOUT the
   *  save dialog — returns a JSON-serializable summary for the harness to assert. */
  exportBoard: (
    boardId: string,
    format: 'png' | 'svg'
  ) => Promise<{
    svg: string
    byteLength: number
    imageCount: number
    embeddedCount: number
  } | null>
  /**
   * Instant (duration 0) camera fit onto a board, matching Canvas FULLVIEW_OPTIONS. Lets
   * the fullview-add probe re-fit each poll tick: RF measures freshly-resized nodes lazily,
   * so the single animated fit from `enterCameraFullView` can no-op on a slow/contended CI
   * host (zoom stays ~1). An instant re-fit per tick lands deterministically once RF has
   * measured the node. Memory `e2e-rf-measurement-race`.
   */
  fitCameraInstant: (id: string) => void
  /**
   * Return the app to an empty canvas for test isolation (T4 Playwright beforeEach):
   * clear full-view/focus UI modes, tear down every native preview view + PTY tree
   * (live AND parked), empty the store + history, and reset the seed-x cursor.
   */
  reset: () => Promise<{ ok: true }>
  /**
   * Serialize the live store to a canvas.json string (the store's toObject). The
   * corrupt-doc recovery probe writes this as a good `canvas.json.bak`, then corrupts
   * the primary, to prove the renderer recovers the last-good snapshot on reopen.
   */
  serializeDoc: () => string
  /**
   * Drive the REAL disk-open recovery cascade for a project dir: invoke the
   * `project:open` IPC, then run the store's `applyOpenResult` — which deep-validates
   * via fromObject, retries `canvas.json.bak` on a deep-corrupt-but-envelope-valid
   * primary (`project:reopenFromBak`), and routes an unrecoverable doc to
   * status:'error'. Returns the resulting project status/error + live board count so
   * the probe can assert recovery-to-open vs the error card. e2e bypasses the
   * WelcomeScreen open flow, so this is the only way the harness reaches the path.
   */
  openProjectFromDisk: (
    dir: string
  ) => Promise<{ status: string; error: string | null; boardCount: number }>
}

/** Extra renderer setters the hook needs that aren't on a store (CanvasInner state). */
export interface E2EHostHooks {
  setFullView: (id: string | null) => void
  openFullViewAnimated: (id: string) => void
  closeFullViewAnimated: () => void
  setFocus: (id: string | null) => void
  setDigestOpen(open: boolean): void
  enterCameraFullView: (id: string) => void
  exitCameraFullView: () => void
  /** M2: select an orchestration connector (CanvasInner state) for the ✕/Delete path. */
  selectConnector: (id: string | null) => void
}

declare global {
  interface Window {
    __canvasE2E?: CanvasE2E
  }
}

let seedX = 0
/** M2: the source board of an in-flight harness-driven connector drag (startConnect). */
let connectFrom: string | null = null

export function installE2EHooks(rf: ReactFlowInstance, host: E2EHostHooks): void {
  seedX = 0 // reset the seed cursor so a re-install (e.g. HMR) starts fresh + idempotent
  const api: CanvasE2E = {
    seedBoard(type, patch) {
      const store = useCanvasStore.getState()
      const id = store.addBoard(type, { x: seedX, y: 0 })
      seedX += 760 // wider than the largest default board (browser 700) → no overlap
      if (patch) store.updateBoard(id, patch)
      return id
    },
    getBoards() {
      return useCanvasStore.getState().boards
    },
    getRuntime(id) {
      const r = usePreviewStore.getState().byId[id]
      return r ? { status: r.status, live: r.live } : null
    },
    readTerminal(id) {
      const term = e2eTerminals.get(id)
      if (!term) return null
      const buf = term.buffer.active
      let out = ''
      for (let i = 0; i < buf.length; i++) {
        out += (buf.getLine(i)?.translateToString(true) ?? '') + '\n'
      }
      return out
    },
    readTerminalInput(id) {
      return (e2eTerminalInput.get(id) ?? []).join('')
    },
    clearTerminalInput(id) {
      e2eTerminalInput.delete(id)
    },
    focusTerminal(id) {
      e2eTerminals.get(id)?.focus()
    },
    dispatchTerminalKey(id, init) {
      const ta = document.querySelector(
        `.react-flow__node[data-id="${id}"] .xterm-helper-textarea`
      )
      if (!ta) return false
      ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
      return true
    },
    selectTerminal(id, col, row, length) {
      e2eTerminals.get(id)?.select(col, row, length)
    },
    terminalSelection(id) {
      return e2eTerminals.get(id)?.getSelection() ?? ''
    },
    resetTerminalWrite(id, text) {
      const t = e2eTerminals.get(id)
      if (!t) return
      t.reset()
      t.write(text)
    },
    terminalCellPoint(id, col, row, fx = 0.5, fy = 0.5) {
      const t = e2eTerminals.get(id)
      if (!t) return null
      const host = document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-screen`)
      if (!host) return null
      const r = host.getBoundingClientRect()
      // The screen element width/height map exactly to cols/rows (no padding here), so
      // a scaled cell is r.width/cols × r.height/rows. Place the point at the requested
      // intra-cell fraction (default center).
      const cw = r.width / t.cols
      const ch = r.height / t.rows
      return { x: r.left + (col + fx) * cw, y: r.top + (row + fy) * ch }
    },
    addChecklist(id) {
      const store = useCanvasStore.getState()
      const b = store.boards.find((x) => x.id === id)
      if (!b || b.type !== 'planning') return
      const cl = makeChecklist(crypto.randomUUID(), crypto.randomUUID(), { x: 60, y: 60 })
      store.updateBoard(id, { elements: [...b.elements, cl] })
    },
    patchBoard(id, patch) {
      useCanvasStore.getState().updateBoard(id, patch)
    },
    fitView(id) {
      const opts = { maxZoom: 1, padding: 0.2, duration: 0 } as const
      void rf.fitView(id ? { ...opts, nodes: [{ id }] } : opts)
    },
    tidy(mode, aspect) {
      useCanvasStore.getState().tidyBoards(mode, aspect)
    },
    tile(template, area) {
      useCanvasStore.getState().tileBoards(template, area)
    },
    boardBucket(id) {
      const board = useCanvasStore.getState().boards.find((b) => b.id === id)
      if (!board) return null
      return boardStatusBucket(board.type, {
        terminalRunning: useTerminalRuntimeStore.getState().running[id],
        preview: usePreviewStore.getState().byId[id]?.status
      })
    },
    bucketPillDot(bucket) {
      // Cast: the harness passes a string; bucketToPill only reads known keys (others → null).
      return bucketToPill(bucket as Parameters<typeof bucketToPill>[0])?.dot ?? null
    },
    setTool: (tool) => useCanvasStore.getState().setTool(tool),
    getTool: () => useCanvasStore.getState().tool,
    setZoom(z) {
      void rf.zoomTo(z, { duration: 0 })
    },
    panBy(dx, dy) {
      const vp = rf.getViewport()
      void rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 0 })
    },
    terminalMounted(id) {
      return e2eTerminals.has(id)
    },
    roundTripOk() {
      try {
        fromObject(useCanvasStore.getState().toObject())
        return true
      } catch {
        return false
      }
    },
    addConnector(sourceId, targetId, kind = 'orchestration') {
      return useCanvasStore.getState().addConnector(sourceId, targetId, kind)
    },
    getConnectors() {
      return useCanvasStore.getState().connectors
    },
    removeConnector(id) {
      useCanvasStore.getState().removeConnector(id)
    },
    serializedConnectorCount() {
      return fromObject(useCanvasStore.getState().toObject()).connectors.length
    },
    startConnect(fromId) {
      connectFrom = fromId
    },
    completeConnectAt(flowX, flowY) {
      if (!connectFrom) return null
      const boards = useCanvasStore.getState().boards
      const target = resolveConnectTarget(boards, connectFrom, { x: flowX, y: flowY })
      const id = target
        ? useCanvasStore.getState().addConnector(connectFrom, target, 'orchestration')
        : null
      connectFrom = null
      return id
    },
    selectConnector(id) {
      host.selectConnector(id)
    },
    setGesture(active) {
      usePreviewStore.getState().setNodeGesture(active)
    },
    deleteBoard(id) {
      const b = useCanvasStore.getState().boards.find((x) => x.id === id)
      if (b?.type === 'terminal') void window.api.parkTerminal(id)
      useCanvasStore.getState().removeBoard(id)
    },
    duplicateBoard(id) {
      return useCanvasStore.getState().duplicateBoard(id)
    },
    undo() {
      useCanvasStore.getState().undo()
    },
    setFullView(id) {
      host.setFullView(id)
    },
    openFullViewAnimated(id) {
      host.openFullViewAnimated(id)
    },
    closeFullViewAnimated() {
      host.closeFullViewAnimated()
    },
    setTerminalDown(id) {
      useTerminalRuntimeStore.getState().setRunning(id, 'exited')
    },
    setFocus(id) {
      host.setFocus(id)
    },
    openDigest() {
      host.setDigestOpen(true)
    },
    closeDigest() {
      host.setDigestOpen(false)
    },
    enterCameraFullView(id) {
      host.enterCameraFullView(id)
    },
    exitCameraFullView() {
      host.exitCameraFullView()
    },
    async exportBoard(boardId, format) {
      const b = useCanvasStore.getState().boards.find((x) => x.id === boardId)
      if (!b || b.type !== 'planning') return null
      const { buildExport } = await import('../canvas/boards/planning/exportBoard')
      const { result, bytes } = await buildExport(b, format)
      return {
        svg: result.svg,
        byteLength: bytes.length,
        imageCount: result.imageCount,
        embeddedCount: result.embeddedCount
      }
    },
    fitCameraInstant(id) {
      // padding/maxZoom mirror Canvas.tsx FULLVIEW_OPTIONS (0.1 / Z_MAX 2.5); duration 0 so
      // a re-fit-each-tick poll converges without animation. Memory e2e-rf-measurement-race.
      void rf.fitView({ padding: 0.1, maxZoom: 2.5, duration: 0, nodes: [{ id }] })
    },
    async reset() {
      // 1. Clear UI modes first so nothing holds a board reference mid-teardown.
      host.setFullView(null)
      host.setFocus(null)
      host.exitCameraFullView()
      // The digest panel (feat/context) is a per-project UI mode too — close it so an
      // open panel from one test can't leak into the next.
      host.setDigestOpen(false)
      // 2. Empty the store + history (renderer stops referencing the old boards).
      //    Clear connectors too (feat/mcp orchestration cables) — else a seeded
      //    connector survives reset() and pollutes the next test.
      useCanvasStore.setState({
        boards: [],
        connectors: [],
        past: [],
        future: [],
        selectedId: null
      })
      // 3. Tear down native resources: close all preview views + kill live AND parked
      //    PTY trees (the canonical project-switch teardown). Idempotent / best-effort.
      await disposeLiveResources()
      // 4. Reset the seed-x cursor so the next test's seedBoard positions restart.
      seedX = 0
      return { ok: true as const }
    },
    serializeDoc() {
      return JSON.stringify(useCanvasStore.getState().toObject())
    },
    async openProjectFromDisk(dir) {
      const r = await window.api.project.open(dir)
      await useCanvasStore.getState().applyOpenResult(r)
      const p = useCanvasStore.getState().project
      return {
        status: p.status,
        error: p.error ?? null,
        boardCount: useCanvasStore.getState().boards.length
      }
    }
  }
  window.__canvasE2E = api
}
