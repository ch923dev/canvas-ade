// Unit coverage for the find-count fix (TerminalFindBar): the settle re-search, the
// flush-before-search ordering, and the honest pending count (a found match with a transiently
// zero decoration count must NOT read "No results"). The SearchAddon is a hand mock — findNext's
// boolean + the onDidChangeResults emitter are the two seams the bar consumes.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { TerminalFindBar } from './TerminalFindBar'
import { SEARCH_SETTLE_MS } from './terminalSearch'
import type { TerminalFindApi } from './useTerminalSpawn'

type ResultsCb = (e: { resultIndex: number; resultCount: number }) => void

function makeApi(opts?: { found?: boolean }) {
  let resultsCb: ResultsCb | undefined
  const addon = {
    findNext: vi.fn(() => opts?.found ?? true),
    findPrevious: vi.fn(() => opts?.found ?? true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((cb: ResultsCb) => {
      resultsCb = cb
      return { dispose: () => (resultsCb = undefined) }
    })
  }
  const term = {
    getSelection: () => 'block', // seeds the query at mount (single-line selection)
    focus: vi.fn()
  }
  const flushPending = vi.fn()
  const api = {
    close: vi.fn(),
    addonRef: { current: addon },
    termRef: { current: term },
    flushPending
  } as unknown as TerminalFindApi
  return {
    api,
    addon,
    flushPending,
    emitResults: (index: number, count: number) =>
      resultsCb?.({ resultIndex: index, resultCount: count })
  }
}

describe('TerminalFindBar — settle re-search + honest count (find-count fix)', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('flushes pending PTY bytes BEFORE searching', () => {
    const { api, addon, flushPending } = makeApi()
    render(<TerminalFindBar api={api} />)
    expect(flushPending).toHaveBeenCalled()
    expect(addon.findNext).toHaveBeenCalled()
    // ordering: the flush landed before the first search call
    expect(flushPending.mock.invocationCallOrder[0]).toBeLessThan(
      addon.findNext.mock.invocationCallOrder[0]
    )
  })

  it('re-runs the SAME incremental search once after the settle window', () => {
    vi.useFakeTimers()
    const { api, addon } = makeApi()
    render(<TerminalFindBar api={api} />)
    const initialCalls = addon.findNext.mock.calls.length
    act(() => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS + 10)
    })
    expect(addon.findNext.mock.calls.length).toBe(initialCalls + 1)
    // ...and only once — no self-rescheduling loop
    act(() => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS * 4)
    })
    expect(addon.findNext.mock.calls.length).toBe(initialCalls + 1)
  })

  it('a manual step (Enter) SUPERSEDES the pending settle re-search (no cursor double-advance)', () => {
    vi.useFakeTimers()
    const { api, addon, container } = (() => {
      const m = makeApi()
      const r = render(<TerminalFindBar api={m.api} />)
      return { ...m, container: r.container }
    })()
    void api
    const stepCallsBefore = addon.findNext.mock.calls.length
    // Enter = step: one incremental:false findNext, and the pending settle timer is cancelled —
    // a late incremental re-run after a step would advance past the user's position.
    const input = container.querySelector('[data-test="terminal-find-input"]') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(addon.findNext.mock.calls.length).toBe(stepCallsBefore + 1)
    act(() => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS * 4)
    })
    expect(addon.findNext.mock.calls.length).toBe(stepCallsBefore + 1) // settle never fired
  })

  it('unmount cancels the pending settle re-search', () => {
    vi.useFakeTimers()
    const { api, addon } = makeApi()
    const { unmount } = render(<TerminalFindBar api={api} />)
    const initialCalls = addon.findNext.mock.calls.length
    unmount()
    act(() => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS * 2)
    })
    expect(addon.findNext.mock.calls.length).toBe(initialCalls)
  })

  it('suppresses "No results" while findNext found a match but the count still reads 0', () => {
    const { api, emitResults, container } = (() => {
      const m = makeApi({ found: true })
      const r = render(<TerminalFindBar api={m.api} />)
      return { ...m, container: r.container }
    })()
    void api
    // the addon has NOT emitted a non-zero count yet (the transient under-count window)
    const count = container.querySelector('[data-test="terminal-find-count"]')!
    expect(count.textContent).toBe('') // quiet pending, NOT "No results"
    expect(count.className).not.toContain('warn')
    // the settle recount arrives -> the real count shows
    act(() => {
      emitResults(0, 1)
    })
    expect(count.textContent).toBe('1 / 1')
  })

  it('still reports an honest "No results" when findNext finds nothing', () => {
    const m = makeApi({ found: false })
    const { container } = render(<TerminalFindBar api={m.api} />)
    const count = container.querySelector('[data-test="terminal-find-count"]')!
    expect(count.textContent).toBe('No results')
    expect(count.className).toContain('warn')
  })
})
