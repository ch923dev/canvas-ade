import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import type { OsrSelectOption } from '../../../../../preload'

/**
 * OS-3 Phase 4 (4E) — the dropdown overlay for a previewed page's native `<select>` (which can't
 * composite offscreen). Options + current value come from the injected page hook; committing writes
 * the value back via CDP (`input`+`change` fire, so controlled React forms update). Keyboard: ↑/↓
 * move the highlight (skipping disabled), Enter commits, Esc dismisses; click commits directly.
 */
export function OsrSelectOverlay({
  options,
  value,
  onCommit,
  onDismiss
}: {
  options: OsrSelectOption[]
  value: string
  onCommit: (value: string) => void
  onDismiss: () => void
}): ReactElement {
  const initial = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  )
  const [active, setActive] = useState(initial)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const step = (dir: 1 | -1): void => {
    setActive((cur) => {
      let i = cur
      for (let n = 0; n < options.length; n++) {
        i = (i + dir + options.length) % options.length
        if (!options[i]?.disabled) return i
      }
      return cur
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const o = options[active]
      if (o && !o.disabled) onCommit(o.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onDismiss()
    }
  }

  return (
    <div
      ref={listRef}
      className="bb-osr-dropdown"
      role="listbox"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {options.map((o, i) => (
        <div
          key={i}
          role="option"
          aria-selected={o.value === value}
          className={
            'bb-osr-opt' +
            (o.value === value ? ' bb-osr-opt-sel' : '') +
            (i === active ? ' bb-osr-opt-active' : '') +
            (o.disabled ? ' bb-osr-opt-disabled' : '')
          }
          onPointerEnter={() => !o.disabled && setActive(i)}
          onClick={() => !o.disabled && onCommit(o.value)}
        >
          <span className="bb-osr-check">
            {o.value === value && <Icon name="check" size={13} />}
          </span>
          <span className="bb-osr-opt-label">{o.label || o.value}</span>
        </div>
      ))}
    </div>
  )
}
