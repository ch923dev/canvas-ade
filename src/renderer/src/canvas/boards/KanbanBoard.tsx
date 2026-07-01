/**
 * Kanban board content (v17, MCP canvas-awareness P4) — a dedicated full-board Trello-style plan
 * visualizer. Renders the persisted `columns` + flat `cards` (bound by `columnId`) as lanes of
 * cards, matching the signed-off mock (docs/research/2026-06-30-mcp-canvas-awareness/mocks/).
 *
 * P4.1 is READ-ONLY: it paints the plan from the board schema (pure — no store subscription; the
 * board object arrives reactively through BoardNode). Human interaction (drag between columns,
 * inline add/edit/delete, WIP enforcement) lands in P4.2; agent mutation (`move_card`/`add_card`)
 * lands in P3. Both write through `updateBoard` → the `columns`/`cards` PATCHABLE_KEYS.
 */
import { useMemo, type ReactElement } from 'react'
import type { KanbanBoard as KanbanBoardData, KanbanCard } from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'

/** Coarse tint for a card's status/type chip, inferred from its free-text tag (falls back to muted). */
function tagTint(tag: string): 'ok' | 'warn' | 'accent' | 'muted' {
  const t = tag.toLowerCase()
  if (t.includes('ship') || t.includes('done') || t.includes('merged')) return 'ok'
  if (t.includes('review') || t.includes('block') || t.includes('wait')) return 'warn'
  if (t.includes('feature') || t.includes('feat')) return 'accent'
  return 'muted'
}

/** One card. Passive in P4.1 — the chips are presentation only (no drag/edit handles yet). */
function Card({ card }: { card: KanbanCard }): ReactElement {
  const hasMeta = !!(card.tag || card.assignee || card.ref)
  return (
    <div className="kb-card">
      <div className="kb-card-title">{card.title}</div>
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
    </div>
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
  // Group cards by column once per board change; within-column order is array order (the schema
  // contract), so a plain per-column filter preserves it — no sort needed.
  const cardsByColumn = useMemo(() => {
    const map = new Map<string, KanbanCard[]>()
    for (const col of board.columns) map.set(col.id, [])
    for (const card of board.cards) map.get(card.columnId)?.push(card)
    return map
  }, [board.columns, board.cards])

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
        <div className="kb-cols">
          {board.columns.map((col) => {
            const cards = cardsByColumn.get(col.id) ?? []
            return (
              <div className="kb-col" key={col.id}>
                <div className="kb-col-h">
                  <span className="kb-col-title">{col.title}</span>
                  <span className="kb-col-count">{cards.length}</span>
                  {col.wip !== undefined && (
                    <span className={'kb-wip' + (cards.length >= col.wip ? ' kb-wip-full' : '')}>
                      WIP {cards.length}/{col.wip}
                    </span>
                  )}
                </div>
                <div className="kb-cards">
                  {cards.length === 0 ? (
                    <div className="kb-col-empty">No cards</div>
                  ) : (
                    cards.map((card) => <Card key={card.id} card={card} />)
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </BoardFrame>
  )
}
