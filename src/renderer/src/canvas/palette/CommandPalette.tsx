/**
 * Command palette island (D4-A, signed off 2026-06-11) — the Ctrl+K command view and
 * the `?` shortcuts view in one floating island (DESIGN.md §8) on the shared Modal
 * primitive (scrim/portal/focus trap+restore/Esc — D1-B).
 *
 * Interaction contract (spec §Interaction):
 * - Combobox pattern: the input KEEPS DOM focus the whole time; ↑/↓ move the active
 *   row (wrapping), Enter runs it, `aria-activedescendant` tracks it for AT.
 * - Running a verb closes the palette FIRST, then executes one macrotask later, so
 *   Modal's unmount focus-restore can never stomp focus a verb moves (the rename
 *   intent's title input). The one exception: "Keyboard shortcuts" switches the view
 *   in place, no close.
 * - Esc layering: the scrim carries `data-palette-open` — the full-view CAPTURE Esc
 *   listener yields to it (after the `[data-confirm-active]` gate, BUG-005 order
 *   unchanged) so Modal's bubble Esc closes the palette first; a second Esc then
 *   exits full view.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { Modal } from '../Modal'
import { TypeGlyph } from '../TypeGlyph'
import {
  buildCommands,
  displayChip,
  SECTION_ORDER,
  SHORTCUT_ROWS,
  type PaletteCommand,
  type PaletteVerbs
} from './commandRegistry'
import { scoreMatch } from './paletteSearch'

export type PaletteView = 'commands' | 'shortcuts'

export interface CommandPaletteProps {
  /** Which view to open on (Ctrl+K → 'commands', `?` → 'shortcuts'). */
  initialView: PaletteView
  /** Verb callbacks from Canvas; `showShortcuts` is palette-internal (view switch). */
  verbs: Omit<PaletteVerbs, 'showShortcuts'>
  onClose: () => void
}

/** Mirrors Canvas/TerminalBoard's IS_MAC detection so chips match the real keys. */
const IS_MAC = navigator.platform.toLowerCase().includes('mac')

function Chips({ chips }: { chips: string[] }): ReactElement {
  return (
    <span className="cp-chips">
      {chips.map((c, i) =>
        c === '·' ? (
          <span key={i} className="cp-chip-sep">
            ·
          </span>
        ) : (
          <kbd key={i}>{displayChip(c, IS_MAC)}</kbd>
        )
      )}
    </span>
  )
}

export function CommandPalette({ initialView, verbs, onClose }: CommandPaletteProps): ReactElement {
  const [view, setView] = useState<PaletteView>(initialView)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const baseId = useId()

  // Store snapshot — live subscriptions so rows stay correct while open (cheap: the
  // command list is a few dozen entries).
  const boards = useCanvasStore((s) => s.boards)
  const groups = useCanvasStore((s) => s.groups)
  const selectedIds = useCanvasStore((s) => s.selectedIds)
  const canUndo = useCanvasStore((s) => s.past.length > 0)
  const canRedo = useCanvasStore((s) => s.future.length > 0)

  // switchView is deliberately not a dep: it only touches setState setters + a ref,
  // so a stale capture is harmless and the memo stays keyed on the caller's verbs.
  const fullVerbs = useMemo<PaletteVerbs>(
    () => ({ ...verbs, showShortcuts: () => switchView('shortcuts') }),
    [verbs]
  )
  const commands = useMemo(
    () =>
      buildCommands(
        {
          boards: boards.map((b) => ({
            id: b.id,
            type: b.type,
            title: b.title,
            agentSessionId: b.type === 'terminal' ? b.agentSessionId : undefined
          })),
          groups: groups.map((g) => ({ id: g.id, name: g.name })),
          selectedIds,
          canUndo,
          canRedo
        },
        fullVerbs
      ),
    [boards, groups, selectedIds, canUndo, canRedo, fullVerbs]
  )

  // Filter + rank within each section; flat order = section order (calm while typing).
  const visible = useMemo(() => {
    const bySection: { section: string; items: PaletteCommand[] }[] = []
    for (const section of SECTION_ORDER) {
      const scored = commands
        .filter((c) => c.section === section)
        .map((c) => ({ c, s: scoreMatch(query, `${c.title} ${c.keywords ?? ''}`) }))
        .filter((x): x is { c: PaletteCommand; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c)
      if (scored.length) bySection.push({ section, items: scored })
    }
    return bySection
  }, [commands, query])
  const flat = useMemo(() => visible.flatMap((g) => g.items), [visible])

  // Shortcuts view rows, filtered by the same input.
  const shortcutGroups = useMemo(() => {
    const rows = SHORTCUT_ROWS.filter((r) => scoreMatch(query, r.label) !== null)
    const sections = [...new Set(rows.map((r) => r.section))]
    return sections.map((s) => ({ section: s, rows: rows.filter((r) => r.section === s) }))
  }, [query])

  const clampedIdx = Math.min(activeIdx, Math.max(0, flat.length - 1))
  const active = flat[clampedIdx]

  function switchView(v: PaletteView): void {
    setView(v)
    setQuery('')
    setActiveIdx(0)
    inputRef.current?.focus()
  }

  function runCommand(cmd: PaletteCommand): void {
    if (cmd.id === 'shortcuts') {
      switchView('shortcuts')
      return
    }
    onClose()
    // One macrotask later: Modal's unmount focus-restore has run, so verbs that move
    // focus themselves (rename → title input) win.
    window.setTimeout(() => cmd.run(), 0)
  }

  // Keep the active row scrolled into view as ↑/↓ move it. (Option ids are document-
  // global — useId-prefixed — so getElementById is safe; jsdom lacks scrollIntoView.)
  useEffect(() => {
    if (!active) return
    document.getElementById(`${baseId}-opt-${active.id}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, baseId])

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (view !== 'commands') {
      // Backspace on an empty query returns to the command view (mirrors the ← button).
      if (e.key === 'Backspace' && query === '') {
        e.preventDefault()
        switchView('commands')
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // The input keeps focus, so arrows scroll the read-only sheet (footer promise).
        e.preventDefault()
        listRef.current?.scrollBy({ top: e.key === 'ArrowDown' ? 56 : -56 })
      }
      return
    }
    if (flat.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((clampedIdx + 1) % flat.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((clampedIdx - 1 + flat.length) % flat.length)
    } else if (e.key === 'Home' && query === '') {
      e.preventDefault()
      setActiveIdx(0)
    } else if (e.key === 'End' && query === '') {
      e.preventDefault()
      setActiveIdx(flat.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (active) runCommand(active)
    }
  }

  const listboxId = `${baseId}-listbox`
  return (
    <Modal
      label="Command palette"
      onClose={onClose}
      zIndex={400}
      scrimProps={{ 'data-palette-open': '', 'data-test': 'palette-scrim' }}
      cardProps={{ 'data-test': 'command-palette' }}
      cardStyle={{
        placeSelf: 'start center',
        marginTop: '16vh',
        width: 560,
        maxWidth: '92vw',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: 0
      }}
    >
      <div className="cp-island">
        {view === 'shortcuts' && (
          <div className="cp-head">
            <button
              type="button"
              className="cp-back"
              aria-label="Back to commands"
              onClick={() => switchView('commands')}
            >
              ←
            </button>
            <span className="cp-title">Keyboard shortcuts</span>
            <kbd className="cp-esc">esc</kbd>
          </div>
        )}
        <div className="cp-search">
          <span className="cp-glass" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            data-test="palette-input"
            // Combobox semantics belong to the COMMANDS view only (review r1): in the
            // shortcuts view the list is read-only prose with no option children, so a
            // combobox pointing at it would be invalid ARIA — there it's a plain filter.
            role={view === 'commands' ? 'combobox' : undefined}
            aria-expanded={view === 'commands' ? 'true' : undefined}
            aria-controls={view === 'commands' ? listboxId : undefined}
            aria-activedescendant={
              view === 'commands' && active ? `${baseId}-opt-${active.id}` : undefined
            }
            aria-label={view === 'commands' ? 'Search commands' : 'Filter shortcuts'}
            placeholder={view === 'commands' ? 'Type a command or search…' : 'Filter shortcuts…'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIdx(0)
            }}
            onKeyDown={onInputKeyDown}
          />
          {view === 'commands' && <kbd className="cp-esc">esc</kbd>}
        </div>
        <div
          className="cp-list"
          ref={listRef}
          // Listbox only while options exist (commands view). The shortcuts sheet stays
          // role-less plain content — `list` would be invalid too (its rows aren't
          // listitem children; group wrappers intervene). Review r1.
          role={view === 'commands' ? 'listbox' : undefined}
          id={listboxId}
          data-test="palette-list"
        >
          {view === 'commands' ? (
            flat.length === 0 ? (
              <div className="cp-empty">No matching commands</div>
            ) : (
              visible.map((group) => (
                <div key={group.section} role="group" aria-label={group.section}>
                  <div className="cp-section" role="presentation">
                    {group.section}
                  </div>
                  {group.items.map((cmd) => (
                    <div
                      key={cmd.id}
                      id={`${baseId}-opt-${cmd.id}`}
                      role="option"
                      aria-selected={active?.id === cmd.id}
                      data-test={`palette-row-${cmd.id}`}
                      className="cp-row"
                      {...(active?.id === cmd.id ? { 'data-active': '' } : {})}
                      onPointerEnter={() => setActiveIdx(flat.indexOf(cmd))}
                      onPointerDown={(e) => e.preventDefault() /* keep input focus */}
                      onClick={() => runCommand(cmd)}
                    >
                      <span className="cp-glyph" aria-hidden>
                        {typeof cmd.glyph === 'string' ? (
                          cmd.glyph
                        ) : (
                          <TypeGlyph type={cmd.glyph.board} />
                        )}
                      </span>
                      <span className="cp-label">{cmd.title}</span>
                      {cmd.chips && <Chips chips={cmd.chips} />}
                    </div>
                  ))}
                </div>
              ))
            )
          ) : shortcutGroups.length === 0 ? (
            <div className="cp-empty">No matching shortcuts</div>
          ) : (
            shortcutGroups.map((group) => (
              <div key={group.section} role="group" aria-label={group.section}>
                <div className="cp-section" role="presentation">
                  {group.section}
                </div>
                {group.rows.map((row) => (
                  <div key={`${group.section}-${row.label}`} className="cp-srow">
                    <span className="cp-label">{row.label}</span>
                    {row.chips.length > 0 && <Chips chips={row.chips} />}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cp-footer">
          {view === 'commands' ? (
            <>
              <span>↑↓ navigate · ↵ run · esc close</span>
              <span className="cp-footer-right">
                <kbd>{displayChip('Ctrl', IS_MAC).toLowerCase()}</kbd>
                <kbd>K</kbd>
              </span>
            </>
          ) : (
            <>
              <span>↑↓ scroll · esc close</span>
              <span className="cp-footer-right">
                <kbd>?</kbd>
              </span>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
