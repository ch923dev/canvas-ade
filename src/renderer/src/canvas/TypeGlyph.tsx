/**
 * Board type glyphs (port of design-reference/icons.jsx `TypeGlyph`). Small,
 * monochrome, never illustrative (DESIGN.md §6): Terminal `›` + caret (blinks
 * `--ok` while running), Browser = 2-bar window mark, Planning = dotted square +
 * pen stroke. Colour is inherited via `currentColor` from the caller.
 */
import type { ReactElement } from 'react'
import type { BoardType } from '../lib/boardSchema'

export interface TypeGlyphProps {
  type: BoardType
  /** Terminal only: drives the caret colour + blink while an agent runs. */
  running?: boolean
}

export function TypeGlyph({ type, running = false }: TypeGlyphProps): ReactElement {
  if (type === 'terminal')
    return (
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 12.5,
          fontWeight: 500,
          letterSpacing: '-0.04em',
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center'
        }}
      >
        ›
        <span
          className={running ? 'ca-caret-run' : ''}
          style={{
            display: 'inline-block',
            width: 6,
            height: 11,
            marginLeft: 1,
            // Inherit the glyph colour so the caret tints with the board status
            // (green running / red failed / neutral idle) set by BoardFrame.
            background: 'currentColor',
            borderRadius: 1,
            transform: 'translateY(0.5px)'
          }}
        />
      </span>
    )
  if (type === 'browser')
    return (
      <svg
        width={15}
        height={15}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x={3.5} y={5} width={17} height={14} rx={1.6} />
        <path d="M3.5 9h17" strokeWidth={1.4} />
        <circle cx={6.4} cy={7} r={0.6} fill="currentColor" stroke="none" />
      </svg>
    )
  if (type === 'command')
    // The orchestrator mark — the ⌘ command glyph (matches the approved production mock), set in
    // the mono face like the terminal caret so it reads as a control surface, not an illustration.
    return (
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 13,
          fontWeight: 500,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center'
        }}
      >
        ⌘
      </span>
    )
  // planning
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={4} y={4} width={16} height={16} rx={2} strokeDasharray="2.4 2.6" />
      <path d="M8.5 15.5l3-1 5-5-2-2-5 5z" strokeDasharray="0" />
    </svg>
  )
}
