/**
 * Command-board submit well (Phase C / C2) — a live task input plus the composition chips that pick
 * which worker boards the task's group spawns. Terminal is always-on (locked); +Planning / +Browser
 * are opt-in and OFF by default (the signed-off terminal-only default). The chosen composition is
 * read at submit and handed to the dispatch choreography. In the collapsed rail the chips are hidden
 * (the rail just submits with the sticky composition). `nodrag` + `stopPropagation` keep typing from
 * dragging the board or firing canvas keybindings.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
import { DEFAULT_COMPOSITION, type Composition } from '../../../lib/commandDispatch'

export function SubmitWell({
  onSubmit,
  showComposition = true
}: {
  onSubmit: (title: string, composition: Composition) => void
  showComposition?: boolean
}): ReactElement {
  const [value, setValue] = useState('')
  // Sticky across submits — dispatching several browser tasks keeps the toggle on.
  const [comp, setComp] = useState<Composition>(DEFAULT_COMPOSITION)

  const submit = (): void => {
    if (!value.trim()) return
    onSubmit(value, comp)
    setValue('')
  }

  return (
    <div style={wrapStyle}>
      <div style={wellStyle}>
        <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>›</span>
        <input
          className="cmd-submit-input nodrag"
          value={value}
          placeholder="Describe a task to dispatch…"
          onChange={(e) => setValue(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          style={inputStyle}
        />
        <button
          className="nodrag"
          title="Dispatch (Enter)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            submit()
          }}
          style={dispatchBtnStyle}
        >
          Dispatch ⏎
        </button>
      </div>
      {showComposition && (
        <div style={composeRowStyle}>
          <span style={composeLabelStyle}>spawn</span>
          <span style={lockedChipStyle} title="Every task spawns a terminal worker">
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--ok)' }} />
            Terminal
          </span>
          <ComposeToggle
            label="+ Planning"
            on={comp.planning}
            onToggle={() => setComp((c) => ({ ...c, planning: !c.planning }))}
          />
          <ComposeToggle
            label="+ Browser"
            on={comp.browser}
            onToggle={() => setComp((c) => ({ ...c, browser: !c.browser }))}
          />
        </div>
      )}
    </div>
  )
}

function ComposeToggle({
  label,
  on,
  onToggle
}: {
  label: string
  on: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <button
      className="nodrag"
      aria-pressed={on}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      style={{
        ...toggleChipBase,
        color: on ? 'var(--accent-hover)' : 'var(--text-3)',
        borderColor: on ? 'rgba(79,140,255,.45)' : 'var(--border-strong)',
        background: on ? 'var(--accent-wash)' : 'transparent'
      }}
    >
      {label}
    </button>
  )
}

const wrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, flex: 'none' }
const wellStyle: CSSProperties = {
  background: 'var(--inset)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)',
  padding: '6px 8px 6px 10px',
  display: 'flex',
  alignItems: 'center',
  gap: 8
}
const inputStyle: CSSProperties = {
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent'
}
const dispatchBtnStyle: CSSProperties = {
  color: 'var(--text-3)',
  fontSize: 11,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  padding: '3px 9px',
  flex: 'none',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap'
}
const composeRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 2px',
  flexWrap: 'wrap'
}
const composeLabelStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '.06em'
}
const chipBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  padding: '4px 10px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--border-subtle)'
}
const lockedChipStyle: CSSProperties = {
  ...chipBase,
  color: 'var(--ok)',
  borderColor: 'rgba(62,207,142,.28)',
  background: 'rgba(62,207,142,.08)'
}
const toggleChipBase: CSSProperties = { ...chipBase, cursor: 'pointer' }
