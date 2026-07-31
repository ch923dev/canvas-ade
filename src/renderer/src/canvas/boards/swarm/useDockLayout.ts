/**
 * Docked-terminals region layout (eyeball feedback 2026-07-31) — divider-driven px sizes for
 * the chat spine (width), worker rail (width) and triage strip (height); the dock viewport
 * takes whatever remains. Live drag = transient React state, converting the divider's SCREEN-px
 * delta to board-local px via the live camera zoom (a board at zoom 0.5 must not resize 2× per
 * pointer px). Release = ONE tracked `updateBoard` step onto `SwarmBoard.dockLayout` (undoable,
 * like a board resize; clamped both at render and at commit so a hand-edited doc can't wedge a
 * region off-screen).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { useCanvasStore } from '../../../store/canvasStore'
import type { SwarmBoard as SwarmBoardData } from '../../../lib/boardSchema'

const CLAMP = {
  chat: { min: 180, max: 560, def: 300 },
  rail: { min: 150, max: 420, def: 208 },
  triage: { min: 84, max: 340, def: 196 }
} as const

export type DockRegion = keyof typeof CLAMP

const clampRegion = (r: DockRegion, v: number): number =>
  Math.round(Math.min(CLAMP[r].max, Math.max(CLAMP[r].min, v)))

export interface DockDividerHandlers {
  onStart: () => void
  onLive: (delta: number) => void
  onEnd: () => void
}

export function useDockLayout(board: SwarmBoardData): {
  sizes: Record<DockRegion, number>
  handlersFor: (region: DockRegion, dir?: 1 | -1) => DockDividerHandlers
} {
  const rfStore = useStoreApi()
  const [live, setLive] = useState<Partial<Record<DockRegion, number>>>({})
  const baseRef = useRef(0)
  const sizes: Record<DockRegion, number> = {
    chat: clampRegion('chat', live.chat ?? board.dockLayout?.chat ?? CLAMP.chat.def),
    rail: clampRegion('rail', live.rail ?? board.dockLayout?.rail ?? CLAMP.rail.def),
    triage: clampRegion('triage', live.triage ?? board.dockLayout?.triage ?? CLAMP.triage.def)
  }
  // Latest clamped sizes for the drag handlers (a useCallback closure would go stale mid-drag).
  // Effect-synced (never written in render — the compiler-lint rule); every commit re-renders,
  // so the ref is current before any pointer event can read it.
  const sizesRef = useRef(sizes)
  useEffect(() => {
    sizesRef.current = sizes
  })

  const handlersFor = useCallback(
    (region: DockRegion, dir: 1 | -1 = 1): DockDividerHandlers => ({
      onStart: (): void => {
        baseRef.current = sizesRef.current[region]
      },
      onLive: (delta: number): void => {
        const zoom = rfStore.getState().transform[2] || 1
        const next = baseRef.current + (dir * delta) / zoom
        setLive((l) => (l[region] === next ? l : { ...l, [region]: next }))
      },
      onEnd: (): void => {
        // Commit against the LIVE board (the prop closure may predate another patch), then
        // drop the transient value so the persisted one takes over seamlessly.
        const committed = clampRegion(region, sizesRef.current[region])
        const store = useCanvasStore.getState()
        const b = store.boards.find((x) => x.id === board.id)
        const cur = b && b.type === 'swarm' ? b.dockLayout : undefined
        store.updateBoard(board.id, {
          dockLayout: { ...cur, [region]: committed }
        } as Partial<SwarmBoardData>)
        setLive((l) => {
          const next = { ...l }
          delete next[region]
          return next
        })
      }
    }),
    [board.id, rfStore]
  )

  return { sizes, handlersFor }
}
