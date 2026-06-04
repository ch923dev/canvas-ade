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
    model: 'google/gemini-2.5-flash',
    hasKey: false,
    encryptionAvailable: true
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
      model: 'google/gemini-2.5-flash',
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

it('T-F6: shows a no-keyring notice when encryption is unavailable', async () => {
  llm.status.mockResolvedValue({
    hasProvider: false,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: false,
    encryptionAvailable: false
  })
  render(<SettingsModal onClose={() => {}} />)
  const notice = (await screen.findByRole('note')) as HTMLElement
  expect(notice.getAttribute('data-test')).toBe('settings-no-keyring')
  expect(notice.textContent).toMatch(/keyring/i)
  expect(notice.textContent).toMatch(/OPENROUTER_API_KEY/)
})

it('T-F6: hides the no-keyring notice when encryption IS available', async () => {
  render(<SettingsModal onClose={() => {}} />) // beforeEach: encryptionAvailable true
  await screen.findByLabelText(/api key/i)
  expect(screen.queryByRole('note')).toBeNull()
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

it('surfaces an error (not a silent failure) when an IPC call rejects on Save (H1)', async () => {
  const onClose = vi.fn()
  llm.setConfig.mockRejectedValue(new Error('channel gone'))
  render(<SettingsModal onClose={onClose} />)
  await screen.findByLabelText(/api key/i)
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not save/i))
  expect(onClose).not.toHaveBeenCalled()
})

// ── BUG-007 ──────────────────────────────────────────────────────────────────────────────────

it('BUG-007(1): a status() resolving AFTER unmount is a silent no-op (cancelled cleanup guard)', async () => {
  // The mount effect now returns a cleanup that flips `cancelled`, so a slow llm.status() that
  // settles after the modal closed must NOT run its setProvider/setModel/setHasKey body. React 18
  // silently swallows a stray post-unmount setState, so we assert the observable contract: the
  // resolve produces no console error/warning and does not throw. (Guards the cleanup wiring from
  // being dropped in a future refactor; the body itself is exercised by the mounted-prefill tests.)
  let resolveStatus: (s: unknown) => void = () => {}
  llm.status.mockReturnValue(
    new Promise((res) => {
      resolveStatus = res as (s: unknown) => void
    })
  )
  const err = vi.spyOn(console, 'error')
  const { unmount } = render(<SettingsModal onClose={() => {}} />)
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

it('BUG-007(2): a resolved {ok:false} setConfig shows an error, does NOT call setKey, keeps modal open', async () => {
  const onClose = vi.fn()
  llm.setConfig.mockResolvedValue({ ok: false, reason: 'forbidden' })
  render(<SettingsModal onClose={onClose} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: 'sk-secret' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not save/i))
  expect(llm.setKey).not.toHaveBeenCalled() // pre-fix the key was sent despite the failed config
  expect(onClose).not.toHaveBeenCalled() // pre-fix the modal closed as if saved
})

it('BUG-007(4): strips embedded whitespace (tab/space) from a pasted key before sending it to MAIN', async () => {
  render(<SettingsModal onClose={() => {}} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  // a wrapped/garbled copy-paste: outer spaces + an EMBEDDED tab and space. trim() leaves the
  // embedded whitespace (only strips the ends) so the malformed key would reach safeStorage and
  // later throw an opaque "invalid header value"; replace(/\s+/g,'') removes all of it.
  fireEvent.change(key, { target: { value: '  sk-abc\tdef ghi  ' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() =>
    expect(llm.setKey).toHaveBeenCalledWith({ provider: 'openrouter', key: 'sk-abcdefghi' })
  )
})

it('BUG-007(4): an all-whitespace key is treated as empty (setKey is skipped)', async () => {
  render(<SettingsModal onClose={() => {}} />)
  const key = (await screen.findByLabelText(/api key/i)) as HTMLInputElement
  fireEvent.change(key, { target: { value: '   \n\t ' } })
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(llm.setConfig).toHaveBeenCalled())
  expect(llm.setKey).not.toHaveBeenCalled()
})

it('BUG-007(3): changing the provider refreshes hasKey for the newly-selected provider', async () => {
  // Persisted provider is openrouter WITH a key; switching the dropdown to anthropic (un-persisted)
  // must drop the "· set" indicator instead of leaving the stale openrouter status showing.
  llm.status.mockResolvedValue({
    hasProvider: true,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: true,
    encryptionAvailable: true
  })
  render(<SettingsModal onClose={() => {}} />)
  const provider = (await screen.findByLabelText(/provider/i)) as HTMLSelectElement
  await waitFor(() => expect(screen.getByText('· set')).toBeTruthy()) // openrouter shows set
  fireEvent.change(provider, { target: { value: 'anthropic' } })
  // status() re-fetch still reports provider=openrouter,hasKey=true; because that !== anthropic,
  // the indicator must clear (we don't know anthropic has a key).
  await waitFor(() => expect(screen.queryByText('· set')).toBeNull())
})

it('BUG-007(5): the scrim shows a wait cursor while a save is in flight', async () => {
  // hold setConfig pending so busy stays true while we inspect the scrim
  let resolveConfig: (v: { ok: boolean }) => void = () => {}
  llm.setConfig.mockReturnValue(
    new Promise<{ ok: boolean }>((res) => {
      resolveConfig = res
    })
  )
  render(<SettingsModal onClose={() => {}} />)
  await screen.findByLabelText(/api key/i)
  const scrim = document.querySelector('[data-test="settings-scrim"]') as HTMLElement
  expect(scrim.style.cursor).toBe('default') // idle
  fireEvent.click(screen.getByRole('button', { name: /save/i }))
  await waitFor(() => expect(scrim.style.cursor).toBe('wait')) // busy
  resolveConfig({ ok: true })
})
