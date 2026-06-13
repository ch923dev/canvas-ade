/**
 * Searchable per-agent command builder (A2). Renders a preset's option schema as
 * selects / toggles / text fields and reports value changes up; the parent composes the
 * launch command from those values (composeCommand) and keeps the editable raw field as
 * the escape hatch. Stateless w.r.t. the values (controlled by the parent); owns only the
 * search query. No options ⇒ this component is never rendered (the parent shows raw only).
 */
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import type { AgentPreset } from './agentPresets'
import type { OptionValues } from './composeCommand'

export function CommandBuilder({
  preset,
  values,
  onChange
}: {
  preset: AgentPreset
  values: OptionValues
  onChange: (next: OptionValues) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  // useMemo so `preset.options ?? []` is a stable ref (a fresh [] each render would churn
  // the `shown` memo's deps; the lint catches it).
  const all = useMemo(() => preset.options ?? [], [preset])
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      q === ''
        ? all
        : all.filter((o) => o.label.toLowerCase().includes(q) || o.flag.toLowerCase().includes(q)),
    [all, q]
  )

  const set = (id: string, v: string | boolean): void => onChange({ ...values, [id]: v })

  return (
    <div style={wrap} data-test="command-builder">
      <div style={head}>Configure {preset.label}</div>
      <div style={search}>
        <Icon name="search" size={13} style={{ color: 'var(--text-3)' }} />
        <input
          style={searchInput}
          placeholder="Search options (model, effort, permission…)"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-test="command-builder-search"
        />
      </div>

      <div style={list}>
        {shown.map((opt) => {
          if (opt.kind === 'toggle') {
            const on = values[opt.id] === true
            return (
              <button
                key={opt.id}
                type="button"
                style={toggleRow}
                onClick={() => set(opt.id, !on)}
                aria-pressed={on}
                data-test={`opt-${opt.id}`}
              >
                <span style={on ? { ...box, ...(opt.danger ? boxDanger : boxOn) } : box}>
                  {on && <Icon name="check" size={10} style={{ color: 'var(--void)' }} />}
                </span>
                <span style={{ ...optName, flex: 1 }}>{opt.label}</span>
                <span style={flagHint}>{opt.flag}</span>
              </button>
            )
          }
          if (opt.kind === 'select') {
            const v = (values[opt.id] as string) ?? ''
            return (
              <div key={opt.id} style={row}>
                <span style={optName}>{opt.label}</span>
                <select
                  style={v ? { ...pill, ...pillOn } : pill}
                  value={v}
                  onChange={(e) => set(opt.id, e.target.value)}
                  data-test={`opt-${opt.id}`}
                >
                  <option value="">—</option>
                  {opt.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span style={flagHint}>{opt.flag}</span>
              </div>
            )
          }
          // text
          const v = (values[opt.id] as string) ?? ''
          return (
            <div key={opt.id} style={row}>
              <span style={optName}>{opt.label}</span>
              <input
                style={textInput}
                placeholder={opt.placeholder}
                spellCheck={false}
                value={v}
                onChange={(e) => set(opt.id, e.target.value)}
                data-test={`opt-${opt.id}`}
              />
              <span style={flagHint}>{opt.flag}</span>
            </div>
          )
        })}
        {shown.length === 0 && <div style={empty}>No options match “{query}”.</div>}
      </div>

      {q !== '' && shown.length > 0 && (
        <div style={countHint}>
          {shown.length} of {all.length} options match
        </div>
      )}
    </div>
  )
}

const wrap: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-inner)',
  background: 'var(--surface)',
  padding: '11px 11px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 9
}
const head: CSSProperties = {
  fontSize: 11,
  color: 'var(--text-3)',
  fontWeight: 500,
  letterSpacing: '0.04em',
  textTransform: 'uppercase'
}
const search: CSSProperties = {
  height: 28,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '0 8px'
}
const searchInput: CSSProperties = {
  border: 'none',
  background: 'transparent',
  outline: 'none',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  width: '100%'
}
const list: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 184,
  overflowY: 'auto'
}
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, minHeight: 30 }
const toggleRow: CSSProperties = {
  ...row,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left'
}
const optName: CSSProperties = { fontSize: 12.5, color: 'var(--text)', flex: '0 0 118px' }
const flagHint: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--text-faint)',
  marginLeft: 'auto'
}
const pill: CSSProperties = {
  height: 26,
  padding: '0 6px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  outline: 'none',
  cursor: 'pointer'
}
const pillOn: CSSProperties = {
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  background: 'var(--accent-wash)'
}
const textInput: CSSProperties = {
  height: 26,
  padding: '0 8px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  outline: 'none',
  width: 120
}
const box: CSSProperties = {
  width: 16,
  height: 16,
  flex: 'none',
  borderRadius: 4,
  border: '1px solid var(--border-strong)',
  background: 'transparent',
  display: 'grid',
  placeItems: 'center'
}
const boxOn: CSSProperties = { background: 'var(--accent)', borderColor: 'var(--accent)' }
const boxDanger: CSSProperties = { background: 'var(--err)', borderColor: 'var(--err)' }
const countHint: CSSProperties = { fontSize: 11, color: 'var(--text-3)' }
const empty: CSSProperties = { fontSize: 12, color: 'var(--text-3)', padding: '4px 0' }
