/**
 * Jarvis J2 — TTS runner units: the speak queue pure over OfflineTtsLike (fake engine,
 * no addon). Contract: FIFO serial synthesis, the chunk-stream shape (plain-JSON
 * base64-PCM16 payloads + self-described sampleRate — the only encoding that survives
 * the worker→host→port hops in Electron's caged Node), cancel = the active synth stops
 * at its next onProgress (return 0) while queued ids close with `{cancelled:true}`
 * dones, and a null engine answers every speak with tts:error instead of synthesizing.
 */
import { describe, expect, it } from 'vitest'
import {
  clampSid,
  createTtsRunner,
  evictAllBut,
  floatToPcm16Base64,
  type OfflineTtsLike,
  type TtsOutMsg,
  type TtsSpeakReq
} from './voiceTtsRunner'

interface FakeCall {
  text: string
  sid: number
  speed: number
  onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean
  resolve: () => void
  reject: (err: Error) => void
}

function makeFakeTts(
  sampleRate = 24000,
  numSpeakers = 8 // roomy default: the shared `req()` fixture speaks as sid 4 unclamped
): { tts: OfflineTtsLike; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const tts: OfflineTtsLike = {
    sampleRate,
    numSpeakers,
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

/** Node pools small Buffers — .buffer alone is the WHOLE pool; honor the view. */
const i16 = (b: Buffer): Int16Array => new Int16Array(b.buffer, b.byteOffset, b.length / 2)

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

    expect(calls[0].onProgress!({ samples: Float32Array.from([0.1, -0.2]), progress: 0.5 })).toBe(1)
    expect(calls[0].onProgress!({ samples: Float32Array.from([0.3]), progress: 1 })).toBe(1)
    calls[0].resolve()
    await tick()

    expect(posted).toEqual([
      { t: 'tts:chunk', id: 1, seq: 0, sampleRate: 24000, pcm16: expect.any(String) },
      { t: 'tts:chunk', id: 1, seq: 1, sampleRate: 24000, pcm16: expect.any(String) },
      { t: 'tts:done', id: 1, cancelled: false }
    ])
    const first = posted[0] as { pcm16: string }
    const decoded = i16(Buffer.from(first.pcm16, 'base64'))
    expect(decoded).toHaveLength(2)
    expect(decoded[0] / 32767).toBeCloseTo(0.1, 3)
    expect(decoded[1] / 32768).toBeCloseTo(-0.2, 3)
  })

  it('encodes a plain-JSON COPY in the callback (native backing reuse cannot corrupt it)', () => {
    const { tts, calls } = makeFakeTts()
    const posted: TtsOutMsg[] = []
    createTtsRunner(tts, (m) => posted.push(m)).speak(req(1))

    const backing = new Float32Array(8).fill(9)
    const view = backing.subarray(2, 4) // 2 samples inside an 8-sample buffer
    view[0] = 0.5
    view[1] = -0.5
    calls[0].onProgress!({ samples: view, progress: 0.5 })
    backing.fill(0) // engine reuses its native memory after the callback returns

    const chunk = posted[0] as { pcm16: string }
    const decoded = i16(Buffer.from(chunk.pcm16, 'base64'))
    expect(decoded).toHaveLength(2)
    expect(decoded[0] / 32767).toBeCloseTo(0.5, 3)
    expect(decoded[1] / 32768).toBeCloseTo(-0.5, 3)
  })

  it('floatToPcm16Base64 clamps out-of-range samples and round-trips the payload', () => {
    const b64 = floatToPcm16Base64(Float32Array.from([2, -2, 0]))
    const decoded = i16(Buffer.from(b64, 'base64'))
    expect(Array.from(decoded)).toEqual([32767, -32768, 0])
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
    expect(calls[0].onProgress!({ samples: Float32Array.from([0.1]), progress: 0.3 })).toBe(1)

    runner.cancel()
    // Queued id 2 closes immediately; its generateAsync is never invoked.
    expect(posted).toContainEqual({ t: 'tts:done', id: 2, cancelled: true })
    // The active synth's next progress callback returns 0 — sherpa cancels the rest.
    expect(calls[0].onProgress!({ samples: Float32Array.from([0.2]), progress: 0.6 })).toBe(0)
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
    expect(calls[1].onProgress!({ samples: Float32Array.from([0.1]), progress: 1 })).toBe(1)
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

describe('clampSid (TTS-5)', () => {
  it('bounds the sid to the live engine speaker count', () => {
    expect(clampSid(4, 1)).toBe(0) // Kokoro sid on a single-speaker Piper swap
    expect(clampSid(5, 2)).toBe(1)
    expect(clampSid(1, 8)).toBe(1) // in-range passes untouched
    expect(clampSid(-3, 2)).toBe(0) // defensive floor
  })

  it('passes the sid through when the engine reports no usable count', () => {
    expect(clampSid(4, 0)).toBe(4)
    expect(clampSid(4, -1)).toBe(4)
    expect(clampSid(4, NaN)).toBe(4)
    expect(clampSid(4, 2.5)).toBe(4)
  })

  it('the runner clamps at generateAsync time (config switch mid-session)', async () => {
    const { tts, calls } = makeFakeTts(22050, 2) // two-speaker engine
    const runner = createTtsRunner(tts, () => {})
    runner.speak({ id: 1, text: 'hi', sid: 47, speed: 1.0 }) // stale Kokoro sid
    await tick()
    expect(calls[0].sid).toBe(1) // bounded, never an out-of-range native index
    calls[0].resolve()
  })
})

describe('evictAllBut (TTS-7)', () => {
  it('drops every entry except the kept key and reports the count', () => {
    const cache = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3]
    ])
    expect(evictAllBut(cache, 'b')).toBe(2)
    expect([...cache.keys()]).toEqual(['b'])
  })

  it('an undefined keep empties the cache (current model has no such file)', () => {
    const cache = new Map([['a', 1]])
    expect(evictAllBut(cache, undefined)).toBe(1)
    expect(cache.size).toBe(0)
  })

  it('a keep-only cache is a no-op', () => {
    const cache = new Map([['a', 1]])
    expect(evictAllBut(cache, 'a')).toBe(0)
    expect(cache.size).toBe(1)
  })
})
