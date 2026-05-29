import { contextBridge, ipcRenderer } from 'electron'
import type { Rectangle, IpcRendererEvent } from 'electron'

export interface SpawnTerminalOpts {
  id: string
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
}

/**
 * Preview lifecycle event (Phase 2.2 browser). Structurally mirrors the main
 * process `PreviewEvent` (re-declared here to keep preload decoupled from main).
 */
export type PreviewEvent =
  | { id: string; type: 'did-finish-load'; url: string }
  | { id: string; type: 'did-navigate'; url: string; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'did-fail-load'; url: string; errorCode: number; errorDescription: string }

const api = {
  // ── Terminal (control plane; data flows over a MessagePort) ──
  spawnTerminal: (opts: SpawnTerminalOpts): Promise<{ id: string; shell: string; pid: number }> =>
    ipcRenderer.invoke('pty:spawn', opts),
  killTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:kill', id),

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
