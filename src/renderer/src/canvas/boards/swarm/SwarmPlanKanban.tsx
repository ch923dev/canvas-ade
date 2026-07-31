/**
 * Swarm plan kanban (task #12) — the plan strip's BACK FACE: the same Planning-board checklist
 * re-projected as "who is doing what" — Queue (unassigned) · one column per live worker · Done.
 *
 * 🔒 A LENS, not a second kanban. Columns are DERIVED — `done` → Done, ledger holder
 * (`planHolders`) → that worker's column, else Queue — and cards travel only when the run's
 * facts change (dispatch, completion, stall). No drag-and-drop, no column authoring. Human
 * edits are the strip's exact three (tick · rename · ＋ add, which lands in Queue), written
 * through the Planning board's own pure element helpers + one undo checkpoint per edit, so the
 * plan board stays the single source of truth here too.
 *
 * The checklist read/commit mirrors SwarmPlanStrip deliberately rather than sharing a module:
 * each face keeps its own narrow fingerprint subscription (the same "never subscribe to the
 * board object" rule — see the strip's comment) and the same literal separator bytes.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { addItem, removeItem, setItemLabel, toggleItem } from '../planning/elements'
import type { PlanningElement } from '../../../lib/boardSchema'
import type { SwarmWorkerLedgerState } from '../../../../../shared/swarmLedgerTypes'

/** Max label length accepted from the kanban — the Planning board's own cap for a checklist row. */
const MAX_LABEL = 500

/** Fingerprint separators — the strip's literal control chars (0x1E/0x1F); no label can forge. */
const ROW = ''
const UNIT = ''

interface PlanItem {
  id: string
  label: string
  done: boolean
}

/** The plan board's first checklist, or null when there is no plan (or it is not a checklist). */
function readChecklist(
  boards: ReturnType<typeof useCanvasStore.getState>['boards'],
  planBoardId: string | null
): { elementId: string; items: PlanItem[] } | null {
  if (planBoardId === null) return null
  const b = boards.find((x) => x.id === planBoardId)
  if (!b || b.type !== 'planning') return null
  const list = b.elements.find((e) => e.kind === 'checklist')
  if (!list || list.kind !== 'checklist') return null
  return {
    elementId: list.id,
    items: list.items.map((i) => ({ id: i.id, label: i.label, done: i.done }))
  }
}

/** A worker column's glance state — drives the header dot + the activity line's tone. */
function workerTone(
  w: SwarmWorkerLedgerState,
  holds: boolean
): { dot: 'working' | 'stalled' | 'idle'; line: string } {
  if (w.state === 'lost') return { dot: 'stalled', line: 'lost — no such board' }
  if (w.state === 'stalled') return { dot: 'stalled', line: w.activity ?? 'stalled' }
  if (holds) return { dot: 'working', line: w.activity ?? 'working…' }
  return { dot: 'idle', line: 'idle — awaiting dispatch' }
}

export function SwarmPlanKanban({
  planBoardId,
  workers,
  holders,
  owners,
  titleOf,
  onOpenPlan,
  onOpenWorker,
  onBack
}: {
  planBoardId: string | null
  /** The run's workers, ledger order (spawn order). */
  workers: SwarmWorkerLedgerState[]
  /** Plan-item id → holding worker's BOARD id, from MAIN's `planHolders` projection. */
  holders: Record<string, string>
  /** Plan-item id → the holding worker's state, from MAIN's `planOwners` projection. */
  owners: Record<string, 'working' | 'stalled'>
  titleOf: (boardId: string) => string
  onOpenPlan: (boardId: string) => void
  onOpenWorker: (boardId: string) => void
  onBack: () => void
}): ReactElement {
  // Narrow subscription: the same primitive fingerprint as the strip — never the board object.
  const fingerprint = useCanvasStore((s) => {
    const cl = readChecklist(s.boards, planBoardId)
    if (!cl) return ''
    const rows = cl.items.map((i) => `${i.done ? '1' : '0'}${i.id}${UNIT}${i.label}`)
    return [cl.elementId, ...rows].join(ROW)
  })
  const [elementId, ...rows] = fingerprint.split(ROW)
  const items: PlanItem[] = fingerprint
    ? rows.map((row) => {
        const sep = row.indexOf(UNIT)
        return { done: row[0] === '1', id: row.slice(1, sep), label: row.slice(sep + 1) }
      })
    : []

  /** Which card is being renamed — an item id, or `'new'` for the Queue's add affordance. */
  const [editingState, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Derived, not an effect — a vanished plan board closes any open edit (the strip's rule).
  const editing = planBoardId === null ? null : editingState
  useEffect(() => {
    if (editing !== null) inputRef.current?.focus()
  }, [editing])

  /** Write through to the Planning board — one undo checkpoint per edit (the strip's commit).
   *  Plain functions: the React Compiler memoizes these; manual useCallback here trips its
   *  preserve-manual-memoization analysis over the fingerprint-derived `elementId`. */
  const commit = (fn: (els: PlanningElement[]) => PlanningElement[]): void => {
    if (planBoardId === null) return
    const store = useCanvasStore.getState()
    const board = store.boards.find((b) => b.id === planBoardId)
    if (!board || board.type !== 'planning') return
    store.beginChange()
    store.updateBoard(planBoardId, { elements: fn(board.elements) })
  }

  const toggle = (itemId: string): void => {
    if (!elementId) return
    commit((els) => toggleItem(els, elementId, itemId))
  }

  const startEdit = (itemId: string, label: string): void => {
    setDraft(label)
    setEditing(itemId)
  }

  /** Land (or abandon) the open rename — the strip's exact semantics. */
  const settle = (cancel = false): void => {
    const id = editing
    setEditing(null)
    if (id === null || cancel || !elementId) return
    const text = draft.trim().slice(0, MAX_LABEL)
    if (id === 'new') {
      if (!text) return
      const fresh = crypto.randomUUID()
      commit((els) => setItemLabel(addItem(els, elementId, fresh), elementId, fresh, text))
      return
    }
    if (!text) {
      commit((els) => removeItem(els, elementId, id))
      return
    }
    commit((els) => setItemLabel(els, elementId, id, text))
  }

  const editor = (
    <input
      ref={inputRef}
      className="sw-kb-input"
      value={draft}
      maxLength={MAX_LABEL}
      aria-label="Plan item label"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => settle()}
      onKeyDown={(e) => {
        // Canvas hotkeys (Delete, arrows) must not fire while a card is being renamed.
        e.stopPropagation()
        if (e.key === 'Enter') settle()
        else if (e.key === 'Escape') settle(true)
      }}
      data-test="swarm-kb-edit"
    />
  )

  // ── derivation: done → Done · held → its worker's column · else Queue ──
  const done = items.filter((i) => i.done)
  const queue = items.filter((i) => !i.done && !holders[i.id])
  const itemsFor = (boardId: string): PlanItem[] =>
    items.filter((i) => !i.done && holders[i.id] === boardId)

  const card = (it: PlanItem): ReactElement => {
    const stalled = owners[it.id] === 'stalled'
    return (
      <div
        key={it.id}
        className={`sw-kb-card${it.done ? ' done' : ''}${stalled ? ' stalled' : ''}`}
        data-test="swarm-kb-card"
        data-item={it.id}
      >
        <div className="sw-kb-card-top">
          <button
            type="button"
            className="sw-kb-tick"
            role="checkbox"
            aria-checked={it.done}
            aria-label={`${it.done ? 'Untick' : 'Tick'} ${it.label}`}
            onClick={() => toggle(it.id)}
            data-test="swarm-kb-tick"
          >
            {it.done ? '✓' : ''}
          </button>
          {editing === it.id ? (
            editor
          ) : (
            <>
              <button
                type="button"
                className="sw-kb-lbl"
                onClick={() => planBoardId && onOpenPlan(planBoardId)}
                title="Open the Planning board"
              >
                {it.label}
              </button>
              <button
                type="button"
                className="sw-kb-rename"
                aria-label={`Rename ${it.label}`}
                onClick={() => startEdit(it.id, it.label)}
                data-test="swarm-kb-rename"
              >
                ⋯
              </button>
            </>
          )}
        </div>
        <div className="sw-kb-meta">
          <span className="sw-kb-num">#{items.findIndex((x) => x.id === it.id) + 1}</span>
          {stalled && <span className="sw-kb-stall-tag">stalled</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="sw-kb" data-test="swarm-plan-kanban">
      <div
        className="sw-kb-head"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button, input')) return
          e.stopPropagation()
          onBack()
        }}
      >
        <button type="button" className="sw-kb-back" onClick={onBack} data-test="swarm-kb-back">
          ⟲ strip
        </button>
        <span className="sw-kb-title">Plan · by worker</span>
        <span className="sw-kb-prog" data-test="swarm-kb-prog">
          <b>{done.length}</b>/{items.length} done
        </span>
      </div>
      {items.length === 0 && editing === null ? (
        <div className="sw-kb-void" data-test="swarm-kb-empty">
          no plan yet — the orchestrator draws one when the run starts
        </div>
      ) : (
        <div className="sw-kb-cols">
          <div className="sw-kb-col" data-test="swarm-kb-col" data-col="queue">
            <div className="sw-kb-col-h">
              <span className="sw-kb-col-name muted">Queue</span>
              <span className="sw-kb-count">{queue.length}</span>
            </div>
            <div className="sw-kb-activity">unassigned</div>
            <div className="sw-kb-cards">
              {queue.map(card)}
              {planBoardId !== null &&
                (editing === 'new' ? (
                  <div className="sw-kb-card">{editor}</div>
                ) : (
                  <button
                    type="button"
                    className="sw-kb-add"
                    aria-label="Add a plan item"
                    onClick={() => startEdit('new', '')}
                    data-test="swarm-kb-add"
                  >
                    ＋ add a plan item
                  </button>
                ))}
            </div>
          </div>
          {workers.map((w) => {
            const held = itemsFor(w.boardId)
            const tone = workerTone(w, held.length > 0)
            return (
              <div
                key={w.boardId}
                className="sw-kb-col"
                data-test="swarm-kb-col"
                data-col={w.boardId}
              >
                <div className="sw-kb-col-h">
                  <span className={`sw-kb-dot ${tone.dot}`} aria-hidden="true" />
                  <button
                    type="button"
                    className="sw-kb-col-name"
                    onClick={() => onOpenWorker(w.boardId)}
                    title="Open this worker"
                  >
                    {titleOf(w.boardId)}
                  </button>
                  {w.role && <span className="sw-kb-role">{w.role}</span>}
                </div>
                <div className={`sw-kb-activity${tone.dot === 'stalled' ? ' stalled' : ''}`}>
                  {tone.line}
                </div>
                <div className="sw-kb-cards">
                  {held.length === 0 ? (
                    <div className="sw-kb-col-empty">nothing held</div>
                  ) : (
                    held.map(card)
                  )}
                </div>
              </div>
            )
          })}
          <div className="sw-kb-col" data-test="swarm-kb-col" data-col="done">
            <div className="sw-kb-col-h">
              <span className="sw-kb-col-name muted">Done</span>
              <span className="sw-kb-count">{done.length}</span>
            </div>
            <div className="sw-kb-activity">&nbsp;</div>
            <div className="sw-kb-cards">
              {done.length === 0 ? <div className="sw-kb-col-empty">none yet</div> : done.map(card)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
