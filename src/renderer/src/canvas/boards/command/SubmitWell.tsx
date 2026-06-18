/**
 * Command-board submit well (Phase C / C2) — a live task input plus the composition chips that pick
 * which worker boards the task's group spawns. Terminal is always-on (locked); +Planning / +Browser
 * are opt-in and OFF by default (the signed-off terminal-only default). The chosen composition is
 * read at submit and handed to the dispatch choreography. In the collapsed rail the chips are hidden
 * (the rail just submits with the sticky composition). `nodrag` + `stopPropagation` keep typing from
 * dragging the board or firing canvas keybindings.
 *
 * Multi-line input (2026-06-18): the well is a chat-style auto-growing `<textarea>` — Enter dispatches,
 * Shift+Enter inserts a newline (mirroring the terminal's Shift+Enter, see commandRegistry). It grows
 * from one row up to MAX_INPUT_PX then scrolls, and snaps back to one row after a submit.
 */
import { useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { DEFAULT_COMPOSITION, type Composition } from '../../../lib/commandDispatch'

/** Cap (px) the well grows to (~6 rows) before the textarea scrolls instead of growing further. */
const MAX_INPUT_PX = 112

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
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow: collapse to the content height (capped at MAX_INPUT_PX) so the well expands with
  // multi-line input and shrinks back when it is cleared. Reset to 'auto' first so it can shrink.
  const autoGrow = (): void => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_PX)}px`
  }

  const submit = (): void => {
    if (!value.trim()) return
    onSubmit(value, comp)
    setValue('')
    // Snap the grown well back to a single row once the text is cleared.
    const el = taRef.current
    if (el) el.style.height = 'auto'
  }

  return (
    <div style={wrapStyle}>
      <div style={wellStyle}>
        <span style={promptCharStyle}>›</span>
        <textarea
          ref={taRef}
          className="cmd-submit-input nodrag"
          value={value}
          rows={1}
          placeholder="Describe a task to dispatch…"
          onChange={(e) => {
            setValue(e.target.value)
            autoGrow()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            // Enter dispatches; Shift+Enter inserts a newline (let the default run). Never submit
            // mid-IME-composition — an Enter that only commits a candidate must not fire dispatch.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          style={inputStyle}
        />
        <button
          className="nodrag"
          title="Dispatch (Enter · Shift+Enter for a newline)"
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
        <div style={hintStyle}>Enter to dispatch · Shift+Enter for a newline</div>
      )}
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
  // Top-aligned so the well grows DOWN with multi-line input; the prompt char rides the first row and
  // the Dispatch button anchors to the bottom-right (chat-style) instead of floating to the middle.
  alignItems: 'flex-start',
  gap: 8
}
const promptCharStyle: CSSProperties = {
  color: 'var(--accent)',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: '17px',
  flex: 'none'
}
const inputStyle: CSSProperties = {
  color: 'var(--text)',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: '17px',
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  resize: 'none',
  overflowY: 'auto',
  maxHeight: MAX_INPUT_PX,
  padding: 0,
  margin: 0,
  display: 'block'
}
const dispatchBtnStyle: CSSProperties = {
  color: 'var(--text-3)',
  fontSize: 11,
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  padding: '3px 9px',
  flex: 'none',
  alignSelf: 'flex-end',
  background: 'transparent',
  cursor: 'pointer',
  whiteSpace: 'nowrap'
}
const hintStyle: CSSProperties = {
  color: 'var(--text-faint)',
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  padding: '0 2px',
  marginTop: -2
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
