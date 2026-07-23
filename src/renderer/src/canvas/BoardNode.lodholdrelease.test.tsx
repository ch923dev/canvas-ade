/**
 * BoardNode — resize-drag hold releases when a zoom-out unmounts NodeResizer (T1a′).
 *
 * Regression guard for the round-2 review finding: BoardNode's `NodeResizer` mounts
 * only in the `!lod` branch, so a zoom-out past LOD_ZOOM DURING a live handle-drag
 * unmounts the resizer without firing `onResizeEnd`. The drag flag in boardResizeDrag
 * would then stay set forever, wedging the terminal's PTY resize (the grid keeps
 * refitting visually, the PTY never hears about it) until the board is recreated.
 *
 * The fix keys BoardNode's cleanup effect on `lod`
 * (`useEffect(() => { if (lod) return undefined; return () => endBoardResizeDrag(id) }, [lod, id])`),
 * so the previously-registered cleanup runs exactly when `lod` flips false → true.
 * This test drives a REAL lod flip through BoardNode's own `useStore(isLod(...))`
 * wiring and asserts the flag clears — if a future refactor drops `lod` from the
 * effect's dependency array, the flag stays held and this test fails. A pure
 * boardResizeDrag registry test cannot catch that; the wiring is the subject here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { BoardFlowNode } from './BoardNode'
import { beginBoardResizeDrag, endBoardResizeDrag, isBoardResizeDragging } from './boardResizeDrag'

// Camera zoom fed to BoardNode's `useStore((s) => isLod(s.transform[2]))`. Mutable so the
// test can cross LOD_ZOOM (0.4) between renders; the real isLod runs inside the selector.
let zoom = 1

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, zoom] }),
    NodeResizer: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
  }
})

// Terminal content is irrelevant here — stub it out so no spawn machinery runs. The board
// deliberately stays a terminal: terminal boards keep full chrome mounted across the LOD
// boundary, so only the NodeResizer subtree unmounts on the flip (the exact bug shape).
vi.mock('./boards/TerminalBoard', () => ({
  TerminalBoard: (): ReactElement => <div data-testid="terminal-stub" />
}))
vi.mock('./boards/BrowserBoard', () => ({
  BrowserBoard: (): ReactElement => <div />
}))
vi.mock('./boards/PlanningBoard', () => ({
  PlanningBoard: (): ReactElement => <div />
}))

afterEach(() => {
  cleanup()
  zoom = 1
  endBoardResizeDrag('board-lod') // defensive: never leak a set flag across tests
})

const TERMINAL_BOARD: BoardFlowNode['data']['board'] = {
  id: 'board-lod',
  type: 'terminal',
  x: 0,
  y: 0,
  w: 420,
  h: 340,
  title: 'Dev agent'
}

function makeNodeProps(board: BoardFlowNode['data']['board']): NodeProps<BoardFlowNode> {
  return {
    id: board.id,
    data: { board },
    selected: false,
    type: 'board',
    dragging: false,
    isConnectable: false,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    width: board.w,
    height: board.h
  } as NodeProps<BoardFlowNode>
}

describe('BoardNode — resize-drag hold releases on LOD-flip unmount (T1a′)', () => {
  it('clears the drag flag when a zoom-out past LOD_ZOOM unmounts NodeResizer mid-drag', async () => {
    const { BoardNode } = await import('./BoardNode')

    zoom = 1 // above LOD_ZOOM → full chrome, NodeResizer mounted
    let rerender!: (ui: ReactElement) => void
    await act(async () => {
      ;({ rerender } = render(<BoardNode {...makeNodeProps(TERMINAL_BOARD)} />))
    })

    // A handle-drag is live (NodeResizer.onResizeStart marks it; called directly here since
    // the resizer is stubbed to null).
    beginBoardResizeDrag('board-lod')
    expect(isBoardResizeDragging('board-lod')).toBe(true)

    // Zoom out past the LOD threshold WITHOUT an onResizeEnd — the `!lod &&` gate drops the
    // resizer. The lod-keyed cleanup must fire endBoardResizeDrag as the effect re-runs.
    zoom = 0.2
    await act(async () => {
      rerender(<BoardNode {...makeNodeProps(TERMINAL_BOARD)} />)
    })

    expect(isBoardResizeDragging('board-lod')).toBe(false)
  })

  it('a drag that stays above LOD_ZOOM keeps the flag until its own release', async () => {
    const { BoardNode } = await import('./BoardNode')

    zoom = 1
    let rerender!: (ui: ReactElement) => void
    await act(async () => {
      ;({ rerender } = render(<BoardNode {...makeNodeProps(TERMINAL_BOARD)} />))
    })

    beginBoardResizeDrag('board-lod')
    // A re-render that does NOT cross the LOD boundary must not release the hold — only a real
    // onResizeEnd (or a genuine unmount) does.
    await act(async () => {
      rerender(<BoardNode {...makeNodeProps(TERMINAL_BOARD)} />)
    })
    expect(isBoardResizeDragging('board-lod')).toBe(true)

    endBoardResizeDrag('board-lod')
    expect(isBoardResizeDragging('board-lod')).toBe(false)
  })
})
