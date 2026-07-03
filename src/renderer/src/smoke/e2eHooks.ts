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
import { useOsrLivenessStore } from '../store/osrLivenessStore'
import { useDataFlowStore } from '../store/dataFlowStore'
import { mergeShapes, type ShapeSample, type ShapeNode, type FormatHint } from '../lib/schemaInfer'
import { useFileTreeUiStore } from '../store/fileTreeUiStore'
import type { NetRecord } from '../../../preload'
import { boardStatusBucket, bucketToPill } from '../store/boardStatus'
import { fromObject } from '../lib/boardSchema'
import { resolveConnectTarget } from '../lib/resolveConnectTarget'
import { makeChecklist } from '../canvas/boards/planning/elements'
import { clearClipboard } from '../canvas/boards/planning/elementClipboard'
import { buildDiagramThemeVars } from '../canvas/boards/planning/diagramTheme'
import { clampTerminalFont } from '../canvas/boards/terminal/terminalFont'
import {
  e2eTerminals,
  e2eTerminalInput,
  e2eTerminalLink,
  e2eTerminalHeld,
  e2eResumeChecks
} from './e2eRegistry'
import { isTerminalLive } from '../store/terminalLivenessStore'
import { disposeLiveResources } from '../store/disposeLiveResources'
import { performProjectSwitch } from '../store/projectSwitch'
import { clearSwitchTransition } from '../store/switchTransitionStore'
import { useToastStore } from '../store/toastStore'
import { useSaveStatusStore } from '../store/saveStatusStore'
import { useSettledZoomStore } from '../store/settledZoomStore'
import { useWayfindingStore, MINIMAP_VISIBLE_KEY } from '../store/wayfindingStore'
import { clearStickyLocalPrefs } from './e2eStickyPrefs'
import { useCommandStore, commandStoreDefaults } from '../store/commandStore'
import { useLibraryStore } from '../store/libraryStore'
import { useAccountStore } from '../store/accountStore'
import { listScenes } from '../canvas/backdrop/sceneRegistry'
// The harness type surface (CanvasE2E) lives in a sibling module so this implementation stays under
// the file-size ratchet; the two move in lock-step (installE2EHooks assigns `const api: CanvasE2E`).
import type { CanvasE2E } from './e2eHooks.types'
import { flushAllTerminalSnapshots } from '../store/terminalSnapshotRegistry'

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
    setOsrAlive(id, alive) {
      const s = useOsrLivenessStore.getState()
      s.setAlive({ ...s.alive, [id]: alive })
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
    flushTerminalSnapshots() {
      // S3: run the real registry flush (serialize each live term → write its .canvas/ sidecar), the
      // same path quit/close/switch take, so the persist round-trip is drivable without a relaunch.
      return flushAllTerminalSnapshots()
    },
    terminalLive(id) {
      return isTerminalLive(id)
    },
    terminalHeldBytes(id) {
      return e2eTerminalHeld.get(id)?.() ?? 0
    },
    resumeCheckState(id) {
      return e2eResumeChecks.get(id) ?? null
    },
    terminalFontSize(id) {
      return e2eTerminals.get(id)?.options.fontSize
    },
    terminalScrollback(id) {
      return e2eTerminals.get(id)?.options.scrollback
    },
    scrollTerminal(id, lines) {
      e2eTerminals.get(id)?.scrollLines(lines)
    },
    terminalScrolledUp(id) {
      const t = e2eTerminals.get(id)
      if (!t) return undefined
      const b = t.buffer.active
      return b.viewportY < b.baseY
    },
    terminalThemeBg(id) {
      return e2eTerminals.get(id)?.options.theme?.background
    },
    terminalFontFamily(id) {
      return e2eTerminals.get(id)?.options.fontFamily
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
      // every later spec AND for the next run (the self-ratchet class). Hide it here; the
      // sticky keys themselves (minimap + file-font + P5 inspector-collapse) are swept by
      // clearStickyLocalPrefs below.
      useWayfindingStore.getState().setMinimapVisible(false)
      // The Command board's queue/view/collapse is a GLOBAL ephemeral store (one orchestrator
      // face) — a spec that switched the seg to 'groups' or collapsed the board would leak that
      // into the next spec (the cross-spec global-state class). Reset to the shipped defaults.
      useCommandStore.setState(commandStoreDefaults())
      // The Project Library panel's open state is a global ephemeral store too (same class as the
      // Digest panel closed via host.setDigestOpen above). A spec that opened it (browserLibrary)
      // left a fixed 320px right-docked overlay covering a later @preview spec's click target (the
      // "Close inspector" button) — the cross-spec library-panel-overlap flake. Close it.
      useLibraryStore.getState().setOpen(false)
      // Phase 1 accounts: a spec that drove the account store to signed-in (the pill avatar +
      // the Settings Account row) must not leak that identity into the next spec. Restore the
      // shipped signed-out default (the same cross-spec global-state class as the stores above).
      useAccountStore.getState().apply({ isLoggedIn: false, encryptionAvailable: true })
      // Phase 3: the in-app element clipboard (planning Ctrl+C/X/V) is a renderer module
      // singleton — it intentionally persists for the whole app session, so a spec that did a
      // Ctrl+C/X would leak an armed clipboard into the next spec (the cross-spec module-state
      // class). A non-empty element clipboard wins over an OS image paste (E7), which would then
      // silently break whiteboard's image-paste spec. Clear it so each test starts empty.
      clearClipboard()
      // Phase 4c: the switch-transition overlay self-clears (IN timer / watchdog), but a
      // spec torn down mid-switch could leave it armed for up to ~4s — an armed overlay is
      // a full-viewport input-eating layer over the next spec (the cross-spec global-state
      // class). Drop it and its timers now.
      clearSwitchTransition()
      // Sweep the sticky localStorage prefs (minimap visibility · file-font · P5 inspector
      // collapse state) — extracted to e2eStickyPrefs.ts (max-lines), key literals kept
      // there for the same eager-bundle reason documented in that module.
      clearStickyLocalPrefs(MINIMAP_VISIBLE_KEY)
      // 3. Tear down native resources: close all preview views + kill live AND parked
      //    PTY trees (the canonical project-switch teardown). Idempotent / best-effort.
      await disposeLiveResources()
      // 3b. Drain the background-sessions registry (Phase 4b): it is MAIN state that
      //     outlives a spec (workers:1 reuses one app), and teardownProject removes the
      //     DIR, not the registry entry — leftover residents would surface as extra
      //     project-dock cards in every later spec. Resources are already dead (the
      //     dispose above), so this is pure bookkeeping; also resets each dir's keep
      //     policy (closeBackgroundProject forgets it).
      try {
        const residents = await window.api.project.listBackground()
        for (const r of residents) {
          await window.api.project.closeBackground(r.dir).catch(() => false)
        }
      } catch {
        /* partial bridge in smoke renders — nothing to drain */
      }
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
    async switchProjectFromDisk(dir, keep) {
      const outcome = await performProjectSwitch(() => window.api.project.open(dir), {
        keepBackground: keep
      })
      const p = useCanvasStore.getState().project
      return {
        outcome,
        status: p.status,
        dir: p.dir,
        boardCount: useCanvasStore.getState().boards.length
      }
    },
    async switchProjectAsk(dir) {
      // Phase 4: the DEFAULT pipeline — no explicit keep, so the per-project policy decides
      // and the ask-on-switch dialog shows when the outgoing project has live resources.
      // The returned promise settles only after the dialog is answered (the spec clicks it).
      const outcome = await performProjectSwitch(() => window.api.project.open(dir))
      const p = useCanvasStore.getState().project
      return {
        outcome,
        status: p.status,
        dir: p.dir,
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
    },
    setAuthStatus(status) {
      useAccountStore.getState().apply(status)
    }
  }
  window.__canvasE2E = api
}
