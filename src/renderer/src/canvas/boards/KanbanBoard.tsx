/**
 * Kanban board content (v17, MCP canvas-awareness P4) — a dedicated full-board Trello-style plan
 * visualizer. Renders the persisted `columns` + flat `cards` (bound by `columnId`) as lanes of
 * cards, matching the signed-off mock (docs/research/2026-06-30-mcp-canvas-awareness/mocks/).
 *
 * P4.2 makes it interactive: drag a card between columns (HTML5-native — no camera inverse-scale
 * math, free DOM drop-zones), inline add/rename/delete a card, and author columns (add/rename/delete
 * + set a soft WIP limit). Every edit commits through `updateBoard` → the `columns`/`cards`
 * PATCHABLE_KEYS as ONE undoable, autosaved step, and the pure transforms live in `kanbanEdit.ts`
 * (unit-tested) so this file stays presentational. Agent mutation (`add_card`/`move_card`) shares the
 * same store keys via the P3 gate. WIP is SOFT: a full column paints its badge warn but never blocks.
 */
import { useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react'
import type {
  KanbanBoard as KanbanBoardData,
  KanbanCard,
  KanbanColumn
} from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import {
  addCard,
  addColumn,
  moveCard,
  removeCard,
  removeColumn,
  renameCard,
  renameColumn,
  setColumnWip
} from './kanbanEdit'

/** Coarse tint for a card's status/type chip, inferred from its free-text tag (falls back to muted). */
function tagTint(tag: string): 'ok' | 'warn' | 'accent' | 'muted' {
  const t = tag.toLowerCase()
  if (t.includes('ship') || t.includes('done') || t.includes('merged')) return 'ok'
  if (t.includes('review') || t.includes('block') || t.includes('wait')) return 'warn'
  if (t.includes('feature') || t.includes('feat')) return 'accent'
  return 'muted'
}

/**
 * A tiny controlled inline editor reused for every Kanban text edit (card title, add-card, column
 * rename, add-column) and the WIP number. Commits on Enter/blur, cancels on Escape; `nodrag nopan`
 * keep the keys/drag off the React Flow canvas. Auto-focuses + selects on mount; a `done` latch stops
 * the blur that our own Enter/Escape triggers from committing twice.
 */
function InlineInput({
  initial,
  placeholder,
  ariaLabel,
  testid,
  numeric,
  onCommit,
  onCancel
}: {
  initial: string
  placeholder?: string
  ariaLabel: string
  testid?: string
  numeric?: boolean
  onCommit: (value: string) => void
  onCancel: () => void
}): ReactElement {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(value)
    else onCancel()
  }
  return (
    <input
      className={'kb-edit nodrag nopan' + (numeric ? ' kb-edit-num' : '')}
      aria-label={ariaLabel}
      data-testid={testid}
      value={value}
      placeholder={placeholder}
      inputMode={numeric ? 'numeric' : undefined}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}

export function KanbanBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onRemoveFromAllGroups,
  onStartConnect
}: BoardViewProps<KanbanBoardData>): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  // Which element is mid-edit (null = none). Ephemeral session state — NEVER serialized.
  const [editCard, setEditCard] = useState<string | null>(null)
  const [addIn, setAddIn] = useState<string | null>(null) // column showing its add-card input
  const [editCol, setEditCol] = useState<string | null>(null)
  const [wipCol, setWipCol] = useState<string | null>(null)
  const [addingCol, setAddingCol] = useState(false)
  const [dragCard, setDragCard] = useState<string | null>(null) // card being dragged (opacity cue)
  const [dragOver, setDragOver] = useState<string | null>(null) // column under the drag (drop cue)

  // Group cards by column once per board change; within-column order is array order (the schema
  // contract), so a plain per-column filter preserves it — no sort needed.
  const cardsByColumn = useMemo(() => {
    const map = new Map<string, KanbanCard[]>()
    for (const col of board.columns) map.set(col.id, [])
    for (const card of board.cards) map.get(card.columnId)?.push(card)
    return map
  }, [board.columns, board.cards])

  // Commit helpers — `beginChange()` FIRST arms the lazy checkpoint (mirroring every user-gesture
  // call site + the MCP handlers), so a real edit records exactly ONE undo step. Each transform
  // returns the SAME array ref on a no-op, so applyBoardPatch skips it and the checkpoint is left
  // unconsumed (no phantom undo step on an empty/blank/unchanged commit — beginChange dedups it).
  const patchCards = (cards: KanbanCard[]): void => {
    beginChange()
    updateBoard(board.id, { cards })
  }
  const patchCols = (columns: KanbanColumn[]): void => {
    beginChange()
    updateBoard(board.id, { columns })
  }

  const commitAddCard = (colId: string, title: string): void => {
    patchCards(addCard(board, colId, title))
    setAddIn(null)
  }
  const commitRenameCard = (id: string, title: string): void => {
    patchCards(renameCard(board, id, title))
    setEditCard(null)
  }
  const commitAddCol = (title: string): void => {
    patchCols(addColumn(board, title))
    setAddingCol(false)
  }
  const commitRenameCol = (id: string, title: string): void => {
    patchCols(renameColumn(board, id, title))
    setEditCol(null)
  }
  const commitWip = (id: string, raw: string): void => {
    const t = raw.trim()
    patchCols(setColumnWip(board, id, t === '' ? undefined : Number(t)))
    setWipCol(null)
  }
  const doRemoveCol = (id: string): void => {
    const next = removeColumn(board, id)
    if (!next) return
    beginChange()
    updateBoard(board.id, next)
  }

  // ── HTML5 drag: card → column. The dragged id rides in dataTransfer (source of truth on drop);
  //    `dragCard` drives only the visual cues. A foreign card (another board's) never sets THIS
  //    board's `dragCard`, so onDragOver won't preventDefault → the browser refuses the cross-board
  //    drop (out of scope) cleanly. moveCard also no-ops an unknown id as a second guard.
  const onCardDragStart =
    (id: string) =>
    (e: DragEvent): void => {
      e.dataTransfer.setData('text/plain', id)
      e.dataTransfer.effectAllowed = 'move'
      setDragCard(id)
    }
  const clearDrag = (): void => {
    setDragCard(null)
    setDragOver(null)
  }
  const onColDragOver =
    (colId: string) =>
    (e: DragEvent): void => {
      if (!dragCard) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dragOver !== colId) setDragOver(colId)
    }
  const onColDrop =
    (colId: string) =>
    (e: DragEvent): void => {
      e.preventDefault()
      const id = e.dataTransfer.getData('text/plain') || dragCard
      clearDrag()
      if (id) patchCards(moveCard(board, id, colId))
    }

  const renderCard = (card: KanbanCard): ReactElement => {
    const editing = editCard === card.id
    const hasMeta = !editing && !!(card.tag || card.assignee || card.ref)
    return (
      <div
        className={'kb-card nodrag nopan' + (dragCard === card.id ? ' kb-dragging' : '')}
        key={card.id}
        data-testid="kb-card"
        draggable={!editing}
        onDragStart={onCardDragStart(card.id)}
        onDragEnd={clearDrag}
      >
        {editing ? (
          <InlineInput
            initial={card.title}
            ariaLabel="Card title"
            testid="kb-card-edit"
            onCommit={(v) => commitRenameCard(card.id, v)}
            onCancel={() => setEditCard(null)}
          />
        ) : (
          <div
            className="kb-card-title"
            title="Double-click to edit"
            onDoubleClick={() => setEditCard(card.id)}
          >
            {card.title}
          </div>
        )}
        {hasMeta && (
          <div className="kb-card-meta">
            {card.tag && <span className={`kb-tag kb-tag-${tagTint(card.tag)}`}>{card.tag}</span>}
            {card.assignee && (
              <span className="kb-assignee">
                <i className="kb-dot" />
                {card.assignee}
              </span>
            )}
            {card.ref && <span className="kb-ref">{card.ref}</span>}
          </div>
        )}
        {!editing && (
          <button
            className="kb-card-del nodrag nopan"
            aria-label="Delete card"
            data-testid="kb-card-del"
            title="Delete card"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => patchCards(removeCard(board, card.id))}
          >
            ×
          </button>
        )}
      </div>
    )
  }

  return (
    <BoardFrame
      type={board.type}
      boardId={board.id}
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      onFull={onFull}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
      onAddToGroup={onAddToGroup}
      onRemoveFromGroup={onRemoveFromGroup}
      onRemoveFromAllGroups={onRemoveFromAllGroups}
      onStartConnect={onStartConnect}
    >
      <div className="kb-root">
        <div className="kb-cols nowheel">
          {board.columns.map((col) => {
            const cards = cardsByColumn.get(col.id) ?? []
            const atLimit = col.wip !== undefined && cards.length >= col.wip
            return (
              <div
                className={'kb-col' + (dragOver === col.id ? ' kb-dragover' : '')}
                key={col.id}
                onDragOver={onColDragOver(col.id)}
                onDrop={onColDrop(col.id)}
              >
                <div className="kb-col-h">
                  {editCol === col.id ? (
                    <InlineInput
                      initial={col.title}
                      ariaLabel="Column title"
                      testid="kb-col-edit"
                      onCommit={(v) => commitRenameCol(col.id, v)}
                      onCancel={() => setEditCol(null)}
                    />
                  ) : (
                    <span
                      className="kb-col-title"
                      title="Double-click to rename"
                      onDoubleClick={() => setEditCol(col.id)}
                    >
                      {col.title}
                    </span>
                  )}
                  <span className="kb-col-count">{cards.length}</span>
                  {wipCol === col.id ? (
                    <InlineInput
                      initial={col.wip !== undefined ? String(col.wip) : ''}
                      ariaLabel="WIP limit"
                      testid="kb-wip-edit"
                      placeholder="WIP"
                      numeric
                      onCommit={(v) => commitWip(col.id, v)}
                      onCancel={() => setWipCol(null)}
                    />
                  ) : col.wip !== undefined ? (
                    <span
                      className={'kb-wip' + (atLimit ? ' kb-wip-full' : '')}
                      title="Double-click to edit WIP limit"
                      onDoubleClick={() => setWipCol(col.id)}
                    >
                      WIP {cards.length}/{col.wip}
                    </span>
                  ) : (
                    <button
                      className="kb-wip-add nodrag nopan"
                      aria-label="Set WIP limit"
                      title="Set WIP limit"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setWipCol(col.id)}
                    >
                      WIP
                    </button>
                  )}
                  {board.columns.length > 1 && (
                    <button
                      className="kb-col-del nodrag nopan"
                      aria-label={`Delete column ${col.title}`}
                      title="Delete column"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => doRemoveCol(col.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="kb-cards nowheel">
                  {cards.length === 0 && addIn !== col.id ? (
                    <div className="kb-col-empty">No cards</div>
                  ) : (
                    cards.map((card) => renderCard(card))
                  )}
                  {addIn === col.id ? (
                    <InlineInput
                      initial=""
                      ariaLabel={`New card in ${col.title}`}
                      testid="kb-add-card-input"
                      placeholder="Card title…"
                      onCommit={(v) => commitAddCard(col.id, v)}
                      onCancel={() => setAddIn(null)}
                    />
                  ) : (
                    <button
                      className="kb-add nodrag nopan"
                      aria-label={`Add card to ${col.title}`}
                      data-testid="kb-add-card"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setAddIn(col.id)}
                    >
                      + Add card
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {addingCol ? (
            <div className="kb-col kb-col-new">
              <InlineInput
                initial=""
                ariaLabel="New column title"
                testid="kb-add-col-input"
                placeholder="Column title…"
                onCommit={commitAddCol}
                onCancel={() => setAddingCol(false)}
              />
            </div>
          ) : (
            <button
              className="kb-addcol nodrag nopan"
              aria-label="Add column"
              data-testid="kb-add-col"
              title="Add column"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setAddingCol(true)}
            >
              +
            </button>
          )}
        </div>
      </div>
    </BoardFrame>
  )
}
