/**
 * BoardNode — per-board ErrorBoundary isolation test.
 *
 * Goal: when a board's content slot throws during render, the ErrorBoundary
 * shows a compact fallback card while the rest of the canvas tree (and the
 * surrounding node container) survives.
 *
 * Architecture note (informed by reading BoardNode):
 * In the non-LOD path BoardNode renders:
 *   - EdgeAnchors + NodeResizer  (outside the portal; mocked to null here)
 *   - <div ref={anchorRef} />    (outside the portal; always present)
 *   - createPortal(subtree, contentHost)
 *
 * `subtree` contains:
 *   <BoardFullViewContext.Provider>
 *     <div onMouseEnter/Leave>    ← hover div; outside the inner ErrorBoundary
 *       <Suspense>
 *         [ErrorBoundary wraps the per-type dispatch]
 *         {board.type === 'terminal' && <TerminalBoard />}
 *         ...
 *       </Suspense>
 *     </div>
 *   </BoardFullViewContext.Provider>
 *
 * The ErrorBoundary wraps the per-type content dispatch only (not Suspense / hover
 * div / context provider). The anchorRef div (outside the portal) is the most
 * stable "frame still alive" witness; we assert its presence alongside the fallback.
 *
 * Strategy:
 * - Mock @xyflow/react so NodeResizer / Handle / useStore work in jsdom.
 * - Mock the lazy TerminalBoard to throw during render.
 * - Mock BrowserBoard / PlanningBoard as simple no-op stubs.
 * - Render BoardNode with a terminal board → content throws.
 * - Assert: fallback text visible AND the node container div is still mounted.
 * - Render BoardNode with a browser board → content renders normally.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { BoardFlowNode } from './BoardNode'

// ── Mocks (hoisted by vitest before module evaluation) ───────────────────────

// @xyflow/react: stub the pieces BoardNode uses.
// - useStore: returns zoom 1 (non-LOD) so the full-chrome path runs.
// - NodeResizer / Handle / Position: passthrough stubs (no RF internal store).
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    useStore: (selector: (s: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
    NodeResizer: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
  }
})

// TerminalBoard throws — this is the content-slot throw we want the boundary to catch.
vi.mock('./boards/TerminalBoard', () => ({
  TerminalBoard: (): never => {
    throw new Error('TerminalBoard kaboom')
  }
}))

// BrowserBoard and PlanningBoard are simple stubs (not the subject of this test).
vi.mock('./boards/BrowserBoard', () => ({
  BrowserBoard: (): ReactElement => <div data-testid="browser-content">browser-ok</div>
}))
vi.mock('./boards/PlanningBoard', () => ({
  PlanningBoard: (): ReactElement => <div>planning-ok</div>
}))

// ── Harness ──────────────────────────────────────────────────────────────────

afterEach(cleanup)

/** Minimal terminal board fixture. */
const TERMINAL_BOARD: BoardFlowNode['data']['board'] = {
  id: 'board-t1',
  type: 'terminal',
  x: 0,
  y: 0,
  w: 420,
  h: 340,
  title: 'Dev agent'
}

const BROWSER_BOARD: BoardFlowNode['data']['board'] = {
  id: 'board-b1',
  type: 'browser',
  x: 0,
  y: 0,
  w: 700,
  h: 500,
  title: 'Preview',
  url: 'http://localhost:5173',
  viewport: 'desktop'
}

/**
 * Build the NodeProps<BoardFlowNode> shape that BoardNode expects.
 * Only `data` and `selected` are read by the component at the paths we exercise.
 */
function makeNodeProps(
  board: BoardFlowNode['data']['board'],
  selected = false
): NodeProps<BoardFlowNode> {
  return {
    id: board.id,
    data: { board },
    selected,
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BoardNode — per-board ErrorBoundary', () => {
  it('shows a fallback card when the content slot throws, and keeps the node container mounted', async () => {
    const { BoardNode } = await import('./BoardNode')

    // Suppress React error boundary console.error noise in test output.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    let container!: HTMLElement
    await act(async () => {
      ;({ container } = render(<BoardNode {...makeNodeProps(TERMINAL_BOARD)} />))
    })

    consoleError.mockRestore()

    // 1. The ErrorBoundary fallback text is in the document.
    expect(screen.getByText(/this board failed to render/i)).toBeTruthy()

    // 2. The surrounding node container (anchorRef div, outside the portal) is still
    //    mounted — the board's frame is alive even though its content slot threw.
    //    This is the "rest of the canvas survives" witness at the BoardNode level.
    const anchorDiv = container.querySelector('div[style*="position: absolute; inset: 0px"]')
    expect(anchorDiv).toBeTruthy()
  })

  it('renders the content normally when the content slot does not throw', async () => {
    const { BoardNode } = await import('./BoardNode')

    await act(async () => {
      render(<BoardNode {...makeNodeProps(BROWSER_BOARD)} />)
    })

    // The browser stub renders its content inside the boundary (no throw).
    expect(screen.getByTestId('browser-content')).toBeTruthy()
    expect(screen.getByText('browser-ok')).toBeTruthy()
  })
})
