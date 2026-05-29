import { contextBridge, ipcRenderer } from 'electron'
import type { Rectangle } from 'electron'

export interface SpawnTerminalOpts {
  id: string
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
}

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
  closeAllPreviews: (): Promise<boolean> => ipcRenderer.invoke('preview:closeAll')
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
