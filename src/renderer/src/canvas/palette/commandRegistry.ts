/**
 * Command-palette registry (D4-A) — THE single enumeration of app verbs + shortcut
 * display chips. The Ctrl+K command view and the `?` shortcuts view both render from
 * here; nothing else hand-lists shortcuts. The real key DISPATCH stays in
 * `resolveCanvasKeyAction` (pure, unit-tested) — a drift-guard test feeds every chip
 * below that claims a canvas chord into the resolver and asserts the action kind, so
 * the chips can never silently disagree with the live keymap.
 *
 * Pure module: `buildCommands` is a function of a store snapshot + injected verb
 * callbacks. Context rows are HIDDEN (not disabled) when their predicate fails —
 * Raycast/Linear convention. Future MCP/agent verbs get a new section here.
 */
import type { BoardType } from '../../lib/boardSchema'

/** Sections in display order. */
export const SECTION_ORDER = [
  'Boards',
  'Selected board',
  'Groups',
  'Canvas',
  'Edit',
  'Help'
] as const
export type PaletteSection = (typeof SECTION_ORDER)[number]

export interface PaletteCommand {
  id: string
  section: PaletteSection
  title: string
  /** Extra match terms beyond the title (never displayed). */
  keywords?: string
  /** Mono glyph for the 16px slot, or a board type rendered via <TypeGlyph>. */
  glyph: string | { board: BoardType }
  /** Shortcut chips in generic form (['Ctrl','G']); display maps per platform. */
  chips?: string[]
  run: () => void
}

/** Verb callbacks injected by Canvas — the registry never imports stores. */
export interface PaletteVerbs {
  newBoard: (type: BoardType) => void
  goToBoard: (id: string) => void
  renameBoard: (id: string) => void
  duplicateBoard: (id: string) => void
  deleteBoard: (id: string) => void
  openFullView: (id: string) => void
  restartTerminal: (id: string, mode: 'resume' | 'new') => void
  exportPlanning: (id: string, format: 'png' | 'svg') => void
  groupSelection: () => void
  focusGroup: (id: string) => void
  ungroup: (id: string) => void
  tidy: () => void
  fitAll: () => void
  resetZoom: () => void
  undo: () => void
  redo: () => void
  showShortcuts: () => void
}

/** The store facts the registry gates on — extracted by the caller. */
export interface PaletteSnapshot {
  boards: { id: string; type: BoardType; title: string; agentSessionId?: string }[]
  groups: { id: string; name: string }[]
  selectedIds: string[]
  canUndo: boolean
  canRedo: boolean
}

const TYPE_LABEL: Record<BoardType, string> = {
  terminal: 'terminal',
  browser: 'browser',
  planning: 'planning'
}

export function buildCommands(snap: PaletteSnapshot, verbs: PaletteVerbs): PaletteCommand[] {
  const out: PaletteCommand[] = []
  const selected =
    snap.selectedIds.length === 1
      ? snap.boards.find((b) => b.id === snap.selectedIds[0])
      : undefined

  // ── Boards ──
  for (const type of ['terminal', 'browser', 'planning'] as const) {
    out.push({
      id: `new-${type}`,
      section: 'Boards',
      title: `New ${TYPE_LABEL[type]} board`,
      keywords: 'create add board',
      glyph: '+',
      run: () => verbs.newBoard(type)
    })
  }
  for (const b of snap.boards) {
    out.push({
      id: `goto-${b.id}`,
      section: 'Boards',
      title: `Go to board: ${b.title || 'untitled'}`,
      keywords: `navigate jump focus ${TYPE_LABEL[b.type]}`,
      glyph: { board: b.type },
      run: () => verbs.goToBoard(b.id)
    })
  }

  // ── Selected board (single selection only; type rows gate further) ──
  if (selected) {
    const id = selected.id
    out.push(
      {
        id: 'rename-board',
        section: 'Selected board',
        title: 'Rename board',
        keywords: 'title edit',
        glyph: '✎',
        chips: ['F2'],
        run: () => verbs.renameBoard(id)
      },
      {
        id: 'duplicate-board',
        section: 'Selected board',
        title: 'Duplicate board',
        keywords: 'copy clone',
        glyph: '⧉',
        run: () => verbs.duplicateBoard(id)
      },
      {
        id: 'fullview-board',
        section: 'Selected board',
        title: 'Open full view',
        keywords: 'maximize expand zoom',
        glyph: '⤢',
        run: () => verbs.openFullView(id)
      },
      {
        id: 'delete-board',
        section: 'Selected board',
        title: 'Delete board',
        keywords: 'remove close',
        glyph: '✕',
        chips: ['Del'],
        run: () => verbs.deleteBoard(id)
      }
    )
    if (selected.type === 'terminal') {
      if (selected.agentSessionId) {
        out.push({
          id: 'restart-resume',
          section: 'Selected board',
          title: 'Restart terminal: resume session',
          keywords: 'agent claude continue',
          glyph: '↻',
          run: () => verbs.restartTerminal(id, 'resume')
        })
      }
      out.push({
        id: 'restart-new',
        section: 'Selected board',
        title: 'Restart terminal: new session',
        keywords: 'agent respawn shell',
        glyph: '↻',
        run: () => verbs.restartTerminal(id, 'new')
      })
    }
    if (selected.type === 'planning') {
      out.push(
        {
          id: 'export-png',
          section: 'Selected board',
          title: 'Export planning board as PNG',
          keywords: 'save image download whiteboard',
          glyph: '⇣',
          run: () => verbs.exportPlanning(id, 'png')
        },
        {
          id: 'export-svg',
          section: 'Selected board',
          title: 'Export planning board as SVG',
          keywords: 'save vector download whiteboard',
          glyph: '⇣',
          run: () => verbs.exportPlanning(id, 'svg')
        }
      )
    }
  }

  // ── Groups ──
  if (snap.selectedIds.length >= 2) {
    out.push({
      id: 'group-selection',
      section: 'Groups',
      title: 'Group selected boards',
      keywords: 'name cluster',
      glyph: '⬚',
      chips: ['Ctrl', 'G'],
      run: () => verbs.groupSelection()
    })
  }
  for (const g of snap.groups) {
    out.push({
      id: `focus-group-${g.id}`,
      section: 'Groups',
      title: `Focus group: ${g.name}`,
      keywords: 'zoom jump navigate',
      glyph: '◉',
      chips: ['F'],
      run: () => verbs.focusGroup(g.id)
    })
  }
  for (const g of snap.groups) {
    out.push({
      id: `ungroup-${g.id}`,
      section: 'Groups',
      title: `Ungroup: ${g.name}`,
      keywords: 'remove dissolve',
      glyph: '⬚',
      run: () => verbs.ungroup(g.id)
    })
  }

  // ── Canvas ──
  out.push(
    {
      id: 'tidy',
      section: 'Canvas',
      title: 'Tidy boards',
      keywords: 'arrange layout pack organize',
      glyph: '⊟',
      chips: ['T'],
      run: () => verbs.tidy()
    },
    {
      id: 'fit',
      section: 'Canvas',
      title: 'Fit all boards',
      keywords: 'camera zoom frame view',
      glyph: '⤢',
      chips: ['1'],
      run: () => verbs.fitAll()
    },
    {
      id: 'reset-zoom',
      section: 'Canvas',
      title: 'Reset zoom to 100%',
      keywords: 'camera recenter actual size',
      glyph: '◎',
      chips: ['0'],
      run: () => verbs.resetZoom()
    }
  )

  // ── Edit (hidden on empty rails — a no-op verb teaches nothing) ──
  if (snap.canUndo) {
    out.push({
      id: 'undo',
      section: 'Edit',
      title: 'Undo',
      keywords: 'revert back',
      glyph: '↶',
      chips: ['Ctrl', 'Z'],
      run: () => verbs.undo()
    })
  }
  if (snap.canRedo) {
    out.push({
      id: 'redo',
      section: 'Edit',
      title: 'Redo',
      keywords: 'repeat forward',
      glyph: '↷',
      chips: ['Ctrl', 'Shift', 'Z'],
      run: () => verbs.redo()
    })
  }

  // ── Help ──
  out.push({
    id: 'shortcuts',
    section: 'Help',
    title: 'Keyboard shortcuts',
    keywords: 'help keys hotkeys bindings cheatsheet',
    glyph: '?',
    chips: ['?'],
    run: () => verbs.showShortcuts()
  })

  return out
}

/** A read-only row in the `?` shortcuts view. Empty `chips` renders label-only. */
export interface ShortcutRow {
  section: string
  label: string
  chips: string[]
}

/**
 * The full shortcut sheet — INCLUDING bindings that are not palette verbs. `·`
 * renders as a plain separator between chip alternatives. Sources: the canvas keymap
 * (`resolveCanvasKeyAction` — drift-guarded), BoardFrame F2, React Flow Del,
 * terminal Shift+Enter (LF), the planning keymap (`usePlanningKeyboard`/`tools.ts`).
 */
export const SHORTCUT_ROWS: ShortcutRow[] = [
  { section: 'Canvas', label: 'Command palette', chips: ['Ctrl', 'K'] },
  { section: 'Canvas', label: 'Keyboard shortcuts', chips: ['?'] },
  { section: 'Canvas', label: 'Fit all boards', chips: ['1'] },
  { section: 'Canvas', label: 'Reset zoom to 100%', chips: ['0'] },
  { section: 'Canvas', label: 'Tidy boards', chips: ['T'] },
  { section: 'Canvas', label: 'Focus group', chips: ['F'] },
  { section: 'Canvas', label: 'Group selected boards', chips: ['Ctrl', 'G'] },
  { section: 'Canvas', label: 'Undo', chips: ['Ctrl', 'Z'] },
  { section: 'Canvas', label: 'Redo', chips: ['Ctrl', 'Shift', 'Z', '·', 'Ctrl', 'Y'] },
  { section: 'Canvas', label: 'Delete selected', chips: ['Del'] },
  { section: 'Canvas', label: 'Clear selection / exit full view', chips: ['Esc'] },
  { section: 'Canvas', label: 'Disable snapping while dragging', chips: ['hold Ctrl'] },
  { section: 'Canvas', label: 'Toggle diagnostics', chips: ['Ctrl', 'Shift', 'D'] },
  { section: 'Boards', label: 'Rename board', chips: ['F2', '·', 'double-click title'] },
  { section: 'Boards', label: 'Focus board', chips: ['double-click'] },
  {
    section: 'Boards',
    label: 'Multi-select boards',
    chips: ['Shift', 'drag', '·', 'Ctrl', 'click']
  },
  { section: 'Terminal', label: 'Newline without submitting', chips: ['Shift', 'Enter'] },
  {
    section: 'Terminal',
    label: 'Ctrl+K in a focused terminal goes to the agent, not the palette',
    chips: []
  },
  {
    section: 'Planning',
    label: 'Tools: select · note · checklist · arrow · pen · erase',
    chips: ['S', 'N', 'C', 'A', 'P', 'E']
  },
  { section: 'Planning', label: 'Nudge selected elements', chips: ['←↑↓→', 'Shift', '10px'] },
  {
    section: 'Planning',
    label: 'Group / ungroup elements',
    chips: ['Ctrl', 'G', '·', 'Ctrl', 'Shift', 'G']
  },
  { section: 'Planning', label: 'Element context menu', chips: ['Shift', 'F10'] },
  { section: 'Planning', label: 'Delete elements', chips: ['Del'] }
]

/** Per-platform chip display: Ctrl→⌘ on mac; Shift always compacts to ⇧. */
export function displayChip(chip: string, isMac: boolean): string {
  if (chip === 'Ctrl') return isMac ? '⌘' : 'Ctrl'
  if (chip === 'Shift') return '⇧'
  return chip
}
