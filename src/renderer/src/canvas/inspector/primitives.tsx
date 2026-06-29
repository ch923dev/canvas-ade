/**
 * Board Inspector primitives — the shared toolkit every per-type inspector composes from (the
 * "base" of the composition; the React-idiomatic stand-in for a base class). One look, one a11y
 * model, one keyboard pattern across all board types. Built for what TerminalInspector (the first
 * consumer) needs; Segmented / Toggle / Swatch land alongside the Browser / Planning inspectors that
 * first require them (primitives extracted from real use, never speculative).
 *
 * Colours/typography live in styles/chrome/boardinspector.css (token-driven); these components are
 * structure + behaviour only — no inline colour literals (STYLE-02).
 */
import { useState, type ReactElement, type ReactNode } from 'react'

/** The shape every per-type inspector content receives. Per-type components widen this with their
 *  own handler props (supplied by the board when it portals its content into the shell slot). */
export interface InspectorContentProps {
  boardId: string
}

/** A collapsible labelled section (uppercase micro label + chevron). Open by default; collapse state
 *  is local for now (localStorage-persisted in a later polish phase). */
export function InspectorSection({
  label,
  defaultOpen = true,
  children
}: {
  label: string
  defaultOpen?: boolean
  children: ReactNode
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="ca-inspector-section">
      <button
        type="button"
        className="ca-inspector-section-hd"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ca-inspector-section-lab">{label}</span>
        <svg
          className="ca-inspector-chev"
          data-open={open}
          width={12}
          height={12}
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden
        >
          <path d="M4.5 3l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
      {open && <div className="ca-inspector-section-body">{children}</div>}
    </section>
  )
}

/** A 28px control row: an optional label (flex-1) + its control on the right. */
export function InspectorRow({
  label,
  children
}: {
  label?: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="ca-inspector-row">
      {label != null && <span className="ca-inspector-row-lab">{label}</span>}
      {children}
    </div>
  )
}

/** −/value/+ stepper (e.g. font size). The live value sits between the two buttons. */
export function InspectorStepper({
  value,
  onDec,
  onInc,
  decDisabled,
  incDisabled,
  decLabel,
  incLabel
}: {
  value: ReactNode
  onDec: () => void
  onInc: () => void
  decDisabled?: boolean
  incDisabled?: boolean
  decLabel: string
  incLabel: string
}): ReactElement {
  return (
    <div className="ca-inspector-step">
      <button
        type="button"
        aria-label={decLabel}
        title={decLabel}
        disabled={decDisabled}
        onClick={onDec}
      >
        −
      </button>
      <span className="ca-inspector-step-val">{value}</span>
      <button
        type="button"
        aria-label={incLabel}
        title={incLabel}
        disabled={incDisabled}
        onClick={onInc}
      >
        +
      </button>
    </div>
  )
}

/** A full-width labelled action button. `primary` accents it, `danger` reds it, `active` washes it
 *  (e.g. a sent-interrupt), `kbd` shows a shortcut chip on the right. */
export function InspectorAction({
  children,
  onClick,
  icon,
  primary,
  danger,
  active,
  disabled,
  kbd,
  title,
  dataTest
}: {
  children: ReactNode
  onClick: () => void
  icon?: ReactNode
  primary?: boolean
  danger?: boolean
  active?: boolean
  disabled?: boolean
  kbd?: string
  title?: string
  dataTest?: string
}): ReactElement {
  return (
    <button
      type="button"
      className="ca-inspector-act"
      data-primary={primary || undefined}
      data-danger={danger || undefined}
      data-active={active || undefined}
      disabled={disabled}
      title={title}
      data-test={dataTest}
      onClick={onClick}
    >
      {icon != null && (
        <span className="ca-inspector-act-ico" aria-hidden>
          {icon}
        </span>
      )}
      <span className="ca-inspector-act-lab">{children}</span>
      {kbd != null && <span className="ca-inspector-act-kbd">{kbd}</span>}
    </button>
  )
}

/** A read-only key/value meta row (mono), e.g. the terminal's shell / command / cwd summary. */
export function InspectorMeta({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="ca-inspector-meta">
      <span className="ca-inspector-meta-lab">{label}</span>
      <span className="ca-inspector-meta-val" title={value}>
        {value}
      </span>
    </div>
  )
}
