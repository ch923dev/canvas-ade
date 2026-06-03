import { contextBridge, ipcRenderer } from 'electron'
import type { Rectangle, IpcRendererEvent } from 'electron'

// ── Phase 2.1 terminal — shell-list + launchCommand + spawn result ──
/** Lifecycle state surfaced to the Terminal board (mirrors main `PtyState`). */
export type PtyState = 'spawning' | 'running' | 'exited' | 'spawn-failed'

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

// ── Phase 3 persistence — project I/O (doc crosses as `unknown`; renderer validates) ──
export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
}
export type ProjectResult =
  | { ok: true; dir: string; name: string; doc: unknown }
  | { ok: false; error: string }

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

  // ── Phase 3 persistence ──
  project: {
    create: (dir: string, name: string, opts: { gitInit?: boolean }): Promise<ProjectResult> =>
      ipcRenderer.invoke('project:create', { dir, name, opts }),
    open: (dir: string): Promise<ProjectResult> => ipcRenderer.invoke('project:open', dir),
    save: (doc: unknown): Promise<boolean> => ipcRenderer.invoke('project:save', doc),
    recents: (): Promise<RecentProject[]> => ipcRenderer.invoke('project:recents'),
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
