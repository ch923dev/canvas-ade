import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SettingsPanel } from './SettingsPanel'
import { useCanvasStore } from '../../store/canvasStore'

// vitest `globals: false` → no RTL auto-cleanup; each render would leak its portaled modal.
afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
  // A minimal window.api so every tab's panes mount without throwing (LLM/recap/orchestration read
  // it on mount). Pane behaviour itself is covered by panes/*.test.tsx — here we test the shell.
  ;(window as unknown as { api: object }).api = {
    llm: {
      status: vi.fn().mockResolvedValue({
        provider: 'openrouter',
        model: 'm',
        hasKey: false,
        encryptionAvailable: true
      })
    },
    recap: { getConsent: vi.fn().mockResolvedValue('undecided'), setConsent: vi.fn() },
    orchestration: {
      getSpawnCap: vi.fn().mockResolvedValue(4),
      setSpawnCap: vi.fn(),
      setConsent: vi.fn()
    }
  }
})

const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })
const sectionShown = (id: string): boolean =>
  document.querySelector(`[data-test="settings-section-${id}"]`) !== null

it('renders the group tabs with "You" active by default', () => {
  render(<SettingsPanel onClose={() => {}} />)
  for (const label of ['You', 'Application', 'Agents & AI', 'Voice', 'System']) {
    expect(tab(label)).toBeTruthy()
  }
  expect(tab('You').getAttribute('aria-selected')).toBe('true')
  // The "You" group's sections show; another group's do not.
  expect(sectionShown('account')).toBe(true)
  expect(sectionShown('billing')).toBe(true)
  expect(sectionShown('appearance')).toBe(false)
})

it('switches the shown sections when another tab is clicked', () => {
  render(<SettingsPanel onClose={() => {}} />)
  fireEvent.click(tab('Application'))
  expect(tab('Application').getAttribute('aria-selected')).toBe('true')
  expect(sectionShown('appearance')).toBe(true)
  expect(sectionShown('terminal')).toBe(true)
  expect(sectionShown('voice')).toBe(false) // voice is now its own top-level tab
  expect(sectionShown('account')).toBe(false)
})

it('the Voice tab is its own top-level group and shows the voice section', () => {
  render(<SettingsPanel onClose={() => {}} />)
  fireEvent.click(tab('Voice'))
  expect(tab('Voice').getAttribute('aria-selected')).toBe('true')
  expect(sectionShown('voice')).toBe(true)
  expect(sectionShown('terminal')).toBe(false)
})

it('opens on the tab that owns initialSection', () => {
  render(<SettingsPanel onClose={() => {}} initialSection="llm" />)
  expect(tab('Agents & AI').getAttribute('aria-selected')).toBe('true')
  expect(sectionShown('llm')).toBe(true)
})

it('ArrowRight moves the selection to the next tab (roving tablist)', () => {
  render(<SettingsPanel onClose={() => {}} />)
  const you = tab('You')
  you.focus()
  fireEvent.keyDown(you, { key: 'ArrowRight' })
  expect(tab('Application').getAttribute('aria-selected')).toBe('true')
  expect(tab('You').getAttribute('aria-selected')).toBe('false')
})

it('Esc closes the panel', () => {
  const onClose = vi.fn()
  render(<SettingsPanel onClose={onClose} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('the close button closes the panel', () => {
  const onClose = vi.fn()
  render(<SettingsPanel onClose={onClose} />)
  fireEvent.click(screen.getByLabelText('Close settings'))
  expect(onClose).toHaveBeenCalledTimes(1)
})

// Each section mounts its REAL pane inside the tab panel — proves the SettingsSectionBody id→pane
// switch (pane bodies' own behaviour is covered by panes/*.test.tsx).
it('the Agents & AI tab renders the LLM form and the orchestration switch', async () => {
  render(<SettingsPanel onClose={() => {}} initialSection="llm" />)
  expect(await screen.findByLabelText('Provider')).toBeTruthy()
  expect(await screen.findByRole('switch', { name: /agent orchestration/i })).toBeTruthy()
})

it('the Application tab renders the recap toggle', async () => {
  render(<SettingsPanel onClose={() => {}} />)
  fireEvent.click(tab('Application'))
  expect(await screen.findByLabelText(/agent recaps \(this project\)/i)).toBeTruthy()
})
