/**
 * The persistent update badge — a small status dot shown whenever an update is waiting, on the
 * Settings gear, the About tile, and the account pill. Reads the shared updateStore, so all three
 * anchors light up together and clear together. Color carries the tier (accent = pending,
 * warn = required, ok = downloaded). The `ring` (a 2px border in the anchor's background) punches
 * the dot cleanly off a busy anchor; pass `style` to position it (absolute corner on a button,
 * inline after a label). Decorative — the actionable copy lives in Settings ▸ About.
 */
import { type CSSProperties, type ReactElement } from 'react'
import { useUpdateStore, selectUpdateBadge } from '../store/updateStore'

const COLOR: Record<'accent' | 'warn' | 'ok', string> = {
  accent: 'var(--accent)',
  warn: 'var(--warn)',
  ok: 'var(--ok)'
}

export function UpdateBadgeDot({
  ring = 'var(--surface-raised)',
  size = 8,
  style
}: {
  ring?: string
  size?: number
  style?: CSSProperties
}): ReactElement | null {
  const color = useUpdateStore(selectUpdateBadge)
  if (!color) return null
  return (
    <span
      aria-hidden
      data-test="update-badge"
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: COLOR[color],
        border: `2px solid ${ring}`,
        boxSizing: 'content-box',
        pointerEvents: 'none',
        ...style
      }}
    />
  )
}
