/**
 * Terminal-recap T15: the back face of a Terminal board. Reads the cached recap prose
 * (the same per-board Tier-2 markdown the DigestPanel renders) for this board and shows
 * it heading-stripped, with a ⟳ refresh that forces a re-summary. Pure presentational
 * + its own load/refresh state — the front face (the live xterm) stays mounted behind
 * the flip, so showing the recap never tears down the PTY session.
 */
import { useEffect, useState, useCallback, type ReactElement } from 'react'
import { stripHeading } from '../lib/digest'
import { IconBtn } from './BoardFrame'

export function RecapView({ boardId }: { boardId: string }): ReactElement {
  const [md, setMd] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const out = await window.api.memory.readBoards([boardId])
    setMd(out[boardId])
  }, [boardId])
  useEffect(() => {
    // `load` only setStates AFTER its await resolves — not a synchronous in-effect
    // setState — but the lint rule can't see through the async boundary (matches the
    // BoardNode.tsx fetch-on-mount precedent).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.memory.refresh(boardId)
      await load()
    } finally {
      setBusy(false)
    }
  }, [boardId, load])
  const body = md ? stripHeading(md) : ''
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        padding: 14,
        overflow: 'auto',
        background: 'var(--surface)'
      }}
      data-test="recap-view"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8
        }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
          RECAP
        </span>
        <IconBtn
          name="refresh"
          title="Refresh recap"
          active={busy}
          onClick={() => void refresh()}
        />
      </div>
      {body ? (
        <div
          style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.5, color: 'var(--text)' }}
          data-test="recap-body"
        >
          {body}
        </div>
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: 12 }} data-test="recap-empty">
          No recap yet. {busy ? 'Updating…' : 'Click ⟳, or enable Agent recaps in Settings.'}
        </div>
      )}
    </div>
  )
}
