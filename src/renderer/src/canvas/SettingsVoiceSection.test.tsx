// @vitest-environment jsdom
/**
 * Voice V4 — Settings › Voice section against a mocked window.api.voice (HANDOFF-V4
 * testing note). Immediate-apply semantics: every field change hits config.set at once;
 * failures revert optimistic state. Model picker drives models.* + the progress push.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { SettingsVoiceSection, accelFromEvent, formatMb } from './SettingsVoiceSection'
import type { VoiceDownloadProgress } from '../../../preload/voice'

afterEach(cleanup)

/** Repo convention is data-test (not RTL's data-testid). */
const byTest = (id: string): HTMLElement | null =>
  document.querySelector(`[data-test="${id}"]`) as HTMLElement | null

const configGet = vi.fn()
const configSet = vi.fn()
const modelsList = vi.fn()
const modelsDownload = vi.fn()
const modelsDelete = vi.fn()
let progressCb: ((p: VoiceDownloadProgress) => void) | null = null

const KROKO = {
  id: 'kroko-en-2025-08-06',
  label: 'Kroko EN (low latency)',
  language: 'en',
  license: 'CC-BY-SA-4.0',
  licenseNote: 'Community model by Banafo (Kroko ASR).',
  totalBytes: 71_053_214,
  isDefault: true,
  status: 'ready' as const
}
const ZIP = {
  id: 'zipformer-en-2023-06-26-int8',
  label: 'Zipformer EN int8 (Apache)',
  language: 'en',
  license: 'Apache-2.0',
  totalBytes: 72_654_782,
  isDefault: false,
  status: 'absent' as const
}

function mockApi(): void {
  ;(window as never as { api: unknown }).api = {
    voice: {
      config: { get: configGet, set: configSet, onChanged: vi.fn(() => () => {}) },
      models: {
        list: modelsList,
        status: vi.fn(),
        download: modelsDownload,
        delete: modelsDelete,
        onDownloadProgress: vi.fn((cb: (p: VoiceDownloadProgress) => void) => {
          progressCb = cb
          return () => {
            progressCb = null
          }
        })
      }
    }
  }
}

async function mount(): Promise<void> {
  render(<SettingsVoiceSection />)
  await act(async () => {}) // config.get + models.list resolve
}

beforeEach(() => {
  vi.clearAllMocks()
  progressCb = null
  mockApi()
  configGet.mockResolvedValue({
    engine: 'sherpa-onnx',
    modelId: KROKO.id,
    language: 'auto',
    autoSendOnFinal: false,
    showPill: true
  })
  configSet.mockResolvedValue({ ok: true })
  modelsList.mockResolvedValue([KROKO, ZIP])
  modelsDownload.mockResolvedValue({ ok: true })
  modelsDelete.mockResolvedValue({ ok: true })
})

afterEach(() => {
  delete (window as never as { api?: unknown }).api
})

describe('accelFromEvent / formatMb (pure)', () => {
  const ev = (
    code: string,
    mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}
  ): Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'> => ({
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta
  })

  it('builds accelerators from bindable chords only', () => {
    expect(accelFromEvent(ev('KeyV', { ctrl: true, alt: true }), false)).toBe('Ctrl+Alt+V')
    expect(accelFromEvent(ev('KeyM', { meta: true, shift: true }), true)).toBe('Shift+Cmd+M')
    expect(accelFromEvent(ev('KeyV'), false)).toBeNull() // bare key
    expect(accelFromEvent(ev('KeyV', { shift: true }), false)).toBeNull() // shift-only
    expect(accelFromEvent(ev('ControlLeft', { ctrl: true }), false)).toBeNull() // lone modifier
    expect(accelFromEvent(ev('Escape', { ctrl: true }), false)).toBeNull() // outside subset
  })

  it('formats SI megabytes', () => {
    expect(formatMb(71_053_214)).toBe('71 MB')
    expect(formatMb(45_200_000, 1)).toBe('45.2 MB')
  })
})

describe('SettingsVoiceSection', () => {
  it('renders nothing without window.api.voice', () => {
    delete (window as never as { api?: unknown }).api
    const { container } = render(<SettingsVoiceSection />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the catalog: DEFAULT badge, license note, ready vs download states', async () => {
    await mount()
    expect(screen.getByText('Kroko EN (low latency)')).toBeTruthy()
    expect(screen.getByText('DEFAULT')).toBeTruthy()
    expect(screen.getByText(/Community model by Banafo/)).toBeTruthy()
    expect(screen.getByText('Downloaded')).toBeTruthy()
    expect(screen.getByText('Download 73 MB')).toBeTruthy()
  })

  it('showPill toggle applies immediately and reverts on failure', async () => {
    await mount()
    const toggle = screen.getByRole('switch', { name: /show voice pill/i })
    fireEvent.click(toggle)
    expect(configSet).toHaveBeenCalledWith({ showPill: false })
    await act(async () => {})
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    configSet.mockResolvedValueOnce({ ok: false })
    fireEvent.click(toggle)
    await act(async () => {})
    expect(toggle.getAttribute('aria-checked')).toBe('false') // reverted to pre-click state
    expect(screen.getByRole('alert').textContent).toMatch(/could not save/i)
  })

  it('selecting a model persists modelId; an absent selection shows the fallback callout', async () => {
    await mount()
    expect(byTest('voice-model-fallback-note')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /use zipformer/i }))
    expect(configSet).toHaveBeenCalledWith({ modelId: ZIP.id })
    await act(async () => {})
    expect(byTest('voice-model-fallback-note')!.textContent).toMatch(
      /uses Kroko EN \(low latency\) until/i
    )
  })

  it('download: calls models.download, renders pushed progress, re-lists on completion', async () => {
    let resolveDownload: (v: { ok: boolean }) => void = () => {}
    modelsDownload.mockImplementationOnce(
      () => new Promise((res) => (resolveDownload = res as never))
    )
    await mount()
    fireEvent.click(byTest(`voice-model-download-${ZIP.id}`)!)
    expect(modelsDownload).toHaveBeenCalledWith(ZIP.id)
    act(() => {
      progressCb?.({
        id: ZIP.id,
        receivedBytes: 45_200_000,
        totalBytes: 72_654_782,
        fileIndex: 1,
        fileCount: 4
      })
    })
    expect(byTest(`voice-model-progress-${ZIP.id}`)!.textContent).toMatch(
      /45\.2 MB of 72\.7 MB · file 1 of 4/
    )
    modelsList.mockResolvedValue([KROKO, { ...ZIP, status: 'ready' as const }])
    await act(async () => resolveDownload({ ok: true }))
    await waitFor(() =>
      expect(byTest(`voice-model-ready-${ZIP.id}`)!.textContent).toBe('Downloaded')
    )
  })

  it('delete calls models.delete and re-lists', async () => {
    await mount()
    modelsList.mockResolvedValue([{ ...KROKO, status: 'absent' as const }, ZIP])
    fireEvent.click(byTest(`voice-model-delete-${KROKO.id}`)!)
    expect(modelsDelete).toHaveBeenCalledWith(KROKO.id)
    await waitFor(() => expect(byTest(`voice-model-ready-${KROKO.id}`)).toBeNull())
  })

  it('language + engine + microphone persist immediately', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText(/dictation language/i), { target: { value: 'en' } })
    expect(configSet).toHaveBeenCalledWith({ language: 'en' })
    fireEvent.change(screen.getByLabelText(/microphone/i), { target: { value: '' } })
    expect(configSet).toHaveBeenCalledWith({ micDeviceId: '' }) // '' clears in MAIN's repair
  })

  it('hotkey capture: arm → chord persists; Esc cancels; bare keys ignored; Reset clears', async () => {
    await mount()
    const field = byTest('voice-hotkey-field')!
    expect(field.textContent).toBe('CtrlShiftM') // default chord as kbd chips

    fireEvent.click(field)
    expect(field.textContent).toMatch(/press keys/)
    fireEvent.keyDown(field, { code: 'KeyV', key: 'v' }) // bare key — stays armed
    expect(configSet).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { code: 'KeyV', key: 'v', ctrlKey: true, altKey: true })
    expect(configSet).toHaveBeenCalledWith({ hotkey: 'Ctrl+Alt+V' })
    await act(async () => {})
    expect(field.textContent).toBe('CtrlAltV')

    fireEvent.click(field)
    fireEvent.keyDown(field, { code: 'Escape', key: 'Escape' })
    expect(field.textContent).toBe('CtrlAltV') // cancelled, chord kept

    fireEvent.click(byTest('voice-hotkey-reset')!)
    expect(configSet).toHaveBeenCalledWith({ hotkey: '' })
    await act(async () => {})
    expect(field.textContent).toBe('CtrlShiftM') // back to the platform default
  })
})
