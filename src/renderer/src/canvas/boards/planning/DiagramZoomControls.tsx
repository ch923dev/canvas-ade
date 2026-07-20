/**
 * Header zoom cluster for DiagramCard (−/reset-to-fit/+), extracted verbatim like
 * DiagramRevScrubber so the card stays under the file-size cap. Presentation-only: the card owns
 * the zoom state (diagramZoom.ts model) — this renders it and calls back through `onZoom`. Every
 * button stops pointer-down propagation so a press never starts a board drag.
 */
import type { CSSProperties, ReactElement } from 'react'
import { stepZoom, ZOOM_FIT, ZOOM_MIN } from './diagramZoom'

const zoomBtn = (disabled: boolean): CSSProperties => ({
  all: 'unset',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.4 : 1,
  padding: '0 5px',
  borderRadius: 4,
  fontFamily: 'var(--term-mono)',
  color: 'var(--text-3)'
})

export function DiagramZoomControls({
  zoom,
  onZoom
}: {
  zoom: number
  onZoom: (z: number) => void
}): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 1 }} title="Scroll to zoom">
      <button
        type="button"
        title="Zoom out"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onZoom(stepZoom(zoom, -1))
        }}
        disabled={zoom <= ZOOM_MIN}
        style={zoomBtn(zoom <= ZOOM_MIN)}
      >
        −
      </button>
      <button
        type="button"
        title="Reset to fit"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onZoom(ZOOM_FIT)
        }}
        style={{
          all: 'unset',
          cursor: 'pointer',
          minWidth: 34,
          textAlign: 'center',
          color: 'var(--text-2)',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        title="Zoom in"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onZoom(stepZoom(zoom, 1))
        }}
        style={zoomBtn(false)}
      >
        +
      </button>
    </div>
  )
}
