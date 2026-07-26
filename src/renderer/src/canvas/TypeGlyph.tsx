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
  if (type === 'file')
    // A document mark with a folded corner — a calm, non-illustrative file glyph (§6).
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
        <path d="M6 3.5h7l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
        <path d="M13 3.5V8.5h5" />
      </svg>
    )
  if (type === 'dataflow')
    // The data-flow mark — the ⌗ glyph used on the board chrome + the mock badge, set in the mono
    // face like the terminal caret / command ⌘ so it reads as a control surface, not an illustration.
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
        ⌗
      </span>
    )
  if (type === 'kanban')
    // The kanban mark — a board split into lanes (outer rect + two dividers), reading as columns of
    // cards. Line icon like the planning glyph so the two content boards share a visual family.
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
        <rect x={3} y={4} width={18} height={16} rx={2} />
        <path d="M9 4v16M15 4v16" />
      </svg>
    )
  if (type === 'swarm')
    // The swarm mark (S1) — one orchestrator node fanned out to three workers: the one-voice
    // manager pattern in a line icon (same family as the kanban/planning marks).
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
        <circle cx={12} cy={5.5} r={2.5} />
        <circle cx={5} cy={18} r={2.2} />
        <circle cx={12} cy={18} r={2.2} />
        <circle cx={19} cy={18} r={2.2} />
        <path d="M12 8v4.5M12 12.5L5.8 16M12 12.5v3.3M12 12.5l6.2 3.5" />
      </svg>
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
