import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Rectangle, IpcRendererEvent } from 'electron'

// ── Phase 2.1 terminal — shell-list + launchCommand + spawn result ──
/** Lifecycle state surfaced to the Terminal board (mirrors main `PtyState`). */
export type PtyState = 'spawning' | 'running' | 'exited' | 'spawn-failed'

/** A human-confirm request surfaced to the modal (mirrors main `ConfirmRequest`, T4.2). */
export interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  denyLabel?: string
}

/** One MCP dispatch audit entry surfaced to the viewer (mirrors main `AuditEntry`, T4.1). */
export interface AuditEntry {
  seq: number
  ts: number
  type: string
  targetId: string
  prompt: string
  nonce: string
  status: string
  outputs?: string
  detail?: string
}

/** A discoverable shell for the per-board picker (mirrors main `ShellInfo`). */
export interface ShellInfo {
  path: string
  label: string
  default?: boolean
}

export interface SpawnTerminalOpts {
  id: string
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  /** Free-text agentic CLI written as the first PTY line (e.g. `claude`). */
  launchCommand?: string
}

/** Result of `pty:spawn`: on failure `pid` is -1 and `state` is `spawn-failed`. */
export interface SpawnTerminalResult {
  id: string
  shell: string
  pid: number
  state: PtyState
  error?: string
}

/** A localhost URL detected from a terminal's dev-server output (Slice C′). */
export interface DetectedUrl {
  url: string
  host: string
  port: number
}

/** Mirrors main `ScreenshotResult` (preview:screenshot). assetId is the relative
 *  `assets/<sha1>.png` path, or null when nothing was saved. `clipboardOk` reports
 *  whether the clipboard copy actually landed (BUG-028: the write can throw).
 *  `ok:false` with reason `not-live` means the view is detached or off-screen so
 *  `capturePage()` would return a blank image; reason `forbidden` means the sender
 *  was not the trusted app renderer (should never occur from normal app flow). */
export type PreviewScreenshotResult =
  | { ok: true; assetId: string | null; clipboardOk: boolean }
  | { ok: false; reason: 'not-live' | 'forbidden' }

/**
 * Preview lifecycle event (Phase 2.2 browser). Structurally mirrors the main
 * process `PreviewEvent` (re-declared here to keep preload decoupled from main).
 */
export type PreviewEvent =
  | { id: string; type: 'did-finish-load'; url: string }
  | { id: string; type: 'did-navigate'; url: string; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'did-fail-load'; url: string; errorCode: number; errorDescription: string }
  // A fresh main-frame navigation STARTED — lets the renderer clear a stale
  // `load-failed` latch so a successful reload/back/forward promotes to `connected`
  // (Bug #5). Kept in sync with the main-process union.
  | { id: string; type: 'did-start-navigation' }
  // The preview's renderer process died (D2-C) — the board shows a crashed state
  // with a Reload CTA. Kept in sync with the main-process union.
  | { id: string; type: 'render-process-gone'; reason: string }

// ── SPIKE (feat/preview-offscreen-spike): offscreen preview → <canvas> ──
// One offscreen-rendered frame pushed main → renderer (OS-3 Phase 2 / 2C — dirty-rect aware).
// `buffer` is the NativeImage bitmap (BGRA) of the DIRTY region only; the renderer keeps its
// <canvas> at `full` size and blits the swizzled buffer at `dirty`'s offset. A full repaint
// reports `dirty == full`. Mirrors main `OsrFramePayload` (preload stays decoupled from main).
export interface OsrRect {
  x: number
  y: number
  width: number
  height: number
}
export interface OsrFrame {
  id: string
  full: { width: number; height: number }
  dirty: OsrRect
  buffer: Uint8Array
}
/** The offscreen page's cursor, mirrored onto the host <canvas>. `image` (a data URL) +
 *  `hotspot` are present only for type:'custom'. Mirrors main `OsrCursorPayload`. */
export interface OsrCursor {
  id: string
  type: string
  image?: string
  hotspot?: { x: number; y: number }
  scale?: number
}
/** A renderer-built input event forwarded to the offscreen view (M3 scaffold). */
export type OsrInputEvent = Parameters<Electron.WebContents['sendInputEvent']>[0]
/** OS-3 Phase 3 — clipboard/selection verb routed to the offscreen WebContents' edit methods. */
export type OsrEditAction = 'copy' | 'cut' | 'paste' | 'selectAll'
/** OS-3 Phase 3 — text commit (`commit`) vs in-progress IME preview (`compose`). */
export type OsrImeKind = 'compose' | 'commit'

// ── Phase 3 persistence — project I/O (doc crosses as `unknown`; renderer validates) ──
export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}
export type ProjectResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }

// ── M-brain T-B1/T-B2 — mirrors main `SummarizeResult` / `LlmStatus` (preload stays decoupled) ──
export type LlmSummarizeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'budget-exceeded' }
  | { ok: false; reason: 'provider-error'; message: string }

export interface LlmStatus {
  hasProvider: boolean
  /** Mirrors main `ProviderName` — keep in sync if a provider is added. */
  provider: 'openrouter' | 'openai' | 'anthropic' | 'local'
  model: string
  baseUrl?: string
  hasKey: boolean
  /** T-F6: false when the OS can't encrypt a key (e.g. Linux without a keyring). */
  encryptionAvailable: boolean
}

export type LlmWriteResult = { ok: boolean; reason?: string }

// ── Terminal-recap T12: consent state ──
export type RecapConsentState = 'enabled' | 'declined' | 'undecided'

// ── Recap redesign S1: the recap face's data bundle. MIRRORS src/main (recapFacts.ts +
// summaryLoop.ts RecapNarrative + recapIpc.ts RecapBundle) — the process boundary means no
// shared import (tsconfig.preload ⊥ tsconfig.node); keep the three in lockstep, same as PtyState.
export type RecapStatus =
  | 'spawning'
  | 'running'
  | 'waiting-on-you'
  | 'idle'
  | 'exited'
  | 'spawn-failed'
export interface RecapFacts {
  v: 1
  status: RecapStatus
  /** PTY session currently alive (running/spawning); Resume is offered only when false. */
  live: boolean
  exitCode?: number
  title?: string
  sessionStart?: number
  lastActivity?: number
  turns: { user: number; agent: number }
  lastAsk?: string
  files: { path: string; op: 'edit' | 'write'; count: number }[]
  commands: { label: string; count: number }[]
  generatedAt: number
}
export interface RecapNarrative {
  now: string
  next?: string
  beats: { ts: number; text: string; role: 'user' | 'agent' }[]
  asOf: number
}
export interface RecapBundle {
  facts: RecapFacts
  narrative?: RecapNarrative
}

const api = {
  // ── Terminal (control plane; data flows over a MessagePort) ──
  spawnTerminal: (opts: SpawnTerminalOpts): Promise<SpawnTerminalResult> =>
    ipcRenderer.invoke('pty:spawn', opts),
  killTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:kill', id),
  // PTY-1: reap EVERY session (live + parked) on project switch — `killTerminal`
  // per-board missed parked (deleted-but-undoable) sessions, leaking child trees.
  disposeAllTerminals: (): Promise<boolean> => ipcRenderer.invoke('pty:disposeAll'),
  // Park the session on delete (keep the proc alive for adopt-on-undo, #15).
  parkTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:park', id),
  // Adopt a parked session on undo; { adopted:false } → caller spawns fresh (#15).
  adoptTerminal: (id: string): Promise<{ adopted: boolean; pid?: number }> =>
    ipcRenderer.invoke('pty:adopt', id),
  // Phase 2.1: OS-aware shell list (best-default first) for the board picker.
  listShells: (): Promise<ShellInfo[]> => ipcRenderer.invoke('pty:shells'),
  // Slice C′: parse the dev-server URL(s) out of a board's PTY output (read-only).
  detectPorts: (id: string): Promise<DetectedUrl[]> =>
    ipcRenderer.invoke('terminal:detectPorts', id),
  // Stage the clipboard image to <project>/.canvas/tmp and return its absolute path
  // (null = no image / no project). The renderer injects the path into the PTY.
  stageClipboardImage: (boardId: string): Promise<string | null> =>
    ipcRenderer.invoke('terminal:stageClipboardImage', boardId),
  cleanupStagedImages: (boardId: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:cleanupStagedImages', boardId),
  // webUtils.getPathForFile replaces the removed File.path (Electron 32+). Called from
  // the terminal drop handler to get a dropped file's real OS path for injection.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ── Clipboard (MAIN-owned; sandbox-clean) ──
  clipboard: {
    writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:writeText', text),
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText')
  },

  // ── Browser preview (WebContentsView, keyed by board id — 1-E) ──
  openPreview: (args: {
    id: string
    url?: string
    bounds: Rectangle
    zoomFactor?: number
  }): Promise<{ url: string }> => ipcRenderer.invoke('preview:open', args),
  // ONE coalesced batch for all views per frame (shared channel with node-pty).
  setPreviewBoundsBatch: (
    items: Array<{ id: string; bounds: Rectangle; zoomFactor?: number }>
  ): Promise<boolean> => ipcRenderer.invoke('preview:setBoundsBatch', items),
  // Snapshot the live view (data URL) before detaching, so an HTML <img> can carry
  // motion / LOD while the native layer is pulled out of the tree (1-D).
  capturePreview: (id: string): Promise<string | null> => ipcRenderer.invoke('preview:capture', id),
  detachPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:detach', id),
  detachAllPreviews: (): Promise<boolean> => ipcRenderer.invoke('preview:detachAll'),
  attachPreview: (args: { id: string; bounds: Rectangle; zoomFactor?: number }): Promise<boolean> =>
    ipcRenderer.invoke('preview:attach', args),
  closePreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:close', id),
  closeAllPreviews: (): Promise<boolean> => ipcRenderer.invoke('preview:closeAll'),

  // ── Phase 2.2 browser — navigation + lifecycle events (additive) ──
  // Navigate the preview's OWN webContents (control plane). Browser-board content
  // never reaches the PTY write channel; these only steer the native view.
  navigatePreview: (id: string, url: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:navigate', { id, url }),
  goBackPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:goBack', id),
  goForwardPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:goForward', id),
  reloadPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:reload', id),
  // Open the preview's current URL in the OS browser (scheme-gated in main).
  openExternalPreview: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:openExternal', url),
  // Screenshot the live view -> clipboard + project assets/. { ok:false, reason:'not-live' }
  // when the view is detached/off-screen (capturePage is blank then).
  screenshotPreview: (id: string): Promise<PreviewScreenshotResult> =>
    ipcRenderer.invoke('preview:screenshot', id),
  /**
   * Subscribe to preview lifecycle events (did-navigate / did-fail-load /
   * did-finish-load), keyed by board id. Returns an unsubscribe fn. The listener
   * gets ONLY the event payload (never the IpcRendererEvent) so the renderer can't
   * reach ipcRenderer.
   */
  onPreviewEvent: (listener: (ev: PreviewEvent) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, ev: PreviewEvent): void => listener(ev)
    ipcRenderer.on('preview:event', handler)
    return () => ipcRenderer.removeListener('preview:event', handler)
  },

  // ── SPIKE (feat/preview-offscreen-spike): offscreen preview → <canvas> ──
  // Render a Browser board's page offscreen and stream frames to a DOM <canvas>
  // (the occlusion fix under test). Isolated from the native preview methods above;
  // the renderer routes here only when VITE_PREVIEW_OSR=1 (BrowserPreviewLayer).
  openOsrPreview: (args: { id: string; url: string }): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrOpen', args),
  closeOsrPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:osrClose', id),
  sendOsrInput: (id: string, event: OsrInputEvent): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrInput', { id, event }),
  // Reload a crashed/failed OSR board (the native reloadPreview has no view in OSR mode).
  reloadOsrPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:osrReload', id),
  // URL-bar Back/Forward in OSR mode (native goBack/goForwardPreview drive a WebContentsView
  // the offscreen path doesn't have, so those buttons would otherwise no-op).
  goBackOsrPreview: (id: string): Promise<boolean> => ipcRenderer.invoke('preview:osrGoBack', id),
  goForwardOsrPreview: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrGoForward', id),
  // OS-3 Phase 1: resize the offscreen surface (M1 supersample + M4 responsive logical width).
  // Sent by the settle-gated sizing hook (useOffscreenSizing) ONLY on a settled-zoom / preset /
  // board-resize change — never per camera frame.
  resizeOsr: (
    id: string,
    size: { logicalW: number; logicalH: number; supersample: number }
  ): Promise<boolean> => ipcRenderer.invoke('preview:osrResize', { id, ...size }),
  // OS-3 Phase 2 (M2 / 2A): set a board's desired paint state. Sent by the settle-gated
  // liveness manager (useOffscreenLiveness) ONLY when visibility flips — `false` freezes the
  // offscreen pump (CPU→0, last frame stays), `true` resumes + invalidates.
  setOsrPaint: (id: string, painting: boolean): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrSetPaint', { id, painting }),
  // Per-interaction focus emulation: enable on canvas focus, disable on blur (P0 — so the
  // caret/:focus ring show while interacting AND the page's blur/focusout still fire).
  setOsrFocus: (id: string, focused: boolean): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrFocus', { id, focused }),
  // OS-3 Phase 3 (3C): clipboard / select-all routed to the offscreen page's own edit methods
  // (wc.copy/cut/paste/selectAll) — the trusted bridge over the page's denied navigator.clipboard.
  osrEditCommand: (id: string, action: OsrEditAction): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrEdit', { id, action }),
  // OS-3 Phase 3 (3A+3B): commit text / drive IME composition into the offscreen page via the
  // attached CDP debugger (Input.insertText / Input.imeSetComposition). All TEXT routes here from
  // the hidden composition-proxy <textarea>; raw key events stay on sendOsrInput.
  osrIme: (id: string, kind: OsrImeKind, text: string): Promise<boolean> =>
    ipcRenderer.invoke('preview:osrIme', { id, kind, text }),
  onPreviewOsrFrame: (listener: (f: OsrFrame) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, f: OsrFrame): void => listener(f)
    ipcRenderer.on('preview:osrFrame', handler)
    return () => ipcRenderer.removeListener('preview:osrFrame', handler)
  },
  // Cursor stream: the offscreen page's cursor type, applied to the board's <canvas>
  // so the preview shows an I-beam over inputs / pointer over links (a bitmap has none).
  onPreviewOsrCursor: (listener: (c: OsrCursor) => void): (() => void) => {
    const handler = (_e: IpcRendererEvent, c: OsrCursor): void => listener(c)
    ipcRenderer.on('preview:osrCursor', handler)
    return () => ipcRenderer.removeListener('preview:osrCursor', handler)
  },

  // ── Phase 3 persistence ──
  project: {
    create: (dir: string, name: string, opts: { gitInit?: boolean }): Promise<ProjectResult> =>
      ipcRenderer.invoke('project:create', { dir, name, opts }),
    open: (dir: string): Promise<ProjectResult> => ipcRenderer.invoke('project:open', dir),
    // T5: deep-validation recovery — fetch ONLY canvas.json.bak so the renderer can retry
    // `fromObject` against the last good snapshot when the primary is envelope-valid but
    // deep-corrupt (MAIN's own .bak fallback only covers parse/envelope failures).
    reopenFromBak: (dir: string): Promise<ProjectResult> =>
      ipcRenderer.invoke('project:reopenFromBak', dir),
    // BUG-009: optional expectedDir — when supplied, MAIN rejects the write unless it
    // still matches the current open dir (guards autosave racing a project switch).
    // Forwarded only when present so dir-less call sites keep their exact IPC shape.
    save: (doc: unknown, expectedDir?: string): Promise<boolean> =>
      expectedDir === undefined
        ? ipcRenderer.invoke('project:save', doc)
        : ipcRenderer.invoke('project:save', doc, expectedDir),
    recents: (): Promise<RecentProject[]> => ipcRenderer.invoke('project:recents'),
    // Both are LIST-ONLY mutations (never touch the project folder) and return the
    // fresh list so the caller can re-render without a second recents() round-trip.
    removeRecent: (path: string): Promise<RecentProject[]> =>
      ipcRenderer.invoke('project:removeRecent', path),
    clearRecents: (): Promise<RecentProject[]> => ipcRenderer.invoke('project:clearRecents'),
    current: (): Promise<ProjectResult | null> => ipcRenderer.invoke('project:current'),
    /**
     * Register a handler that main invokes (`project:flush`) right before it hard-exits
     * on quit (BUG-M2). The hard `app.exit(0)` bypasses the renderer `beforeunload`, so
     * the autosave flush would otherwise never run and the last ~1s edit is lost. The
     * handler runs (awaiting the underlying `project:save`) and main awaits the reply
     * before exiting. Returns an unsubscribe fn.
     */
    onFlush: (handler: () => void | Promise<void>): (() => void) => {
      const listener = async (_e: IpcRendererEvent, replyChannel: string): Promise<void> => {
        try {
          await handler()
        } finally {
          ipcRenderer.send(replyChannel)
        }
      }
      ipcRenderer.on('project:flush', listener)
      return () => ipcRenderer.removeListener('project:flush', listener)
    }
  },
  // ── Phase 3 / W4 assets — write pasted/dropped bytes, read them back as bytes ──
  asset: {
    write: (bytes: Uint8Array, ext: string): Promise<{ assetId: string } | { error: string }> =>
      ipcRenderer.invoke('asset:write', { bytes, ext }),
    read: (assetId: string): Promise<Uint8Array | null> => ipcRenderer.invoke('asset:read', assetId)
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder')
  },
  export: {
    save: (args: {
      bytes: Uint8Array
      ext: 'png' | 'svg'
      defaultName: string
    }): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke('export:save', args)
  },
  // ── M-memory T-M4: read cached Tier-2 prose for the panel (pure disk read; MAIN-guarded) ──
  memory: {
    readBoards: (ids: string[]): Promise<Record<string, string>> =>
      ipcRenderer.invoke('memory:readBoards', ids),
    // T-F4: force a re-summary of one board (bypasses the debounce; still budget/key-gated +
    // passive in MAIN). {ok:false} when no project is open / over cap. Renderer re-reads prose after.
    refresh: (boardId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('memory:refresh', boardId)
  },
  // ── M-brain T-B1/T-B2: provider-agnostic LLM (MAIN owns the key/egress) ──
  llm: {
    summarize: (input: { system?: string; text: string }): Promise<LlmSummarizeResult> =>
      ipcRenderer.invoke('llm:summarize', input),
    status: (): Promise<LlmStatus> => ipcRenderer.invoke('llm:status'),
    setKey: (args: { provider: LlmStatus['provider']; key: string }): Promise<LlmWriteResult> =>
      ipcRenderer.invoke('llm:setKey', args),
    clearKey: (args: { provider: LlmStatus['provider'] }): Promise<LlmWriteResult> =>
      ipcRenderer.invoke('llm:clearKey', args),
    setConfig: (args: {
      provider: LlmStatus['provider']
      model: string
      baseUrl?: string
      maxCallsPerDay?: number
    }): Promise<LlmWriteResult> => ipcRenderer.invoke('llm:setConfig', args)
  },

  // ── Terminal-recap T12: consent + learned-patches push ──
  recap: {
    /** S1: one-shot read for the recap face — live LOCAL facts + the cached narrative. */
    get: (boardId: string): Promise<RecapBundle | null> => ipcRenderer.invoke('recap:get', boardId),
    getConsent: (): Promise<RecapConsentState> => ipcRenderer.invoke('recap:getConsent'),
    setConsent: (decision: 'enabled' | 'declined'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('recap:setConsent', decision),
    /** main → renderer: learned patches `{boardId, sessionId, transcriptPath}[]` to persist on boards. */
    onLearned: (
      cb: (patches: { boardId: string; sessionId: string; transcriptPath: string }[]) => void
    ): (() => void) => {
      const h = (
        _e: IpcRendererEvent,
        p: { boardId: string; sessionId: string; transcriptPath: string }[]
      ): void => cb(p)
      ipcRenderer.on('recap:learned', h)
      return () => ipcRenderer.removeListener('recap:learned', h)
    }
  },

  // ── MCP board mirror (control plane; metadata only — id/type/title + coarse status
  //    bucket, never content) ──
  mcp: {
    publishBoards: (payload: {
      boards: Array<{ id: string; type: string; title: string; status: string }>
      connectors: Array<{ id: string; sourceId: string; targetId: string; kind: string }>
    }): void => ipcRenderer.send('mcp:boards', payload),

    // MAIN → renderer command channel (the inverse of publishBoards). The handler
    // gets the command + a reply fn that acks on MAIN's unique reply channel.
    // Returns an unsubscribe fn. Control-plane only.
    onCommand: (
      handler: (command: { type: string }, reply: (ack: unknown) => void) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        msg: { command: { type: string }; replyChannel: string }
      ): void => {
        handler(msg.command, (ack) => ipcRenderer.send(msg.replyChannel, ack))
      }
      ipcRenderer.on('mcp:command', listener)
      return () => ipcRenderer.removeListener('mcp:command', listener)
    },

    // Read-only view of the MCP dispatch audit trail (T4.1). Most-recent-first,
    // capped MAIN-side. There is intentionally NO write side — entries are recorded
    // only by the MAIN dispatch path, so the renderer can neither forge nor erase one.
    readAudit: (opts?: { limit?: number }): Promise<AuditEntry[]> =>
      ipcRenderer.invoke('audit:read', opts),

    // 🔒 Human-confirm gate (T4.2): MAIN posts a confirm request; the renderer shows a
    // modal and replies the human's decision on MAIN's unique reply channel. Returns an
    // unsubscribe fn. MAIN owns the decision (it blocks the tool on this reply).
    onConfirm: (
      handler: (request: ConfirmRequest, reply: (decision: { approved: boolean }) => void) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        msg: { request: ConfirmRequest; replyChannel: string }
      ): void => {
        handler(msg.request, (decision) => ipcRenderer.send(msg.replyChannel, decision))
      }
      ipcRenderer.on('mcp:confirm', listener)
      return () => ipcRenderer.removeListener('mcp:confirm', listener)
    }
  }
}

/**
 * The PTY data-plane MessagePort is transferred from main → preload over IPC.
 * MessagePorts can't cross the contextBridge directly, so we re-post them into
 * the main world with window.postMessage (the documented Electron pattern).
 * The renderer listens for { __ptyPort, id } and reads event.ports[0].
 */
ipcRenderer.on('pty:port', (e, msg: { id: string }) => {
  // Same-origin re-post (SEC-2): pin the target origin instead of '*' so this stays
  // safe if an iframe is ever introduced. The MessagePorts ride in the transfer list.
  window.postMessage({ __ptyPort: true, id: msg.id }, window.location.origin, e.ports)
})

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // Fallback when contextIsolation is somehow off (should never happen).
  ;(window as unknown as Record<string, unknown>).api = api
}

export type CanvasApi = typeof api
