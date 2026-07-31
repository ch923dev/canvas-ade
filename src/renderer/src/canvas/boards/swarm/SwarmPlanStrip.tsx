/**
 * Swarm plan strip (region 2) — the run's Planning-board checklist as compact task chips, and
 * since S2 an EDITABLE one (design §3, decision D2: always-live, no edit mode).
 *
 * The chip is split into spatially distinct hit targets rather than gaining a mode:
 *   [✓] checkbox → toggles `done`, writing through immediately
 *   label        → jumps to the Planning board (S1 behaviour, unchanged)
 *   ● owner dot  → a live worker holds this item (blue working · amber stalled), from the ledger
 *   ⋯ handle     → hover/focus-only; renames in place. ⌫ on an emptied rename removes the item.
 * plus a trailing `＋` chip that opens an empty rename at the end of the strip.
 *
 * 🔒 THE PLAN BOARD REMAINS THE SOURCE OF TRUTH. Labels and `done` are read from the live canvas
 * and every edit is written back through the Planning board's own pure element helpers + the
 * canvasStore undo checkpoint — so a mis-tick is one ⌘Z away and the strip never becomes a second
 * copy of the plan. The ledger supplies ONLY ownership (which worker holds which item).
 *
 * 🔒 Human edits are DIRECT, orchestrator edits stay confirmed (design D6). A confirm modal for
 * "did you mean to tick that box?" is the approval-flooding anti-pattern (07 §4.7): it trains the
 * click-through reflex that buries the decisions that actually matter. This is the human's own
 * board and their own plan; the agent-originated path is unchanged from every other MCP write.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'
import { addItem, removeItem, setItemLabel, toggleItem } from '../planning/elements'
import type { PlanningElement } from '../../../lib/boardSchema'

/** Max label length accepted from the strip — the Planning board's own cap for a checklist row. */
const MAX_LABEL = 500

/** Fingerprint separators. Control characters, so no label can forge a row or field boundary. */
const ROW = ''
const UNIT = ''

interface StripItem {
  id: string
  label: string
  done: boolean
}

/** The plan board's first checklist, or null when there is no plan (or it is not a checklist). */
function readChecklist(
  boards: ReturnType<typeof useCanvasStore.getState>['boards'],
  planBoardId: string | null
): { elementId: string; items: StripItem[] } | null {
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

export function SwarmPlanStrip({
  planBoardId,
  owners,
  onOpen,
  onFlip
}: {
  planBoardId: string | null
  /** Plan-item id → the holding worker's state, from MAIN's ledger projection. */
  owners: Record<string, 'working' | 'stalled'>
  onOpen: (boardId: string) => void
  /** Flip the strip to its kanban back-face (task #12). Absent ⇒ no flip affordance renders. */
  onFlip?: () => void
}): ReactElement {
  // Subscribe narrowly: a primitive FINGERPRINT of the first checklist (its element id + one
  // encoded row per item), never the board. A whole-board subscription would re-render the strip
  // on every canvas drag frame, and a fresh array out of the selector would trip
  // useSyncExternalStore's cached-snapshot check (the EMPTY_RUN lesson in swarmStore).
  const fingerprint = useCanvasStore((s) => {
    const cl = readChecklist(s.boards, planBoardId)
    if (!cl) return ''
    const rows = cl.items.map((i) => `${i.done ? '1' : '0'}${i.id}${UNIT}${i.label}`)
    return [cl.elementId, ...rows].join(ROW)
  })
  const [elementId, ...rows] = fingerprint.split(ROW)
  const items: StripItem[] = fingerprint
    ? rows.map((row) => {
        const sep = row.indexOf(UNIT)
        return { done: row[0] === '1', id: row.slice(1, sep), label: row.slice(sep + 1) }
      })
    : []

  /** Which item is being renamed — an item id, or `'new'` for the trailing add chip. */
  const [editingState, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // DERIVED, not an effect: a plan board that vanishes (deleted, or the project switched) closes
  // any open edit, because there is nowhere left for it to land. Resetting it from an effect
  // would be a synchronous setState inside render's commit — a cascading-render smell.
  const editing = planBoardId === null ? null : editingState
  useEffect(() => {
    if (editing !== null) inputRef.current?.focus()
  }, [editing])

  /**
   * Write through to the Planning board. `beginChange()` arms ONE undo checkpoint per edit, so
   * every strip edit is exactly as undoable as the same edit made on the board itself.
   */
  const commit = useCallback(
    (fn: (els: PlanningElement[]) => PlanningElement[]): void => {
      if (planBoardId === null) return
      const store = useCanvasStore.getState()
      const board = store.boards.find((b) => b.id === planBoardId)
      if (!board || board.type !== 'planning') return
      store.beginChange()
      store.updateBoard(planBoardId, { elements: fn(board.elements) })
    },
    [planBoardId]
  )

  const toggle = useCallback(
    (itemId: string): void => {
      if (!elementId) return
      commit((els) => toggleItem(els, elementId, itemId))
    },
    [commit, elementId]
  )

  const startEdit = (itemId: string, label: string): void => {
    setDraft(label)
    setEditing(itemId)
  }

  /**
   * Land (or abandon) the open rename. An emptied EXISTING label removes the item — the design's
   * ⌫ affordance — while an empty NEW chip simply closes, because adding a blank row to the plan
   * of record is never what the human meant.
   */
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
      className="sw-task-input"
      value={draft}
      maxLength={MAX_LABEL}
      aria-label="Plan item label"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => settle()}
      onKeyDown={(e) => {
        // The canvas owns single-key hotkeys (Delete, Backspace, arrows) — none of them may fire
        // while a plan item is being renamed.
        e.stopPropagation()
        if (e.key === 'Enter') settle()
        else if (e.key === 'Escape') settle(true)
      }}
      data-test="swarm-plan-edit"
    />
  )

  return (
    <div
      className="sw-plan"
      data-test="swarm-plan-strip"
      // Task #12: double-click on the strip SURFACE flips to the kanban face — never on a
      // control (chips/inputs act on click), and never board-wide (chat/composer/dock live there).
      onDoubleClick={(e) => {
        if (!onFlip) return
        if ((e.target as HTMLElement).closest('button, input')) return
        e.stopPropagation() // stop RF's node-double-click focus from also firing
        onFlip()
      }}
    >
      <span className="sw-plan-lbl">Plan</span>
      {items.length === 0 && editing === null ? (
        <span className="sw-plan-empty">
          no plan yet — the orchestrator draws one when the run starts
        </span>
      ) : (
        <>
          {items.map((it, i) => (
            <span
              key={it.id}
              className={`sw-task${it.done ? ' done' : ''}${editing === it.id ? ' editing' : ''}`}
              data-test="swarm-plan-chip"
            >
              <button
                type="button"
                className="sw-task-box"
                role="checkbox"
                aria-checked={it.done}
                aria-label={`${it.done ? 'Untick' : 'Tick'} ${it.label}`}
                onClick={() => toggle(it.id)}
                data-test="swarm-plan-tick"
              >
                {it.done ? '✓' : ''}
              </button>
              <span className="sw-task-n">{i + 1}</span>
              {editing === it.id ? (
                editor
              ) : (
                <>
                  <button
                    type="button"
                    className="sw-task-lbl"
                    onClick={() => planBoardId && onOpen(planBoardId)}
                    title="Open the Planning board"
                  >
                    {it.label}
                  </button>
                  {owners[it.id] && (
                    <span
                      className={`sw-task-own ${owners[it.id]}`}
                      title={
                        owners[it.id] === 'stalled'
                          ? 'a worker holds this item, and has stalled'
                          : 'a worker is working this item'
                      }
                    />
                  )}
                  <button
                    type="button"
                    className="sw-task-edit"
                    aria-label={`Rename ${it.label}`}
                    onClick={() => startEdit(it.id, it.label)}
                    data-test="swarm-plan-rename"
                  >
                    ⋯
                  </button>
                </>
              )}
            </span>
          ))}
          {planBoardId !== null &&
            (editing === 'new' ? (
              <span className="sw-task editing">{editor}</span>
            ) : (
              <button
                type="button"
                className="sw-task sw-task-add"
                aria-label="Add a plan item"
                onClick={() => startEdit('new', '')}
                data-test="swarm-plan-add"
              >
                ＋
              </button>
            ))}
        </>
      )}
      {onFlip && (
        <button
          type="button"
          className="sw-plan-flip"
          aria-label="View the plan as a kanban"
          title="Flip the plan to a kanban (or double-click the strip)"
          onClick={onFlip}
          data-test="swarm-plan-flip"
        >
          ⊞ kanban
        </button>
      )}
    </div>
  )
}
