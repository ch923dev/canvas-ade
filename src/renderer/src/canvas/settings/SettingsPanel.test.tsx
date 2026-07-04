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
// Drilled ⇔ the detail pane is the visible half of the track. Detected via the section's
// aria-hidden (set from `active === null`) so it is independent of any one pane's content — the
// Voice pane, for instance, renders nothing without window.api.voice yet the panel is still drilled.
const detailSection = (): Element | null =>
  document.querySelector('[data-test="settings-detail"]')?.closest('section') ?? null
const drilled = (): boolean => detailSection()?.getAttribute('aria-hidden') === 'false'

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
  // Drill the MCP tile — a static read-only pane, so the shell test needs no window.api stub.
  fireEvent.click(screen.getByRole('button', { name: /MCP Servers/ }))
  expect(drilled()).toBe(true)
  const detail = document.querySelector('[data-test="settings-detail"]')
  expect(detail?.textContent).toMatch(/coming in a later update/i)
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
