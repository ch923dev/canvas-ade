import { useState, type ReactElement } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * The chrome cluster's icon-button primitive (28px square, accent-wash when active). Extracted
 * from AppChrome unchanged (bell PR) so chrome siblings (NotificationBell) can use it without an
 * AppChrome import cycle; AppChrome's ~10 call sites are untouched. `dataTest`/`ariaLabel` are
 * additive — AppChrome passes neither.
 */
export function ToolBtn({
  name,
  title,
  active = false,
  big = false,
  pressed,
  expanded,
  onClick,
  dataTest,
  ariaLabel
}: {
  name: IconName
  title: string
  active?: boolean
  big?: boolean
  /** CHROME-02: toggle buttons (dock arming) pass their on/off state → aria-pressed.
   *  Omitted for plain action buttons (zoom/fit/settings) so they stay un-toggled to AT. */
  pressed?: boolean
  /** CHROME-02: popup triggers (Tidy) pass their open state → aria-haspopup + aria-expanded. */
  expanded?: boolean
  onClick: () => void
  /** e2e selector hook (the bell); AppChrome's buttons select by `title` and pass nothing. */
  dataTest?: string
  /** Live label override (the bell announces its unread count); `title` remains the static one. */
  ariaLabel?: string
}): ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      // ca-t-ctl (A12): hover transition via class so reduced-motion can suppress it.
      className="ca-t-ctl"
      title={title}
      data-test={dataTest}
      aria-label={ariaLabel}
      // CHROME-02: undefined ⇒ React omits the attr (correct for plain action buttons).
      aria-pressed={pressed}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: big ? 32 : 28,
        height: 28,
        display: 'grid',
        placeItems: 'center',
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        background: active
          ? 'var(--accent-wash)'
          : hover
            ? 'var(--surface-overlay)'
            : 'transparent',
        color: active ? 'var(--accent)' : hover ? 'var(--text)' : 'var(--text-3)'
      }}
    >
      <Icon name={name} size={16} />
    </button>
  )
}
