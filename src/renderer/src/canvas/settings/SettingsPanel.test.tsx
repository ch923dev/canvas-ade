import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SettingsPanel } from './SettingsPanel'
import { useCanvasStore } from '../../store/canvasStore'

// vitest `globals: false` → no RTL auto-cleanup; each render would leak its portaled modal.
afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
})

const backButton = (): HTMLElement => screen.getByRole('button', { name: 'Back to Settings' })
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

it('drilled: back button is unambiguously labelled and the off-screen home grid is inert', () => {
  render(<SettingsPanel onClose={() => {}} initialSection="mcp" />)
  // The back button's accessible name is the spelled-out action, not the bare "Settings" heading.
  expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeTruthy()
  // The home pane (any tile lives in it) is pulled out of the tab order + a11y tree while drilled.
  const home = document.querySelector('[data-test^="settings-tile-"]')?.closest('section') ?? null
  expect(home?.getAttribute('aria-hidden')).toBe('true')
  expect(home?.hasAttribute('inert')).toBe(true)
})

// Each interactive tile drills into its REAL pane — proves the SettingsSectionBody id→pane switch
// (the pane bodies' own behaviour is covered by panes/*.test.tsx; here we only assert the wiring).
describe('section wiring (SettingsSectionBody)', () => {
  const llm = {
    status: vi.fn().mockResolvedValue({
      provider: 'openrouter',
      model: 'm',
      hasKey: false,
      encryptionAvailable: true
    })
  }
  const recap = { getConsent: vi.fn().mockResolvedValue('undecided'), setConsent: vi.fn() }
  const orchestration = {
    getSpawnCap: vi.fn().mockResolvedValue(4),
    setSpawnCap: vi.fn(),
    setConsent: vi.fn()
  }

  beforeEach(() => {
    ;(window as unknown as { api: object }).api = { llm, recap, orchestration }
  })

  it('the llm tile renders the LLM form', async () => {
    render(<SettingsPanel onClose={() => {}} initialSection="llm" />)
    expect(await screen.findByLabelText('Provider')).toBeTruthy()
  })

  it('the terminal tile renders the recap toggle', async () => {
    render(<SettingsPanel onClose={() => {}} initialSection="terminal" />)
    expect(await screen.findByLabelText(/agent recaps \(this project\)/i)).toBeTruthy()
  })

  it('the orchestration tile renders the orchestration switch', async () => {
    render(<SettingsPanel onClose={() => {}} initialSection="orchestration" />)
    expect(await screen.findByRole('switch', { name: /agent orchestration/i })).toBeTruthy()
  })
})
