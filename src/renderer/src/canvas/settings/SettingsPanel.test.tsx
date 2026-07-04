import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SettingsPanel } from './SettingsPanel'
import { useCanvasStore } from '../../store/canvasStore'

// vitest `globals: false` → no RTL auto-cleanup; each render would leak its portaled modal.
afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
})

const backButton = (): HTMLElement => screen.getByRole('button', { name: 'Settings' })
const drilled = (): boolean => screen.queryByText(/move here in the next build step/) !== null

it('renders every category tile grouped under its heading', () => {
  render(<SettingsPanel onClose={() => {}} />)
  for (const label of [
    'Account',
    'Billing',
    'Appearance',
    'Terminal',
    'Voice',
    'Context · LLM',
    'Orchestration',
    'MCP Servers',
    'About'
  ]) {
    expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy()
  }
  for (const group of ['You', 'Application', 'Agents & AI', 'System']) {
    expect(screen.getByText(group)).toBeTruthy()
  }
  expect(drilled()).toBe(false)
})

it('drills into a section on tile click and shows its detail', () => {
  render(<SettingsPanel onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /Context · LLM/ }))
  expect(drilled()).toBe(true)
  // the drilled section's own content is what rendered (both panes co-exist in the DOM, so scope
  // the assertion to the detail body rather than a bare getByText that also matches the tile).
  const detail = document.querySelector('[data-test="settings-detail"]')
  expect(detail?.textContent).toContain('Context · LLM')
})

it('back button returns to the home grid', () => {
  render(<SettingsPanel onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /Appearance/ }))
  expect(drilled()).toBe(true)
  fireEvent.click(backButton())
  expect(drilled()).toBe(false)
})

it('opens drilled when initialSection is given', () => {
  render(<SettingsPanel onClose={() => {}} initialSection="account" />)
  expect(drilled()).toBe(true)
})

it('Esc goes up one level when drilled (does not close)', () => {
  const onClose = vi.fn()
  render(<SettingsPanel onClose={onClose} initialSection="voice" />)
  expect(drilled()).toBe(true)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(drilled()).toBe(false)
  expect(onClose).not.toHaveBeenCalled()
})

it('Esc closes when already at the home grid', () => {
  const onClose = vi.fn()
  render(<SettingsPanel onClose={onClose} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('the close button closes outright', () => {
  const onClose = vi.fn()
  render(<SettingsPanel onClose={onClose} initialSection="mcp" />)
  fireEvent.click(screen.getByLabelText('Close settings'))
  expect(onClose).toHaveBeenCalledTimes(1)
})
