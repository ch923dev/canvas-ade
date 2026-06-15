import { describe, expect, it, vi } from 'vitest'
import {
  buildCommands,
  displayChip,
  SECTION_ORDER,
  SHORTCUT_ROWS,
  type PaletteSnapshot,
  type PaletteVerbs
} from './commandRegistry'
import {
  resolveCanvasKeyAction,
  type CanvasKeyAction,
  type KeyChord
} from '../hooks/useCanvasKeybindings'

function verbsMock(): PaletteVerbs {
  return {
    newBoard: vi.fn(),
    goToBoard: vi.fn(),
    renameBoard: vi.fn(),
    duplicateBoard: vi.fn(),
    deleteBoard: vi.fn(),
    openFullView: vi.fn(),
    restartTerminal: vi.fn(),
    exportPlanning: vi.fn(),
    groupSelection: vi.fn(),
    focusGroup: vi.fn(),
    ungroup: vi.fn(),
    tidy: vi.fn(),
    fitAll: vi.fn(),
    resetZoom: vi.fn(),
    toggleMinimap: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    showShortcuts: vi.fn()
  }
}

function snap(over: Partial<PaletteSnapshot> = {}): PaletteSnapshot {
  return { boards: [], groups: [], selectedIds: [], canUndo: false, canRedo: false, ...over }
}

const T = { id: 't1', type: 'terminal', title: 'agent-1' } as const
const P = { id: 'p1', type: 'planning', title: 'plan' } as const
const B = { id: 'b1', type: 'browser', title: 'preview' } as const

describe('buildCommands — visibility matrix', () => {
  it('baseline: creates + canvas + help only (no selection, no groups, empty rails)', () => {
    const cmds = buildCommands(snap(), verbsMock())
    const ids = cmds.map((c) => c.id)
    expect(ids).toEqual([
      'new-terminal',
      'new-browser',
      'new-planning',
      'new-command',
      'tidy',
      'fit',
      'reset-zoom',
      'toggle-minimap',
      'shortcuts'
    ])
  })

  it('one goto row per board, carrying the board-type glyph', () => {
    const cmds = buildCommands(snap({ boards: [T, P, B] }), verbsMock())
    const gotos = cmds.filter((c) => c.id.startsWith('goto-'))
    expect(gotos.map((c) => c.title)).toEqual([
      'Go to board: agent-1',
      'Go to board: plan',
      'Go to board: preview'
    ])
    expect(gotos[0].glyph).toEqual({ board: 'terminal' })
  })

  it('untitled boards fall back in the goto title', () => {
    const cmds = buildCommands(snap({ boards: [{ ...T, title: '' }] }), verbsMock())
    expect(cmds.find((c) => c.id === 'goto-t1')?.title).toBe('Go to board: untitled')
  })

  it('selected-board rows require a SINGLE selection', () => {
    const none = buildCommands(snap({ boards: [T, P] }), verbsMock())
    const multi = buildCommands(snap({ boards: [T, P], selectedIds: ['t1', 'p1'] }), verbsMock())
    const single = buildCommands(snap({ boards: [T, P], selectedIds: ['t1'] }), verbsMock())
    expect(none.some((c) => c.section === 'Selected board')).toBe(false)
    expect(multi.some((c) => c.section === 'Selected board')).toBe(false)
    expect(single.some((c) => c.id === 'rename-board')).toBe(true)
    expect(single.some((c) => c.id === 'delete-board')).toBe(true)
  })

  it('terminal restart rows: new always (when terminal selected), resume only with agentSessionId', () => {
    const noSession = buildCommands(snap({ boards: [T], selectedIds: ['t1'] }), verbsMock())
    expect(noSession.some((c) => c.id === 'restart-new')).toBe(true)
    expect(noSession.some((c) => c.id === 'restart-resume')).toBe(false)
    const withSession = buildCommands(
      snap({ boards: [{ ...T, agentSessionId: 's-1' }], selectedIds: ['t1'] }),
      verbsMock()
    )
    expect(withSession.some((c) => c.id === 'restart-resume')).toBe(true)
  })

  it('export rows only for a selected planning board; restart absent', () => {
    const cmds = buildCommands(snap({ boards: [P], selectedIds: ['p1'] }), verbsMock())
    expect(cmds.some((c) => c.id === 'export-png')).toBe(true)
    expect(cmds.some((c) => c.id === 'export-svg')).toBe(true)
    expect(cmds.some((c) => c.id === 'restart-new')).toBe(false)
  })

  it('group-selection requires >=2 selected; per-group focus/ungroup rows from groups', () => {
    const g = { id: 'g1', name: 'feature-x' }
    const one = buildCommands(
      snap({ boards: [T, P], selectedIds: ['t1'], groups: [g] }),
      verbsMock()
    )
    expect(one.some((c) => c.id === 'group-selection')).toBe(false)
    expect(one.some((c) => c.id === 'focus-group-g1')).toBe(true)
    expect(one.some((c) => c.id === 'ungroup-g1')).toBe(true)
    const two = buildCommands(snap({ boards: [T, P], selectedIds: ['t1', 'p1'] }), verbsMock())
    expect(two.some((c) => c.id === 'group-selection')).toBe(true)
  })

  it('undo/redo rows track the rails', () => {
    const cmds = buildCommands(snap({ canUndo: true }), verbsMock())
    expect(cmds.some((c) => c.id === 'undo')).toBe(true)
    expect(cmds.some((c) => c.id === 'redo')).toBe(false)
  })

  it('every command sits in a known section', () => {
    const cmds = buildCommands(
      snap({
        boards: [{ ...T, agentSessionId: 's' }, P, B],
        selectedIds: ['t1'],
        groups: [{ id: 'g1', name: 'g' }],
        canUndo: true,
        canRedo: true
      }),
      verbsMock()
    )
    for (const c of cmds) expect(SECTION_ORDER).toContain(c.section)
  })

  it('runs route to the right verb with the right args', () => {
    const verbs = verbsMock()
    const cmds = buildCommands(
      snap({ boards: [{ ...T, agentSessionId: 's' }], selectedIds: ['t1'] }),
      verbs
    )
    cmds.find((c) => c.id === 'new-planning')!.run()
    expect(verbs.newBoard).toHaveBeenCalledWith('planning')
    cmds.find((c) => c.id === 'goto-t1')!.run()
    expect(verbs.goToBoard).toHaveBeenCalledWith('t1')
    cmds.find((c) => c.id === 'restart-resume')!.run()
    expect(verbs.restartTerminal).toHaveBeenCalledWith('t1', 'resume')
  })
})

describe('chip ↔ resolveCanvasKeyAction drift guard', () => {
  /** Commands whose chips claim a live canvas chord → the resolver kind they must hit.
   *  bareKeyAllowed mirrors each chord's real guard (bare keys need it; mods don't). */
  const CLAIMS: { id: string; chord: KeyChord; kind: CanvasKeyAction['kind'] }[] = [
    { id: 'tidy', chord: key('t'), kind: 'tidy' },
    { id: 'fit', chord: key('1'), kind: 'fit' },
    { id: 'reset-zoom', chord: key('0'), kind: 'reset' },
    { id: 'toggle-minimap', chord: key('m'), kind: 'toggleMinimap' },
    { id: 'group-selection', chord: key('g', { ctrlKey: true }), kind: 'group' },
    { id: 'undo', chord: key('z', { ctrlKey: true }), kind: 'undo' },
    { id: 'redo', chord: key('z', { ctrlKey: true, shiftKey: true }), kind: 'redo' }
  ]

  function key(k: string, over: Partial<KeyChord> = {}): KeyChord {
    return { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over }
  }

  it('every chip-claimed chord resolves to its command action', () => {
    const cmds = buildCommands(
      snap({ boards: [T, P], selectedIds: ['t1', 'p1'], canUndo: true, canRedo: true }),
      verbsMock()
    )
    for (const claim of CLAIMS) {
      // The command must exist and carry chips (the claim list mirrors the registry).
      const cmd = cmds.find((c) => c.id === claim.id)
      expect(cmd?.chips?.length, claim.id).toBeTruthy()
      const action = resolveCanvasKeyAction(claim.chord, {
        typing: false,
        bareKeyAllowed: true,
        boardNavAllowed: false
      })
      expect(action?.kind, claim.id).toBe(claim.kind)
    }
  })

  it('focus-group chip F resolves to focusGroup', () => {
    const cmds = buildCommands(snap({ groups: [{ id: 'g', name: 'g' }] }), verbsMock())
    expect(cmds.find((c) => c.id === 'focus-group-g')?.chips).toContain('F')
    const action = resolveCanvasKeyAction(
      { key: 'f', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
      { typing: false, bareKeyAllowed: true, boardNavAllowed: false }
    )
    expect(action?.kind).toBe('focusGroup')
  })

  /** D4-B: the board-nav rows in the ? sheet claim live chords too — feed each into the
   *  resolver (boardNavAllowed mirrors the real whitelist guard) and pin the row exists,
   *  so the sheet can never drift from the keymap. */
  const NAV_ROWS: { label: string; chord: KeyChord; kind: CanvasKeyAction['kind'] }[] = [
    { label: 'Cycle board selection', chord: key('Tab'), kind: 'cycleBoard' },
    { label: 'Cycle board selection', chord: key('Tab', { shiftKey: true }), kind: 'cycleBoard' },
    { label: 'Move selected boards', chord: key('ArrowRight'), kind: 'moveBoard' },
    {
      label: 'Move selected boards',
      chord: key('ArrowDown', { shiftKey: true }),
      kind: 'moveBoard'
    },
    {
      label: 'Resize selected boards',
      chord: key('ArrowUp', { altKey: true }),
      kind: 'resizeBoard'
    },
    { label: 'Focus board', chord: key('Enter'), kind: 'focusBoard' }
  ]

  it('every board-nav sheet row resolves to its action (D4-B drift guard)', () => {
    for (const row of NAV_ROWS) {
      expect(
        SHORTCUT_ROWS.some((r) => r.section === 'Boards' && r.label === row.label),
        row.label
      ).toBe(true)
      const action = resolveCanvasKeyAction(row.chord, {
        typing: false,
        bareKeyAllowed: true,
        boardNavAllowed: true
      })
      expect(action?.kind, row.label).toBe(row.kind)
    }
  })

  it('the D4-C minimap row is on the sheet and M resolves to toggleMinimap', () => {
    expect(
      SHORTCUT_ROWS.some(
        (r) => r.section === 'Canvas' && r.label === 'Toggle minimap' && r.chips.includes('M')
      )
    ).toBe(true)
    const action = resolveCanvasKeyAction(key('m'), {
      typing: false,
      bareKeyAllowed: true,
      boardNavAllowed: false
    })
    expect(action?.kind).toBe('toggleMinimap')
  })

  it('the A3 focus-return row is on the sheet (Esc — handled main-side, not a resolver chord)', () => {
    expect(
      SHORTCUT_ROWS.some(
        (r) => r.section === 'Boards' && /preview/i.test(r.label) && r.chips.includes('Esc')
      )
    ).toBe(true)
  })
})

describe('SHORTCUT_ROWS + displayChip', () => {
  it('rows are non-empty and label-only rows are allowed', () => {
    expect(SHORTCUT_ROWS.length).toBeGreaterThan(10)
    for (const r of SHORTCUT_ROWS) {
      expect(r.label.length).toBeGreaterThan(0)
      expect(r.section.length).toBeGreaterThan(0)
    }
  })

  it('maps Ctrl/Shift per platform', () => {
    expect(displayChip('Ctrl', false)).toBe('Ctrl')
    expect(displayChip('Ctrl', true)).toBe('⌘')
    expect(displayChip('Shift', true)).toBe('⇧')
    expect(displayChip('Shift', false)).toBe('⇧')
    expect(displayChip('F2', true)).toBe('F2')
  })
})
