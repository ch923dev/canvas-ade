import { describe, it, expect, vi } from 'vitest'
import type { MessagePortMain } from 'electron'
import { createCloudSttEngine, type CloudSttEvent, type CloudSymbolSets } from './cloudSttEngine'
import { CloudTranscribeError, type CloudTranscribeInput } from './openaiTranscribe'
import type { VoiceEngineHandle } from './voiceEngine'
import { decodeWav } from './voiceWav'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A fake MessagePortMain: feed inbound messages, capture outbound posts. */
function makePort(): {
  port: MessagePortMain
  send: (m: unknown) => void
  posted: unknown[]
  closed: () => boolean
} {
  let handler: ((e: { data: unknown }) => void) | null = null
  const posted: unknown[] = []
  let closed = false
  const port = {
    on: (_ev: 'message', cb: (e: { data: unknown }) => void) => {
      handler = cb
    },
    postMessage: (m: unknown) => posted.push(m),
    start: () => {},
    close: () => {
      closed = true
    }
  } as unknown as MessagePortMain
  return { port, send: (m) => handler?.({ data: m }), posted, closed: () => closed }
}

/** A local handle stub — every method a spy so delegation is observable. */
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

const frame = (bytes: number[]): { t: 'frame'; d: ArrayBuffer } => ({
  t: 'frame',
  d: Uint8Array.from(bytes).buffer
})

const SYMBOLS: CloudSymbolSets = { bias: ['contextIsolation'], dict: ['contextIsolation'] }

describe('createCloudSttEngine — batch transcribe on eos', () => {
  it('buffers frames, assembles a WAV, emits transcribing then the formatRestore-corrected final', async () => {
    const events: CloudSttEvent[] = []
    let seenWav: Buffer | null = null
    let seenKeyterms: readonly string[] = []
    const engine = createCloudSttEngine({
      local: makeLocal(),
      transcribe: async ({ wav, keyterms }: CloudTranscribeInput) => {
        seenWav = wav
        seenKeyterms = keyterms
        return 'the context isolation flag' // prose form → formatRestore fixes it
      },
      emit: (e) => events.push(e),
      getSymbols: () => SYMBOLS
    })
    const p = makePort()
    engine.startSession(p.port, null)
    p.send(frame([1, 2, 3, 4]))
    p.send(frame([5, 6, 7, 8]))
    const stopP = engine.stopSession()
    p.send({ t: 'eos' })
    const { frames } = await stopP
    await tick()

    expect(frames).toBe(2)
    expect(p.posted).toContainEqual({ t: 'stop' }) // renderer told to release the mic
    expect(seenKeyterms).toEqual(['contextIsolation']) // top-30 bias passed to transcribe
    expect(decodeWav(seenWav!).pcm.equals(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true)
    expect(events).toEqual([
      { kind: 'transcribing' },
      { kind: 'final', text: 'the contextIsolation flag' }
    ])
  })

  it('emits a fail-visible error (not a final) when the transcription fails', async () => {
    const events: CloudSttEvent[] = []
    const engine = createCloudSttEngine({
      local: makeLocal(),
      transcribe: async () => {
        throw new CloudTranscribeError('quota', 'HTTP 402', 402)
      },
      emit: (e) => events.push(e),
      getSymbols: () => SYMBOLS
    })
    const p = makePort()
    engine.startSession(p.port, null)
    p.send(frame([1, 2, 3, 4]))
    await engine.stopSession()
    p.send({ t: 'eos' })
    await tick()
    expect(events).toEqual([{ kind: 'transcribing' }, { kind: 'error', reason: 'quota' }])
  })

  it('drops a stale result when a newer hold supersedes it', async () => {
    const events: CloudSttEvent[] = []
    const d = deferred<string>()
    const engine = createCloudSttEngine({
      local: makeLocal(),
      transcribe: () => d.promise,
      emit: (e) => events.push(e),
      getSymbols: () => SYMBOLS
    })
    const a = makePort()
    engine.startSession(a.port, null)
    a.send(frame([1, 2, 3, 4]))
    await engine.stopSession()
    a.send({ t: 'eos' }) // session A transcription now in flight
    // A newer session starts before A's transcription resolves.
    const b = makePort()
    engine.startSession(b.port, null)
    d.resolve('stale result for A')
    await tick()
    // Only A's 'transcribing' emitted; its final is dropped (superseded), no 'final' event.
    expect(events).toEqual([{ kind: 'transcribing' }])
  })

  it('makes no API call and emits nothing when no audio was captured', async () => {
    const events: CloudSttEvent[] = []
    const transcribe = vi.fn(async () => 'x')
    const engine = createCloudSttEngine({
      local: makeLocal(),
      transcribe,
      emit: (e) => events.push(e),
      getSymbols: () => SYMBOLS
    })
    const p = makePort()
    engine.startSession(p.port, null)
    await engine.stopSession()
    p.send({ t: 'eos' })
    await tick()
    expect(transcribe).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})

describe('createCloudSttEngine — delegation of the non-STT surface', () => {
  it('passes TTS / KWS / failure / dispose straight through to the local handle', () => {
    const local = makeLocal()
    const engine = createCloudSttEngine({
      local,
      transcribe: async () => '',
      emit: () => {},
      getSymbols: () => SYMBOLS
    })
    const failCb = (): void => {}
    engine.onEngineFailure(failCb)
    expect(local.onEngineFailure).toHaveBeenCalledWith(failCb) // host lifecycle stays observable
    engine.startTtsSession({} as MessagePortMain, null)
    expect(local.startTtsSession).toHaveBeenCalled()
    engine.ttsSpeak({ id: 1, text: 'hi', sid: 0, speed: 1 })
    expect(local.ttsSpeak).toHaveBeenCalled()
    engine.startKwsSession({} as MessagePortMain, null)
    expect(local.startKwsSession).toHaveBeenCalled()
    engine.dispose()
    expect(local.dispose).toHaveBeenCalled()
  })
})
