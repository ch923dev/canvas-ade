/**
 * Searchable per-agent command builder (A2). Renders a preset's option schema as
 * selects / toggles / text fields and reports value changes up; the parent composes the
 * launch command from those values (composeCommand) and keeps the editable raw field as
 * the escape hatch. Stateless w.r.t. the values (controlled by the parent); owns only the
 * search query. No options ⇒ this component is never rendered (the parent shows raw only).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
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
  const [activeGroup, setActiveGroup] = useState('')
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  // useMemo so `preset.options ?? []` is a stable ref (a fresh [] each render would churn
  // the dependent memos; the lint catches it).
  const all = useMemo(() => preset.options ?? [], [preset])
  const q = query.trim().toLowerCase()

  // Distinct option groups in first-appearance order (= the tab order). ≥2 groups ⇒ category
  // tabs; agents without groups (Codex/Gemini/OpenCode) yield none ⇒ a flat list.
  const groups = useMemo(() => {
    const seen: string[] = []
    for (const o of all) if (o.group && !seen.includes(o.group)) seen.push(o.group)
    return seen
  }, [all])
  const hasGroups = groups.length >= 2
  // Search is a tucked-away icon (tabs already chunk the options); only worth offering once a
  // preset has enough flags that scanning the tabs is slower than typing.
  const canSearch = all.length > 4
  // Tabs show when not searching; the search box replaces the tab strip (one band, not two).
  const tabbed = !searching && hasGroups
  // Guard the active tab against a preset switch (the prior preset's group may not exist now).
  const active = groups.includes(activeGroup) ? activeGroup : (groups[0] ?? '')

  // Focus the search field when it opens. (Transient search/tab state is reset by remount —
  // the parent keys this component on the preset id, so switching agents starts it fresh.)
  useEffect(() => {
    if (searching) searchRef.current?.focus()
  }, [searching])

  const shown = useMemo(() => {
    if (searching)
      return all.filter(
        (o) => o.label.toLowerCase().includes(q) || o.flag.toLowerCase().includes(q)
      )
    if (hasGroups) return all.filter((o) => o.group === active)
    return all
  }, [all, q, searching, hasGroups, active])

  const closeSearch = (): void => {
    setSearching(false)
    setQuery('')
  }
  const set = (id: string, v: string | boolean): void => onChange({ ...values, [id]: v })

  return (
    <div style={wrap} data-test="command-builder">
      <div style={head}>Configure {preset.label}</div>

      {searching && canSearch && (
        <div style={search}>
          <Icon name="search" size={13} style={{ color: 'var(--text-3)' }} />
          <input
            ref={searchRef}
            style={searchInput}
            placeholder="Search options…"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-test="command-builder-search"
          />
          <button
            type="button"
            style={iconBtn}
            onClick={closeSearch}
            aria-label="Close search"
            data-test="command-builder-search-close"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {!searching && (tabbed || canSearch) && (
        <div style={tabs} role="tablist">
          {tabbed &&
            groups.map((g) => {
              const on = g === active
              return (
                <button
                  key={g}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  style={on ? { ...tab, ...tabOn } : tab}
                  onClick={() => setActiveGroup(g)}
                  data-test={`group-${g.toLowerCase()}`}
                >
                  {g}
                </button>
              )
            })}
          {canSearch && (
            <button
              type="button"
              style={searchToggle}
              onClick={() => setSearching(true)}
              aria-label="Search options"
              data-test="command-builder-search-toggle"
            >
              <Icon name="search" size={14} />
            </button>
          )}
        </div>
      )}

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
                <span style={optName}>{opt.label}</span>
                <span style={flagHint} title={opt.flag}>
                  {opt.flag}
                </span>
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
                  <option value="" style={optChoice}>
                    —
                  </option>
                  {opt.choices.map((c) => (
                    <option key={c.value} value={c.value} style={optChoice}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span style={flagHint} title={opt.flag}>
                  {opt.flag}
                </span>
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
              <span style={flagHint} title={opt.flag}>
                {opt.flag}
              </span>
            </div>
          )
        })}
        {shown.length === 0 && q !== '' && <div style={empty}>No options match “{query}”.</div>}
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
  // Flush section, not a box-in-a-box: a light top-border groups it without stealing
  // horizontal room to a second layer of padding (the cramped-dialog fix).
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: 12,
  marginTop: 1,
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
  flex: 1,
  minWidth: 0
}
// A small chrome icon button (the search close ×, sized to the search row).
const iconBtn: CSSProperties = {
  flex: 'none',
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0
}
// Underline tabs — visually distinct from the dialog's Details/Appearance pill segmented
// control above, so it doesn't read as tabs-inside-tabs.
const tabs: CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid var(--border-subtle)'
}
const tab: CSSProperties = {
  // Equal-width segments so the four tabs spread evenly across the full strip.
  flex: '1 1 0',
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  padding: '3px 4px 7px',
  marginBottom: -1,
  borderBottom: '2px solid transparent',
  color: 'var(--text-3)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  textAlign: 'center',
  cursor: 'pointer',
  whiteSpace: 'nowrap'
}
const tabOn: CSSProperties = {
  color: 'var(--text)',
  borderBottomColor: 'var(--accent)',
  fontWeight: 500
}
// The collapsed-search affordance: a magnifier tucked at the right end of the tab strip.
const searchToggle: CSSProperties = {
  flex: 'none',
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: 'var(--text-3)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0 2px 7px',
  marginBottom: -1
}
const list: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  maxHeight: 232,
  overflowY: 'auto',
  // Explicit: overflow-y:auto otherwise computes overflow-x to auto too, which produced the
  // stray horizontal scrollbar. Rows are now shrink-to-fit (minWidth:0) so nothing clips.
  overflowX: 'hidden',
  paddingRight: 2,
  // Thin dark scrollbar (matches .cp-list) — the bright native bar read as a defect.
  scrollbarWidth: 'thin',
  scrollbarColor: 'var(--border-strong) transparent'
}
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 30,
  minWidth: 0
}
const toggleRow: CSSProperties = {
  ...row,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left'
}
const optName: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--text)',
  // Content-width with a floor: rows are left-packed (label → control → flag, tight), and the
  // floor lines the controls up across rows. Ellipsis caps the few long labels.
  flex: '0 1 auto',
  minWidth: 96,
  maxWidth: 188,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}
const flagHint: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10.5,
  color: 'var(--text-faint)',
  // Sits tight against its control (no longer floated to the row's far edge). Cap + ellipsis so
  // a long flag like `--dangerously-skip-permissions` can't blow the row out; full flag in title.
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: 'none',
  maxWidth: 150
}
const pill: CSSProperties = {
  height: 26,
  width: 150,
  flex: 'none',
  padding: '0 6px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  outline: 'none',
  cursor: 'pointer',
  // Render the native dropdown popup with dark chrome (light popup + washed options was the bug).
  colorScheme: 'dark'
}
// "Selected" = accent border + text only. We deliberately do NOT tint the control's background:
// a light --accent-wash bled into the native option popup, washing out the unselected rows.
const pillOn: CSSProperties = {
  borderColor: 'var(--accent)',
  color: 'var(--accent)'
}
// Explicit per-option colors so the native popup is always readable regardless of pill state.
const optChoice: CSSProperties = { background: 'var(--surface-overlay)', color: 'var(--text)' }
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
  flex: 'none',
  width: 150
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
