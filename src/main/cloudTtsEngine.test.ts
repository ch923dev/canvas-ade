import { describe, it, expect, vi } from 'vitest'
import type { MessagePortMain } from 'electron'
import { createCloudTtsEngine } from './cloudTtsEngine'
import { CloudSpeakError, type CloudSpeak, type CloudSpeakInput } from './openaiSpeak'
import type { VoiceEngineHandle } from './voiceEngine'
import type { TtsOutMsg } from './voiceTtsRunner'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const abortErr = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** A fake MessagePortMain: capture outbound posts + the close. */
function makePort(): { port: MessagePortMain; posted: TtsOutMsg[]; closed: () => boolean } {
  const posted: TtsOutMsg[] = []
  let closed = false
  const port = {
    postMessage: (m: unknown) => posted.push(m as TtsOutMsg),
    close: () => {
      closed = true
    }
  } as unknown as MessagePortMain
  return { port, posted, closed: () => closed }
}

/** A local handle stub — every method a spy so delegation (and non-delegation of TTS) is observable. */
function makeLocal(): VoiceEngineHandle & Record<string, ReturnType<typeof vi.fn>> {
  return {
    startSession: vi.fn(),
    stopSession: vi.fn(() => Promise.resolve({ frames: 0 })),
    onEngineFailure: vi.fn(),
    startTtsSession: vi.fn(),
    ttsSpeak: vi.fn(),
    ttsCancel: vi.fn(),
    stopTtsSession: vi.fn(),
    onTtsFailure: vi.fn(),
    startKwsSession: vi.fn(),
    stopKwsSession: vi.fn(() => Promise.resolve({ frames: 0 })),
    onKwsFailure: vi.fn(),
    dispose: vi.fn()
  } as unknown as VoiceEngineHandle & Record<string, ReturnType<typeof vi.fn>>
}

/** A controllable speak seam: each call parks until the test resolves/rejects it. */
function makeSpeak(): {
  speak: CloudSpeak
  calls: (CloudSpeakInput & { resolve: () => void; reject: (e: unknown) => void })[]
} {
  const calls: (CloudSpeakInput & { resolve: () => void; reject: (e: unknown) => void })[] = []
  const speak: CloudSpeak = (input) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ ...input, resolve, reject })
    })
  return { speak, calls }
}

const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')
const req = (id: number, text = 'hi') => ({ id, text, sid: 0, speed: 1 })

describe('createCloudTtsEngine — streaming synthesis over the tts port', () => {
  it('streams each pcm run as a 24 kHz tts:chunk then a non-cancelled tts:done', async () => {
    const { speak, calls } = makeSpeak()
    const engine = createCloudTtsEngine({ local: makeLocal(), speak })
    const p = makePort()
    engine.startTtsSession(p.port, null)
    engine.ttsSpeak(req(1))
    await tick()
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toBe('hi')

    calls[0].onAudio(Uint8Array.of(1, 2, 3, 4))
    calls[0].onAudio(Uint8Array.of(5, 6))
    calls[0].resolve()
    await tick()

    expect(p.posted).toEqual([
      { t: 'tts:chunk', id: 1, seq: 0, sampleRate: 24_000, pcm16: b64([1, 2, 3, 4]) },
      { t: 'tts:chunk', id: 1, seq: 1, sampleRate: 24_000, pcm16: b64([5, 6]) },
      { t: 'tts:done', id: 1, cancelled: false }
    ])
  })

  it('runs speaks FIFO and serially — a second speak waits for the first to finish', async () => {
    const { speak, calls } = makeSpeak()
    const engine = createCloudTtsEngine({ local: makeLocal(), speak })
    const p = makePort()
    engine.startTtsSession(p.port, null)
    engine.ttsSpeak(req(1))
    engine.ttsSpeak(req(2))
    await tick()
    expect(calls).toHaveLength(1) // serial: #2 is queued behind #1

    calls[0].resolve()
    await tick()
    expect(calls).toHaveLength(2) // #1 done → #2 starts
    calls[1].resolve()
    await tick()

    const dones = p.posted.filter((m) => m.t === 'tts:done')
    expect(dones).toEqual([
      { t: 'tts:done', id: 1, cancelled: false },
      { t: 'tts:done', id: 2, cancelled: false }
    ])
  })

  it('ttsCancel aborts the in-flight fetch, drops later chunks, and drains the queue as cancelled', async () => {
    const { speak, calls } = makeSpeak()
    const engine = createCloudTtsEngine({ local: makeLocal(), speak })
    const p = makePort()
    engine.startTtsSession(p.port, null)
    engine.ttsSpeak(req(1))
    engine.ttsSpeak(req(2))
    await tick()

    calls[0].onAudio(Uint8Array.of(1, 2)) // one chunk before the barge-in
    engine.ttsCancel()
    // The queued #2 settles cancelled immediately; the in-flight #1's signal is aborted.
    expect(p.posted).toContainEqual({ t: 'tts:done', id: 2, cancelled: true })
    expect(calls[0].signal?.aborted).toBe(true)

    calls[0].onAudio(Uint8Array.of(3, 4)) // post-cancel emit must be dropped (epoch changed)
    calls[0].reject(abortErr())
    await tick()

    const chunks = p.posted.filter((m) => m.t === 'tts:chunk')
    expect(chunks).toEqual([
      { t: 'tts:chunk', id: 1, seq: 0, sampleRate: 24_000, pcm16: b64([1, 2]) }
    ])
    expect(p.posted).toContainEqual({ t: 'tts:done', id: 1, cancelled: true })
    expect(calls).toHaveLength(1) // #2 never ran
  })

  it('posts a fail-visible tts:error (with the classified reason) when synthesis fails', async () => {
    const speak: CloudSpeak = async () => {
      throw new CloudSpeakError('quota', 'HTTP 402', 402)
    }
    const engine = createCloudTtsEngine({ local: makeLocal(), speak })
    const p = makePort()
    engine.startTtsSession(p.port, null)
    engine.ttsSpeak(req(1))
    await tick()
    expect(p.posted).toContainEqual({ t: 'tts:error', id: 1, error: 'quota' })
  })

  it('stopTtsSession + dispose cancel the active synthesis and close the port', async () => {
    const { speak, calls } = makeSpeak()
    const local = makeLocal()
    const engine = createCloudTtsEngine({ local, speak })
    const p = makePort()
    engine.startTtsSession(p.port, null)
    engine.ttsSpeak(req(1))
    await tick()
    engine.stopTtsSession()
    expect(calls[0].signal?.aborted).toBe(true)
    expect(p.closed()).toBe(true)
    engine.dispose()
    expect(local.dispose).toHaveBeenCalled()
  })
})

describe('createCloudTtsEngine — delegation of the non-TTS surface', () => {
  it('delegates STT / KWS / engine-failure / dispose to local, but NOT ttsSpeak', () => {
    const local = makeLocal()
    const engine = createCloudTtsEngine({ local, speak: async () => {} })
    const failCb = (): void => {}
    engine.onEngineFailure(failCb)
    expect(local.onEngineFailure).toHaveBeenCalledWith(failCb)
    engine.startSession({} as MessagePortMain, null)
    expect(local.startSession).toHaveBeenCalled()
    engine.startKwsSession({} as MessagePortMain, null)
    expect(local.startKwsSession).toHaveBeenCalled()
    const ttsFailCb = (): void => {}
    engine.onTtsFailure(ttsFailCb)
    expect(local.onTtsFailure).toHaveBeenCalledWith(ttsFailCb) // host TTS-worker lifecycle stays observable
    // TTS synthesis is cloud-overridden — it must NOT reach the local runner.
    engine.startTtsSession(makePort().port, null)
    engine.ttsSpeak(req(1))
    expect(local.ttsSpeak).not.toHaveBeenCalled()
    expect(local.startTtsSession).not.toHaveBeenCalled()
  })
})
