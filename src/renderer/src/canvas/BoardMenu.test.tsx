// @vitest-environment jsdom
/**
 * Spatial I2 — the ⋯ menu's "Make main board" row (main + sidebar). It is the FIRST row, hands
 * THIS board's id to BoardActions.makeMain (the shared tidy engine with `primary`) and closes the
 * menu; it is absent for a terminal docked in a swarm board (no canvas rect to arrange) and when
 * no BoardActions provider is mounted.
 *
 * globals: false — import vitest helpers explicitly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BoardMenu } from './BoardMenu'
import { BoardActionsContext, type BoardActions } from './boardActions'
import { useCanvasStore } from '../store/canvasStore'
import type { Board } from '../lib/boardSchema'

afterEach(cleanup)

const SEED_BOARDS = [
  { id: 'web', type: 'browser', x: 0, y: 0, w: 640, h: 420, title: 'App' },
  { id: 'plan', type: 'planning', x: 700, y: 0, w: 400, h: 300, title: 'Plan', elements: [] },
  { id: 'sw', type: 'swarm', x: 0, y: 500, w: 600, h: 400, title: 'Swarm' },
  { id: 'dock', type: 'terminal', x: 0, y: 0, w: 300, h: 200, title: 'Worker', dockedIn: 'sw' }
] as unknown as Board[]

function makeActs(): BoardActions {
  return {
    requestFullView: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    pushPreviewTo: vi.fn(),
    startConnect: vi.fn(),
    addToGroup: vi.fn(),
    removeFromGroup: vi.fn(),
    removeFromAllGroups: vi.fn(),
    focusBoard: vi.fn(),
    makeMain: vi.fn()
  }
}

function openMenu(boardId: string, acts: BoardActions | null): void {
  const menu = (
    <BoardMenu boardId={boardId} onFull={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />
  )
  render(
    acts ? <BoardActionsContext.Provider value={acts}>{menu}</BoardActionsContext.Provider> : menu
  )
  fireEvent.click(screen.getByTitle('More'))
}

const rows = (): string[] =>
  screen.getAllByRole('menuitem').map((el) => el.textContent?.replace('sidebar = rest', '') ?? '')

describe('BoardMenu — "Make main board" (spatial I2, main + sidebar)', () => {
  beforeEach(() => useCanvasStore.setState({ boards: SEED_BOARDS, groups: [] }))

  it('is the first row, with the quiet "sidebar = rest" hint', () => {
    openMenu('web', makeActs())
    expect(rows()).toEqual(['Make main board', 'Full view', 'Duplicate', 'Delete'])
    const row = screen.getByRole('menuitem', { name: /Make main board/ })
    expect(row.querySelector('.board-menu-hint')?.textContent).toBe('sidebar = rest')
  })

  it("hands THIS board's id to makeMain and closes the menu", () => {
    const acts = makeActs()
    openMenu('web', acts)
    fireEvent.click(screen.getByRole('menuitem', { name: /Make main board/ }))
    expect(acts.makeMain).toHaveBeenCalledTimes(1)
    expect(acts.makeMain).toHaveBeenCalledWith('web')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('is offered for any board on the canvas (a swarm board itself included)', () => {
    openMenu('sw', makeActs())
    expect(rows()[0]).toBe('Make main board')
  })

  it('is absent for a terminal docked in a swarm board', () => {
    openMenu('dock', makeActs())
    expect(rows()).toEqual(['Full view', 'Duplicate', 'Delete'])
  })

  it('is absent for an unknown board and without a BoardActions provider', () => {
    openMenu('ghost', makeActs())
    expect(rows()).not.toContain('Make main board')
    cleanup()
    openMenu('web', null)
    expect(rows()).not.toContain('Make main board')
  })
})
