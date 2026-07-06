import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { UpdateSurfaces } from './UpdateSurfaces'

/** Mirrors the status shape UpdateSurfaces consumes (main `UpdateStatus`). */
type Status =
  | { state: 'checking' }
  | { state: 'available'; version: string; tier: 'optional' | 'recommended' }
  | { state: 'mandatory'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

let handler: ((s: Status) => void) | null = null
const download = vi.fn()
const install = vi.fn()

beforeEach(() => {
  cleanup()
  handler = null
  download.mockClear()
  install.mockClear()
  ;(window as unknown as { api: unknown }).api = {
    update: {
      onStatus: (h: (s: Status) => void) => {
        handler = h
        return () => {
          handler = null
        }
      },
      download,
      install,
      check: vi.fn()
    }
  }
})

const fire = (s: Status): void => act(() => handler!(s))
/** The update buttons follow the app's `data-test` convention (AboutPane), not `data-testid`. */
const byTest = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-test="${id}"]`)

describe('UpdateSurfaces — tier routing', () => {
  it('optional → NO transient surface (the persistent badge is its only prompt)', () => {
    render(<UpdateSurfaces />)
    fire({ state: 'available', version: '1.0.0', tier: 'optional' })
    expect(screen.queryByTestId('update-banner')).toBeNull()
    expect(screen.queryByTestId('force-update-modal')).toBeNull()
  })

  it('recommended → banner', () => {
    render(<UpdateSurfaces />)
    fire({ state: 'available', version: '2.0.0', tier: 'recommended' })
    expect(screen.getByTestId('update-banner')).toBeTruthy()
    expect(screen.getByText(/Update 2\.0\.0 available/)).toBeTruthy()
    expect(screen.queryByTestId('force-update-modal')).toBeNull()
  })

  it('mandatory → blocking modal, no banner', () => {
    render(<UpdateSurfaces />)
    fire({ state: 'mandatory', version: '3.0.0' })
    expect(screen.getByTestId('force-update-modal')).toBeTruthy()
    expect(screen.getByText(/Update to 3\.0\.0 to keep using Expanse/)).toBeTruthy()
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })

  it('forced latch: a later tier-less event keeps the modal', () => {
    render(<UpdateSurfaces />)
    fire({ state: 'mandatory', version: '3.0.0' })
    fire({ state: 'downloading', percent: 40 })
    // Still the modal (download-progress carries no tier — it must not downgrade the latch).
    expect(screen.getByTestId('force-update-modal')).toBeTruthy()
    fire({ state: 'ready', version: '3.0.0' })
    expect(screen.getByTestId('force-update-modal')).toBeTruthy()
    expect(byTest('force-update-install')).toBeTruthy()
  })

  it('banner Later dismisses it (until the next fresh available)', () => {
    render(<UpdateSurfaces />)
    fire({ state: 'available', version: '2.0.0', tier: 'recommended' })
    expect(screen.getByTestId('update-banner')).toBeTruthy()
    act(() => byTest('banner-update-later')!.click())
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })

  it('is a no-op when window.api.update is absent (older preload)', () => {
    ;(window as unknown as { api: unknown }).api = {}
    expect(() => render(<UpdateSurfaces />)).not.toThrow()
    expect(screen.queryByTestId('update-banner')).toBeNull()
    expect(screen.queryByTestId('force-update-modal')).toBeNull()
  })
})
