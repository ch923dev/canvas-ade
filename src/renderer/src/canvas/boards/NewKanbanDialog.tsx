/**
 * Kanban config dialog — the place-first creation picker a freshly-dropped Kanban opens BEFORE it is
 * usable, so the columns' MEANING is a deliberate up-front choice (like New Terminal picks the agent).
 *
 * A dock-placed Kanban is born with the flow template and its spawn "held" via `configPendingId`
 * (same gate the terminal uses); this dialog resolves it:
 *  - **Flow** (default): columns are ordered workflow stages — keep the seeded template
 *    (Backlog · In Progress · Review · Done); the card modal's lane field reads "Status".
 *  - **Category**: columns are unordered buckets the user defines — clear the template to an EMPTY
 *    board (they add a lane per subsystem / phase / owner) and stamp `columnAxis:'category'` +
 *    the chosen `axisLabel` (the modal's lane-field label + board caption).
 *  - **Cancel / Esc**: release as the default Flow board (template kept), matching the terminal's
 *    "cancel = plain shell" release.
 *
 * The axis is chosen ONCE here and is not editable afterward (decided 2026-07-14) — recreate the
 * board to switch. Built on the shared Modal (scrim + focus-trap + Esc); inline-styled to match
 * NewTerminalDialog's card exactly.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from '../Modal'
import { useCanvasStore } from '../../store/canvasStore'
import type { KanbanBoard as KanbanBoardData } from '../../lib/boardSchema'

type Axis = 'flow' | 'category'

export function NewKanbanDialog({
  board,
  onClose
}: {
  board: KanbanBoardData
  /** Release the held board (clearConfigPending). Called on Create AND Cancel/Esc. */
  onClose: () => void
}): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const [axis, setAxis] = useState<Axis>('flow')
  const [name, setName] = useState('')

  const create = (): void => {
    // Flow keeps the template the board was born with (columnAxis absent ⇒ 'flow' at read), so there
    // is nothing to patch — just release. Category re-shapes the board to empty + stamps the axis.
    if (axis === 'category') {
      beginChange()
      updateBoard(board.id, {
        columnAxis: 'category',
        axisLabel: name.trim() || undefined,
        columns: []
      })
    }
    onClose()
  }

  return (
    <Modal
      label="New Kanban"
      onClose={onClose}
      zIndex={600}
      scrimProps={{ 'data-test': 'new-kanban-scrim' }}
      cardProps={{ 'data-test': 'new-kanban-dialog' }}
      cardStyle={card}
    >
      <div style={title}>New Kanban</div>

      <div>
        <div style={sectionLabel}>What do the columns mean?</div>
        <div style={tiles}>
          <AxisTile
            on={axis === 'flow'}
            testid="kanban-axis-flow"
            glyph={
              <path
                d="M3 10h11M10 6l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            }
            name="Flow"
            desc="Ordered workflow stages a card moves through."
            example="Backlog → Doing → Done"
            meta="Starts with a template"
            onPick={() => setAxis('flow')}
          />
          <AxisTile
            on={axis === 'category'}
            testid="kanban-axis-category"
            glyph={
              <>
                <rect
                  x="3"
                  y="3.5"
                  width="5.5"
                  height="5.5"
                  rx="1.3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="11.5"
                  y="3.5"
                  width="5.5"
                  height="5.5"
                  rx="1.3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <rect
                  x="3"
                  y="11.5"
                  width="5.5"
                  height="5.5"
                  rx="1.3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </>
            }
            name="Category"
            desc="Buckets a card belongs to — you define them."
            example="Subsystem · Phase · Owner"
            meta="Starts empty"
            onPick={() => setAxis('category')}
          />
        </div>
      </div>

      {axis === 'category' && (
        <label style={fieldWrap}>
          <span style={fieldLabel}>Grouped by</span>
          <input
            style={fld}
            placeholder="e.g. Phase, Subsystem, Sprint"
            aria-label="Category axis name"
            data-test="new-kanban-axis-name"
            spellCheck={false}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
            onFocus={ringOn}
            onBlur={ringOff}
          />
          <span style={hint}>
            Names the column axis — the card modal&apos;s lane field &amp; the board caption.
          </span>
        </label>
      )}

      <div style={footer}>
        <button type="button" style={btnGhost} onClick={onClose} data-test="new-kanban-cancel">
          Cancel
        </button>
        <button type="button" style={btnPrimary} onClick={create} data-test="new-kanban-create">
          {axis === 'flow' ? 'Create Flow board' : 'Create Category board'}
        </button>
      </div>
    </Modal>
  )
}

function AxisTile({
  on,
  testid,
  glyph,
  name,
  desc,
  example,
  meta,
  onPick
}: {
  on: boolean
  testid: string
  glyph: ReactElement
  name: string
  desc: string
  example: string
  meta: string
  onPick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      style={on ? { ...tile, ...tileOn } : tile}
      aria-pressed={on}
      aria-label={name}
      data-test={testid}
      onClick={onPick}
    >
      <span style={on ? { ...glyphBox, ...glyphBoxOn } : glyphBox} aria-hidden="true">
        <svg width="19" height="19" viewBox="0 0 20 20" fill="none">
          {glyph}
        </svg>
      </span>
      <span style={on ? { ...tName, ...tNameOn } : tName}>{name}</span>
      <span style={tDesc}>{desc}</span>
      <span style={tEx}>{example}</span>
      <span style={tMeta}>{meta}</span>
    </button>
  )
}

// Inline-styled inputs can't use :focus-visible — mirror the select-ring on focus/blur (as
// NewTerminalDialog does).
const ringOn = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = '0 0 0 1.5px var(--accent)'
}
const ringOff = (e: { currentTarget: HTMLElement }): void => {
  e.currentTarget.style.boxShadow = ''
}

const card: CSSProperties = {
  width: 460,
  maxWidth: '92vw',
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 14
}
const title: CSSProperties = {
  textAlign: 'center',
  fontSize: 15,
  lineHeight: '22px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--text)'
}
const sectionLabel: CSSProperties = {
  fontSize: 10,
  lineHeight: '14px',
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 7
}
const tiles: CSSProperties = { display: 'flex', gap: 10 }
const tile: CSSProperties = {
  flex: 1,
  textAlign: 'left',
  cursor: 'pointer',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  borderRadius: 'var(--r-inner)',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)'
}
const tileOn: CSSProperties = {
  borderColor: 'var(--accent)',
  background: 'var(--accent-wash)',
  boxShadow: '0 0 0 1px var(--accent)'
}
const glyphBox: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 'var(--r-ctl)',
  display: 'grid',
  placeItems: 'center',
  background: 'var(--surface-overlay)',
  border: '1px solid var(--border-subtle)'
}
const glyphBoxOn: CSSProperties = {
  background: 'transparent',
  borderColor: 'var(--accent)',
  color: 'var(--accent)'
}
const tName: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--text)' }
const tNameOn: CSSProperties = { color: 'var(--accent)' }
const tDesc: CSSProperties = { fontSize: 11, lineHeight: 1.45, color: 'var(--text-3)' }
const tEx: CSSProperties = { fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-2)' }
const tMeta: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--text-faint)',
  marginTop: 2
}
const fieldWrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const fieldLabel: CSSProperties = { fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }
const fld: CSSProperties = {
  height: 30,
  padding: '0 9px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  outline: 'none'
}
const hint: CSSProperties = { fontSize: 11, color: 'var(--text-3)' }
const footer: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 2 }
const btnGhost: CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  cursor: 'pointer'
}
const btnPrimary: CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--accent)',
  background: 'var(--accent-wash)',
  color: 'var(--accent)',
  fontWeight: 600
}
