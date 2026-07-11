/**
 * Jarvis J2 — TTS runner units: the speak queue pure over OfflineTtsLike (fake engine,
 * no addon). Contract: FIFO serial synthesis, the chunk-stream shape (exactly-sized
 * COPIED buffers + self-described sampleRate), cancel = the active synth stops at its
 * next onProgress (return 0) while queued ids close with `{cancelled:true}` dones, and
 * a null engine answers every speak with tts:error instead of synthesizing.
 */
import { describe, expect, it } from 'vitest'
import {
  createTtsRunner,
  type OfflineTtsLike,
  type TtsOutMsg,
  type TtsSpeakReq
} from './voiceEngineHost'

interface FakeCall {
  text: string
  sid: number
  speed: number
  onProgress?: (samples: Float32Array, progress: number) => number | boolean
  resolve: () => void
  reject: (err: Error) => void
}

function makeFakeTts(sampleRate = 24000): { tts: OfflineTtsLike; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const tts: OfflineTtsLike = {
    sampleRate,
    numSpeakers: 1,
    generateAsync(req) {
      return new Promise((resolve, reject) => {
        calls.push({
          text: req.text,
          sid: req.sid,
          speed: req.speed,
          onProgress: req.onProgress,
          resolve: () => resolve({ samples: new Float32Array(0), sampleRate }),
          reject
        })
      })
    }
  }
  return { tts, calls }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const req = (id: number, text = `utterance ${id}`): TtsSpeakReq => ({
  id,
  text,
  sid: 4,
  speed: 1.0
})

describe('createTtsRunner', () => {
  it('synthesizes a speak: chunks stream with seq + sampleRate, then a non-cancelled done', async () => {
    const { tts, calls } = makeFakeTts(24000)
    const posted: TtsOutMsg[] = []
    const runner = createTtsRunner(tts, (m) => posted.push(m))

    runner.speak(req(1, 'hello there'))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ text: 'hello there', sid: 4, speed: 1.0 })

    expect(calls[0].onProgress!(Float32Array.from([0.1, -0.2]), 0.5)).toBe(1)
    expect(calls[0].onProgress!(Float32Array.from([0.3]), 1)).toBe(1)
    calls[0].resolve()
    await tick()

    expect(posted).toEqual([
      { t: 'tts:chunk', id: 1, seq: 0, sampleRate: 24000, d: expect.any(ArrayBuffer) },
      { t: 'tts:chunk', id: 1, seq: 1, sampleRate: 24000, d: expect.any(ArrayBuffer) },
      { t: 'tts:done', id: 1, cancelled: false }
    ])
    const first = posted[0] as { d: ArrayBuffer }
    expect(Array.from(new Float32Array(first.d))).toEqual([
      0.10000000149011612, -0.20000000298023224
    ])
  })

  it('posts an exactly-sized COPY (a view into a larger buffer does not leak its backing)', () => {
    const { tts, calls } = makeFakeTts()
    const posted: TtsOutMsg[] = []
    createTtsRunner(tts, (m) => posted.push(m)).speak(req(1))

    const backing = new Float32Array(8).fill(9)
    const view = backing.subarray(2, 4) // 2 samples inside an 8-sample buffer
    view[0] = 0.5
    view[1] = -0.5
    calls[0].onProgress!(view, 0.5)
    backing.fill(0) // engine reuses its native memory after the callback returns

    const chunk = posted[0] as { d: ArrayBuffer }
    expect(chunk.d.byteLength).toBe(2 * 4)
    expect(Array.from(new Float32Array(chunk.d))).toEqual([0.5, -0.5])
  })

  it('runs speaks serially FIFO: the second synth starts only after the first resolves', async () => {
    const { tts, calls } = makeFakeTts()
    const posted: TtsOutMsg[] = []
    const runner = createTtsRunner(tts, (m) => posted.push(m))

    runner.speak(req(1))
    runner.speak(req(2))
    expect(calls).toHaveLength(1)

    calls[0].resolve()
    await tick()
    expect(calls).toHaveLength(2)
    expect(calls[1].text).toBe('utterance 2')
    calls[1].resolve()
    await tick()
    expect(posted).toEqual([
      { t: 'tts:done', id: 1, cancelled: false },
      { t: 'tts:done', id: 2, cancelled: false }
    ])
  })

  it('cancel stops the active synth at its next onProgress and drains the queue with cancelled dones', async () => {
    const { tts, calls } = makeFakeTts()
    const posted: TtsOutMsg[] = []
    const runner = createTtsRunner(tts, (m) => posted.push(m))

    runner.speak(req(1))
    runner.speak(req(2))
    expect(calls[0].onProgress!(Float32Array.from([0.1]), 0.3)).toBe(1)

    runner.cancel()
    // Queued id 2 closes immediately; its generateAsync is never invoked.
    expect(posted).toContainEqual({ t: 'tts:done', id: 2, cancelled: true })
    // The active synth's next progress callback returns 0 — sherpa cancels the rest.
    expect(calls[0].onProgress!(Float32Array.from([0.2]), 0.6)).toBe(0)
    calls[0].resolve()
    await tick()

    expect(calls).toHaveLength(1)
    expect(posted.filter((m) => m.t === 'tts:chunk')).toHaveLength(1) // nothing after cancel
    expect(posted).toContainEqual({ t: 'tts:done', id: 1, cancelled: true })
  })

  it('a speak AFTER a cancel synthesizes normally (epoch isolation)', async () => {
    const { tts, calls } = makeFakeTts()
    const posted: TtsOutMsg[] = []
    const runner = createTtsRunner(tts, (m) => posted.push(m))

    runner.speak(req(1))
    runner.cancel()
    calls[0].resolve()
    await tick()

    runner.speak(req(2))
    expect(calls).toHaveLength(2)
    expect(calls[1].onProgress!(Float32Array.from([0.1]), 1)).toBe(1)
    calls[1].resolve()
    await tick()
    expect(posted).toContainEqual({ t: 'tts:done', id: 2, cancelled: false })
  })

  it('a rejecting synth posts tts:error and the queue continues to the next request', async () => {
    const { tts, calls } = makeFakeTts()
    const posted: TtsOutMsg[] = []
    const runner = createTtsRunner(tts, (m) => posted.push(m))

    runner.speak(req(1))
    runner.speak(req(2))
    calls[0].reject(new Error('onnx graph exploded'))
    await tick()

    expect(posted[0]).toEqual({ t: 'tts:error', id: 1, error: 'onnx graph exploded' })
    expect(calls).toHaveLength(2)
    calls[1].resolve()
    await tick()
    expect(posted).toContainEqual({ t: 'tts:done', id: 2, cancelled: false })
  })

  it('a null engine (model absent / init failed) answers speaks with tts:error', () => {
    const posted: TtsOutMsg[] = []
    const runner = createTtsRunner(null, (m) => posted.push(m))
    runner.speak(req(7))
    expect(posted).toEqual([{ t: 'tts:error', id: 7, error: 'tts model not loaded' }])
    runner.cancel() // safe no-op
  })
})
