import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { UpdateNowRow } from './UpdateNowRow'
import WelcomeScreen from './WelcomeScreen'
import { useUpdateStore, type UpdateStatus } from '../store/updateStore'
import { useCanvasStore } from '../store/canvasStore'

const check = vi.fn<() => Promise<boolean>>()
const download = vi.fn<() => Promise<boolean>>()
const install = vi.fn<() => Promise<boolean>>()

beforeEach(() => {
  useUpdateStore.setState({ status: null, version: '' })
  check.mockReset().mockResolvedValue(true)
  download.mockReset().mockResolvedValue(true)
  install.mockReset().mockResolvedValue(true)
  ;(window as unknown as { api: unknown }).api = {
    update: { check, download, install, onStatus: () => () => {} },
    project: { recents: vi.fn().mockResolvedValue([]) },
    dialog: { openFolder: vi.fn() }
  }
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

/** MAIN pushing an `update:status` event (useUpdateStatusSync → updateStore). */
const push = (s: UpdateStatus): void => act(() => useUpdateStore.getState().setStatus(s))
const button = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-test="welcome-update-now"]')!
const row = (): string => document.querySelector('[data-test="welcome-update-row"]')!.textContent!

describe('UpdateNowRow — one click: check → download by itself → restart', () => {
  it('idle → Checking… → found → downloads ONCE → progress → Restart & install', async () => {
    render(<UpdateNowRow />)
    expect(button().textContent).toBe('Update now')

    fireEvent.click(button())
    expect(check).toHaveBeenCalledTimes(1)
    expect(button().textContent).toBe('Checking…')
    expect(button().disabled).toBe(true)

    push({ state: 'checking' })
    expect(button().textContent).toBe('Checking…')

    push({ state: 'available', version: '0.48.1', tier: 'optional' })
    expect(download).toHaveBeenCalledTimes(1)
    expect(button().textContent).toBe('Starting download…')

    push({ state: 'downloading', percent: 42 })
    expect(row()).toContain('Downloading 0.48.1 — 42%')
    expect(download).toHaveBeenCalledTimes(1)

    push({ state: 'ready', version: '0.48.1' })
    expect(row()).toContain('Update 0.48.1 is ready.')
    fireEvent.click(document.querySelector('[data-test="welcome-update-install"]')!)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('a mandatory result downloads too (the blocking modal and this row share the flow)', () => {
    render(<UpdateNowRow />)
    fireEvent.click(button())
    push({ state: 'mandatory', version: '0.48.1' })
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('nothing newer on the feed ⇒ says so; Check again re-checks', () => {
    render(<UpdateNowRow />)
    fireEvent.click(button())
    push({ state: 'none' })
    expect(row()).toContain('No newer version on your update feed.')
    expect(button().textContent).toBe('Check again')
    fireEvent.click(button())
    expect(check).toHaveBeenCalledTimes(2)
    expect(button().textContent).toBe('Checking…')
  })

  it('offline ⇒ Retry; a retry that finds the update downloads it', () => {
    render(<UpdateNowRow />)
    fireEvent.click(button())
    push({ state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })
    expect(row()).toContain("Couldn't reach the update server.")
    expect(button().textContent).toBe('Retry')
    fireEvent.click(button())
    expect(check).toHaveBeenCalledTimes(2)
    push({ state: 'available', version: '0.48.1', tier: 'optional' })
    expect(download).toHaveBeenCalledTimes(1)
  })

  it("a stale launch-check error reads as Checking… after the click, not as this click's result", () => {
    useUpdateStore.setState({ status: { state: 'error', message: 'offline at launch' } })
    render(<UpdateNowRow />)
    expect(button().textContent).toBe('Update now')
    fireEvent.click(button())
    expect(button().textContent).toBe('Checking…')
  })

  it('an update the launch check already found: label names it, click downloads without re-checking', () => {
    push({ state: 'available', version: '0.48.1', tier: 'recommended' })
    render(<UpdateNowRow />)
    expect(button().textContent).toBe('Update to 0.48.1')
    fireEvent.click(button())
    expect(check).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('an update already downloaded at launch: straight to Restart & install', () => {
    push({ state: 'ready', version: '0.48.1' })
    render(<UpdateNowRow />)
    expect(row()).toContain('Update 0.48.1 is ready.')
  })

  it('dev / unsigned build (no update:check handler ⇒ rejects) ⇒ updates unavailable', async () => {
    check.mockRejectedValue(new Error("No handler registered for 'update:check'"))
    render(<UpdateNowRow />)
    fireEvent.click(button())
    await waitFor(() => expect(row()).toContain("Updates aren't available in this build."))
    expect(button()).toBeNull()
  })
})

describe('WelcomeScreen mounts the row only for the "newer version" open error', () => {
  const showError = (error: string): void =>
    useCanvasStore.setState({ project: { dir: null, name: null, status: 'error', error } })

  it('"saved by a newer version of the app" ⇒ row shown', () => {
    showError(
      'migrate: document schemaVersion 24 (requires reader ≥ 24) is newer than supported 23 — ' +
        'this project was saved by a newer version of the app; update the app to open it'
    )
    render(<WelcomeScreen />)
    expect(screen.getByText('Update now')).toBeTruthy()
  })

  it('any other open error ⇒ no row', () => {
    showError('ENOSPC: no space left on device')
    render(<WelcomeScreen />)
    expect(screen.queryByText('Update now')).toBeNull()
  })
})
