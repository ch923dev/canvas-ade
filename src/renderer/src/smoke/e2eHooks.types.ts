/**
 * Type surface for the in-process E2E renderer hook (`window.__canvasE2E`), split out of e2eHooks.ts
 * so the harness IMPLEMENTATION stays under the file-size ratchet. Pure declarations — no runtime.
 * The impl (`installE2EHooks`) assigns `const api: CanvasE2E`, so these two files move in lock-step.
 */
import type {
  Board,
  BoardType,
  CanvasBackground,
  Connector,
  ConnectorKind
} from '../lib/boardSchema'
import type { Tool } from '../store/canvasStore'
import type { TidyMode } from '../lib/tidyLayout'
import type { TileTemplate } from '../lib/tileLayout'
import type { CommandTask } from '../store/commandStore'

/** Per-board runtime fields the harness asserts on (subset of PreviewRuntime). */
export interface RuntimeProbe {
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
  /**
   * The same log as discrete per-write chunks. Voice V3's Send contract is byte-shape
   * sensitive: the paste text and the `\r` must be SEPARATE port writes (never
   * `text + '\r'` in one), which only the chunk boundaries can prove.
   */
  readTerminalInputChunks: (id: string) => string[]
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
  /** Lane A — whether useTerminalLiveness currently rates this terminal LIVE (on-screen ∧ ≥ LOD).
   *  Default-true for an unreconciled board; false once gated off-screen / below-LOD. */
  terminalLive: (id: string) => boolean
  /** Lane A — the write coalescer's HELD byte count for a terminal (PTY bytes buffered but not yet
   *  rendered). Grows while the board is gated (proves the PTY keeps producing); ~0 while live. */
  terminalHeldBytes: (id: string) => number
  /** Terminal-resume F1: the last settled MAIN resume-validity check for a board (null until one
   *  lands). Specs asserting the Resume affordance's ABSENCE await the check for the id they
   *  staged first — a bare toHaveCount(0) would pass trivially before the IPC round-trip. */
  resumeCheckState: (id: string) => { sessionId?: string; canResume: boolean } | null
  /** The live xterm font size for a terminal board (px), or undefined if not mounted. */
  terminalFontSize: (id: string) => number | undefined
  /** The live xterm scrollback for a terminal board (lines), or undefined if not mounted. */
  terminalScrollback: (id: string) => number | undefined
  /** Phase 5 · S4: scroll a terminal's viewport by N lines (negative = up) — drives the jump badge. */
  scrollTerminal: (id: string, lines: number) => void
  /** Phase 5 · S4: whether a terminal is scrolled above its live tail (viewportY < baseY), or undefined. */
  terminalScrolledUp: (id: string) => boolean | undefined
  /** Lane B: the live xterm theme background hex for a terminal board (a stable representative of
   *  the applied ANSI palette), or undefined if not mounted. Asserts a theme switch applied live. */
  terminalThemeBg: (id: string) => string | undefined
  /** Lane B: the live xterm font-family literal stack for a terminal board, or undefined. */
  terminalFontFamily: (id: string) => string | undefined
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
  /** Phase 5 · S3: flush every live terminal's scrollback to its `.canvas/terminal/<id>.snapshot`
   *  sidecar (the SAME registry the quit/close/switch paths use), so the persist round-trip is
   *  drivable from a spec without an app relaunch. */
  flushTerminalSnapshots: () => Promise<void>
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
  /**
   * Background sessions (Phase 2): drive the REAL project-switch pipeline
   * (store/projectSwitch.performProjectSwitch — lock → autosave cancel → pinned flush-save →
   * background/dispose handover → load) against a disk dir. `keep` forces the keep-running
   * branch explicitly so the spec doesn't depend on the EXPANSE_BG_SESSIONS env flag.
   * Returns the pipeline outcome + the settled project so the spec can assert the landing.
   */
  switchProjectFromDisk: (
    dir: string,
    keep: boolean
  ) => Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
  /**
   * Phase 4: the DEFAULT switch pipeline (no explicit keep) — the per-project policy decides,
   * and the ask-on-switch dialog appears when the outgoing project has live resources. The
   * promise settles only after any dialog is answered, so specs drive the real modal.
   */
  switchProjectAsk: (
    dir: string
  ) => Promise<{ outcome: string; status: string; dir: string | null; boardCount: number }>
  /** Reveal the auto-hide docked file-tree panel (mirrors the user moving onto the left-edge zone).
   *  Since SLICE-013 the FileTree is lazy and only MOUNTS once the panel has been revealed, so a tree
   *  probe must reveal first — a real user never interacts with the still-hidden (unmounted) tree. */
  revealSidePanel: () => void
  /** 4A — force a Browser board's audible flag so the URL-bar audio control renders without real
   *  media (OSR headless rarely fires media-started-playing); the test then drives the popover. */
  setOsrAudible: (id: string, audible: boolean) => void
  /** 4A — read a Browser board's ephemeral audio state (mute + volume) to assert control behavior. */
  getOsrAudio: (id: string) => { muted: boolean; volume: number }
  /**
   * #269 — force a Browser board's MAX_LIVE existence flag — exactly what the liveness manager writes
   * on evict (false) / revive (true). Bypasses the >4-board + camera choreography (like
   * `setCommandTasks` bypasses spawn choreography) so the revive-sizing regression guard can drive an
   * evict→revive deterministically without staging five boards and a pan.
   */
  setOsrAlive: (id: string, alive: boolean) => void
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
  /**
   * Phase 1 accounts — drive the renderer account store directly: the deterministic stand-in for
   * MAIN's `auth:statusChanged` push (no live WorkOS in e2e). It runs the SAME `apply` the real
   * onStatusChanged handler runs (presence-only payload), so the chrome pill / SignInView / Settings
   * Account section react exactly as in production. Sign-OUT is tested via the real IPC (no external
   * dependency); only the sign-IN side needs this mock.
   */
  /**
   * Voice V1 — the live capture pipeline state (`voiceStore`, ephemeral). The voice e2e
   * asserts frames flow (framesSent grows, level rises under the fake-media tone) and that
   * stop() lands (capturing false). All plain numbers/booleans — evaluate-bridge safe.
   */
  voiceState: () => {
    capturing: boolean
    level: number
    micSilent: boolean
    framesSent: number
    /** V3 composer state — the voiceComposer e2e asserts the partial→final→draft flow. */
    draft: string
    partial: string
    flyoutOpen: boolean
    modelStatus: 'ready' | 'absent' | 'unknown'
  }
  /**
   * Jarvis — the conversation/panel state (`jarvisStore`, ephemeral). The jarvis e2e
   * drives a stub-voice final through the mock brain and asserts the turn lifecycle
   * (thinking → streaming reply → done) + the display transcript + the structural
   * mic-gate (panel close disarms converse). Evaluate-bridge safe.
   */
  jarvisState: () => {
    converseMode: boolean
    activeTurnId: number | null
    awaitingReply: boolean
    streamText: string
    lastUserText: string
    turnCount: number
    lastAssistantText: string
    panelOpen: boolean
    lastError: string | null
    /** J4: the ACTIVE turn's tool-act rows + whether a confirm gate is parked. */
    acts: Array<{ actId: number; name: string; phase: string; summary: string }>
    pendingConfirm: { title: string; body: string } | null
    /** J4: resolved act rows folded into the transcript (role === 'act'). */
    actChipCount: number
  }
  setAuthStatus: (status: {
    isLoggedIn: boolean
    email?: string
    plan?: 'free' | 'pro'
    encryptionAvailable: boolean
  }) => void
  /**
   * desktop-notifications P5 — the live in-app toast queue (message/kind/sticky). Asserts a
   * lifecycle event's toast surfaced through the REAL MAIN deliver → `notify:lifecycle` IPC path.
   */
  notifyToasts: () => Array<{ message: string; kind: 'error' | 'ok' | 'info'; sticky: boolean }>
  /** desktop-notifications P5 — a board's unseen-attention kind from attentionStore, or null. */
  attentionKind: (id: string) => 'done' | 'needs-input' | 'error' | null
  /** desktop-notifications P5 — the on-canvas attention ring's `data-kind` rendered in the board
   *  node DOM (proves the BoardAttention overlay mounted on-canvas), or null. */
  attentionRingKind: (id: string) => 'done' | 'needs-input' | 'error' | null
}

declare global {
  interface Window {
    __canvasE2E?: CanvasE2E
  }
}
