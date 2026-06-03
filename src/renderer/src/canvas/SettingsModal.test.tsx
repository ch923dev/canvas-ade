import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'

// `globals: false` in vitest.config means RTL's auto-cleanup hook isn't registered,
// so each render would leak its portaled <body> modal into the next test.
afterEach(cleanup)

const llm = {
  status: vi.fn(),
  setKey: vi.fn(),
  clearKey: vi.fn(),
  setConfig: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  llm.status.mockResolvedValue({
    hasProvider: false,
    provider: 'openrouter',
    model: 'google/gemini-2.0-flash-001',
    hasKey: false
  })
  llm.setKey.mockResolvedValue({ ok: true })
  llm.clearKey.mockResolvedValue({ ok: true })
  llm.setConfig.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: { llm: typeof llm } }).api = { llm }
})

it('prefills provider + model from status on open', async () => {
  render(<SettingsModal onClose={() => {}} />)
  await waitFor(() => expect(llm.status).toHaveBeenCalled())
  const provider = screen.getByLabelText(/provider/i) as HTMLSelectElement
  const model = screen.getByLabelText(/model/i) as HTMLInputElement
  await waitFor(() => expect(provider.value).toBe('openrouter'))
  expect(model.value).toBe('google/gemini-2.0-flash-001')
})

it('prefills the Base URL field for a local provider', async () => {
  llm.status.mockResolvedValue({
    hasProvider: true,
    provider: 'local',
    model: 'local-model',
    baseUrl: 'http://127.0.0.1:1234/v1',
    hasKey: false
  })
  render(<SettingsModal onClose={() => {}} />)
  const base = (await screen.findByLabelText(/base url/i)) as HTMLInputElement
  await waitFor(() => expect(base.value).toBe('http://127.0.0.1:1234/v1'))
})

it('masks the key input', async () => {
  render(<SettingsModal onClose={() => {}} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  expect(key.type).toBe('password')
})

it('Save writes config and the key when a key is entered', async () => {
  const onClose = vi.fn()
  render(<SettingsModal onClose={onClose} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: 'sk-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() =>
    expect(llm.setConfig).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'google/gemini-2.0-flash-001',
      baseUrl: undefined
    })
  )
  expect(llm.setKey).toHaveBeenCalledWith({ provider: 'openrouter', key: 'sk-secret' })
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

it('Save does not call setKey when the key field is empty', async () => {
  render(<SettingsModal onClose={() => {}} />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(llm.setConfig).toHaveBeenCalled())
  expect(llm.setKey).not.toHaveBeenCalled()
})

it('Clear key calls clearKey for the active provider', async () => {
  render(<SettingsModal onClose={() => {}} />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /clear key/i }))
  await waitFor(() => expect(llm.clearKey).toHaveBeenCalledWith({ provider: 'openrouter' }))
})

it('keeps the modal open and shows an error when the key save fails', async () => {
  const onClose = vi.fn()
  llm.setKey.mockResolvedValue({ ok: false, reason: 'encryption-unavailable' })
  render(<SettingsModal onClose={onClose} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: 'sk-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/keyring/i))
  expect(onClose).not.toHaveBeenCalled()
})
