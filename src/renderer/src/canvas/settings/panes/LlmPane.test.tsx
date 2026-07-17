// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { LlmPane } from './LlmPane'

/**
 * Context·LLM pane coverage. These assertions migrated verbatim from the retired
 * `SettingsModal.test.tsx` when the LLM form became a standalone drill-in pane — the pane owns the
 * same provider/model/key/cap wiring and the same guards (BUG-007/029/031), so the regression net
 * moves with it. Two behaviours changed with the reshape and are reflected below:
 *   - Save no longer closes the surface (there is no `onClose` here); on success it shows an inline
 *     "Saved" indicator (`settings-saved`) and clears the key field.
 *   - The app-wide worker cap left this form for the Orchestration pane (see OrchestrationPane.test).
 */

// `globals: false` → RTL auto-cleanup is not registered; unmount each render's tree by hand.
afterEach(cleanup)

const llm = {
  status: vi.fn(),
  setKey: vi.fn(),
  clearKey: vi.fn(),
  setConfig: vi.fn(),
  // Model combobox (lazy — only called when the list is opened).
  models: { list: vi.fn() }
}

beforeEach(() => {
  vi.clearAllMocks()
  llm.status.mockResolvedValue({
    hasProvider: false,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: false,
    encryptionAvailable: true,
    callsToday: 0,
    defaultMaxCallsPerDay: 200
  })
  llm.setKey.mockResolvedValue({ ok: true })
  llm.clearKey.mockResolvedValue({ ok: true })
  llm.setConfig.mockResolvedValue({ ok: true })
  llm.models.list.mockResolvedValue({
    ok: true,
    fetchedAt: Date.now(),
    models: [{ id: 'picked/from-list', contextLength: 128_000, toolUse: true }]
  })
  ;(window as unknown as { api: { llm: typeof llm } }).api = { llm }
})

it('prefills provider + model from status on mount', async () => {
  render(<LlmPane />)
  await waitFor(() => expect(llm.status).toHaveBeenCalled())
  const provider = screen.getByLabelText(/provider/i) as HTMLSelectElement
  const model = screen.getByLabelText(/model/i) as HTMLInputElement
  await waitFor(() => expect(provider.value).toBe('openrouter'))
  expect(model.value).toBe('google/gemini-2.5-flash')
})

it('prefills the Base URL field for a local provider', async () => {
  llm.status.mockResolvedValue({
    hasProvider: true,
    provider: 'local',
    model: 'local-model',
    baseUrl: 'http://127.0.0.1:1234/v1',
    hasKey: false
  })
  render(<LlmPane />)
  const base = (await screen.findByLabelText(/base url/i)) as HTMLInputElement
  await waitFor(() => expect(base.value).toBe('http://127.0.0.1:1234/v1'))
})

it('masks the key input', async () => {
  render(<LlmPane />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  expect(key.type).toBe('password')
})

it('Save writes config and the key when a key is entered, then shows the Saved indicator', async () => {
  render(<LlmPane />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  // Wait for status() to resolve (cap prefilled) so the saved payload is deterministic.
  await waitFor(() =>
    expect((screen.getByLabelText(/max llm calls per day/i) as HTMLInputElement).value).toBe('200')
  )
  fireEvent.change(key, { target: { value: 'sk-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() =>
    expect(llm.setConfig).toHaveBeenCalledWith({
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      baseUrl: undefined,
      maxCallsPerDay: 200
    })
  )
  expect(llm.setKey).toHaveBeenCalledWith({ provider: 'openrouter', key: 'sk-secret' })
  // The pane stays open and confirms in place (no onClose) — the key field is cleared on success.
  await waitFor(() => expect(document.querySelector('[data-test="settings-saved"]')).not.toBeNull())
  expect(key.value).toBe('')
})

it('picking a model from the combobox updates the field and Save persists it', async () => {
  render(<LlmPane />)
  const model = (await screen.findByLabelText(/model/i)) as HTMLInputElement
  await waitFor(() => expect(model.value).toBe('google/gemini-2.5-flash'))
  fireEvent.click(model) // opens the list → lazy fetch
  await waitFor(() => expect(llm.models.list).toHaveBeenCalledWith({ provider: 'openrouter' }))
  fireEvent.click(await screen.findByText('picked/from-list'))
  expect(model.value).toBe('picked/from-list')
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() =>
    expect(llm.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'picked/from-list' })
    )
  )
})

it('Save does not call setKey when the key field is empty', async () => {
  render(<LlmPane />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(llm.setConfig).toHaveBeenCalled())
  expect(llm.setKey).not.toHaveBeenCalled()
})

// ── MCP-05: per-day call cap field + usage peek ────────────────────────────────────────────────

describe('MCP-05: per-day call cap field + usage peek', () => {
  it('prefills the cap field with the configured value and shows the usage peek', async () => {
    llm.status.mockResolvedValue({
      hasProvider: true,
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      hasKey: false,
      encryptionAvailable: true,
      callsToday: 12,
      maxCallsPerDay: 50,
      defaultMaxCallsPerDay: 200
    })
    render(<LlmPane />)
    const field = (await screen.findByLabelText(/max llm calls per day/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('50'))
    const peek = document.querySelector('[data-test="settings-usage-peek"]') as HTMLElement
    expect(peek.textContent).toMatch(/12 of 50/)
  })

  it('falls back to the default cap when none is configured', async () => {
    render(<LlmPane />)
    const field = (await screen.findByLabelText(/max llm calls per day/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('200'))
  })

  it('Save sends an edited cap to setConfig', async () => {
    render(<LlmPane />)
    const field = (await screen.findByLabelText(/max llm calls per day/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('200'))
    fireEvent.change(field, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(llm.setConfig).toHaveBeenCalledWith(expect.objectContaining({ maxCallsPerDay: 25 }))
    )
  })
})

it('Clear key calls clearKey for the active provider', async () => {
  render(<LlmPane />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /clear key/i }))
  await waitFor(() => expect(llm.clearKey).toHaveBeenCalledWith({ provider: 'openrouter' }))
})

it('T-F6: shows a no-keyring notice when encryption is unavailable', async () => {
  llm.status.mockResolvedValue({
    hasProvider: false,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: false,
    encryptionAvailable: false
  })
  render(<LlmPane />)
  const notice = (await screen.findByRole('note')) as HTMLElement
  expect(notice.getAttribute('data-test')).toBe('settings-no-keyring')
  expect(notice.textContent).toMatch(/keyring/i)
  expect(notice.textContent).toMatch(/OPENROUTER_API_KEY/)
})

it('T-F6: hides the no-keyring notice when encryption IS available', async () => {
  render(<LlmPane />) // beforeEach: encryptionAvailable true
  await screen.findByLabelText(/api key/i)
  expect(screen.queryByRole('note')).toBeNull()
})

it('shows an error and does NOT show Saved when the key save fails', async () => {
  llm.setKey.mockResolvedValue({ ok: false, reason: 'encryption-unavailable' })
  render(<LlmPane />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: 'sk-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/keyring/i))
  expect(document.querySelector('[data-test="settings-saved"]')).toBeNull()
})

it('surfaces an error (not a silent failure) when an IPC call rejects on Save (H1)', async () => {
  llm.setConfig.mockRejectedValue(new Error('channel gone'))
  render(<LlmPane />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not save/i))
  expect(document.querySelector('[data-test="settings-saved"]')).toBeNull()
})

// ── BUG-007 ──────────────────────────────────────────────────────────────────────────────────

it('BUG-007(1): a status() resolving AFTER unmount is a silent no-op (cancelled cleanup guard)', async () => {
  let resolveStatus: (s: unknown) => void = () => {}
  llm.status.mockReturnValue(
    new Promise((res) => {
      resolveStatus = res as (s: unknown) => void
    })
  )
  const err = vi.spyOn(console, 'error')
  const { unmount } = render(<LlmPane />)
  unmount() // cleanup sets cancelled = true
  resolveStatus({
    hasProvider: false,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: false,
    encryptionAvailable: true
  })
  await new Promise((r) => setTimeout(r, 5))
  expect(err).not.toHaveBeenCalled()
  err.mockRestore()
})

it('BUG-007(2): a resolved {ok:false} setConfig shows an error, does NOT call setKey, stays unsaved', async () => {
  llm.setConfig.mockResolvedValue({ ok: false, reason: 'forbidden' })
  render(<LlmPane />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: 'sk-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not save/i))
  expect(llm.setKey).not.toHaveBeenCalled() // pre-fix the key was sent despite the failed config
  expect(document.querySelector('[data-test="settings-saved"]')).toBeNull()
})

it('BUG-007(4): strips embedded whitespace (tab/space) from a pasted key before sending it to MAIN', async () => {
  render(<LlmPane />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: '  sk-abc\tdef ghi  ' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() =>
    expect(llm.setKey).toHaveBeenCalledWith({ provider: 'openrouter', key: 'sk-abcdefghi' })
  )
})

it('BUG-007(4): an all-whitespace key is treated as empty (setKey is skipped)', async () => {
  render(<LlmPane />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: '   \n\t ' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(llm.setConfig).toHaveBeenCalled())
  expect(llm.setKey).not.toHaveBeenCalled()
})

it('BUG-007(3): changing the provider refreshes hasKey for the newly-selected provider', async () => {
  llm.status.mockResolvedValue({
    hasProvider: true,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: true,
    encryptionAvailable: true
  })
  render(<LlmPane />)
  const provider = (await screen.findByLabelText(/provider/i)) as HTMLSelectElement
  await waitFor(() => expect(screen.getByText('· set')).toBeTruthy()) // openrouter shows set
  fireEvent.change(provider, { target: { value: 'anthropic' } })
  // status() re-fetch still reports provider=openrouter,hasKey=true; because that !== anthropic,
  // the indicator must clear (we don't know anthropic has a key).
  await waitFor(() => expect(screen.queryByText('· set')).toBeNull())
})

it('BUG-007(5): the Save button is disabled while a save is in flight', async () => {
  // hold setConfig pending so `busy` stays true while we inspect the control (the pane-level busy
  // guard that replaced the old modal-scrim wait cursor).
  let resolveConfig: (v: { ok: boolean }) => void = () => {}
  llm.setConfig.mockReturnValue(
    new Promise<{ ok: boolean }>((res) => {
      resolveConfig = res
    })
  )
  render(<LlmPane />)
  await screen.findByLabelText(/api key/i)
  const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement
  expect(save.disabled).toBe(false) // idle
  fireEvent.click(save)
  await waitFor(() => expect(save.disabled).toBe(true)) // busy
  resolveConfig({ ok: true })
  await waitFor(() => expect(save.disabled).toBe(false))
})

// ── BUG-029 ──────────────────────────────────────────────────────────────────────────────────

it('BUG-029: clear() with {ok:false} from clearKey must NOT clear hasKey state', async () => {
  llm.status.mockResolvedValue({
    hasProvider: true,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: true,
    encryptionAvailable: true
  })
  llm.clearKey.mockResolvedValue({ ok: false, reason: 'forbidden' })
  render(<LlmPane />)
  await waitFor(() => expect(screen.getByText('· set')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /clear key/i }))
  await waitFor(() => expect(llm.clearKey).toHaveBeenCalledWith({ provider: 'openrouter' }))
  // "· set" is still visible — hasKey must NOT have been cleared — and the user sees an error.
  expect(screen.getByText('· set')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toMatch(/could not clear/i)
})

// ── BUG-031 ──────────────────────────────────────────────────────────────────────────────────

it('BUG-031: onProvider() status() rejection must not produce unhandledRejection, hasKey falls to false', async () => {
  llm.status
    .mockResolvedValueOnce({
      hasProvider: true,
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      hasKey: true,
      encryptionAvailable: true
    })
    .mockRejectedValueOnce(new Error('IPC channel gone'))
  const unhandled = vi.fn()
  window.addEventListener('unhandledrejection', unhandled)
  render(<LlmPane />)
  const provider = (await screen.findByLabelText(/provider/i)) as HTMLSelectElement
  await waitFor(() => expect(screen.getByText('· set')).toBeTruthy())
  fireEvent.change(provider, { target: { value: 'anthropic' } })
  await new Promise((r) => setTimeout(r, 10))
  expect(unhandled).not.toHaveBeenCalled()
  expect(screen.queryByText('· set')).toBeNull()
  window.removeEventListener('unhandledrejection', unhandled)
})

it('BUG-031: mount effect status() rejection must not produce unhandledRejection', async () => {
  llm.status.mockRejectedValue(new Error('IPC channel gone on mount'))
  const unhandled = vi.fn()
  window.addEventListener('unhandledrejection', unhandled)
  render(<LlmPane />)
  await new Promise((r) => setTimeout(r, 10))
  expect(unhandled).not.toHaveBeenCalled()
  window.removeEventListener('unhandledrejection', unhandled)
})
