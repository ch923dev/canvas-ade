// @vitest-environment jsdom
/**
 * SendToBoardPanel (cross-board element transfer, Phase 2 picker) + the context-menu entry
 * that opens it. The panel is the pure chooser — title (group-expanded count), Copy/Move
 * (default Move), the OTHER-planning-board list, and the "+ New planning board" sentinel —
 * routing the choice through `onPick({ target, mode })`. These pin the contract the host
 * (useSendToBoard) relies on; the routing + placement live in useSendToBoard.test.tsx.
 *
 * globals: false — import every vitest/testing-library helper explicitly.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SendToBoardPanel, NEW_PLANNING_BOARD, type SendTarget } from './SendToBoardPanel'
import { buildContextMenuEntries, type ContextMenuDeps } from './contextMenuEntries'
import { makeNote } from './elements'
import type { PlanningElement } from '../../../lib/boardSchema'

afterEach(cleanup)

const TARGETS: SendTarget[] = [
  { id: 'p2', title: 'Sprint Plan' },
  { id: 'p3', title: 'Architecture' }
]

function renderPanel(over?: Partial<Parameters<typeof SendToBoardPanel>[0]>): {
  onPick: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
} {
  const onPick = vi.fn()
  const onClose = vi.fn()
  render(
    <SendToBoardPanel
      anchor={{ x: 100, y: 100 }}
      count={3}
      targets={TARGETS}
      onPick={onPick}
      onClose={onClose}
      {...over}
    />
  )
  return { onPick, onClose }
}

describe('SendToBoardPanel', () => {
  it('titles with the group-expanded count + lists the other boards and the New row', () => {
    renderPanel()
    expect(screen.getByText(/Send 3 items to/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sprint Plan/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Architecture/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /New planning board/ })).toBeTruthy()
  })

  it('pluralizes the count (1 → "item", N → "items")', () => {
    renderPanel({ count: 1 })
    expect(screen.getByText(/Send 1 item to/)).toBeTruthy()
    // Guard against "1 items".
    expect(screen.queryByText(/Send 1 items to/)).toBeNull()
  })

  it('defaults to Move (the mock); Copy is offered but unchecked', () => {
    renderPanel()
    expect((screen.getByRole('radio', { name: 'Move' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'Copy' }) as HTMLInputElement).checked).toBe(false)
  })

  it('picks an existing board with the default Move mode', () => {
    const { onPick } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Sprint Plan/ }))
    expect(onPick).toHaveBeenCalledWith({ target: 'p2', mode: 'move' })
  })

  it('honours the Copy toggle in the onPick payload', () => {
    const { onPick } = renderPanel()
    fireEvent.click(screen.getByRole('radio', { name: 'Copy' }))
    fireEvent.click(screen.getByRole('button', { name: /Architecture/ }))
    expect(onPick).toHaveBeenCalledWith({ target: 'p3', mode: 'copy' })
  })

  it('picks the "+ New planning board" sentinel', () => {
    const { onPick } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /New planning board/ }))
    expect(onPick).toHaveBeenCalledWith({ target: NEW_PLANNING_BOARD, mode: 'move' })
  })

  it('renders the New row even when there are no other boards (it is always a valid target)', () => {
    const { onPick } = renderPanel({ targets: [] })
    expect(screen.queryByRole('button', { name: /Sprint Plan/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /New planning board/ }))
    expect(onPick).toHaveBeenCalledWith({ target: NEW_PLANNING_BOARD, mode: 'move' })
  })

  it('dismisses on Escape (usePickerDismiss)', () => {
    const { onClose } = renderPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── The context-menu entry that opens the picker (contextMenuEntries) ────────────
function deps(over: Partial<ContextMenuDeps>): ContextMenuDeps {
  return {
    elements: [],
    sel: new Set(),
    wb: { w: 400, h: 300 },
    measured: new Map(),
    beginChange: vi.fn(),
    commit: vi.fn(),
    clearSel: vi.fn(),
    setSelectedIds: vi.fn(),
    newId: () => 'nid',
    onOpenSendTo: vi.fn(),
    ...over
  }
}

describe('contextMenuEntries — "Send to board…"', () => {
  it('adds an enabled entry right after Duplicate (the picker is always reachable)', () => {
    const note = makeNote('n1', { x: 0, y: 0 }, 0)
    const entries = buildContextMenuEntries(deps({ elements: [note], sel: new Set(['n1']) }))
    const ids = entries.map((e) => e.id)
    expect(ids).toContain('send-to-board')
    expect(ids.indexOf('send-to-board')).toBe(ids.indexOf('duplicate') + 1)
    const entry = entries.find((e) => e.id === 'send-to-board')
    expect(entry?.kind === 'action' && entry.disabled).toBeFalsy()
  })

  it('captures the GROUP-EXPANDED selection when invoked', () => {
    // Two notes sharing a group; selecting one must send BOTH (a group travels together).
    const a: PlanningElement = { ...makeNote('a', { x: 0, y: 0 }, 0), groupId: 'g1' }
    const b: PlanningElement = { ...makeNote('b', { x: 40, y: 40 }, 1), groupId: 'g1' }
    const onOpenSendTo = vi.fn()
    const entries = buildContextMenuEntries(
      deps({ elements: [a, b], sel: new Set(['a']), onOpenSendTo })
    )
    const entry = entries.find((e) => e.id === 'send-to-board')
    if (entry?.kind !== 'action') throw new Error('send-to-board entry missing')
    entry.onSelect()
    expect(onOpenSendTo).toHaveBeenCalledTimes(1)
    expect([...onOpenSendTo.mock.calls[0][0]].sort()).toEqual(['a', 'b'])
  })
})
