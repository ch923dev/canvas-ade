/**
 * Kanban card-detail modal (v19, card-detail epic) — the "open a card to see everything" surface the
 * flat card face deliberately withholds (Linear rule: no description prose on the face). Jira-style two
 * columns: the CONTENT pane (title + description + attachments) on the left, a METADATA sidebar (status,
 * tags, assignee, reference, file+line refs) on the right. Built on the shared `Modal` primitive, so the
 * scrim / focus-trap / Esc / focus-restore all come for free (canvas/Modal.tsx).
 *
 * TWO MODES (#346): EDIT (`cardId`) opens an existing card — every field commits through the SAME
 * `beginChange()` + `updateBoard({ cards })` path the board face uses (a modal edit is ONE undoable,
 * autosaved step; an unchanged value → op returns the same array ref → records nothing). CREATE
 * (`createInColumnId`) opens an EMPTY draft with the target column pre-picked — nothing touches the
 * store until the primary "Add card" commits the whole card (title + description + tags + fileRefs +
 * attachments) as ONE new card in one undo step. The board keys this modal by cardId / a create token,
 * so switching REMOUNTS with fresh state rather than needing a prop→state sync effect (#345 finding).
 */
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { KanbanBoard, KanbanCard, KanbanFileRef } from '../../lib/boardSchema'
import type { KanbanAttachment } from '../../lib/kanbanSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { Modal } from '../Modal'
import {
  addCardDetailed,
  effectiveTags,
  moveCard,
  removeCard,
  renameCard,
  setCardAssignee,
  setCardAttachments,
  setCardDescription,
  setCardFileRefs,
  setCardRef,
  setCardTags,
  tagTint
} from './kanbanEdit'
import { AttachmentsBlock } from './KanbanAttachments'
import { PickFileLinesModal } from './PickFileLinesModal'

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
  createInColumnId,
  onClose
}: {
  board: KanbanBoard
  /** EDIT mode: the id of the existing card to open. Mutually exclusive with `createInColumnId`. */
  cardId?: string
  /** CREATE mode: the column a brand-new card is being added to (pre-selected). */
  createInColumnId?: string
  onClose: () => void
}): ReactElement | null {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  const openFileRef = useCanvasStore((s) => s.openFileRef)

  const isCreate = createInColumnId !== undefined

  // The live card (re-read each render so undo / an MCP write reflect immediately). In create mode there
  // is no card yet; all hooks below still run (seeded from empty), then we only bail in EDIT mode.
  const card: KanbanCard | null =
    cardId != null ? (board.cards.find((c) => c.id === cardId) ?? null) : null

  const titleRef = useRef<HTMLInputElement>(null)

  // Single-value fields buffer locally. In EDIT they seed from the card and commit on blur (a keystroke
  // isn't a store write / undo step); in CREATE they ARE the draft and commit once on "Add card". Chip /
  // fileRef / attachment lists live on the card in edit mode, or in the draft arrays below in create mode.
  const [title, setTitle] = useState(card?.title ?? '')
  const [description, setDescription] = useState(card?.description ?? '')
  const [assignee, setAssignee] = useState(card?.assignee ?? '')
  const [ref, setRef] = useState(card?.ref ?? '')
  const [tagDraft, setTagDraft] = useState('')
  const [columnId, setColumnId] = useState(
    createInColumnId ?? card?.columnId ?? board.columns[0]?.id ?? ''
  )
  // The pick-file-lines modal: 'add' a new ref, or edit the ref at { index }; null = closed.
  const [picker, setPicker] = useState<'add' | { index: number } | null>(null)
  // Create-mode-only draft lists (edit mode reads these fields off the live card instead).
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftFileRefs, setDraftFileRefs] = useState<KanbanFileRef[]>([])
  const [draftAttachments, setDraftAttachments] = useState<KanbanAttachment[]>([])
  // True while an attachment's asset.write is in flight — gates the create-mode "Add card" so a commit
  // can't race a pending write and drop the attachment (leaving an orphaned blob on disk).
  const [attachBusy, setAttachBusy] = useState(false)

  // EDIT mode only: bail if the card was deleted out from under the modal (create has no card).
  if (!isCreate && !card) return null

  const commit = (cards: KanbanCard[]): void => {
    beginChange()
    updateBoard(board.id, { cards })
  }

  // Field values are read from the draft (create) or the live card (edit) uniformly below.
  const tags = isCreate ? draftTags : effectiveTags(card as KanbanCard)
  const fileRefs = isCreate ? draftFileRefs : (card?.fileRefs ?? [])
  const attachments = isCreate ? draftAttachments : (card?.attachments ?? [])
  const columnTitle = board.columns.find((c) => c.id === columnId)?.title ?? columnId
  // v19 column axis: the sidebar column-picker label reflects what the columns MEAN — a workflow
  // "Status" (flow) vs the board's category name (e.g. "Phase"). Absent axis ⇒ flow ⇒ "Status".
  const axisLabel =
    board.axisLabel?.trim() || (board.columnAxis === 'category' ? 'Category' : 'Status')

  const addTag = (): void => {
    const v = tagDraft.trim()
    if (!v) return
    if (isCreate) setDraftTags((prev) => (prev.includes(v) ? prev : [...prev, v]))
    else commit(setCardTags(board, cardId as string, [...tags, v]))
    setTagDraft('')
  }
  const removeTag = (t: string): void => {
    if (isCreate) setDraftTags((prev) => prev.filter((x) => x !== t))
    else
      commit(
        setCardTags(
          board,
          cardId as string,
          tags.filter((x) => x !== t)
        )
      )
  }

  const removeRef = (i: number): void => {
    if (isCreate) setDraftFileRefs((prev) => prev.filter((_, j) => j !== i))
    else
      commit(
        setCardFileRefs(
          board,
          cardId as string,
          fileRefs.filter((_, j) => j !== i)
        )
      )
  }
  // The pick-file-lines modal returns a normalized ref → append (add) or replace (edit), then close.
  const applyPick = (r: KanbanFileRef): void => {
    const next =
      picker && picker !== 'add'
        ? fileRefs.map((x, j) => (j === picker.index ? r : x))
        : [...fileRefs, r]
    if (isCreate) setDraftFileRefs(next)
    else commit(setCardFileRefs(board, cardId as string, next))
    setPicker(null)
  }
  const openRef = (r: KanbanFileRef): void => {
    const p = r.path.trim()
    if (!p) return
    openFileRef(p, r.line, r.endLine)
    onClose() // reveal the file board (the modal sits above the canvas) scrolled to the line
  }

  // Attachments. Add hands the parent freshly-built entries (the block already persisted the bytes).
  // Edit-mode add RE-READS the live board at commit time: `asset.write` awaits open a window in which
  // another edit could land, and updateBoard fully replaces `cards` — so committing off the stale prop
  // would drop that concurrent change (the usePlanningImageIO live-read discipline).
  const onAddAttachments = (entries: KanbanAttachment[]): void => {
    if (isCreate) {
      setDraftAttachments((prev) => [...prev, ...entries])
      return
    }
    const live = useCanvasStore.getState().boards.find((b) => b.id === board.id)
    if (live?.type !== 'kanban') return
    const liveCard = live.cards.find((c) => c.id === cardId)
    if (!liveCard) return
    commit(
      setCardAttachments(live, cardId as string, [...(liveCard.attachments ?? []), ...entries])
    )
  }
  const removeAttachment = (i: number): void => {
    if (isCreate) setDraftAttachments((prev) => prev.filter((_, j) => j !== i))
    else
      commit(
        setCardAttachments(
          board,
          cardId as string,
          attachments.filter((_, j) => j !== i)
        )
      )
  }

  const onDelete = (): void => {
    commit(removeCard(board, cardId as string))
    onClose()
  }

  // CREATE: commit the whole draft as ONE new card (addCardDetailed normalizes every field). A blank
  // title is refused (a card must keep a title) — focus the field rather than silently no-op.
  const onAdd = (): void => {
    if (attachBusy) return // an attachment write is still in flight — don't commit without it
    if (!title.trim()) {
      titleRef.current?.focus()
      return
    }
    beginChange()
    updateBoard(board.id, {
      cards: addCardDetailed(board, columnId, {
        title,
        description,
        tags: draftTags,
        assignee,
        ref,
        fileRefs: draftFileRefs,
        attachments: draftAttachments
      })
    })
    onClose()
  }

  return (
    <Modal
      label={isCreate ? 'New card' : `Card: ${card?.title}`}
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
            {isCreate ? `New card in ${columnTitle}` : columnTitle}
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
              placeholder={isCreate ? 'Card title…' : undefined}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={enterBlurs}
              onBlur={() => {
                if (isCreate) return // create commits on "Add card", not per-field
                const next = renameCard(board, cardId as string, title)
                commit(next)
                // renameCard REJECTS a blank/unchanged title (returns the same array — a card must
                // keep a title). Unlike the buffered clearable fields, a blank here doesn't persist,
                // so resync the local buffer to the real title — else a cleared-then-abandoned field
                // shows permanently empty while the card face still holds its name (review #345).
                if (next === board.cards && card) setTitle(card.title)
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
                onBlur={() => {
                  if (isCreate) return
                  commit(setCardDescription(board, cardId as string, description))
                }}
              />
            </div>
            <div className="kbm-field">
              <span className="kbm-label">Attachments</span>
              <AttachmentsBlock
                attachments={attachments}
                onAdd={onAddAttachments}
                onRemove={removeAttachment}
                onPendingChange={setAttachBusy}
                toastKey={board.id}
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
                value={columnId}
                onChange={(e) => {
                  if (isCreate) setColumnId(e.target.value)
                  else commit(moveCard(board, cardId as string, e.target.value))
                }}
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
                onBlur={() => {
                  if (isCreate) return
                  commit(setCardAssignee(board, cardId as string, assignee))
                }}
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
                onBlur={() => {
                  if (isCreate) return
                  commit(setCardRef(board, cardId as string, ref))
                }}
              />
            </div>

            <div className="kbm-block">
              <span className="kbm-label">Files &amp; lines</span>
              <div className="kbm-refs">
                {fileRefs.map((r, i) => {
                  const cut = r.path.lastIndexOf('/') + 1
                  const lines =
                    r.line != null ? (r.endLine ? `L${r.line}–${r.endLine}` : `L${r.line}`) : ''
                  return (
                    <div className="kbm-ref" key={i} data-testid="kbm-ref">
                      <button
                        className="kbm-ref-path"
                        title="Edit this reference"
                        onClick={() => setPicker({ index: i })}
                      >
                        <span className="kbm-ref-dir">{r.path.slice(0, cut)}</span>
                        <span className="kbm-ref-base">{r.path.slice(cut)}</span>
                      </button>
                      {lines && <span className="kbm-ref-ln">{lines}</span>}
                      <button
                        className="kbm-ref-open"
                        aria-label="Open file at line"
                        title="Open file at line on the canvas"
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
                  )
                })}
                <button
                  className="kbm-ref-add"
                  data-testid="kbm-ref-add"
                  onClick={() => setPicker('add')}
                >
                  + Add file &amp; line
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="kbm-foot">
          {isCreate ? (
            <>
              <button className="ca-btn-ghost" data-testid="kbm-cancel" onClick={onClose}>
                Cancel
              </button>
              <span className="kbm-spacer" />
              <button
                className="ca-btn-primary kbm-addbtn"
                data-testid="kbm-add"
                disabled={attachBusy}
                onClick={onAdd}
              >
                {attachBusy ? 'Adding files…' : 'Add card'}
              </button>
            </>
          ) : (
            <button className="ca-btn-ghost kbm-del" data-testid="kbm-delete" onClick={onDelete}>
              Delete card
            </button>
          )}
        </div>

        {picker !== null && (
          <PickFileLinesModal
            initial={picker === 'add' ? undefined : fileRefs[picker.index]}
            onPick={applyPick}
            onClose={() => setPicker(null)}
          />
        )}
      </div>
    </Modal>
  )
}
