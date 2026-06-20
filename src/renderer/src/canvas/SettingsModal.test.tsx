import { it, expect, vi, beforeEach, afterEach, describe } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useCanvasStore } from '../store/canvasStore'

// `globals: false` in vitest.config means RTL's auto-cleanup hook isn't registered,
// so each render would leak its portaled <body> modal into the next test.
afterEach(cleanup)

const llm = {
  status: vi.fn(),
  setKey: vi.fn(),
  clearKey: vi.fn(),
  setConfig: vi.fn()
}

const recap = {
  getConsent: vi.fn(),
  setConsent: vi.fn()
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
  recap.getConsent.mockResolvedValue('undecided')
  recap.setConsent.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: { llm: typeof llm; recap: typeof recap } }).api = { llm, recap }
  // Reset the store to a no-project state between tests.
  useCanvasStore.setState({ project: { dir: null, name: null, status: 'welcome' } })
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
  // Wait for status() to resolve (cap prefilled to the default) so the saved payload is
  // deterministic — model defaults to the same value before status, so it can't gate the race.
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
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

it('Save does not call setKey when the key field is empty', async () => {
  render(<SettingsModal onClose={() => {}} />)
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
    render(<SettingsModal onClose={() => {}} />)
    const field = (await screen.findByLabelText(/max llm calls per day/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('50'))
    const peek = document.querySelector('[data-test="settings-usage-peek"]') as HTMLElement
    expect(peek.textContent).toMatch(/12 of 50/)
  })

  it('falls back to the default cap when none is configured', async () => {
    // beforeEach status: maxCallsPerDay undefined + defaultMaxCallsPerDay 200.
    render(<SettingsModal onClose={() => {}} />)
    const field = (await screen.findByLabelText(/max llm calls per day/i)) as HTMLInputElement
    await waitFor(() => expect(field.value).toBe('200'))
  })

  it('Save sends an edited cap to setConfig', async () => {
    render(<SettingsModal onClose={() => {}} />)
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

// ── BUG-029 ──────────────────────────────────────────────────────────────────────────────────

it('BUG-029: clear() with {ok:false} from clearKey must NOT clear hasKey state or key field', async () => {
  // Arrange: hasKey is true (key is set), clearKey returns {ok:false} (frame-guard rejection path)
  llm.status.mockResolvedValue({
    hasProvider: true,
    provider: 'openrouter',
    model: 'google/gemini-2.5-flash',
    hasKey: true,
    encryptionAvailable: true
  })
  llm.clearKey.mockResolvedValue({ ok: false, reason: 'forbidden' })
  render(<SettingsModal onClose={() => {}} />)
  // Wait for the "· set" indicator to confirm hasKey=true was loaded
  await waitFor(() => expect(screen.getByText('· set')).toBeTruthy())
  // Act: click Clear key
  fireEvent.click(screen.getByRole('button', { name: /clear key/i }))
  await waitFor(() => expect(llm.clearKey).toHaveBeenCalledWith({ provider: 'openrouter' }))
  // Assert: "· set" is still visible — hasKey must NOT have been cleared
  expect(screen.getByText('· set')).toBeTruthy()
  // Assert: an error message is displayed to the user
  expect(screen.getByRole('alert').textContent).toMatch(/could not clear/i)
})

// ── BUG-031 ──────────────────────────────────────────────────────────────────────────────────

it('BUG-031: onProvider() status() rejection must not produce unhandledRejection, hasKey falls to false', async () => {
  // Arrange: initial load sets hasKey=true for openrouter
  llm.status
    .mockResolvedValueOnce({
      hasProvider: true,
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      hasKey: true,
      encryptionAvailable: true
    })
    // Second call (from onProvider) rejects — simulates IPC channel gone
    .mockRejectedValueOnce(new Error('IPC channel gone'))
  const unhandled = vi.fn()
  // In jsdom, unhandled promise rejections surface on window
  window.addEventListener('unhandledrejection', unhandled)
  render(<SettingsModal onClose={() => {}} />)
  const provider = (await screen.findByLabelText(/provider/i)) as HTMLSelectElement
  await waitFor(() => expect(screen.getByText('· set')).toBeTruthy()) // openrouter hasKey=true loaded
  // Act: change provider — triggers the second status() call which rejects
  fireEvent.change(provider, { target: { value: 'anthropic' } })
  // Wait a tick for the rejection to propagate
  await new Promise((r) => setTimeout(r, 10))
  // Assert: no unhandled rejection fired
  expect(unhandled).not.toHaveBeenCalled()
  // Assert: hasKey fell to false (safe default on IPC failure)
  expect(screen.queryByText('· set')).toBeNull()
  window.removeEventListener('unhandledrejection', unhandled)
})

it('BUG-031: mount effect status() rejection must not produce unhandledRejection', async () => {
  // The mount effect (line ~50) also calls status() without .catch()
  llm.status.mockRejectedValue(new Error('IPC channel gone on mount'))
  const unhandled = vi.fn()
  window.addEventListener('unhandledrejection', unhandled)
  render(<SettingsModal onClose={() => {}} />)
  // Wait for the rejection to propagate
  await new Promise((r) => setTimeout(r, 10))
  // Assert: no unhandled rejection
  expect(unhandled).not.toHaveBeenCalled()
  window.removeEventListener('unhandledrejection', unhandled)
})

// ── Agent recaps toggle ───────────────────────────────────────────────────────────────────────

describe('Agent recaps toggle', () => {
  // Helper: locate the toggle via its aria-label (the project uses data-test, not data-testid,
  // so RTL's findByTestId won't find it — use findByLabelText or querySelector instead).
  const findToggle = async (): Promise<HTMLInputElement> =>
    (await screen.findByLabelText(/agent recaps \(this project\)/i)) as HTMLInputElement

  it('is disabled with a hint when no project is open (project.dir === null)', async () => {
    // Store already reset to dir:null in beforeEach.
    recap.getConsent.mockResolvedValue('declined')
    render(<SettingsModal onClose={() => {}} />)
    const toggle = await findToggle()
    expect(toggle.disabled).toBe(true)
    expect(screen.getByText(/open a project to enable/i)).toBeTruthy()
  })

  it('is enabled and unchecked when a project is open and consent is declined', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('declined')
    render(<SettingsModal onClose={() => {}} />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.disabled).toBe(false))
    expect(toggle.checked).toBe(false)
  })

  it('is checked when consent is enabled', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('enabled')
    render(<SettingsModal onClose={() => {}} />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
  })

  it('calls setConsent("enabled") and checks the box when toggled on', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('declined')
    render(<SettingsModal onClose={() => {}} />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.disabled).toBe(false))
    fireEvent.click(toggle)
    expect(recap.setConsent).toHaveBeenCalledWith('enabled')
    await waitFor(() => expect(toggle.checked).toBe(true))
  })

  it('calls setConsent("declined") and unchecks the box when toggled off', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('enabled')
    render(<SettingsModal onClose={() => {}} />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
    fireEvent.click(toggle)
    expect(recap.setConsent).toHaveBeenCalledWith('declined')
    await waitFor(() => expect(toggle.checked).toBe(false))
  })

  it('BUG-065: reverts the toggle and shows an error on a resolved {ok:false}', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('enabled')
    recap.setConsent.mockResolvedValue({ ok: false })
    render(<SettingsModal onClose={() => {}} />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
    fireEvent.click(toggle) // untick — but MAIN reports nothing was persisted
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/agent recaps/i))
    // The optimistic untick was reverted: the hook is still installed, the UI must say so.
    expect(toggle.checked).toBe(true)
  })

  it('BUG-065: a setConsent rejection reverts the toggle without an unhandledRejection', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    recap.getConsent.mockResolvedValue('declined')
    recap.setConsent.mockRejectedValue(new Error('ENOSPC'))
    const unhandled = vi.fn()
    window.addEventListener('unhandledrejection', unhandled)
    render(<SettingsModal onClose={() => {}} />)
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.disabled).toBe(false))
    fireEvent.click(toggle) // tick — but the write throws (disk full)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/agent recaps/i))
    expect(toggle.checked).toBe(false) // reverted — recaps were never enabled
    await new Promise((r) => setTimeout(r, 10))
    expect(unhandled).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', unhandled)
  })

  it('re-reads consent when the open project changes (projectDir dep)', async () => {
    // Start with no project (dir:null) — getConsent is called once on mount.
    recap.getConsent.mockResolvedValue('declined')
    render(<SettingsModal onClose={() => {}} />)
    await waitFor(() => expect(recap.getConsent).toHaveBeenCalledTimes(1))

    // Simulate the user opening a project while the modal stays mounted.
    recap.getConsent.mockResolvedValue('enabled')
    useCanvasStore.setState({
      project: { dir: '/new/project', name: 'new-project', status: 'open' }
    })

    // The effect must re-run, calling getConsent again and reflecting the new value.
    await waitFor(() => expect(recap.getConsent).toHaveBeenCalledTimes(2))
    const toggle = await findToggle()
    await waitFor(() => expect(toggle.checked).toBe(true))
  })

  it('loads consent with a cancellation guard (post-unmount resolve is a no-op)', async () => {
    useCanvasStore.setState({
      project: { dir: '/some/project', name: 'my-project', status: 'open' }
    })
    let resolveConsent: (v: string) => void = () => {}
    recap.getConsent.mockReturnValue(
      new Promise((res) => {
        resolveConsent = res as (v: string) => void
      })
    )
    const err = vi.spyOn(console, 'error')
    const { unmount } = render(<SettingsModal onClose={() => {}} />)
    unmount()
    resolveConsent('enabled')
    await new Promise((r) => setTimeout(r, 5))
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
})
