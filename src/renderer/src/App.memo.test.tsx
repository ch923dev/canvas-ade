// @vitest-environment jsdom
/**
 * R5 (audit P-1) — the ROOT RE-RENDER GATE.
 *
 * Phase 2's gate is "the root children no longer re-render on a board drag". A React Profiler
 * recording proves that once, by hand, for the person holding the mouse; this file proves it on
 * every run, which is what stops it silently regressing the next time someone reaches for a store
 * value in `App`.
 *
 * The regression it guards is cheap to reintroduce and invisible in review: any coarse subscription
 * placed in `App` (or in a hook `App` calls) re-renders 14 subtrees at drag frequency — including
 * `JarvisPanel`, which owns a rAF canvas painter. `paint` is the steepest per-board cost in the
 * switch pipeline (11.1 → 46.5 ms, 0 → 24 boards), so this is the measured half of Phase 2.
 *
 * Method: mock every child to a render COUNTER, keep `canvasStore` real, then mutate `boards` the
 * way a drag does — a fresh array reference per frame — and assert nothing re-rendered. Mocking the
 * children is what makes the assertion about `App`'s subscriptions rather than about React: a
 * counter cannot memo itself, so any count that moves came from the root.
 *
 * The deliberate non-vacuity check is the last test: it drives a pick `App` genuinely DOES
 * subscribe (`project.status`) and asserts the counters DO move. Without it, a broken harness that
 * rendered nothing would pass every assertion above it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

/** One render counter per mocked child, keyed by name. */
const renders: Record<string, number> = {}
const counter = (name: string) =>
  function Counted(): null {
    renders[name] = (renders[name] ?? 0) + 1
    return null
  }

vi.mock('./canvas/Canvas', () => ({ default: counter('Canvas') }))
vi.mock('./canvas/WelcomeScreen', () => ({ default: counter('WelcomeScreen') }))
vi.mock('./canvas/AuditLogViewer', () => ({ default: counter('AuditLogViewer') }))
vi.mock('./canvas/ConfirmModal', () => ({ default: counter('ConfirmModal') }))
vi.mock('./canvas/BatchConfirmModal', () => ({ default: counter('BatchConfirmModal') }))
vi.mock('./canvas/AskOnSwitchModal', () => ({ default: counter('AskOnSwitchModal') }))
vi.mock('./canvas/CloseSessionsModal', () => ({ default: counter('CloseSessionsModal') }))
vi.mock('./canvas/ProjectDock', () => ({ default: counter('ProjectDock') }))
vi.mock('./canvas/SwitchTransitionOverlay', () => ({ default: counter('SwitchTransitionOverlay') }))
vi.mock('./canvas/RunningProjectSwitcher', () => ({
  RunningProjectSwitcher: counter('RunningProjectSwitcher')
}))
vi.mock('./canvas/Toast', () => ({ ToastIsland: counter('ToastIsland') }))
vi.mock('./canvas/UpdateSurfaces', () => ({ UpdateSurfaces: counter('UpdateSurfaces') }))
vi.mock('./canvas/SignInView', () => ({ SignInView: counter('SignInView') }))
vi.mock('./voice/VoicePill', () => ({ VoicePill: counter('VoicePill') }))
vi.mock('./jarvis/JarvisPanel', () => ({ JarvisPanel: counter('JarvisPanel') }))
// The R5 leaf itself is counted too — it is SUPPOSED to re-render per drag frame. Asserting that
// it does is what proves the subscription was moved rather than deleted.
vi.mock('./store/McpPublisher', () => ({ McpPublisher: counter('McpPublisher') }))

// Every side-effecting hook `App` arms. Stubbed to no-ops: they reach for `window.api`, MessagePorts
// and timers, none of which this assertion is about.
vi.mock('./smoke/useRendererSmoke', () => ({ useRendererSmoke: () => {} }))
vi.mock('./store/useProjectBoot', () => ({ useProjectBoot: () => {} }))
vi.mock('./store/useAutosave', () => ({ useAutosave: () => {} }))
vi.mock('./store/useProjectSwitchHotkey', () => ({ useProjectSwitchHotkey: () => {} }))
vi.mock('./store/useMcpCommands', () => ({ useMcpCommands: () => {} }))
vi.mock('./store/useUpdateStatusSync', () => ({ useUpdateStatusSync: () => {} }))
vi.mock('./voice/useVoiceCapture', () => ({ useVoiceCapture: () => {} }))
vi.mock('./voice/useTtsPlayback', () => ({ useTtsPlayback: () => {} }))
vi.mock('./store/useNotifications', () => ({ useNotifications: () => {} }))
vi.mock('./store/useSwarmEvents', () => ({ useSwarmEvents: () => {} }))
// accountStore: `App` picks `s.status` off it, so it stays a real subscription surface — just one
// with a fixed value here.
vi.mock('./store/accountStore', () => ({
  useAccountStore: (sel: (s: { status: string }) => unknown) => sel({ status: 'signed-in' }),
  useAccountSync: () => {}
}))

const { useCanvasStore } = await import('./store/canvasStore')
const { useSwitchTransitionStore } = await import('./store/switchTransitionStore')
const { default: App } = await import('./App')

/** A board, shaped enough for the store. Geometry is what a drag actually mutates. */
const board = (id: string, x: number): Record<string, unknown> => ({
  id,
  type: 'planning',
  title: id,
  x,
  y: 0,
  w: 400,
  h: 300,
  elements: []
})

/** Total renders across every mocked child EXCEPT the publisher leaf. */
const childRenders = (): number =>
  Object.entries(renders)
    .filter(([name]) => name !== 'McpPublisher')
    .reduce((n, [, c]) => n + c, 0)

beforeEach(() => {
  for (const k of Object.keys(renders)) delete renders[k]
  vi.stubGlobal('__REQUIRE_ACCOUNT__', false)
  useSwitchTransitionStore.setState({ phase: 'idle' })
  useCanvasStore.setState({
    boards: [board('a', 0), board('b', 500)] as never,
    project: { dir: 'C:/p', name: 'p', status: 'open' }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('App root re-render boundary (R5)', () => {
  it('a drag-shaped boards mutation re-renders NO root child', () => {
    render(<App />)
    const before = childRenders()
    expect(before).toBeGreaterThan(0) // the tree actually mounted

    // 30 frames of a drag: a fresh `boards` array with fresh board objects each time, exactly what
    // React Flow's onNodesChange produces.
    act(() => {
      for (let frame = 1; frame <= 30; frame++) {
        useCanvasStore.setState({
          boards: [board('a', frame), board('b', 500)] as never
        })
      }
    })

    expect(childRenders()).toBe(before)
  })

  it('APP ITSELF does not re-render on a boards mutation', () => {
    render(<App />)
    // `McpPublisher` is the one child App renders WITHOUT a memo wrapper, and it is mocked here so
    // it holds no subscription of its own. Its render count is therefore a direct read-out of
    // App's OWN render count — the only instrument in this file that can see past the memo
    // boundary, and the one that fails if `useMcpPublish` (or any other coarse pick) moves back up
    // to the root. Without it the memo wrapper would mask a reintroduced P-1 completely.
    const before = renders.McpPublisher ?? 0
    expect(before).toBeGreaterThan(0)

    act(() => {
      for (let frame = 1; frame <= 30; frame++) {
        useCanvasStore.setState({ boards: [board('a', frame)] as never })
      }
    })

    expect(renders.McpPublisher).toBe(before)
  })

  it('a re-render of App alone does not propagate into the children (the memo boundary)', () => {
    render(<App />)
    const beforeApp = renders.McpPublisher ?? 0
    const beforeChildren = childRenders()

    // `switchPhase` is a pick App genuinely holds, and flipping it idle → in changes only the
    // wrapper's className: every child stays mounted with the same (zero) props. So App MUST
    // re-render and the children MUST NOT — which is exactly what `memo` is here to guarantee, and
    // the only assertion in this file that fails if the memo wrappers are dropped.
    act(() => {
      useSwitchTransitionStore.setState({ phase: 'in' })
    })

    expect(renders.McpPublisher).toBeGreaterThan(beforeApp)
    expect(childRenders()).toBe(beforeChildren)
  })

  it('NON-VACUITY: a pick App really does subscribe still re-renders the children', () => {
    render(<App />)
    const before = childRenders()

    act(() => {
      useCanvasStore.setState({ project: { dir: null, name: '', status: 'welcome' } })
    })

    expect(childRenders()).toBeGreaterThan(before)
  })
})
