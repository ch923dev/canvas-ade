import { it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DigestPanel } from './DigestPanel'
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
  ]
}
const EMPTY: CanvasDoc = { schemaVersion: 2, viewport: null, boards: [] }

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
