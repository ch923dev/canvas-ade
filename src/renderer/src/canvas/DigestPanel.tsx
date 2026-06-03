/**
 * Tier-1 reopen digest panel (presentational). Renders the CanvasDigest from
 * `buildDigest` (T-D1) as an auto slide-in side panel of per-board cards. Pure: all
 * state (open/closed) is owned by the container in Canvas.tsx. No LLM / no key — this
 * is the no-cost reopen context. T-M4: renders cached Tier-2 prose (the `prose` prop,
 * heading-stripped) when present, else the Tier-1 lines.
 */
import type { ReactElement } from 'react'
import type { CanvasDigest } from '../lib/digest'
import { stripHeading } from '../lib/digest'

const TYPE_TAG: Record<string, string> = {
  terminal: 'TERM',
  browser: 'WEB',
  planning: 'PLAN'
}

export interface DigestPanelProps {
  digest: CanvasDigest
  /** T-M4: cached Tier-2 prose by board id (raw board-<id>.md). Absent → Tier-1 lines. */
  prose?: Record<string, string>
  open: boolean
  onOpen: () => void
  onClose: () => void
}

export function DigestPanel({
  digest,
  prose,
  open,
  onOpen,
  onClose
}: DigestPanelProps): ReactElement {
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
              {(() => {
                const raw = prose?.[b.boardId]
                const body = raw ? stripHeading(raw) : ''
                return body ? (
                  <p className="digest-prose" data-test="digest-prose">
                    {body}
                  </p>
                ) : (
                  <ul className="digest-lines">
                    {b.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                )
              })()}
            </article>
          ))}
        </div>
      </aside>
    </>
  )
}
