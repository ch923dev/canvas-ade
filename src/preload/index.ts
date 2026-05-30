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
  // Park the session on delete (keep the proc alive for adopt-on-undo, #15).
  parkTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:park', id),
  // Adopt a parked session on undo; { adopted:false } → caller spawns fresh (#15).
  adoptTerminal: (id: string): Promise<{ adopted: boolean; pid?: number }> =>
    ipcRenderer.invoke('pty:adopt', id),
  // Phase 2.1: OS-aware shell list (best-default first) for the board picker.
  listShells: (): Promise<ShellInfo[]> => ipcRenderer.invoke('pty:shells'),

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
    current: (): Promise<ProjectResult | null> => ipcRenderer.invoke('project:current')
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder')
  }
}

/**
 * The PTY data-plane MessagePort is transferred from main → preload over IPC.
 * MessagePorts can't cross the contextBridge directly, so we re-post them into
 * the main world with window.postMessage (the documented Electron pattern).
 * The renderer listens for { __ptyPort, id } and reads event.ports[0].
 */
ipcRenderer.on('pty:port', (e, msg: { id: string }) => {
  window.postMessage({ __ptyPort: true, id: msg.id }, '*', e.ports)
})

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // Fallback when contextIsolation is somehow off (should never happen).
  ;(window as unknown as Record<string, unknown>).api = api
}

export type CanvasApi = typeof api
