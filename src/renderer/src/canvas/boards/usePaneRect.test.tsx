// @vitest-environment jsdom
/**
 * `usePaneRect` — the cached pane box (audit P-2 / R6).
 *
 * The finding this hook exists for is a COUNT, not a behaviour: both liveness managers reconcile on
 * every `boards`-ref change (≈60×/s during a node drag) and each used to open its reconcile with a
 * `getBoundingClientRect()` — a synchronous layout flush, twice per frame, on the drag path.
 *
 * So the load-bearing assertion here is "how many times was the DOM measured", and the tests are
 * written to fail if the cache is bypassed rather than to merely confirm the numbers come out right.
 * Correctness of the box itself is the cheap half; the counts are the point.
 *
 * jsdom has no `ResizeObserver`, so one is installed per test with a hook to fire it — which
 * doubles as coverage of the guarded `typeof ResizeObserver === 'undefined'` fallback path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useRef } from 'react'
import type { ReactElement } from 'react'
import { usePaneRect, type PaneRect } from './usePaneRect'

/** Fires every live observer's callback, standing in for a real layout change. */
let fireResize: () => void = () => {}

function installResizeObserver(): void {
  const callbacks = new Set<() => void>()
  fireResize = () => {
    for (const cb of callbacks) cb()
  }
  class FakeResizeObserver {
    constructor(private cb: () => void) {}
    observe(): void {
      callbacks.add(this.cb)
    }
    disconnect(): void {
      callbacks.delete(this.cb)
    }
    unobserve(): void {
      callbacks.delete(this.cb)
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
}

/** The measured box, swappable mid-test so a re-measure is observably different. */
let box = { left: 10, top: 20, width: 800, height: 600 }
const measured = vi.fn()

/** Harness: renders a pane, exposes the getter's latest value + a manual re-read button. */
function Harness({ onGetter }: { onGetter: (g: () => PaneRect | null) => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const getRect = usePaneRect(ref)
  onGetter(getRect)
  return <div ref={ref} data-testid="pane" />
}

beforeEach(() => {
  installResizeObserver()
  measured.mockClear()
  box = { left: 10, top: 20, width: 800, height: 600 }
  // jsdom reports an all-zeros rect for everything; patch the prototype so the hook sees a real box
  // and so every measurement is counted.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    measured()
    return { ...box, right: box.left + box.width, bottom: box.top + box.height } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('usePaneRect', () => {
  it('measures once on mount and serves every later read from cache', () => {
    let getRect: () => PaneRect | null = () => null
    render(<Harness onGetter={(g) => (getRect = g)} />)

    const afterMount = measured.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    // 60 reads = one second of drag frames through BOTH liveness managers. Not one of them may
    // touch the DOM: this exact count is the finding P-2 raised.
    for (let i = 0; i < 60; i++) getRect()

    expect(measured.mock.calls.length).toBe(afterMount)
    expect(getRect()).toEqual({ x: 10, y: 20, width: 800, height: 600 })
  })

  it('re-measures when the ResizeObserver fires, and serves the NEW box', () => {
    let getRect: () => PaneRect | null = () => null
    render(<Harness onGetter={(g) => (getRect = g)} />)
    const afterMount = measured.mock.calls.length

    box = { left: 0, top: 40, width: 500, height: 400 }
    act(() => fireResize())

    expect(measured.mock.calls.length).toBeGreaterThan(afterMount)
    expect(getRect()).toEqual({ x: 0, y: 40, width: 500, height: 400 })
  })

  it('re-measures on a window resize', () => {
    let getRect: () => PaneRect | null = () => null
    render(<Harness onGetter={(g) => (getRect = g)} />)

    box = { left: 0, top: 0, width: 1024, height: 768 }
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    expect(getRect()).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })

  it('re-measures when an ancestor animation ends — the transform ResizeObserver cannot see', () => {
    // Mount DURING the rise: `.st-app-rise` runs scale(1.03) translateY(10px) on an ANCESTOR of
    // the pane for 240 ms, and Canvas mounts inside that window on every project switch. A
    // transform never changes the layout box, so ResizeObserver stays silent — without the
    // animationend listener this scaled rect would be cached forever.
    box = { left: -2, top: 21, width: 824, height: 618 }
    let getRect: () => PaneRect | null = () => null
    const { container } = render(<Harness onGetter={(g) => (getRect = g)} />)
    expect(getRect()).toEqual({ x: -2, y: 21, width: 824, height: 618 })

    // The settled box, once `.st-app-rise` finishes.
    box = { left: 10, top: 20, width: 800, height: 600 }
    act(() => {
      container.dispatchEvent(new Event('animationend', { bubbles: true }))
    })

    expect(getRect()).toEqual({ x: 10, y: 20, width: 800, height: 600 })
  })

  it('reads null for a zero-area pane — the "not laid out yet" signal callers bail on', () => {
    box = { left: 0, top: 0, width: 0, height: 0 }
    let getRect: () => PaneRect | null = () => null
    render(<Harness onGetter={(g) => (getRect = g)} />)

    expect(getRect()).toBeNull()
  })

  it('the getter identity is stable, so a consumer reconcile callback is never re-created', () => {
    const getters: Array<() => PaneRect | null> = []
    const { rerender } = render(<Harness onGetter={(g) => getters.push(g)} />)
    rerender(<Harness onGetter={(g) => getters.push(g)} />)
    act(() => fireResize())
    rerender(<Harness onGetter={(g) => getters.push(g)} />)

    // A changing identity would tear down and re-arm the liveness store subscription on every
    // resize — the reason this hook returns a getter instead of the rect.
    expect(new Set(getters).size).toBe(1)
  })

  it('still works without ResizeObserver (guarded fallback), refreshing on window resize', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    let getRect: () => PaneRect | null = () => null
    render(<Harness onGetter={(g) => (getRect = g)} />)

    expect(getRect()).toEqual({ x: 10, y: 20, width: 800, height: 600 })

    box = { left: 5, top: 5, width: 300, height: 200 }
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    expect(getRect()).toEqual({ x: 5, y: 5, width: 300, height: 200 })
  })
})
