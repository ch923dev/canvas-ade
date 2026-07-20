/**
 * ‹ n/N › revision scrubber for the DiagramCard header (v22, B4) — a READ-ONLY peek at an expanse
 * diagram's prior specs. `revIndex` is the card's ephemeral session state (null = the live head);
 * the buttons follow the header zoom-button chrome (unset-styled, stopPropagation so a press never
 * starts a board drag). Nothing here writes the element — history is display-only until Phase 4.
 */
import type { CSSProperties, ReactElement } from 'react'

function btn(disabled: boolean): CSSProperties {
  return {
    all: 'unset',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    padding: '0 5px',
    borderRadius: 4,
    fontFamily: 'var(--term-mono)',
    color: 'var(--text-3)'
  }
}

export function DiagramRevScrubber({
  count,
  revIndex,
  onScrub
}: {
  /** Number of stored revisions (the head adds one more display state: n/N shows N = count+1). */
  count: number
  /** Current peek: null = live head, else an index into revisions (oldest→newest). */
  revIndex: number | null
  onScrub: (next: number | null) => void
}): ReactElement {
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 1 }}
      title="Revision history (read-only)"
    >
      <button
        type="button"
        title="Older revision"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onScrub(revIndex === null ? count - 1 : Math.max(0, revIndex - 1))
        }}
        disabled={revIndex === 0}
        style={btn(revIndex === 0)}
      >
        ‹
      </button>
      <span
        style={{
          minWidth: 26,
          textAlign: 'center',
          color: revIndex === null ? 'var(--text-3)' : 'var(--accent)',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {(revIndex ?? count) + 1}/{count + 1}
      </span>
      <button
        type="button"
        title="Newer revision"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onScrub(revIndex === null || revIndex + 1 >= count ? null : revIndex + 1)
        }}
        disabled={revIndex === null}
        style={btn(revIndex === null)}
      >
        ›
      </button>
    </div>
  )
}
