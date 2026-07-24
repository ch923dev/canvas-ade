/**
 * Swarm plan strip (region 2) — a READ-ONLY projection of the run's Planning board: the first
 * checklist's items render as compact task chips (done ✓ / todo ▢), matching the signed-off S1
 * artifact. Clicking anywhere opens the full Planning board (jump). Editing / mid-run task adds
 * are S2 (the strip only ever reads the canvasStore elements the MCP tools already write).
 */
import { type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'

interface StripItem {
  label: string
  done: boolean
}

export function SwarmPlanStrip({
  planBoardId,
  onOpen
}: {
  planBoardId: string | null
  onOpen: (boardId: string) => void
}): ReactElement {
  // Subscribe narrowly: the first checklist of the plan board, as a primitive fingerprint —
  // a whole-board subscription would re-render the strip on every canvas drag frame.
  const fingerprint = useCanvasStore((s) => {
    if (planBoardId === null) return ''
    const b = s.boards.find((x) => x.id === planBoardId)
    if (!b || b.type !== 'planning') return ''
    const list = b.elements.find((e) => e.kind === 'checklist')
    if (!list || list.kind !== 'checklist') return ''
    return list.items.map((i) => `${i.done ? '1' : '0'}${i.label}`).join('\u0001')
  })
  const items: StripItem[] = fingerprint
    ? fingerprint.split('\u0001').map((row) => ({ done: row[0] === '1', label: row.slice(1) }))
    : []

  return (
    <div className="sw-plan" data-test="swarm-plan-strip">
      <span className="sw-plan-lbl">Plan</span>
      {items.length === 0 ? (
        <span className="sw-plan-empty">
          no plan yet — the orchestrator draws one when the run starts
        </span>
      ) : (
        <>
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              className={`sw-task${it.done ? ' done' : ''}`}
              onClick={() => planBoardId && onOpen(planBoardId)}
              title="Open the Planning board"
            >
              <span className="sw-task-n">{i + 1}</span> {it.label}{' '}
              <span className="sw-task-st">{it.done ? '✓' : '▢'}</span>
            </button>
          ))}
          <span className="sw-plan-ro">read-only · click opens the board · editing → S2</span>
        </>
      )}
    </div>
  )
}
