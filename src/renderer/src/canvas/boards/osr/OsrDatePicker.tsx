import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import { monthGrid, monthLabel, parseIsoDate, isoDate } from '../../../lib/osrWidgets'

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/**
 * OS-3 Phase 4 (4E) — calendar overlay for a previewed page's `<input type="date">` (no native
 * picker offscreen). Committing writes the `YYYY-MM-DD` value back via CDP. Today = accent ring,
 * the selected day = accent fill (mirrors the signed-off mock). Esc dismisses; ‹/› navigate months.
 */
export function OsrDatePicker({
  value,
  onCommit,
  onDismiss
}: {
  value: string
  onCommit: (iso: string) => void
  onDismiss: () => void
}): ReactElement {
  const today = new Date()
  const todayIso = isoDate(today.getFullYear(), today.getMonth(), today.getDate())
  const init = parseIsoDate(value) ?? {
    year: today.getFullYear(),
    month0: today.getMonth(),
    day: today.getDate()
  }
  const [view, setView] = useState({ year: init.year, month0: init.month0 })
  const selectedIso = parseIsoDate(value) ? value : null
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const shift = (delta: number): void =>
    setView((v) => {
      const m = v.month0 + delta
      return { year: v.year + Math.floor(m / 12), month0: ((m % 12) + 12) % 12 }
    })

  const cells = monthGrid(view.year, view.month0)

  return (
    <div
      ref={rootRef}
      className="bb-osr-picker"
      tabIndex={0}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onDismiss()
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="bb-osr-pk-head">
        <button className="bb-osr-pk-nav" onClick={() => shift(-1)} aria-label="Previous month">
          <Icon name="back" size={13} />
        </button>
        <span className="bb-osr-pk-month">{monthLabel(view.year, view.month0)}</span>
        <button className="bb-osr-pk-nav" onClick={() => shift(1)} aria-label="Next month">
          <Icon name="forward" size={13} />
        </button>
      </div>
      <div className="bb-osr-pk-grid">
        {WEEKDAYS.map((w, i) => (
          <div key={`w${i}`} className="bb-osr-pk-wd">
            {w}
          </div>
        ))}
        {cells.map((c) => (
          <button
            key={c.iso}
            className={
              'bb-osr-pk-day' +
              (c.inMonth ? '' : ' bb-osr-pk-mut') +
              (c.iso === todayIso ? ' bb-osr-pk-today' : '') +
              (c.iso === selectedIso ? ' bb-osr-pk-sel' : '')
            }
            onClick={() => onCommit(c.iso)}
          >
            {c.day}
          </button>
        ))}
      </div>
    </div>
  )
}
