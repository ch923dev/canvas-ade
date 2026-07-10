import type { ReactElement } from 'react'
import { useAttentionStore, type AttentionKind } from '../store/attentionStore'

/**
 * On-canvas unseen-attention overlay (desktop-notifications P2, DESIGN.md Surface 1) — the
 * "which board wants me" indicator. Mounted once per BoardNode ABOVE the content/LOD layers,
 * so it reads at full detail and on the zoomed-out card alike, with zero per-type wiring:
 *  - needs-input → `--warn` ring + slow pulse + "● needs you" badge
 *  - error       → `--err` ring (steady) + "! error" badge
 *  - done        → `--ok` ring (steady) + "✓ done" badge (user 2026-07-07: ring on done too)
 * All colour/pulse styling lives in styles/canvas/board-attention.css keyed on `data-kind`;
 * the pulse is reduced-motion gated in base.css (ring + badge persist). Clears when the user
 * selects/focuses the board (useNotifications owns that), so it never needs pointer events.
 */
const BADGE_TEXT: Record<AttentionKind, string> = {
  'needs-input': '● needs you',
  error: '! error',
  done: '✓ done'
}

export function BoardAttention({ boardId }: { boardId: string }): ReactElement | null {
  const kind = useAttentionStore((s) => s.byId[boardId])
  if (!kind) return null
  return (
    <div className="ca-attn" data-kind={kind}>
      <div className="ca-attn-ring" />
      <span className="ca-attn-badge">{BADGE_TEXT[kind]}</span>
    </div>
  )
}
