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
import { useOsrWidgetStore } from '../store/osrWidgetStore'
import { useOsrNetworkStore } from '../store/osrNetworkStore'
import { useDataFlowStore } from '../store/dataFlowStore'
import { mergeShapes, type ShapeSample, type ShapeNode, type FormatHint } from '../lib/schemaInfer'
import { useFileTreeUiStore } from '../store/fileTreeUiStore'
import type { NetRecord } from '../../../preload'
import { boardStatusBucket, bucketToPill } from '../store/boardStatus'
import {
  fromObject,
  type Board,
  type BoardType,
  type CanvasBackground,
  type Connector,
  type ConnectorKind
} from '../lib/boardSchema'
import type { Tool } from '../store/canvasStore'
import { resolveConnectTarget } from '../lib/resolveConnectTarget'
import type { TidyMode } from '../lib/tidyLayout'
import type { TileTemplate } from '../lib/tileLayout'
import { makeChecklist } from '../canvas/boards/planning/elements'
import { clearClipboard } from '../canvas/boards/planning/elementClipboard'
import { buildDiagramThemeVars } from '../canvas/boards/planning/diagramTheme'
import { clampTerminalFont } from '../canvas/boards/terminal/terminalFont'
import { e2eTerminals, e2eTerminalInput, e2eTerminalLink } from './e2eRegistry'
import { disposeLiveResources } from '../store/disposeLiveResources'
import { useToastStore } from '../store/toastStore'
import { useSaveStatusStore } from '../store/saveStatusStore'
import { useSettledZoomStore } from '../store/settledZoomStore'
import { useWayfindingStore, MINIMAP_VISIBLE_KEY } from '../store/wayfindingStore'
import { useCommandStore, commandStoreDefaults, type CommandTask } from '../store/commandStore'
import { useLibraryStore } from '../store/libraryStore'
import { listScenes } from '../canvas/backdrop/sceneRegistry'

/** Per-board runtime fields the harness asserts on (subset of PreviewRuntime). */
interface RuntimeProbe {
  status: string
}

export interface CanvasE2E {
  /** Add a board at an auto-incremented world x; optionally patch durable props. */
  seedBoard: (type: BoardType, patch?: Partial<Board>) => string
  /** Place-first New Terminal flow: add a terminal whose spawn is held for the dialog. */
  seedConfigPendingTerminal: () => string
  /** Id of the terminal awaiting New Terminal config (null when none / resolved). */
  getConfigPendingId: () => string | null
  /** Current boards (plain data — serializable). */
  getBoards: () => Board[]
  /** Set the multi-selection (group create path). */
  setSelection: (ids: string[]) => void
  /** Current selection (D4-B Tab-cycle probe asserts on it). */
  getSelection: () => string[]
  /** Live camera viewport (D4-B Enter-focus probe asserts the camera moved). */
  getViewport: () => { x: number; y: number; zoom: number }
  /** S4: patch the canvas backdrop through the real store action (settings-class, untracked). */
  setBackground: (patch: Partial<CanvasBackground>) => void
  /** S4: the live backdrop settings (plain data — serializable), or null when never set. */
  getBackground: () => CanvasBackground | null
  /** PR 3: registered bundled-scene ids, so e2e coverage is registry-derived. */
  listSceneIds: () => string[]
  /**
   * C3: inject the Command board's ephemeral task queue directly (bypassing the real spawn
   * choreography) so the routing-edge overlay can be driven deterministically — a real dispatch
   * would leak a worker into MAIN's spawn-cap `tracked`. e2e only.
   */
  setCommandTasks: (tasks: CommandTask[]) => void
  /** Named groups (plain data — serializable). */
  getGroups: () => { id: string; name: string; boardIds: string[] }[]
  /** Create a group from ids (mirrors Ctrl+G's store path); returns the new group id. */
  addGroup: (name: string, ids: string[]) => string
  /** S6: add a board to a group via the real reflow path (membership + re-pack); for e2e. */
  addToGroupReflowed: (groupId: string, boardId: string) => void
  /** Browser preview runtime for a board id, or null if none yet. */
  getRuntime: (id: string) => RuntimeProbe | null
  /**
   * OS-3 Phase 5 — true iff the board's OSR <canvas> has painted a REAL frame (≥1 opaque pixel
   * AND non-uniform colour). The OSR replacement for the native `captureView → {attached, empty}`
   * probe: it proves the offscreen frame actually reached the visible DOM canvas (the regression
   * surface OSR adds). Reads the canvas in-renderer via getImageData (the canvas is filled by
   * renderer-owned putImageData, so it is not tainted). False when no canvas / not yet painted.
   */
  osrCanvasNonBlank: (id: string) => boolean
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
    init: {
      key: string
      ctrlKey?: boolean
      shiftKey?: boolean
      altKey?: boolean
      metaKey?: boolean
    }
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
  /** Select a board by id, or pass null to clear the selection (e.g. to assert a File board's
   *  deselected snapshot rather than its selected live editor). */
  select: (id: string | null) => void
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
  /** Current live camera zoom (asserts the settled-zoom snap, terminalCrisp.e2e). */
  getZoom: () => number
  /** Pan the camera by a screen-pixel delta (used to push a board's chrome past a window edge). Bug 14. */
  panBy: (dx: number, dy: number) => void
  /** True if a terminal board's xterm instance is currently mounted (registered). */
  terminalMounted: (id: string) => boolean
  /** The live xterm font size for a terminal board (px), or undefined if not mounted. */
  terminalFontSize: (id: string) => number | undefined
  /** The live xterm scrollback for a terminal board (lines), or undefined if not mounted. */
  terminalScrollback: (id: string) => number | undefined
  /** Phase 4: the active Unicode width-table version ('11' once the Unicode11Addon loaded), or
   *  undefined if not mounted. The links e2e asserts the addon took effect at construction. */
  terminalUnicodeVersion: (id: string) => string | undefined
  /** Phase 4: drive the terminal's web-link activator with a URI + modifier flags — the EXACT
   *  function the WebLinksAddon calls — so routing (Browser board vs shell:openExternal, modifier
   *  gate, Shift flip) is testable without synthesizing an xterm link-click. No-op if not mounted. */
  activateTerminalLink: (
    id: string,
    uri: string,
    mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
  ) => void
  /** Rendered terminal geometry for the clip probe: rects of the live xterm sub-elements vs the
   *  clipping well, plus dpr/rows/cols. Null if not mounted. */
  terminalGeometry: (id: string) => null | {
    dpr: number
    rows: number
    cols: number
    cellHeight: number
    gridBottom: number
    wellBottom: number
    overflow: number
  }
  /** Terminal render-state probe (DOM renderer; terminal-crisp umbrella). `netScale` is the
   *  .xterm-screen rendered-vs-layout width ratio — IN-CANVAS it equals the camera zoom (the
   *  host rides the transform, no counter-scale), 1 in full view; `effectiveFont` is the live
   *  xterm render font (the pin in-canvas; pinned × fullViewScale in full view); `hSlack`/
   *  `vSlack` are the rendered px between the grid's right/bottom edge and the well's
   *  (negative ⇒ the grid CLIPS). */
  terminalCounterScale: (id: string) => null | {
    effectiveFont: number
    cols: number
    rows: number
    netScale: number | null
    hSlack: number | null
    vSlack: number | null
  }
  /** Drive a REAL board resize (store -> React Flow -> the well ResizeObserver -> fit). */
  setBoardSize: (id: string, w: number, h: number) => void
  /** Pin a terminal's font size (drives the reactive apply + refit). For the clip x font matrix. */
  setBoardFont: (id: string, px: number) => void
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
  /** Reveal the auto-hide docked file-tree panel (mirrors the user moving onto the left-edge zone).
   *  Since SLICE-013 the FileTree is lazy and only MOUNTS once the panel has been revealed, so a tree
   *  probe must reveal first — a real user never interacts with the still-hidden (unmounted) tree. */
  revealSidePanel: () => void
  /** 4A — force a Browser board's audible flag so the URL-bar audio control renders without real
   *  media (OSR headless rarely fires media-started-playing); the test then drives the popover. */
  setOsrAudible: (id: string, audible: boolean) => void
  /** 4A — read a Browser board's ephemeral audio state (mute + volume) to assert control behavior. */
  getOsrAudio: (id: string) => { muted: boolean; volume: number }
  /** SLICE-010 — replace a board's captured Network records with `count` synthetic rows, so the
   *  virtualization probe can prove only ~viewport rows mount as `<tr>` at the 1000-record cap. */
  seedOsrNet: (id: string, count: number) => void
  /** JD-4 — inject a canned, deterministic login→home API capture into the source board's network +
   *  the inferred schemas + a body-lineage edge into the dataflow board, so the Data-Flow board renders
   *  a populated focus-on-node graph (entities + a dashed lineage edge) without a live page/MAIN sample.
   *  Returns the route template keys for assertions. */
  seedDataFlowDemo: (sourceId: string, dataflowId: string) => { templates: string[] }
  /** JD-4 — set the Data-Flow board's noise filters (both default ON) so a spec can exercise the
   *  unfiltered firehose or assert the filtered view deterministically. */
  setDfFilters: (dataflowId: string, apiOnly: boolean, firstParty: boolean) => void
  /** S4 — the LIVE Mermaid theme vars the app feeds the render worker (`buildDiagramThemeVars`).
   *  The ER a11y contrast spec renders an erDiagram with EXACTLY these and asserts the row
   *  backgrounds are dark — proving the builder's var names still match what Mermaid reads. */
  diagramThemeVars: () => Record<string, string>
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
  /** Close the group name popover (CanvasInner state) — an ephemeral UI mode reset() must clear. */
  closeGroupNaming: () => void
  /** Close the which-group focus picker (CanvasInner state) — same ephemeral-mode reset() parity. */
  closeGroupPicker: () => void
  /** Close the group right-click context menu (CanvasInner state) — ephemeral-mode reset() parity. */
  closeGroupMenu: () => void
  /** S6: run the real add-to-group reflow (membership + re-pack) — CanvasInner's reflowAddToGroup. */
  addToGroupReflowed: (groupId: string, boardId: string) => void
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
    seedConfigPendingTerminal() {
      const store = useCanvasStore.getState()
      const id = store.addBoard('terminal', { x: seedX, y: 0 }, { configPending: true })
      seedX += 760
      return id
    },
    getConfigPendingId() {
      return useCanvasStore.getState().configPendingId
    },
    getBoards() {
      return useCanvasStore.getState().boards
    },
    setSelection(ids) {
      useCanvasStore.getState().setSelection(ids)
    },
    getSelection() {
      return useCanvasStore.getState().selectedIds
    },
    getViewport() {
      return rf.getViewport()
    },
    setBackground(patch) {
      useCanvasStore.getState().setBackground(patch)
    },
    getBackground() {
      return useCanvasStore.getState().background
    },
    setOsrAudible(id, audible) {
      useOsrWidgetStore.getState().setAudible(id, audible)
    },
    getOsrAudio(id) {
      const s = useOsrWidgetStore.getState()
      return { muted: s.muted[id] ?? false, volume: s.volume[id] ?? 1 }
    },
    listSceneIds() {
      return listScenes().map((s) => s.id)
    },
    setCommandTasks(tasks) {
      useCommandStore.setState({ tasks })
    },
    getGroups() {
      return useCanvasStore.getState().groups
    },
    addGroup(name, ids) {
      return useCanvasStore.getState().addGroup(name, ids)
    },
    addToGroupReflowed(groupId, boardId) {
      host.addToGroupReflowed(groupId, boardId)
    },
    getRuntime(id) {
      const r = usePreviewStore.getState().byId[id]
      return r ? { status: r.status } : null
    },
    osrCanvasNonBlank(id) {
      const cv = document.querySelector(
        `[data-bb-frame="${id}"] canvas.bb-live`
      ) as HTMLCanvasElement | null
      if (!cv || cv.width === 0 || cv.height === 0) return false
      const ctx = cv.getContext('2d')
      if (!ctx) return false
      const { data } = ctx.getImageData(0, 0, cv.width, cv.height)
      // Non-blank = at least one opaque pixel AND not a single uniform colour (rejects both the
      // cleared/transparent canvas and a flat fill). Early-exit once both conditions hold.
      const r0 = data[0]
      const g0 = data[1]
      const b0 = data[2]
      let anyOpaque = false
      let nonUniform = false
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] !== 0) anyOpaque = true
        if (data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0) nonUniform = true
        if (anyOpaque && nonUniform) return true
      }
      return false
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
      const ta = document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-helper-textarea`)
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
      // Resolve the screen via the LIVE xterm's own element, not a node-scoped DOM query:
      // in full view the content is portaled to the modal, so `.react-flow__node[...]` no
      // longer contains it. `t.element` is the xterm host wherever it currently lives.
      const host = t?.element?.querySelector('.xterm-screen') as HTMLElement | null | undefined
      if (!t || !host) return null
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
    select(id) {
      useCanvasStore.getState().selectBoard(id)
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
    getZoom() {
      return rf.getViewport().zoom
    },
    panBy(dx, dy) {
      const vp = rf.getViewport()
      void rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 0 })
    },
    terminalMounted(id) {
      return e2eTerminals.has(id)
    },
    terminalFontSize(id) {
      return e2eTerminals.get(id)?.options.fontSize
    },
    terminalScrollback(id) {
      return e2eTerminals.get(id)?.options.scrollback
    },
    terminalUnicodeVersion(id) {
      return e2eTerminals.get(id)?.unicode.activeVersion
    },
    activateTerminalLink(id, uri, mods) {
      e2eTerminalLink.get(id)?.(uri, mods)
    },
    terminalGeometry(id) {
      const term = e2eTerminals.get(id)
      if (!term) return null
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)
      const screenEl = node?.querySelector('.xterm-screen') as HTMLElement | null
      const wellEl = (node?.querySelector('.xterm') as HTMLElement | null)?.closest(
        '.nowheel'
      ) as HTMLElement | null
      if (!screenEl || !wellEl) return null
      const grid = screenEl.getBoundingClientRect()
      const well = wellEl.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        rows: term.rows,
        cols: term.cols,
        cellHeight: grid.height / Math.max(1, term.rows),
        gridBottom: grid.bottom,
        wellBottom: well.bottom,
        overflow: grid.bottom - well.bottom // > 0 => the grid spills past the clip boundary
      }
    },
    terminalCounterScale(id) {
      const term = e2eTerminals.get(id)
      if (!term) return null
      // Resolve via the LIVE xterm's own element (full-view-portal safe, like
      // terminalCellPoint) — not a node-scoped DOM query.
      const s = term.element?.querySelector('.xterm-screen') as HTMLElement | null
      const well = term.element?.closest('.nowheel') as HTMLElement | null
      const netScale =
        s && s.offsetWidth > 0 ? s.getBoundingClientRect().width / s.offsetWidth : null
      const g = s?.getBoundingClientRect()
      const w = well?.getBoundingClientRect()
      return {
        effectiveFont: term.options.fontSize ?? 0,
        cols: term.cols,
        rows: term.rows,
        netScale,
        hSlack: g && w ? w.right - g.right : null,
        vSlack: g && w ? w.bottom - g.bottom : null
      }
    },
    setBoardSize(id, w, h) {
      useCanvasStore.getState().resizeBoard(id, w, h)
    },
    setBoardFont(id, px) {
      // Clamp like the production seam so the stored pin matches what the apply effect renders —
      // an out-of-range raw write would diverge stored-vs-effective and confuse a test diagnostic.
      useCanvasStore.getState().updateBoard(id, { fontSize: clampTerminalFont(px) })
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
      // The group name popover (feat/named-board-groups) is the same: a test that fired Ctrl+G
      // leaves it open + focused, where it swallows the next test's Ctrl+G — close it too.
      host.closeGroupNaming()
      // Likewise the which-group focus picker (a fixed overlay) — close it so a test that left it
      // open can't steal the next test's outside-pointerdown / Escape.
      host.closeGroupPicker()
      // And the tab right-click context menu (a fixed overlay) — same ephemeral-mode parity.
      host.closeGroupMenu()
      // 2. Empty the store + history (renderer stops referencing the old boards).
      //    Clear connectors too (feat/mcp orchestration cables) — else a seeded
      //    connector survives reset() and pollutes the next test. ALSO restore the
      //    open-project state: with workers:1 ONE app is reused across all spec files,
      //    so a spec that drove the app to status:'error' (recovery.e2e.ts) leaves the
      //    canvas UNMOUNTED — without this the next spec's seeded board never renders.
      //    Mirrors the e2e boot in App.tsx (CANVAS_E2E ⇒ project open). reset-isolation.e2e.ts.
      useCanvasStore.setState({
        boards: [],
        connectors: [],
        groups: [],
        past: [],
        future: [],
        selectedId: null,
        selectedIds: [],
        // Backdrop is per-project document state — a spec that set a wallpaper/scene
        // must not leave it painting under every later spec (same isolation class as
        // connectors above).
        background: null,
        // A New Terminal dialog left open (config-pending) would otherwise gate the next
        // spec's seeded terminal's spawn (same ephemeral-isolation class).
        configPendingId: null,
        project: { dir: null, name: 'e2e', status: 'open' }
      })
      // D1-A: toasts + the save-failure state are global ephemeral stores too — a toast
      // left standing (the sticky save-failure especially) would occlude the next spec's
      // bottom-right region AND register a chrome-exclusion zone that demotes any live
      // board under it (the island joins resolveChromeZones while visible).
      useToastStore.getState().clearToasts()
      useSaveStatusStore.getState().clearSaveFailure()
      // The settled-zoom store is global ephemeral state too — a spec that left it at a
      // non-1 zoom would seed the next spec's terminals with a stale crisp/suspend value
      // for the first ~SETTLE_MS (same isolation class as the toasts above).
      useSettledZoomStore.getState().setSettledZoom(1)
      // D4-C: the minimap island is STICKY (localStorage, persistent userData) — a spec
      // that toggled it on would leave a bottom-right island + chrome-exclusion zone for
      // every later spec AND for the next run (the self-ratchet class). Hide + clear the
      // sticky key so each test starts from the shipped first-run default (hidden).
      useWayfindingStore.getState().setMinimapVisible(false)
      try {
        window.localStorage.removeItem(MINIMAP_VISIBLE_KEY)
      } catch {
        // storage unavailable — nothing sticky to clear
      }
      // The Command board's queue/view/collapse is a GLOBAL ephemeral store (one orchestrator
      // face) — a spec that switched the seg to 'groups' or collapsed the board would leak that
      // into the next spec (the cross-spec global-state class). Reset to the shipped defaults.
      useCommandStore.setState(commandStoreDefaults())
      // The Project Library panel's open state is a global ephemeral store too (same class as the
      // Digest panel closed via host.setDigestOpen above). A spec that opened it (browserLibrary)
      // left a fixed 320px right-docked overlay covering a later @preview spec's click target (the
      // "Close inspector" button) — the cross-spec library-panel-overlap flake. Close it.
      useLibraryStore.getState().setOpen(false)
      // Phase 3: the in-app element clipboard (planning Ctrl+C/X/V) is a renderer module
      // singleton — it intentionally persists for the whole app session, so a spec that did a
      // Ctrl+C/X would leak an armed clipboard into the next spec (the cross-spec module-state
      // class). A non-empty element clipboard wins over an OS image paste (E7), which would then
      // silently break whiteboard's image-paste spec. Clear it so each test starts empty.
      clearClipboard()
      // S3: the File-board viewer font is sticky too (localStorage, persistent userData); the
      // A-/A+ steppers ratchet it across runs (same self-ratchet class as the minimap above), so
      // file.e2e's A+ assertion eventually fails once the base hits FILE_FONT_MAX. Clear it so
      // each test starts from DEFAULT_FILE_FONT. Literal, not imported: fileBoardSyntax statically
      // pulls in CodeMirror and e2eHooks is in the eager main bundle — importing the key would
      // drag the lazy ~2.5MB CM6 chunk into startup.
      try {
        window.localStorage.removeItem('canvas-ade:file-font')
      } catch {
        // storage unavailable — nothing sticky to clear
      }
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
    },
    revealSidePanel() {
      useFileTreeUiStore.getState().reveal()
    },
    seedOsrNet(id, count) {
      const records: NetRecord[] = Array.from({ length: count }, (_unused, i) => ({
        requestId: `seed-${i}`,
        url: `https://example.test/req-${String(i).padStart(4, '0')}.js`,
        method: 'GET',
        type: 'script',
        status: 200,
        startTs: i, // monotonic so the waterfall window is well-formed
        endTs: i + 5,
        encodedDataLength: 1234,
        initiator: 'parser'
      }))
      // replay REPLACES the renderer mirror with exactly these rows (deterministic total + order),
      // unaffected by the few real document-load rows already captured.
      useOsrNetworkStore.getState().apply(id, { id, kind: 'replay', records })
    },
    seedDataFlowDemo(sourceId, dataflowId) {
      const ORIGIN = 'http://localhost:3000'
      const U = '550e8400-e29b-41d4-a716-446655440000'
      const records: NetRecord[] = [
        {
          requestId: 'home',
          url: `${ORIGIN}/home`,
          method: 'GET',
          type: 'document',
          status: 200,
          startTs: 0,
          endTs: 9
        },
        {
          requestId: 'sess',
          url: `${ORIGIN}/api/v2/session`,
          method: 'POST',
          type: 'fetch',
          status: 201,
          startTs: 10,
          endTs: 51
        },
        {
          requestId: 'cust',
          url: `${ORIGIN}/api/v2/customers/${U}`,
          method: 'GET',
          type: 'fetch',
          status: 200,
          startTs: 20,
          endTs: 48
        },
        {
          requestId: 'ord',
          url: `${ORIGIN}/api/v2/orders`,
          method: 'GET',
          type: 'fetch',
          status: 200,
          startTs: 30,
          endTs: 64
        }
      ]
      const net = useOsrNetworkStore.getState()
      net.apply(sourceId, { id: sourceId, kind: 'replay', records })
      net.setInferShapes(sourceId, true)
      const obj = (children: Record<string, ShapeNode>): ShapeNode => ({
        types: ['object'],
        children
      })
      const str = (format?: FormatHint): ShapeNode =>
        format ? { types: ['string'], format } : { types: ['string'] }
      const num = (): ShapeNode => ({ types: ['number'] })
      const one = (root: ShapeNode): ShapeSample[] => [{ root, complete: true }]
      const templates = [
        'POST http://localhost:3000/api/v2/session',
        'GET http://localhost:3000/api/v2/customers/{uuid}',
        'GET http://localhost:3000/api/v2/orders'
      ]
      net.setSchema(sourceId, templates[0], {
        schema: mergeShapes(one(obj({ id: str('uuid'), customerId: str('uuid') }))),
        sampled: 9,
        requested: 9
      })
      net.setSchema(sourceId, templates[1], {
        schema: mergeShapes(one(obj({ id: str('uuid'), email: str('email'), name: str() }))),
        sampled: 12,
        requested: 12
      })
      net.setSchema(sourceId, templates[2], {
        schema: mergeShapes(one(obj({ id: str('uuid'), customerId: str('uuid'), total: num() }))),
        sampled: 8,
        requested: 8
      })
      // The MAIN body-side lineage pass would return this value-less edge (session.customerId reappears
      // in the orders request); seed it directly so the dashed lineage edge renders headlessly.
      useDataFlowStore.getState().setBodyLineage(dataflowId, [
        {
          idName: 'customerId',
          fromRequestId: 'sess',
          toRequestId: 'ord',
          location: 'body',
          confidence: 'body-match'
        }
      ])
      return { templates }
    },
    setDfFilters(dataflowId, apiOnly, firstParty) {
      const s = useDataFlowStore.getState()
      s.setApiOnly(dataflowId, apiOnly)
      s.setFirstParty(dataflowId, firstParty)
    },
    diagramThemeVars() {
      return buildDiagramThemeVars()
    }
  }
  window.__canvasE2E = api
}
