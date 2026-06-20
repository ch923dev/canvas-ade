import { it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { DigestPanel } from './DigestPanel'
import { digestStatusTone } from '../lib/digestPanel'
import { buildDigest } from '../lib/digest'
import type { CanvasDoc } from '../lib/boardSchema'

const DOC: CanvasDoc = {
  schemaVersion: 2,
  viewport: null,
  boards: [
    {
      id: 't1',
      type: 'terminal',
      x: 0,
      y: 0,
      w: 420,
      h: 340,
      title: 'Dev server',
      launchCommand: 'pnpm dev',
      port: 5173
    },
    {
      id: 'b1',
      type: 'browser',
      x: 0,
      y: 0,
      w: 700,
      h: 500,
      title: 'Preview',
      url: 'http://localhost:5173',
      viewport: 'desktop',
      previewSourceId: 't1'
    },
    {
      id: 'p1',
      type: 'planning',
      x: 0,
      y: 0,
      w: 516,
      h: 366,
      title: 'Plan',
      elements: [
        {
          kind: 'checklist',
          id: 'c1',
          x: 0,
          y: 0,
          w: 240,
          h: 0,
          title: 'Auth',
          items: [
            { id: 'i1', label: 'a', done: true },
            { id: 'i2', label: 'b', done: false }
          ]
        }
      ]
    }
  ],
  connectors: []
}
const EMPTY: CanvasDoc = { schemaVersion: 2, viewport: null, boards: [], connectors: [] }

it('renders one card per board with title, status and lines', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelectorAll('[data-test=digest-card]')).toHaveLength(3)
  expect(screen.getByText('3 boards — 1 terminal, 1 browser, 1 planning')).toBeTruthy()
  expect(screen.getByText('Dev server')).toBeTruthy()
  expect(screen.getByText('Runs `pnpm dev`')).toBeTruthy()
  expect(screen.getByText('Auth: 1/2 done')).toBeTruthy()
})

it('marks the panel open and renders no reopen tab when open', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelector('[data-test=digest-panel]')!.getAttribute('data-open')).toBe(
    'true'
  )
  expect(container.querySelector('[data-test=digest-reopen]')).toBeNull()
})

it('hides the panel and shows a reopen tab when closed', () => {
  const onOpen = vi.fn()
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open={false} onOpen={onOpen} onClose={() => {}} />
  )
  expect(container.querySelector('[data-test=digest-panel]')!.getAttribute('data-open')).toBe(
    'false'
  )
  const reopen = container.querySelector('[data-test=digest-reopen]') as HTMLButtonElement
  expect(reopen).toBeTruthy()
  reopen.click()
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('T-F3: marks the panel inert only when closed (keeps it out of the tab order)', () => {
  const { container, rerender } = render(
    <DigestPanel digest={buildDigest(DOC)} open={false} onOpen={() => {}} onClose={() => {}} />
  )
  const panel = container.querySelector('[data-test=digest-panel]')!
  expect(panel.hasAttribute('inert')).toBe(true)
  rerender(<DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />)
  expect(panel.hasAttribute('inert')).toBe(false)
})

it('calls onClose when the dismiss button is clicked', () => {
  const onClose = vi.fn()
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={onClose} />
  )
  ;(container.querySelector('[data-test=digest-close]') as HTMLButtonElement).click()
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('handles an empty canvas', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(EMPTY)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelectorAll('[data-test=digest-card]')).toHaveLength(0)
  expect(screen.getByText('0 boards — 0 terminal, 0 browser, 0 planning')).toBeTruthy()
})

it('renders cached prose (heading stripped) for a board that has it', () => {
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      prose={{ t1: '# Dev server\n\nRuns the Vite dev server and serves the SPA.\n' }}
      open
      onOpen={() => {}}
      onClose={() => {}}
    />
  )
  expect(screen.getByText('Runs the Vite dev server and serves the SPA.')).toBeTruthy()
  expect(screen.queryByText('# Dev server')).toBeNull()
  const cards = container.querySelectorAll('[data-test=digest-card]')
  const termCard = cards[0]
  expect(termCard.querySelector('[data-test=digest-prose]')).toBeTruthy()
  expect(termCard.querySelector('.digest-lines')).toBeNull()
})

it('falls back to Tier-1 lines for boards without cached prose', () => {
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      prose={{ t1: '# Dev server\n\nprose for t1\n' }}
      open
      onOpen={() => {}}
      onClose={() => {}}
    />
  )
  const browserCard = container.querySelectorAll('[data-test=digest-card]')[1]
  expect(browserCard.querySelector('.digest-lines')).toBeTruthy()
  expect(browserCard.querySelector('[data-test=digest-prose]')).toBeNull()
})

it('renders Tier-1 lines for every card when no prose map is passed', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelectorAll('[data-test=digest-prose]')).toHaveLength(0)
  expect(container.querySelectorAll('.digest-lines')).toHaveLength(3)
})

it('T-F4: renders no refresh control when onRefresh is not provided', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  expect(container.querySelectorAll('[data-test=digest-refresh]')).toHaveLength(0)
})

it('T-F4: a ⟳ per card calls onRefresh(boardId) and shows a busy state until it resolves', async () => {
  let release: () => void = () => {}
  const onRefresh = vi.fn(
    () =>
      new Promise<void>((res) => {
        release = res
      })
  )
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      open
      onOpen={() => {}}
      onClose={() => {}}
      onRefresh={onRefresh}
    />
  )
  const buttons = container.querySelectorAll('[data-test=digest-refresh]')
  expect(buttons).toHaveLength(3) // one per board
  const first = buttons[0] as HTMLButtonElement
  first.click()
  expect(onRefresh).toHaveBeenCalledWith('t1')
  await waitFor(() => expect(first.getAttribute('data-busy')).toBe('true'))
  expect(first.disabled).toBe(true)
  release()
  await waitFor(() => expect(first.getAttribute('data-busy')).toBe('false'))
  expect(first.disabled).toBe(false)
})

it('T-F4: ignores repeat clicks while a refresh is already in flight', async () => {
  let release: () => void = () => {}
  const onRefresh = vi.fn(
    () =>
      new Promise<void>((res) => {
        release = res
      })
  )
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      open
      onOpen={() => {}}
      onClose={() => {}}
      onRefresh={onRefresh}
    />
  )
  const first = container.querySelectorAll('[data-test=digest-refresh]')[0] as HTMLButtonElement
  first.click()
  await waitFor(() => expect(first.getAttribute('data-busy')).toBe('true'))
  first.click() // disabled + guarded → no second call
  first.click()
  expect(onRefresh).toHaveBeenCalledTimes(1)
  release()
})

// ── MCP-06: every status value gets an intentional tone ──────────────────────────────────────
it('MCP-06: maps each board status to a tone (active / linked / progress / idle)', () => {
  expect(digestStatusTone('ready')).toBe('active')
  expect(digestStatusTone('linked')).toBe('linked')
  expect(digestStatusTone('orchestrator')).toBe('linked')
  expect(digestStatusTone('2/5 done')).toBe('progress')
  expect(digestStatusTone('idle')).toBe('idle')
  expect(digestStatusTone('static')).toBe('idle')
  expect(digestStatusTone('notes')).toBe('idle')
})

it('MCP-06: renders data-tone on every status chip, not just ready/linked', () => {
  const { container } = render(
    <DigestPanel digest={buildDigest(DOC)} open onOpen={() => {}} onClose={() => {}} />
  )
  const tones = Array.from(container.querySelectorAll('.digest-status')).map((el) =>
    el.getAttribute('data-tone')
  )
  // terminal(ready)→active, browser(linked)→linked, planning(1/2 done)→progress
  expect(tones).toEqual(['active', 'linked', 'progress'])
})

// ── MCP-08: long prose clamps behind a Show more / less toggle ────────────────────────────────
const LONG_PROSE = '# Dev server\n\n' + 'word '.repeat(80) // ~400 chars body → clampable
const SHORT_PROSE = '# Dev server\n\nA short one-liner summary.'

it('MCP-08: clamps long prose and toggles expand/collapse', async () => {
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      prose={{ t1: LONG_PROSE }}
      open
      onOpen={() => {}}
      onClose={() => {}}
    />
  )
  const proseEl = container.querySelector('[data-test=digest-prose]') as HTMLElement
  expect(proseEl.getAttribute('data-clamped')).toBe('true')
  const toggle = container.querySelector('[data-test=digest-prose-toggle]') as HTMLButtonElement
  expect(toggle).toBeTruthy()
  expect(toggle.textContent).toBe('Show more')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  toggle.click()
  await waitFor(() => expect(proseEl.getAttribute('data-clamped')).toBe('false'))
  expect(toggle.textContent).toBe('Show less')
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
})

it('MCP-08: short prose renders no toggle and is never clamped', () => {
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      prose={{ t1: SHORT_PROSE }}
      open
      onOpen={() => {}}
      onClose={() => {}}
    />
  )
  expect(container.querySelector('[data-test=digest-prose-toggle]')).toBeNull()
  expect(
    (container.querySelector('[data-test=digest-prose]') as HTMLElement).getAttribute(
      'data-clamped'
    )
  ).toBe('false')
})

// ── MCP-04: a refresh that produced nothing surfaces the reason ───────────────────────────────
it('MCP-04: shows the refresh feedback message when onRefresh returns one', async () => {
  const onRefresh = vi.fn(async () => ({
    ok: false,
    message: 'No AI summary — connect a provider.'
  }))
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      open
      onOpen={() => {}}
      onClose={() => {}}
      onRefresh={onRefresh}
    />
  )
  const first = container.querySelectorAll('[data-test=digest-refresh]')[0] as HTMLButtonElement
  first.click()
  await waitFor(() => expect(screen.getByText('No AI summary — connect a provider.')).toBeTruthy())
  expect(
    (container.querySelector('[data-test=digest-feedback]') as HTMLElement).getAttribute('role')
  ).toBe('status')
})

it('MCP-04: shows no feedback when the refresh succeeds (ok or void return)', async () => {
  const onRefresh = vi.fn(async () => ({ ok: true }))
  const { container } = render(
    <DigestPanel
      digest={buildDigest(DOC)}
      open
      onOpen={() => {}}
      onClose={() => {}}
      onRefresh={onRefresh}
    />
  )
  const first = container.querySelectorAll('[data-test=digest-refresh]')[0] as HTMLButtonElement
  first.click()
  await waitFor(() => expect(first.getAttribute('data-busy')).toBe('false'))
  expect(container.querySelector('[data-test=digest-feedback]')).toBeNull()
})
