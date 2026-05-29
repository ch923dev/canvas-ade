/**
 * In-process E2E renderer hook (Stage 1). When the page is in e2e mode this installs
 * `window.__canvasE2E` — a tiny imperative surface MAIN drives via
 * `webContents.executeJavaScript`: seed boards through the real Zustand store, read
 * board/runtime state back, read a terminal's framebuffer, and fit the camera. All
 * return values are JSON-serializable so they survive the executeJavaScript bridge.
 *
 * Installed from CanvasInner (which owns the React Flow instance) and guarded by
 * isE2E(); a no-op in every normal run.
 */
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { fromObject, type Board, type BoardType } from '../lib/boardSchema'
import { makeChecklist } from '../canvas/boards/planning/elements'
import { e2eTerminals } from './e2eRegistry'

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
  /** Append a checklist element (one starter item) to a planning board. */
  addChecklist: (id: string) => void
  /** Fit the camera to one board (id) or all boards — forces zoom ≥ LOD for capture. */
  fitView: (id?: string) => void
  /** True if the live store round-trips through toObject→fromObject without throwing. */
  roundTripOk: () => boolean
}

declare global {
  interface Window {
    __canvasE2E?: CanvasE2E
  }
}

let seedX = 0

export function installE2EHooks(rf: ReactFlowInstance): void {
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
    addChecklist(id) {
      const store = useCanvasStore.getState()
      const b = store.boards.find((x) => x.id === id)
      if (!b || b.type !== 'planning') return
      const cl = makeChecklist(crypto.randomUUID(), crypto.randomUUID(), { x: 60, y: 60 })
      store.updateBoard(id, { elements: [...b.elements, cl] })
    },
    fitView(id) {
      const opts = { maxZoom: 1, padding: 0.2, duration: 0 } as const
      void rf.fitView(id ? { ...opts, nodes: [{ id }] } : opts)
    },
    roundTripOk() {
      try {
        fromObject(useCanvasStore.getState().toObject())
        return true
      } catch {
        return false
      }
    }
  }
  window.__canvasE2E = api
}
