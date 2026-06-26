/**
 * Phase 1 accounts: the signed-in identity glyph — a small circle with the email's initial.
 * Shared by the chrome account pill (AppChrome) and the Settings → Account row so both read the
 * same. Free = a neutral `--border-strong` ring; Pro = a 1px `--accent` ring (the only visual
 * difference, per DESIGN.md — functional, no decoration).
 */
import type { CSSProperties, ReactElement } from 'react'
import type { Plan } from '../store/accountStore'

/** First letter of the email, uppercased; '?' if we somehow have no email yet. */
function initial(email?: string): string {
  const c = email?.trim()?.[0]
  return c ? c.toUpperCase() : '?'
}

export function AccountAvatar({
  email,
  plan,
  size = 24
}: {
  email?: string
  plan?: Plan
  size?: number
}): ReactElement {
  const pro = plan === 'pro'
  const style: CSSProperties = {
    width: size,
    height: size,
    flex: 'none',
    borderRadius: 999,
    display: 'grid',
    placeItems: 'center',
    background: pro ? 'var(--accent-wash)' : 'var(--surface-overlay)',
    border: `1px solid ${pro ? 'var(--accent)' : 'var(--border-strong)'}`,
    color: pro ? 'var(--accent)' : 'var(--text-2)',
    fontFamily: 'var(--ui)',
    fontSize: Math.round(size * 0.46),
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none'
  }
  return (
    <span style={style} aria-hidden="true">
      {initial(email)}
    </span>
  )
}
