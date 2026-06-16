/**
 * Shared board chrome shell (port of design-reference/boards.jsx `BoardFrame`).
 * One shell for all three board types — only the type glyph + content slot vary
 * (DESIGN.md §6). Renders two ways: the full chrome (title bar + content) and the
 * zoomed-out LOD card (glyph + tag + title + status dot). Purely presentational;
 * the canvas (React Flow node) owns position / drag / resize / selection state.
 */
import type { MouseEvent, ReactNode, ReactElement } from 'react'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { BoardType } from '../lib/boardSchema'
import { useCanvasStore } from '../store/canvasStore'
import { BoardFullViewContext } from './fullViewContext'
import { Icon, type IconName } from './Icon'
import { Menu } from './Menu'
import { usePaletteIntentStore } from './palette/paletteIntentStore'
import { TypeGlyph } from './TypeGlyph'

const TYPE_TAG: Record<BoardType, string> = {
  terminal: 'TERMINAL',
  browser: 'BROWSER',
  planning: 'PLANNING',
  file: 'FILE'
}

/** Status indicator: a coloured dot (`--ok` pulses) + optional mono label. */
export interface BoardStatus {
  /** A CSS colour token string, e.g. `'var(--ok)'`. */
  dot: string
  label?: string
}

/** D0-6: stable live-region text. The terminal's visible label churns — a braille
 *  spinner glyph re-renders every 80ms and the elapsed timer every second — so the
 *  polite region would otherwise announce continuously. Drop the glyph and map the
 *  timer suffix to a constant word; the text then changes only on real transitions
 *  (`claude · starting` → `claude · running` → `claude · exited`).
 *  The `MM:SS → running` rewrite is safe because statusFor (terminalState.ts) appends
 *  the timer suffix ONLY in its `running` arm — `exited`/`idle`/`spawn-failed` labels
 *  never carry a trailing timestamp. */
function srStatusText(label: string): string {
  return label
    .replace(/[⠀-⣿]\s*/g, '')
    .replace(/\s*·\s*\d+:\d{2}\s*$/, ' · running')
    .trim()
}

/** D0-6: always-mounted live region that starts EMPTY and fills only on a real status
 *  TRANSITION (same intent as BrowserBoard's srConn sentinel) — a region that mounts
 *  WITH content is announced by NVDA/JAWS, so boards carrying a pre-existing status
 *  would all speak at once on project load. Pure derived render: the mount-time
 *  normalized text is captured once (lazy useState) and suppressed; anything else
 *  renders. Known minor gap: a later return to exactly the mount-time text (e.g.
 *  restart back into the state the board loaded in) is silent for that one step. */
function SrBoardStatus({ label }: { label?: string }): ReactElement {
  const [initial] = useState(() => (label ? srStatusText(label) : ''))
  const norm = label ? srStatusText(label) : ''
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {norm === initial ? '' : norm}
    </span>
  )
}

/** D2-A: inline board title (closes the DESIGN.md §6 "title is inline-editable on
 *  double-click" mandate). Double-click — or F2 while this board is the single
 *  selection — swaps the title span for an input; Enter/blur commit, Esc cancels.
 *  A commit is one undoable gesture (`beginChange` + `updateBoard`); empty or
 *  unchanged text cancels instead (no store write, no phantom undo step). Renders
 *  the plain span when `boardId` is absent (nothing to rename). */
function BoardTitle({
  boardId,
  title,
  selected
}: {
  boardId?: string
  title: string
  selected: boolean
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Latches on the first commit/cancel so the close paths fire exactly once (the
  // GroupNamePopover discipline): an Esc-cancel must not let the input's unmount
  // blur re-fire commit and resurrect the discarded draft.
  const doneRef = useRef(false)

  // Mount-stable listener inputs (the mid-dispatch removal class, D1-B/C): the window
  // listeners below are registered ONCE and read these refs — a dep-driven re-register
  // gets removed mid-dispatch by a sync store commit and the DOM skips the very
  // keydown being handled.
  const editingRef = useRef(editing)
  const selectedRef = useRef(selected)
  const boardIdRef = useRef(boardId)
  const titleRef = useRef(title)
  useEffect(() => {
    editingRef.current = editing
    selectedRef.current = selected
    boardIdRef.current = boardId
    titleRef.current = title
  })

  // Stable identities (refs + setState only) so the mount-stable listener effect can
  // depend on them without ever re-registering.
  const startEdit = useCallback((): void => {
    if (!boardIdRef.current) return
    doneRef.current = false
    setEditing(true)
  }, [])
  const commit = useCallback((): void => {
    if (doneRef.current) return
    doneRef.current = true
    setEditing(false)
    // Read the LIVE DOM value, not a state closure: a fast type-then-Enter can beat
    // the last onChange flush (the input is uncontrolled for exactly this reason).
    const next = (inputRef.current?.value ?? '').trim()
    const id = boardIdRef.current
    // Empty or unchanged → cancel semantics: no store write, no undo checkpoint.
    if (!id || !next || next === titleRef.current) return
    const store = useCanvasStore.getState()
    store.beginChange()
    store.updateBoard(id, { title: next })
  }, [])
  const cancel = useCallback((): void => {
    if (doneRef.current) return
    doneRef.current = true
    setEditing(false)
  }, [])

  useEffect(() => {
    // Esc on the CAPTURE phase: while editing in full view, the canvas's own capture
    // listener (useCanvasKeybindings #3) stops propagation before the input's React
    // handler ever sees the key — but same-target window listeners still run after a
    // stopPropagation, so this one reliably cancels the edit. (That Esc also exits
    // full view — the canvas listener registered first; acceptable: the draft is
    // discarded either way, never committed by the relocation blur.)
    const onEscCapture = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && editingRef.current) cancel()
    }
    const onF2 = (e: KeyboardEvent): void => {
      if (e.key !== 'F2' || editingRef.current || !selectedRef.current || !boardIdRef.current)
        return
      const t = e.target as HTMLElement | null
      // Typing guard: F2 must not hijack an input/textarea/contentEditable — including
      // xterm's hidden helper textarea (F2 in a focused terminal belongs to the agent).
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      // Only an unambiguous single selection renames: a marquee multi-select would
      // otherwise open an input on every selected board at once.
      if (useCanvasStore.getState().selectedIds.length > 1) return
      e.preventDefault()
      startEdit()
    }
    window.addEventListener('keydown', onEscCapture, true)
    window.addEventListener('keydown', onF2)
    return () => {
      window.removeEventListener('keydown', onEscCapture, true)
      window.removeEventListener('keydown', onF2)
    }
  }, [startEdit, cancel])

  // Focus + select the whole title once the input mounts, so typing replaces it.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // D4-A: the command palette's "Rename board" posts a one-shot intent (it can't call
  // startEdit directly). Consume by board id — the palette already closed and restored
  // focus a macrotask earlier, so the title input's focus grab below wins cleanly.
  const paletteIntent = usePaletteIntentStore((s) => s.intent)
  useEffect(() => {
    if (!paletteIntent || paletteIntent.kind !== 'rename') return
    if (paletteIntent.boardId !== boardId) return
    usePaletteIntentStore.getState().consume(paletteIntent.nonce)
    startEdit()
  }, [paletteIntent, boardId, startEdit])

  if (editing) {
    return (
      <input
        ref={inputRef}
        // `nodrag nopan` (React Flow escape hatches): the title bar is the node drag
        // handle and dblclick inside `nopan` is excluded from the d3 dblclick-zoom.
        className="board-title-edit nodrag nopan"
        defaultValue={title}
        aria-label="Board title"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Containment: title keystrokes must not reach the canvas keymap / React
          // Flow deleteKeyCode (both listen on window bubble) or the board beneath.
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') cancel()
        }}
        onBlur={commit}
      />
    )
  }
  return (
    <span
      // `nopan` only (NOT nodrag): it excludes the dblclick from d3's dblclick-zoom,
      // while the span stays part of the title-bar drag handle — it is flex:1 (most of
      // the bar), so dragging a board by its title text must keep working. A clean
      // double-click has no movement, so RF's drag threshold never engages between
      // the two clicks. The INPUT keeps nodrag: text-selection drags must not move
      // the board.
      className="board-title nopan"
      title={boardId ? 'Rename: double-click or F2' : undefined}
      onDoubleClick={
        boardId
          ? (e) => {
              e.stopPropagation()
              startEdit()
            }
          : undefined
      }
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: selected ? 'var(--text)' : 'var(--text-2)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flex: 1,
        minWidth: 0
      }}
    >
      {title}
    </span>
  )
}

/** 24×24 icon button used in the title-bar action slot. */
export function IconBtn({
  name,
  title,
  active = false,
  danger = false,
  disabled,
  size = 15,
  sw,
  restColor = 'var(--text-3)',
  onClick,
  onLongPress,
  longPressMs = 500,
  onContextMenu,
  onPointerDown
}: {
  name: IconName
  title: string
  active?: boolean
  danger?: boolean
  /** When true, the button is visually muted and not clickable. */
  disabled?: boolean
  size?: number
  /** Stroke width override for the glyph (sparse glyphs like ⋯ need more ink to read). */
  sw?: number
  /** Resting (non-hover, non-active) icon colour. Default `--text-3`; the ⋯ overflow
   *  trigger uses `--text-2` so it isn't near-invisible at rest. */
  restColor?: string
  onClick?: (e: MouseEvent) => void
  /** Press-to-drag start (M2 connector handle): fires on pointer-down, before any
   *  click/long-press timing, so a press-drag-release that ends off the button still
   *  begins the gesture. Receives the down event (already stop-propagated from the drag). */
  onPointerDown?: (e: MouseEvent) => void
  /** Press-and-hold handler. When the pointer is held ≥`longPressMs`, this fires and the
   *  subsequent click (the release) is suppressed so `onClick` does NOT also run. */
  onLongPress?: () => void
  longPressMs?: number
  /** Right-click (context-menu) handler — an accessible, no-timing alternative to
   *  `onLongPress`. Suppresses the native context menu when set. */
  onContextMenu?: () => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  // Long-press: a timer armed on pointer-down fires onLongPress; `heldRef` then gates the
  // trailing click so a hold never doubles as a tap. Cleared on up/leave (= a short tap).
  const heldRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const clearTimer = (): void => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  // Cancel the long-press timer when the component unmounts (BUG-034): if the board is
  // removed while the 500ms timer is in flight, the callback must not fire on the dead tree.
  useEffect(() => () => clearTimer(), [])
  const handlePointerDown = (): void => {
    if (!onLongPress) return
    heldRef.current = false
    timerRef.current = window.setTimeout(() => {
      heldRef.current = true
      onLongPress()
    }, longPressMs)
  }
  const handleClick = (e: MouseEvent): void => {
    clearTimer()
    if (heldRef.current) {
      // A long-press already fired — swallow the release click.
      heldRef.current = false
      return
    }
    onClick?.(e)
  }
  const color = active
    ? 'var(--accent)'
    : danger && hover
      ? 'var(--err)'
      : hover
        ? 'var(--text-2)'
        : restColor
  return (
    <button
      // ca-t-ctl (A12): hover colour/background transition via class, not inline,
      // so prefers-reduced-motion can suppress it (index.css media block).
      className="ca-t-ctl"
      title={title}
      disabled={disabled}
      onClick={handleClick}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault()
              clearTimer()
              onContextMenu()
            }
          : undefined
      }
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        clearTimer() // pointer left the button before the hold fired → cancel
      }}
      // Accent ring on keyboard focus so the title-bar controls are visible to keyboard
      // users (matches the §6 board select-ring treatment).
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      // Stop the title-bar drag from starting when a control is pressed; also arm/disarm
      // the long-press timer on press/release.
      onMouseDown={(e) => {
        e.stopPropagation()
        handlePointerDown()
        onPointerDown?.(e)
      }}
      onMouseUp={clearTimer}
      style={{
        width: 24,
        height: 24,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 'var(--r-ctl)',
        border: '1px solid transparent',
        cursor: disabled ? 'default' : 'pointer',
        background: hover && !disabled ? 'var(--surface-overlay)' : 'transparent',
        color,
        outline: 'none',
        boxShadow: focus ? '0 0 0 1.5px var(--accent)' : 'none',
        ...(disabled ? { opacity: 0.35 } : {})
      }}
    >
      <Icon name={name} size={size} sw={sw} />
    </button>
  )
}

/** ⋯ overflow popover: Full view · Duplicate · Add/Remove group · Delete (DESIGN §6.1; S6). */
export function BoardMenu({
  boardId,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup
}: {
  /** This board's id — used to compute eligible groups (not already a member) + membership. */
  boardId?: string
  onFull?: (e: MouseEvent) => void
  onDuplicate?: () => void
  onDelete?: () => void
  /** S6: add this board to a group (the absorb re-pack). One item per eligible group. */
  onAddToGroup?: (groupId: string) => void
  /** S6: remove this board from every group it belongs to. Shown only when it is in one. */
  onRemoveFromGroup?: () => void
}): ReactElement {
  // S6: read groups live so the eligible-list / membership reflect the current state.
  const groups = useCanvasStore((s) => s.groups)
  const eligibleGroups =
    boardId && onAddToGroup ? groups.filter((g) => !g.boardIds.includes(boardId)) : []
  const inAnyGroup = !!boardId && groups.some((g) => g.boardIds.includes(boardId))
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)

  const openMenu = (e: MouseEvent): void => {
    e.stopPropagation()
    setOpen((v) => !v)
  }

  const item = (label: string, danger: boolean, fn?: (e: MouseEvent) => void): ReactElement => (
    <button
      className="board-menu-item"
      role="menuitem"
      data-danger={danger || undefined}
      onClick={(e) => {
        e.stopPropagation()
        setOpen(false)
        fn?.(e)
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      ref={triggerRef}
      style={{ position: 'relative', display: 'inline-flex' }}
      // Prevent React Flow from treating a ⋯ button press as a canvas-node drag start (the
      // trigger sits in the title bar, which is the RF drag handle). Outside-close re-click
      // toggling (#BUG-045) no longer needs this — the Menu shell's anchor exclusion covers it.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* The ⋯ dots are a near-inkless glyph; bump stroke + use a brighter rest colour so
          the overflow affordance is actually visible at rest (not only when clicked). */}
      <IconBtn
        name="more"
        title="More"
        active={open}
        size={16}
        sw={2.6}
        restColor="var(--text-2)"
        onClick={openMenu}
      />
      {/* Shared Menu shell (D1-C): body portal, viewport clamp (right-aligned under the
          trigger, flips above on bottom overflow — bug 14), Escape/outside/resize close,
          menuitem roving tabindex + arrow keys, and the ADR 0002 detach-live-previews-
          while-open signal. The trigger wrapper above is the anchor (and is excluded
          from outside-close so re-clicking the ⋯ toggles closed — BUG-045). */}
      {open && (
        <Menu
          anchor={triggerRef}
          align="right"
          label="Board actions"
          className="board-menu"
          onClose={() => setOpen(false)}
        >
          {onFull && item('Full view', false, onFull)}
          {onDuplicate && item('Duplicate', false, () => onDuplicate())}
          {/* S6: one "Add to {name}" row per group this board is NOT already in. */}
          {onAddToGroup &&
            eligibleGroups.map((g) => (
              <span key={g.id} style={{ display: 'contents' }}>
                {item(`Add to ${g.name}`, false, () => onAddToGroup(g.id))}
              </span>
            ))}
          {/* S6: remove from every group the board belongs to (shown only when in one). */}
          {onRemoveFromGroup && inAnyGroup && item('Remove from group', false, onRemoveFromGroup)}
          {onDelete && item('Delete', true, () => onDelete())}
        </Menu>
      )}
    </div>
  )
}

export interface BoardFrameProps {
  type: BoardType
  /** This board's id — threaded to the ⋯ menu for the S6 add/remove-group items. */
  boardId?: string
  title: string
  selected?: boolean
  hovered?: boolean
  dimmed?: boolean
  /** Render the zoomed-out LOD card instead of full chrome. */
  lod?: boolean
  /** This board is the one shown in the full-view modal → the maximize control
   *  flips to the EXIT affordance (restore glyph + "Exit full view (Esc)"). */
  fullView?: boolean
  running?: boolean
  /** D2-B: PTY warming up — shows the top sliver in its slow variant before `running`. */
  spawning?: boolean
  status?: BoardStatus | null
  /** Per-type action controls shown left of maximize/⋯ in the title bar. */
  actions?: ReactNode
  /** Content-well background; `--inset` for Terminal, `--surface` otherwise. */
  contentBg?: string
  /** Provided only when the board is focusable → renders the maximize button. */
  onFull?: (e: MouseEvent) => void
  /** ⋯ menu → Duplicate. When provided alongside onFull/onDelete, the ⋯ button shows. */
  onDuplicate?: () => void
  /** ⋯ menu → Delete (danger). */
  onDelete?: () => void
  /** S6 ⋯ menu → add this board to a group (the absorb re-pack). */
  onAddToGroup?: (groupId: string) => void
  /** S6 ⋯ menu → remove this board from every group it belongs to. */
  onRemoveFromGroup?: () => void
  /** M2: begin a connector drag from this board (renders the title-bar connector handle). */
  onStartConnect?: () => void
  children?: ReactNode
}

export function BoardFrame({
  type,
  boardId,
  title,
  selected = false,
  hovered = false,
  dimmed = false,
  lod = false,
  fullView = false,
  running = false,
  spawning = false,
  status,
  actions,
  contentBg = 'var(--surface)',
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onStartConnect,
  children
}: BoardFrameProps): ReactElement {
  // Effective full-view: the explicit prop wins; otherwise read the ambient flag
  // BoardNode provides around this board's subtree (the per-type boards don't all
  // forward a prop). This is what lights the exit affordance at runtime.
  const ctxFullView = useContext(BoardFullViewContext)
  const isFullView = fullView || ctxFullView
  if (lod) {
    return (
      // ca-lod-card (D2-D): 100ms fade-in on mount — the entering half of the LOD
      // crossfade (BoardNode/TerminalBoard keep the detail render beneath it during
      // the overlap) — plus the 120ms ease on the focus-dim opacity. Both suppressed
      // by the reduced-motion media block in index.css.
      <div
        className="ca-lod-card"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'var(--r-board)',
          background: 'var(--surface-raised)',
          // §6 selected = accent ring (box-shadow) only; border stays neutral.
          border: '1px solid var(--border-subtle)',
          boxShadow: selected
            ? '0 0 0 1.5px var(--accent), var(--shadow-board)'
            : 'var(--shadow-board)',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 22px',
          opacity: dimmed ? 0.55 : 1,
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            color: 'var(--text-2)',
            flex: 'none',
            transform: 'scale(1.6)',
            transformOrigin: 'left center'
          }}
        >
          <TypeGlyph type={type} running={running} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              // §3 micro role — 10px is the on-canvas minimum (was 9px, below it).
              fontSize: 'var(--fs-micro)',
              letterSpacing: 'var(--tr-micro)',
              fontWeight: 'var(--fw-micro)',
              color: 'var(--text-3)', // D0-2: a readable tag — faint is disabled-only
              fontFamily: 'var(--mono)'
            }}
          >
            {TYPE_TAG[type]}
          </div>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 2
            }}
          >
            {title}
          </div>
        </div>
        {status && (
          <span
            className={status.dot === 'var(--ok)' ? 'ca-pulse' : ''}
            style={{ width: 9, height: 9, borderRadius: 999, background: status.dot, flex: 'none' }}
          />
        )}
      </div>
    )
  }

  return (
    // ca-board-shell (D2-D): the select-ring (box-shadow, §9 120ms ease-out), hover
    // border, and focus-dim opacity (now the same 120ms ease-out — audit fix 3, was
    // an off-contract .15s) transitions live in a CSS class so the reduced-motion
    // media block can suppress them (an inline transition wins over the @media rule).
    <div
      className="ca-board-shell"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'var(--r-board)',
        background: contentBg,
        overflow: 'hidden',
        // §6 selected = the 1.5px --accent ring (box-shadow) is the ONLY accent edge
        // treatment; the 1px border stays neutral (hover→--border else --border-subtle).
        border: `1px solid ${hovered ? 'var(--border)' : 'var(--border-subtle)'}`,
        boxShadow: selected
          ? '0 0 0 1.5px var(--accent), var(--shadow-board)'
          : 'var(--shadow-board)',
        opacity: dimmed ? 0.55 : 1,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {(running || spawning) && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            overflow: 'hidden',
            zIndex: 3
          }}
        >
          {/* D2-B: spawning shows the same sliver in a slower/dimmer variant, so the
              state reads as activity before `running` (it previously showed label-only). */}
          <div className={running ? 'ca-progress-bar' : 'ca-progress-bar ca-progress-spawn'} />
        </div>
      )}

      {/* Title bar = the React Flow drag handle (see BoardNode `dragHandle`). */}
      <div
        className="board-titlebar"
        style={{
          height: 'var(--titlebar-h)',
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 8px 0 10px',
          cursor: 'grab',
          background: selected ? 'var(--accent-wash)' : 'var(--surface-raised)',
          borderBottom: '1px solid var(--border-subtle)'
        }}
      >
        {/* The type glyph carries status: tinted to the status colour (green running /
            red failed / neutral idle). */}
        <span
          // ca-t-glyph (A12): the status-tint colour transition, reduced-motion gated.
          className={`ca-t-glyph${status?.dot === 'var(--ok)' && running ? ' ca-pulse' : ''}`}
          style={{
            color: status ? status.dot : selected ? 'var(--text-2)' : 'var(--text-3)',
            display: 'inline-flex',
            flex: 'none'
          }}
        >
          <TypeGlyph type={type} running={running} />
        </span>
        {/* Shrinkable middle (type tag + title + status label + per-type actions):
            collapses BEFORE the universal maximize/⋯ controls so the ⋯ trigger never
            clips off the title bar's right edge on a narrow board (bug 13). overflow:hidden
            keeps the tag + an overlong per-type cluster from pushing out / painting over
            the pinned controls. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden'
          }}
        >
          {/* §6 mandates a 10px micro type tag (TERMINAL/BROWSER/PLANNING) left of the
              title. Inside the shrinkable middle (the title collapses first) so a narrow
              board clips the tag rather than overflowing the pinned controls (menu-chrome). */}
          <span
            style={{
              fontSize: 'var(--fs-micro)',
              letterSpacing: 'var(--tr-micro)',
              fontWeight: 'var(--fw-micro)',
              color: 'var(--text-3)',
              fontFamily: 'var(--mono)',
              flex: 'none'
            }}
          >
            {TYPE_TAG[type]}
          </span>
          {/* D2-A: inline-editable title (double-click / F2) — see BoardTitle. */}
          <BoardTitle boardId={boardId} title={title} selected={selected} />
          {/* D0-6 (A5): persistent polite live region so status TRANSITIONS are announced
              (the visible label is hover-only, so it can't serve as the live region). The
              text strips the per-frame spinner glyph and maps the per-second elapsed timer
              to a stable word — announcements fire only on real state changes. Always
              mounted + starts empty so project load never mass-announces. */}
          <SrBoardStatus label={status?.label} />
          {/* Status label is on-demand: only while hovered or selected, kept calm at
              rest (the glyph colour carries the at-a-glance signal). */}
          {status?.label && (hovered || selected) && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--text-3)',
                whiteSpace: 'nowrap',
                flex: 'none'
              }}
            >
              {status.label}
            </span>
          )}
          {actions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
              {actions}
            </div>
          )}
        </div>
        {/* Universal controls, pinned at the far right — always visible & clickable. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
          {/* M2 connector handle — press-drag to draw an orchestration cable to another
              board. Pointer-down begins the gesture (Canvas tracks the rubber-band + drop
              target); hidden in full view (no canvas to drop onto). */}
          {onStartConnect && !isFullView && (
            <IconBtn
              name="connector"
              title="Draw a connector to another board"
              size={14}
              onPointerDown={() => onStartConnect()}
            />
          )}
          {/* In full view this same toggle is the EXIT affordance (USER DECISION
              2026-06-01: no separate top band) — restore glyph + an Esc-hinting title.
              onFull already toggles full view off. */}
          {onFull && (
            <IconBtn
              name={isFullView ? 'minimize' : 'maximize'}
              title={isFullView ? 'Exit full view (Esc)' : 'Full view'}
              size={14}
              onClick={onFull}
            />
          )}
          {(onFull || onDuplicate || onDelete || onAddToGroup || onRemoveFromGroup) && (
            <BoardMenu
              boardId={boardId}
              onFull={onFull}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onAddToGroup={onAddToGroup}
              onRemoveFromGroup={onRemoveFromGroup}
            />
          )}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', background: contentBg }}>
        {children}
      </div>
    </div>
  )
}
