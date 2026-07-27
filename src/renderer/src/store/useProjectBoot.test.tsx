// @vitest-environment jsdom
/**
 * `useProjectBoot` — the boot auto-reopen door (audit R4).
 *
 * This is the door the audit actually indicted: of the three production opens, boot was the one
 * that took NO switch lock, so a click on a recent while `project.current()` was still resolving
 * ran two concurrent opens (#BUG-009). Two facts have to stay true, and neither was testable while
 * this lived inside `App.tsx`:
 *   • boot goes through `openProject` — which is where the lock, the loading state and the
 *     rejection routing live (proved in `openProject.test.ts`). Routing is therefore the whole
 *     assertion; re-proving the lock here would only test the mock.
 *   • it fires exactly ONCE per mount. A boot that re-opened on every re-render would restart the
 *     project under the user, and `[]` deps are easy to lose in a refactor.
 *
 * The e2e suite cannot cover any of this: under CANVAS_E2E the hook takes the harness branch and
 * never opens a project at all. This file plus the manual dev check ARE boot's coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'

const { openProject, isE2E, setState } = vi.hoisted(() => ({
  openProject: vi.fn(async (_load: () => Promise<unknown>) => 'opened' as const),
  isE2E: vi.fn(() => false),
  setState: vi.fn()
}))

vi.mock('./openProject', () => ({ openProject }))
vi.mock('../smoke/e2eRegistry', () => ({ isE2E }))
vi.mock('./canvasStore', () => ({ useCanvasStore: { setState } }))

const { useProjectBoot } = await import('./useProjectBoot')

function Boot(): ReactElement {
  useProjectBoot()
  return <div />
}

const current = vi.fn(async () => ({ ok: true, dir: 'C:/p', name: 'p', doc: {} }))

beforeEach(() => {
  cleanup()
  openProject.mockClear()
  setState.mockClear()
  current.mockClear()
  isE2E.mockReturnValue(false)
  ;(globalThis as unknown as { window: Window & { api: unknown } }).window.api = {
    project: { current }
  } as never
})

describe('useProjectBoot', () => {
  it('opens the most-recent project through the shared primitive', async () => {
    render(<Boot />)

    expect(openProject).toHaveBeenCalledTimes(1)
    // The thunk is what asks MAIN — invoke it to prove boot reaches for `project.current` and not,
    // say, a hand-rolled open that would bypass the primitive's lock.
    await openProject.mock.calls[0][0]()
    expect(current).toHaveBeenCalledTimes(1)
    expect(setState).not.toHaveBeenCalled()
  })

  it('fires once per mount, not once per render', () => {
    const { rerender } = render(<Boot />)
    rerender(<Boot />)
    rerender(<Boot />)

    expect(openProject).toHaveBeenCalledTimes(1)
  })

  it('under CANVAS_E2E it seeds the open status and never touches the disk', () => {
    isE2E.mockReturnValue(true)

    render(<Boot />)

    expect(openProject).not.toHaveBeenCalled()
    expect(setState).toHaveBeenCalledWith({
      project: { dir: null, name: 'e2e', status: 'open' }
    })
  })
})
