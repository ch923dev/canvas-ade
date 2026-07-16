// @vitest-environment jsdom
/**
 * Jarvis J5 — PersonaPane's wake-word download row (PR #354 review round 2: this exact
 * completion path produced two live dev-check bugs — no re-arm after the download, then
 * a stale-closure re-enable — so the race gets pinned by tests). Contract:
 *   - a successful download re-asserts wakeWordEnabled IFF MAIN's FRESH config still has
 *     it on (the re-arm gesture for useWakeWord's config-changed reconcile);
 *   - a user who toggled the feature OFF mid-download is NEVER silently re-enabled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { PersonaPane } from './PersonaPane'
import type { JarvisConfigView } from '../../../../../preload/jarvis'

afterEach(cleanup)

const jarvisStatus = vi.fn()
const jarvisConfigGet = vi.fn()
const jarvisConfigSet = vi.fn()
const wakeList = vi.fn()
const wakeDownload = vi.fn()

const CFG: JarvisConfigView = {
  enabled: true,
  name: 'Jarvis',
  tonePreset: 'butler',
  customToneText: '',
  speakingRate: 1.05,
  verbosity: 'concise',
  announcePolicy: 'attention',
  model: 'claude-opus-4-8',
  historyMode: 'session',
  wakeWordEnabled: true
}

function mockApi(): void {
  ;(window as never as { api: unknown }).api = {
    jarvis: {
      status: jarvisStatus,
      config: { get: jarvisConfigGet, set: jarvisConfigSet, onChanged: vi.fn(() => () => {}) },
      history: { clear: vi.fn() }
    },
    llm: { setKey: vi.fn(), clearKey: vi.fn() },
    voice: {
      supported: true,
      wake: {
        models: {
          list: wakeList,
          status: vi.fn(),
          download: wakeDownload,
          delete: vi.fn(),
          onDownloadProgress: vi.fn(() => () => {})
        }
      }
    }
  }
}

async function mount(): Promise<void> {
  render(<PersonaPane />)
  await act(async () => {}) // status + models.list resolve
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
  jarvisStatus.mockResolvedValue({ hasKey: true, encryptionAvailable: true, config: CFG })
  wakeList.mockResolvedValue([
    {
      id: 'kws-zipformer-gigaspeech-3.3M',
      label: 'Wake word EN (zipformer 3.3M)',
      language: 'en',
      license: 'Apache-2.0',
      totalBytes: 17_626_723,
      isDefault: true,
      status: 'absent'
    }
  ])
})

describe('PersonaPane wake-word download completion (the twice-bitten race)', () => {
  it('re-asserts wakeWordEnabled when MAIN still has it on (the re-arm gesture)', async () => {
    let settle!: (v: { ok: boolean }) => void
    wakeDownload.mockReturnValue(new Promise((r) => (settle = r)))
    jarvisConfigGet.mockResolvedValue(CFG) // fresh read: still enabled
    await mount()

    fireEvent.click(screen.getByText('Download'))
    await act(async () => {
      settle({ ok: true })
    })

    expect(jarvisConfigGet).toHaveBeenCalled()
    expect(jarvisConfigSet).toHaveBeenCalledWith({ wakeWordEnabled: true })
  })

  it('NEVER re-enables when the user toggled the feature off mid-download', async () => {
    let settle!: (v: { ok: boolean }) => void
    wakeDownload.mockReturnValue(new Promise((r) => (settle = r)))
    // MAIN's truth at completion time: the user turned it off while the 17 MB streamed.
    jarvisConfigGet.mockResolvedValue({ ...CFG, wakeWordEnabled: false })
    await mount()

    fireEvent.click(screen.getByText('Download'))
    await act(async () => {
      settle({ ok: true })
    })

    expect(jarvisConfigGet).toHaveBeenCalled()
    expect(jarvisConfigSet).not.toHaveBeenCalled()
  })

  it('a failed download surfaces the error and never touches the config', async () => {
    wakeDownload.mockResolvedValue({ ok: false, error: 'kws archive integrity failure' })
    await mount()

    fireEvent.click(screen.getByText('Download'))
    await act(async () => {})

    expect(screen.getByRole('alert').textContent).toContain('integrity')
    expect(jarvisConfigGet).not.toHaveBeenCalled()
    expect(jarvisConfigSet).not.toHaveBeenCalled()
  })
})
