/**
 * Connector-drag overlays (M2 rubber-band + GROUP-03 drop target), extracted from Canvas (the
 * god-file max-lines ratchet). Two `fixed`/client-space layers, drawn only while a connector drag
 * is in flight:
 *   • the rubber-band — a calm dashed line from the source board's centre to the live pointer;
 *   • GROUP-03 drop target — the resolved target board glows accent (ring + wash + "Connect here"
 *     pill), symmetric with the group-box drag's drop-target glow.
 * Both are pointer-events:none so neither eats the release, and positioned in CLIENT coords (the
 * same space as the pointer + flowToScreenPosition) so there's no pane-rect / ref read in render.
 */
import { type ReactElement } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import type { Board } from '../lib/boardSchema'

export interface ConnectorDragOverlayProps {
  rf: ReactFlowInstance
  boards: Board[]
  connectFromId: string | null
  connectPointer: { x: number; y: number } | null
  /** GROUP-03: the resolved drop-target board id (null over empty canvas / the source). */
  connectTargetId: string | null
}

export function ConnectorDragOverlay({
  rf,
  boards,
  connectFromId,
  connectPointer,
  connectTargetId
}: ConnectorDragOverlayProps): ReactElement | null {
  if (!connectFromId) return null
  const src = boards.find((b) => b.id === connectFromId)
  const tgt = connectTargetId ? boards.find((b) => b.id === connectTargetId) : undefined
  const line =
    connectPointer && src
      ? rf.flowToScreenPosition({ x: src.x + src.w / 2, y: src.y + src.h / 2 })
      : null
  const tl = tgt ? rf.flowToScreenPosition({ x: tgt.x, y: tgt.y }) : null
  const br = tgt ? rf.flowToScreenPosition({ x: tgt.x + tgt.w, y: tgt.y + tgt.h }) : null
  return (
    <>
      {line && connectPointer && (
        <svg
          style={{
            position: 'fixed',
            inset: 0,
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: 50
          }}
        >
          <line
            x1={line.x}
            y1={line.y}
            x2={connectPointer.x}
            y2={connectPointer.y}
            stroke="var(--border-strong)"
            strokeWidth={2}
            strokeDasharray="5 5"
          />
        </svg>
      )}
      {tl && br && (
        <div
          className="ca-connect-drop-target"
          style={{
            position: 'fixed',
            left: tl.x,
            top: tl.y,
            width: Math.max(0, br.x - tl.x),
            height: Math.max(0, br.y - tl.y),
            pointerEvents: 'none',
            zIndex: 49
          }}
        >
          <span className="ca-connect-drop-pill">Connect here</span>
        </div>
      )}
    </>
  )
}
