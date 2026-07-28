/**
 * “Publish findings →” — the HUMAN trigger for P4's end-of-run durable batch.
 *
 * Sits at the foot of the recap face, which is the end-of-run surface: you flip to the recap to read
 * what the run concluded, and this is where you keep it. Picks a destination kanban board, then asks
 * MAIN to compose + confirm + write in ONE step.
 *
 * 🔒 It sends a BOARD ID AND NOTHING ELSE. Card content is derived MAIN-side from the `write_result`
 * data it already holds, so the renderer cannot author a finding — the same rule the agent-facing
 * `publish_findings` tool obeys, enforced in the same place.
 *
 * 🔒 It is not a write in itself. MAIN answers with ONE `confirmBatch` modal listing every finding
 * as its own vetoable row; nothing lands until that is answered, and the outcome string it returns
 * (published · declined · merged · capped) is surfaced verbatim rather than reduced to a checkmark.
 */
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { useCommandStore } from '../../../store/commandStore'

export function PublishFindingsBar(): ReactElement | null {
  // 🔒 Subscribe to a PRIMITIVE fingerprint, then derive the list from a getState() read keyed by
  // it (the GROUP-07 pattern CommandBoard's `poolKey` already uses). Selecting
  // `boards.filter().map()` directly returns a FRESH ARRAY on every store notification, which
  // zustand's Object.is equality reads as "changed" every time — an unbounded render loop that
  // crashed this whole board with React #185. The fingerprint changes only when a kanban board is
  // added, removed, or retitled, so a board DRAG no longer re-renders this bar at all.
  const kanbanKey = useCanvasStore((s) =>
    s.boards
      .filter((b) => b.type === 'kanban')
      .map((b) => `${b.id}:${b.title}`)
      .join('|')
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps -- kanbanKey IS the cache key for this read
  const kanbans = useMemo(
    () =>
      useCanvasStore
        .getState()
        .boards.filter((b) => b.type === 'kanban')
        .map((b) => ({ id: b.id, title: b.title })),
    [kanbanKey]
  )
  // Only offer this once some worker has actually reported — an empty run has nothing to publish,
  // and an always-on button that always answers "nothing to publish" trains people to ignore it.
  const hasResults = useCommandStore((s) =>
    s.tasks.some((t) => t.result !== undefined || t.status === 'done' || t.status === 'failed')
  )
  const [target, setTarget] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)

  if (!hasResults) return null

  const chosen = kanbans.some((k) => k.id === target) ? target : (kanbans[0]?.id ?? '')

  const run = async (): Promise<void> => {
    const api = window.api?.orchestration?.publishFindings
    if (!api || !chosen || busy) return
    setBusy(true)
    setOutcome(null)
    try {
      const r = await api(chosen)
      // The summary carries the disclosure (what merged, who reported nothing, what the cap
      // dropped). Shown verbatim — a reason that is not in the surface does not exist.
      setOutcome(r.summary)
    } catch {
      setOutcome('publish failed — MAIN did not answer')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={barStyle}>
      <div style={rowStyle}>
        <span style={lblStyle}>Findings</span>
        {kanbans.length === 0 ? (
          // Absence, stated. Without this the foot would simply be empty and the feature would look
          // like it does not exist rather than like it is missing a destination.
          <span style={noteStyle}>
            no kanban board on this canvas — add one to publish findings
          </span>
        ) : (
          <>
            <select
              className="nodrag"
              style={selStyle}
              value={chosen}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Destination kanban board"
            >
              {kanbans.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.title}
                </option>
              ))}
            </select>
            <button
              className="nodrag"
              style={btnStyle}
              disabled={busy}
              onClick={() => void run()}
              title="Compose every worker's findings into one confirmed batch of cards"
            >
              {busy ? 'awaiting your confirmation…' : 'Publish findings →'}
            </button>
          </>
        )}
      </div>
      {outcome && <div style={outStyle}>{outcome}</div>}
    </div>
  )
}

const barStyle: CSSProperties = {
  flex: 'none',
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: 8,
  marginTop: 2,
  display: 'flex',
  flexDirection: 'column',
  gap: 6
}
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const lblStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 'var(--fs-micro)',
  fontWeight: 'var(--fw-micro)' as unknown as number,
  letterSpacing: 'var(--tr-micro)',
  textTransform: 'uppercase',
  color: 'var(--text-3)'
}
const noteStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  color: 'var(--text-faint)'
}
const selStyle: CSSProperties = {
  height: 21,
  maxWidth: 200,
  background: 'var(--inset)',
  color: 'var(--text-2)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  fontFamily: 'var(--ui)',
  fontSize: 11,
  padding: '0 4px'
}
const btnStyle: CSSProperties = {
  height: 21,
  padding: '0 9px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid rgba(79,140,255,.4)',
  background: 'var(--accent-wash)',
  color: 'var(--accent-hover)',
  fontFamily: 'var(--ui)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer'
}
const outStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9.5,
  lineHeight: 1.5,
  color: 'var(--text-3)',
  overflowWrap: 'anywhere'
}
