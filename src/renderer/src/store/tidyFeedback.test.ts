import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { showTidyFeedback, TIDY_TOAST_ID } from './tidyFeedback'
import { useToastStore, type Toast } from './toastStore'
import { useCanvasStore } from './canvasStore'
import { useCanvasViewStore } from './canvasViewStore'
import { useCameraRequestStore } from './cameraRequestStore'
import { useRoleSignalsStore } from './roleSignalsStore'
import { useOrchestrationStore } from './orchestrationStore'
import { runTidy, type TidyRun, type TidyUnitInfo } from './spatialTidy'
import { createBoard, type Board } from '../lib/boardSchema'

/**
 * The user-facing tidy toasts (spatial C8, DESIGN W3 / W7): ONE keyed toast, replaced in place;
 * Undo only ever undoes the tidy's own step; Pages REPLACES the previous tidy's step; success is
 * silent.
 */

const term = (id: string, x = 0, y = 0): Board =>
  ({ ...createBoard('terminal', { id, x, y }) }) as Board

const unit = (name: string, why = `hero = ${name}`): TidyUnitInfo => ({
  key: name,
  name,
  scene: 'lead',
  heroIds: [],
  why,
  boardIds: []
})

const run = (extra: Partial<TidyRun>): TidyRun => ({
  ok: true,
  args: { mode: 'roles', implicit: true },
  moved: 0,
  count: 2,
  ...extra
})

const toast = (): Toast | undefined =>
  useToastStore.getState().toasts.find((t) => t.id === TIDY_TOAST_ID)
const click = (label: string): void => {
  const a = toast()?.actions?.find((x) => x.label === label)
  if (!a) throw new Error(`no "${label}" action on ${JSON.stringify(toast())}`)
  a.run()
}
const labels = (): string[] => (toast()?.actions ?? []).map((a) => a.label)

function seed(
  boards: Board[],
  groups: Array<{ id: string; name: string; boardIds: string[] }> = []
): void {
  useCanvasStore.setState({ boards, connectors: [], groups, past: [], future: [] } as never)
}

beforeEach(() => {
  useToastStore.getState().clearToasts()
  useCameraRequestStore.setState({ seq: 0, target: null })
  useCanvasViewStore.setState({ pane: { w: 1920, h: 1080 }, camera: { x: 0, y: 0, zoom: 1 } })
  useRoleSignalsStore.getState().reset()
  useOrchestrationStore.setState({ leadBoardId: null })
  seed([term('a'), term('b', 3000, 0)])
})
afterEach(() => useCanvasViewStore.setState({ pane: null, camera: null }))

describe('W7 — a roles tidy that leaves contexts off-stage', () => {
  it('names the stage why + the off-stage units (3, then +N); Show all · Undo', () => {
    useCanvasStore.getState().applyLayout([{ id: 'a', x: 50, y: 0 }]) // the tidy's own step
    showTidyFeedback(
      run({
        moved: 1,
        units: [unit('api', 'hero = lead'), unit('B'), unit('C'), unit('D'), unit('E')]
      })
    )
    expect(toast()!.message).toBe(
      'Arranged by role · hero = lead. 4 more contexts off-stage: B, C, D +1'
    )
    expect(labels()).toEqual(['Show all', 'Undo'])
  })

  it('one off-stage unit reads singular; nothing moved ⇒ no Undo', () => {
    showTidyFeedback(run({ moved: 0, units: [unit('api'), unit('web')] }))
    expect(toast()!.message).toMatch(/1 more context off-stage: web$/)
    expect(labels()).toEqual(['Show all'])
  })

  it('Undo reverts the tidy step — and ONLY while it is still the latest step', () => {
    useCanvasStore.getState().applyLayout([{ id: 'a', x: 50, y: 0 }])
    showTidyFeedback(run({ moved: 1, units: [unit('api'), unit('web')] }))
    click('Undo')
    expect(useCanvasStore.getState().boards.find((b) => b.id === 'a')!.x).toBe(0)
    expect(toast()).toBeUndefined()

    useCanvasStore.getState().applyLayout([{ id: 'a', x: 50, y: 0 }])
    showTidyFeedback(run({ moved: 1, units: [unit('api'), unit('web')] }))
    useCanvasStore.getState().applyLayout([{ id: 'b', x: 10, y: 10 }]) // a later, unrelated edit
    click('Undo')
    const st = useCanvasStore.getState()
    expect(st.boards.find((b) => b.id === 'b')!.x).toBe(10) // the later edit survives
    expect(st.boards.find((b) => b.id === 'a')!.x).toBe(50)
  })

  it('Show all frames every board; an unreadable whole canvas follows with the W3 copy', () => {
    showTidyFeedback(run({ units: [unit('api'), unit('web')] }))
    click('Show all')
    expect(useCameraRequestStore.getState().target).toMatchObject({ kind: 'rect' })
    expect(toast()).toBeUndefined() // a 2-board canvas reads fine

    seed([term('a'), term('b', 40_000, 0)])
    showTidyFeedback(run({ units: [unit('api'), unit('web')] }))
    click('Show all')
    expect(toast()!.message).toMatch(
      /^Tidied 2 boards\. They're too small to read at once \(\d+%\)\.$/
    )
  })
})

describe('W3 — a fit tidy that ends unreadable', () => {
  const unreadable = run({
    args: { mode: 'fit', implicit: false },
    count: 16,
    moved: 3,
    fitZoom: 0.234,
    readable: false
  })

  it('reports the boards + percent; Pages always, Focus a group only when a group exists', () => {
    showTidyFeedback(unreadable)
    expect(toast()!.message).toBe("Tidied 16 boards. They're too small to read at once (23%).")
    expect(labels()).toEqual(['Pages'])

    seed([term('a')], [{ id: 'g1', name: 'Auth', boardIds: ['a'] }])
    showTidyFeedback(unreadable)
    expect(labels()).toEqual(['Focus a group', 'Pages'])
    click('Focus a group')
    expect(useCameraRequestStore.getState().target).toEqual({ kind: 'groupPicker' })
  })

  it('a paged run offers no Pages; a legacy packer never gets W3', () => {
    showTidyFeedback({ ...unreadable, args: { mode: 'fit', implicit: false, overflow: 'pages' } })
    expect(labels()).toEqual([])
    useToastStore.getState().clearToasts()
    showTidyFeedback({ ...unreadable, args: { mode: 'smart', implicit: false } })
    expect(toast()).toBeUndefined()
  })

  it('Pages REPLACES the previous tidy: one undo step, now paged', () => {
    seed(Array.from({ length: 16 }, (_, i) => term(`t${i}`)))
    useCanvasViewStore.setState({ pane: { w: 800, h: 500 } })
    const first = runTidy({ mode: 'fit' })
    if (!first.ok) throw new Error(first.error)
    expect(first.readable).toBe(false)
    showTidyFeedback(first)
    expect(useCanvasStore.getState().past).toHaveLength(1)
    click('Pages')
    expect(useCanvasStore.getState().past).toHaveLength(1) // replaced, not stacked
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().boards.every((b) => b.x === 0 && b.y === 0)).toBe(true)
  })
})

describe('silence is the success state', () => {
  it('a readable tidy dismisses a stale tidy toast', () => {
    showTidyFeedback(run({ units: [unit('api'), unit('web')] }))
    expect(toast()).toBeDefined()
    showTidyFeedback(run({ args: { mode: 'fit', implicit: false }, fitZoom: 0.8, readable: true }))
    expect(toast()).toBeUndefined()
  })
})
