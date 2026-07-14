/**
 * Kanban card-detail modal (v19, card-detail epic) — the "open a card to see everything" surface the
 * flat card face deliberately withholds (Linear rule: no description prose on the face). Jira-style two
 * columns: the CONTENT pane (title + description) on the left, a METADATA sidebar (status, tags,
 * assignee, reference, file+line refs) on the right. Built on the shared `Modal` primitive, so the
 * scrim / focus-trap / Esc / focus-restore all come for free (canvas/Modal.tsx).
 *
 * Every edit commits through the SAME `beginChange()` + `updateBoard({ cards })` path the board face
 * uses, via the pure `kanbanEdit` ops — so a modal edit is ONE undoable, autosaved step and a no-op
 * (unchanged value → op returns the same array ref) records nothing. Text fields commit on blur/Enter;
 * chips + file refs commit on each add/remove (and on blur for inline ref edits). The live card is read
 * from `board.cards` each render, so an external change (undo, an agent's MCP write) reflects live.
 */
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { KanbanBoard, KanbanCard, KanbanFileRef } from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { Modal } from '../Modal'
import {
  effectiveTags,
  moveCard,
  removeCard,
  renameCard,
  setCardAssignee,
  setCardDescription,
  setCardFileRefs,
  setCardRef,
  setCardTags,
  tagTint
} from './kanbanEdit'

/** Enter commits a single-line field by blurring it (the blur handler does the actual commit). */
function enterBlurs(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.currentTarget.blur()
  }
}

export function KanbanCardModal({
  board,
  cardId,
  onClose
}: {
  board: KanbanBoard
  cardId: string
  onClose: () => void
}): ReactElement | null {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const openFileRef = useCanvasStore((s) => s.openFileRef)

  // The live card (re-read each render so undo / an MCP write reflect immediately). Null ⇒ deleted out
  // from under the modal; all hooks below still run (seeded from the optional card), then we bail.
  const card: KanbanCard | null = board.cards.find((c) => c.id === cardId) ?? null

  const titleRef = useRef<HTMLInputElement>(null)

  // Single-value fields buffer locally and commit on blur (so a keystroke isn't a store write / undo
  // step). Seeded once per mount from the card; the parent keys this modal by `cardId`, so switching
  // to another card REMOUNTS with fresh state rather than needing a prop→state sync effect. The `refs`
  // list buffers inline path/line edits and commits on add/remove + field blur.
  const [title, setTitle] = useState(card?.title ?? '')
  const [description, setDescription] = useState(card?.description ?? '')
  const [assignee, setAssignee] = useState(card?.assignee ?? '')
  const [ref, setRef] = useState(card?.ref ?? '')
  const [tagDraft, setTagDraft] = useState('')
  const [refs, setRefs] = useState<KanbanFileRef[]>(card?.fileRefs ?? [])

  if (!card) return null

  const commit = (cards: KanbanCard[]): void => {
    beginChange()
    updateBoard(board.id, { cards })
  }

  const tags = effectiveTags(card)
  const columnTitle = board.columns.find((c) => c.id === card.columnId)?.title ?? card.columnId
  // v19 column axis: the sidebar column-picker label reflects what the columns MEAN — a workflow
  // "Status" (flow) vs the board's category name (e.g. "Phase"). Absent axis ⇒ flow ⇒ "Status".
  const axisLabel =
    board.axisLabel?.trim() || (board.columnAxis === 'category' ? 'Category' : 'Status')

  const addTag = (): void => {
    const v = tagDraft.trim()
    if (!v) return
    commit(setCardTags(board, cardId, [...tags, v]))
    setTagDraft('')
  }
  const removeTag = (t: string): void =>
    commit(
      setCardTags(
        board,
        cardId,
        tags.filter((x) => x !== t)
      )
    )

  const commitRefs = (next: KanbanFileRef[]): void => commit(setCardFileRefs(board, cardId, next))
  const updateRef = (i: number, patch: Partial<KanbanFileRef>): void =>
    setRefs(refs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const parseLine = (raw: string): number | undefined => {
    const t = raw.trim()
    return t ? Number(t) : undefined
  }
  const removeRef = (i: number): void => {
    const next = refs.filter((_, j) => j !== i)
    setRefs(next)
    commitRefs(next)
  }
  const openRef = (r: KanbanFileRef): void => {
    const p = r.path.trim()
    if (!p) return
    openFileRef(p, r.line, r.endLine)
    onClose() // reveal the file board (the modal sits above the canvas) scrolled to the line
  }

  const onDelete = (): void => {
    commit(removeCard(board, cardId))
    onClose()
  }

  return (
    <Modal
      label={`Card: ${card.title}`}
      onClose={onClose}
      zIndex={9000}
      initialFocusRef={titleRef}
      cardProps={{ 'data-testid': 'kanban-card-modal' }}
      cardStyle={{ width: 720, maxWidth: '92vw', padding: 0 }}
    >
      <div className="kbm">
        <div className="kbm-head">
          <span className="kbm-crumb">
            {board.title || 'Kanban'}
            <span className="kbm-sep">▸</span>
            {columnTitle}
          </span>
          <span className="kbm-spacer" />
          <span className="kbm-hint">Esc to close</span>
          <button className="kbm-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="kbm-body">
          {/* left — content */}
          <div className="kbm-content">
            <input
              ref={titleRef}
              className="kbm-title"
              aria-label="Card title"
              data-testid="kbm-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={enterBlurs}
              onBlur={() => {
                const next = renameCard(board, cardId, title)
                commit(next)
                // renameCard REJECTS a blank/unchanged title (returns the same array — a card must
                // keep a title). Unlike the buffered clearable fields, a blank here doesn't persist,
                // so resync the local buffer to the real title — else a cleared-then-abandoned field
                // shows permanently empty while the card face still holds its name (review #345).
                if (next === board.cards) setTitle(card.title)
              }}
            />
            <div className="kbm-field">
              <span className="kbm-label">Description</span>
              <textarea
                className="kbm-desc"
                aria-label="Card description"
                data-testid="kbm-desc"
                value={description}
                placeholder="Add a description…"
                rows={6}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => commit(setCardDescription(board, cardId, description))}
              />
            </div>
          </div>

          {/* right — metadata sidebar */}
          <div className="kbm-side">
            <div className="kbm-block">
              <span className="kbm-label">{axisLabel}</span>
              <select
                className="kbm-select"
                aria-label={axisLabel}
                data-testid="kbm-status"
                value={card.columnId}
                onChange={(e) => commit(moveCard(board, cardId, e.target.value))}
              >
                {board.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="kbm-block">
              <span className="kbm-label">Tags</span>
              <div className="kbm-tags">
                {tags.map((t) => (
                  <span key={t} className={`kb-tag kb-tag-${tagTint(t)} kbm-tag`}>
                    {t}
                    <button
                      className="kbm-tag-x"
                      aria-label={`Remove tag ${t}`}
                      onClick={() => removeTag(t)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="kbm-tag-input"
                  aria-label="Add tag"
                  data-testid="kbm-tag-input"
                  value={tagDraft}
                  placeholder="+ add"
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                  onBlur={addTag}
                />
              </div>
            </div>

            <div className="kbm-block">
              <span className="kbm-label">Assignee</span>
              <input
                className="kbm-input"
                aria-label="Assignee"
                data-testid="kbm-assignee"
                value={assignee}
                placeholder="Unassigned"
                onChange={(e) => setAssignee(e.target.value)}
                onKeyDown={enterBlurs}
                onBlur={() => commit(setCardAssignee(board, cardId, assignee))}
              />
            </div>

            <div className="kbm-block">
              <span className="kbm-label">Reference</span>
              <input
                className="kbm-input"
                aria-label="External reference"
                data-testid="kbm-ref"
                value={ref}
                placeholder="e.g. PR #271"
                onChange={(e) => setRef(e.target.value)}
                onKeyDown={enterBlurs}
                onBlur={() => commit(setCardRef(board, cardId, ref))}
              />
            </div>

            <div className="kbm-block">
              <span className="kbm-label">Files &amp; lines</span>
              <div className="kbm-refs">
                {refs.map((r, i) => (
                  <div className="kbm-ref" key={i} data-testid="kbm-ref">
                    <input
                      className="kbm-ref-path"
                      aria-label="File path"
                      value={r.path}
                      placeholder="path/to/file.ts"
                      onChange={(e) => updateRef(i, { path: e.target.value })}
                      onBlur={() => commitRefs(refs)}
                    />
                    <input
                      className="kbm-ref-line"
                      aria-label="Start line"
                      inputMode="numeric"
                      value={r.line ?? ''}
                      placeholder="ln"
                      onChange={(e) => updateRef(i, { line: parseLine(e.target.value) })}
                      onKeyDown={enterBlurs}
                      onBlur={() => commitRefs(refs)}
                    />
                    <input
                      className="kbm-ref-line"
                      aria-label="End line"
                      inputMode="numeric"
                      value={r.endLine ?? ''}
                      placeholder="–"
                      onChange={(e) => updateRef(i, { endLine: parseLine(e.target.value) })}
                      onKeyDown={enterBlurs}
                      onBlur={() => commitRefs(refs)}
                    />
                    <button
                      className="kbm-ref-open"
                      aria-label="Open file at line"
                      title="Open file at line"
                      disabled={!r.path.trim()}
                      onClick={() => openRef(r)}
                    >
                      ↗
                    </button>
                    <button
                      className="kbm-ref-del"
                      aria-label="Remove file reference"
                      onClick={() => removeRef(i)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="kbm-ref-add"
                  data-testid="kbm-ref-add"
                  onClick={() => setRefs([...refs, { path: '' }])}
                >
                  + Add file &amp; line
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="kbm-foot">
          <button className="ca-btn-ghost kbm-del" data-testid="kbm-delete" onClick={onDelete}>
            Delete card
          </button>
        </div>
      </div>
    </Modal>
  )
}
