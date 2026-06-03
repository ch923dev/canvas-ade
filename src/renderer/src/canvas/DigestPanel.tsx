/**
 * Tier-1 reopen digest panel (presentational). Renders the CanvasDigest from
 * `buildDigest` (T-D1) as an auto slide-in side panel of per-board cards. Pure: all
 * state (open/closed) is owned by the container in Canvas.tsx. No LLM / no key — this
 * is the no-cost reopen context. The T-M4 milestone later swaps in cached Tier-2 prose.
 */
import type { ReactElement } from 'react'
import type { CanvasDigest } from '../lib/digest'

const TYPE_TAG: Record<string, string> = {
  terminal: 'TERM',
  browser: 'WEB',
  planning: 'PLAN'
}

export interface DigestPanelProps {
  digest: CanvasDigest
  open: boolean
  onOpen: () => void
  onClose: () => void
}

export function DigestPanel({ digest, open, onOpen, onClose }: DigestPanelProps): ReactElement {
  return (
    <>
      {!open && (
        <button
          type="button"
          className="digest-reopen"
          data-test="digest-reopen"
          onClick={onOpen}
          title="Show project context"
        >
          Context
        </button>
      )}
      <aside className="digest-panel" data-test="digest-panel" data-open={open} aria-hidden={!open}>
        <header className="digest-head">
          <span className="digest-head-title">Project context</span>
          <button
            type="button"
            className="digest-close"
            data-test="digest-close"
            onClick={onClose}
            aria-label="Dismiss context panel"
          >
            ✕
          </button>
        </header>
        <p className="digest-sub">{digest.header}</p>
        <div className="digest-list">
          {digest.boards.map((b) => (
            <article key={b.boardId} className="digest-card" data-test="digest-card">
              <div className="digest-card-top">
                <span className="digest-tag">{TYPE_TAG[b.type] ?? b.type.toUpperCase()}</span>
                <span className="digest-card-title">{b.title}</span>
                <span className="digest-status" data-status={b.status}>
                  {b.status}
                </span>
              </div>
              <ul className="digest-lines">
                {b.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </aside>
    </>
  )
}
