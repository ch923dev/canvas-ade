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
import { readCollapsePref, writeCollapsePref } from './collapsePrefs'

/** The shape every per-type inspector content receives. Per-type components widen this with their
 *  own handler props (supplied by the board when it portals its content into the shell slot). */
export interface InspectorContentProps {
  boardId: string
}

/** A collapsible labelled section (uppercase micro label + chevron). Open by default; a
 *  `persistKey` makes the user's toggle sticky (localStorage `ca.inspector.collapse.<key>`,
 *  app-level — see collapsePrefs.ts; P5). `aside` renders a trailing node (e.g. the Element
 *  section's selection-count chip) between the label and the chevron. */
export function InspectorSection({
  label,
  defaultOpen = true,
  persistKey,
  aside,
  children
}: {
  label: string
  defaultOpen?: boolean
  /** Stable id (e.g. `terminal.appearance`) — when set, the open/closed choice persists. */
  persistKey?: string
  aside?: ReactNode
  children: ReactNode
}): ReactElement {
  // Lazy initializer: the persisted choice wins over defaultOpen; read once per mount so
  // the e2e harness's key-removal reset takes effect on the next mount, not mid-session.
  const [open, setOpen] = useState(
    () => (persistKey ? readCollapsePref(persistKey) : null) ?? defaultOpen
  )
  const toggle = (): void => {
    // Persist OUTSIDE the setState updater (updaters must stay pure — StrictMode
    // double-invokes them; the guarded write is idempotent but shouldn't run twice).
    const next = !open
    if (persistKey) writeCollapsePref(persistKey, next)
    setOpen(next)
  }
  return (
    <section className="ca-inspector-section">
      <button
        type="button"
        className="ca-inspector-section-hd"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="ca-inspector-section-lab">{label}</span>
        {aside}
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

/** A single-select segmented control (e.g. the Browser viewport class or the network-panel dock).
 *  Options render as compact pill segments; the active one is accent-washed. `fill` stretches the
 *  segments to equal widths (used for the full-row device-class picker). Radiogroup semantics. */
export function InspectorSegmented<T extends string>({
  value,
  options,
  onChange,
  fill,
  ariaLabel
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>
  onChange: (v: T) => void
  fill?: boolean
  ariaLabel?: string
}): ReactElement {
  return (
    <div
      className="ca-inspector-seg"
      data-fill={fill || undefined}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-on={o.value === value || undefined}
          onClick={() => onChange(o.value)}
        >
          {o.icon != null && (
            <span className="ca-inspector-seg-ico" aria-hidden>
              {o.icon}
            </span>
          )}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** A binary on/off switch (e.g. mute, network inspector). The label lives in the InspectorRow; this
 *  is the switch only. Switch-role a11y with aria-checked. */
export function InspectorToggle({
  checked,
  onChange,
  ariaLabel
}: {
  checked: boolean
  onChange: (next: boolean) => void
  ariaLabel: string
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className="ca-inspector-toggle"
      data-on={checked || undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="ca-inspector-toggle-knob" aria-hidden />
    </button>
  )
}

/** A 0–1 range slider (e.g. volume). A native <input type=range> for full keyboard/a11y; styled via
 *  boardinspector.css. The value is a 0–1 fraction; the DOM range works in whole percent. */
export function InspectorSlider({
  value,
  onChange,
  ariaLabel,
  valueText
}: {
  value: number
  onChange: (v: number) => void
  ariaLabel: string
  valueText?: string
}): ReactElement {
  return (
    <input
      type="range"
      className="ca-inspector-slider"
      min={0}
      max={100}
      step={1}
      value={Math.round(value * 100)}
      aria-label={ariaLabel}
      aria-valuetext={valueText}
      onChange={(e) => onChange(Number(e.target.value) / 100)}
    />
  )
}

/** A swatch row (e.g. note tint or text colour) — the always-visible mirror of the context menu's
 *  swatchRow. Each swatch shows its `fill` (with an optional `edge` border); the `current` one gets
 *  the accent ring. `glyph` renders a mark inside a swatch that has no distinct fill (e.g. "plain").
 *  Radiogroup semantics (one current value). First landed by the Planning inspector's Element
 *  section (P4). */
export function InspectorSwatches({
  swatches,
  onPick,
  disabled,
  ariaLabel
}: {
  swatches: ReadonlyArray<{
    id: string
    fill: string
    edge?: string
    title: string
    current?: boolean
    glyph?: string
  }>
  onPick: (id: string) => void
  disabled?: boolean
  ariaLabel?: string
}): ReactElement {
  return (
    <div className="ca-inspector-swatches" role="radiogroup" aria-label={ariaLabel}>
      {swatches.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={s.current || false}
          aria-label={s.current ? `${s.title} (current)` : s.title}
          title={s.current ? `${s.title} (current)` : s.title}
          className="ca-inspector-swatch"
          data-on={s.current || undefined}
          disabled={disabled}
          style={{ background: s.fill, borderColor: s.edge }}
          onClick={() => onPick(s.id)}
        >
          {s.glyph != null && (
            <span className="ca-inspector-swatch-g" aria-hidden>
              {s.glyph}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** A compact icon-button cluster (e.g. align edges / distribute axes) — the always-visible mirror of
 *  the context menu's iconRow. Icon-agnostic: the caller supplies each button's `icon` node. The whole
 *  cluster disables as a unit (align needs ≥2 elements, distribute ≥3). First landed by the Planning
 *  inspector's Element section (P4). */
export function InspectorIconButtons({
  buttons,
  disabled,
  ariaLabel
}: {
  buttons: ReadonlyArray<{ id: string; title: string; icon: ReactNode; onSelect: () => void }>
  disabled?: boolean
  ariaLabel?: string
}): ReactElement {
  return (
    <div
      className="ca-inspector-iconbtns"
      data-disabled={disabled || undefined}
      role="group"
      aria-label={ariaLabel}
    >
      {buttons.map((b) => (
        <button
          key={b.id}
          type="button"
          title={b.title}
          aria-label={b.title}
          disabled={disabled}
          onClick={b.onSelect}
        >
          {b.icon}
        </button>
      ))}
    </div>
  )
}
