/**
 * Voice V2 — engine-host pure units: Int16→Float32 conversion, the per-session decode
 * loop (createFrameProcessor over a fake RecognizerLike), and the recognizer config
 * shape. The module's utilityProcess main block is guarded on `process.parentPort`, so
 * importing it under vitest is side-effect free.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachSession,
  buildKwsConfig,
  buildRecognizerConfig,
  buildVadConfig,
  createFrameProcessor,
  createKwsProcessor,
  int16ToFloat32,
  type RecognizerLike,
  type SessionPortLike,
  type StreamLike
} from './voiceEngineHost'

const frameOf = (samples: number[]): ArrayBuffer => Int16Array.from(samples).buffer as ArrayBuffer

describe('int16ToFloat32', () => {
  it('scales by 1/32768 with full range intact', () => {
    const out = int16ToFloat32(frameOf([0, 16384, -16384, 32767, -32768]))
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(0.5, 6)
    expect(out[2]).toBeCloseTo(-0.5, 6)
    expect(out[3]).toBeCloseTo(32767 / 32768, 6)
    expect(out[4]).toBe(-1)
  })
})

/** Scripted fake: per-push decode readiness, result text, and endpoint flags. */
function fakeRecognizer(script: Array<{ text: string; endpoint?: boolean; readyCount?: number }>): {
  rec: RecognizerLike
  calls: string[]
} {
  const calls: string[] = []
  let step = -1
  let readyLeft = 0
  const stream: StreamLike = {
    acceptWaveform: () => {
      step++
      readyLeft = script[step]?.readyCount ?? 1
      calls.push(`accept:${step}`)
    }
  }
  const rec: RecognizerLike = {
    createStream: () => stream,
    isReady: () => readyLeft > 0,
    decode: () => {
      readyLeft--
      calls.push('decode')
    },
    isEndpoint: () => !!script[step]?.endpoint,
    reset: () => calls.push('reset'),
    getResult: () => ({ text: script[step]?.text ?? '' })
  }
  return { rec, calls }
}

describe('createFrameProcessor', () => {
  it('null recognizer degrades to counting only (model-absent e2e path)', () => {
    const post = vi.fn()
    const proc = createFrameProcessor(null, post)
    proc.push(frameOf([1, 2, 3]))
    proc.push(frameOf([4, 5, 6]))
    expect(proc.frames()).toBe(2)
    expect(post).not.toHaveBeenCalled()
  })

  it('posts a partial only when the text changes', () => {
    const { rec } = fakeRecognizer([
      { text: '' }, // silence — nothing yet
      { text: 'hello' },
      { text: 'hello' }, // unchanged → no repost
      { text: 'hello world' }
    ])
    const post = vi.fn()
    const proc = createFrameProcessor(rec, post)
    for (let i = 0; i < 4; i++) proc.push(frameOf([0]))
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      { t: 'partial', text: 'hello' },
      { t: 'partial', text: 'hello world' }
    ])
    expect(proc.frames()).toBe(4)
  })

  it('endpoint posts a final, resets the stream, and clears the partial dedupe', () => {
    const { rec, calls } = fakeRecognizer([
      { text: 'stop now', endpoint: true },
      { text: 'stop now' } // same text again AFTER reset → must re-post as a new partial
    ])
    const post = vi.fn()
    const proc = createFrameProcessor(rec, post)
    proc.push(frameOf([0]))
    proc.push(frameOf([0]))
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      { t: 'partial', text: 'stop now' },
      { t: 'final', text: 'stop now' },
      { t: 'partial', text: 'stop now' }
    ])
    expect(calls).toContain('reset')
  })

  it('drains decode while the stream is ready', () => {
    const { rec, calls } = fakeRecognizer([{ text: 'x', readyCount: 3 }])
    createFrameProcessor(rec, vi.fn()).push(frameOf([0]))
    expect(calls.filter((c) => c === 'decode')).toHaveLength(3)
  })

  it('a silent endpoint (empty text) resets without posting a final', () => {
    const { rec, calls } = fakeRecognizer([{ text: '', endpoint: true }])
    const post = vi.fn()
    createFrameProcessor(rec, post).push(frameOf([0]))
    expect(post).not.toHaveBeenCalled()
    expect(calls).toContain('reset')
  })
})

class FakePort implements SessionPortLike {
  listeners: Array<(e: { data: unknown }) => void> = []
  posted: unknown[] = []
  started = false
  closed = false
  throwOnPost = false
  on(event: 'message', listener: (e: { data: unknown }) => void): this {
    if (event === 'message') this.listeners.push(listener)
    return this
  }
  start(): void {
    this.started = true
  }
  postMessage(msg: unknown): void {
    if (this.throwOnPost) throw new Error('port closed')
    this.posted.push(msg)
  }
  close(): void {
    this.closed = true
  }
  emit(data: unknown): void {
    for (const l of this.listeners) l({ data })
  }
}

const frameMsg = (bytes = 3840): { t: string; d: ArrayBuffer } => ({
  t: 'frame',
  d: new ArrayBuffer(bytes)
})

describe('attachSession (drain protocol)', () => {
  afterEach(() => vi.useRealTimers())

  it('starts the port, counts well-formed frames only, ignores junk', () => {
    const port = new FakePort()
    const s = attachSession(port, null)
    expect(port.started).toBe(true)
    port.emit(frameMsg())
    port.emit(frameMsg())
    port.emit(null)
    port.emit('junk')
    port.emit({ t: 'frame', d: 'not-a-buffer' })
    expect(s.frames()).toBe(2)
  })

  it('requestStop posts {t:stop} and reports ONLY after eos — frames queued behind the stop are still counted (the under-count race)', () => {
    const port = new FakePort()
    const s = attachSession(port, null)
    port.emit(frameMsg())
    const onDone = vi.fn()
    s.requestStop(onDone)
    expect(port.posted).toEqual([{ t: 'stop' }])
    // Frames that were already in flight land AFTER the stop request…
    port.emit(frameMsg())
    port.emit(frameMsg())
    expect(onDone).not.toHaveBeenCalled() // …and the report waits for the sentinel.
    port.emit({ t: 'eos' })
    expect(onDone).toHaveBeenCalledWith(3)
    expect(port.closed).toBe(true)
  })

  it('requestStop falls back to the timeout when no eos ever arrives (renderer gone)', () => {
    vi.useFakeTimers()
    const port = new FakePort()
    const s = attachSession(port, null)
    port.emit(frameMsg())
    const onDone = vi.fn()
    s.requestStop(onDone, 1000)
    vi.advanceTimersByTime(1001)
    expect(onDone).toHaveBeenCalledWith(1)
    expect(port.closed).toBe(true)
    // A late eos after the timeout must not double-report.
    port.emit({ t: 'eos' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('endNow tears down without a report; a dead-port throw is swallowed', () => {
    const port = new FakePort()
    const s = attachSession(port, null)
    s.endNow()
    expect(port.posted).toEqual([{ t: 'stop' }])
    expect(port.closed).toBe(true)
    const dead = new FakePort()
    dead.throwOnPost = true
    expect(() => attachSession(dead, null).endNow()).not.toThrow()
    expect(dead.closed).toBe(true)
  })

  it('logs cadence every 8th frame under debug with the injected clock', () => {
    const port = new FakePort()
    const log = vi.fn()
    let nowMs = 0
    attachSession(port, null, { debug: true, log, now: () => nowMs })
    for (let i = 0; i < 8; i++) {
      nowMs = (i + 1) * 120
      port.emit(frameMsg())
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('[voice] host: 8 frames, 8.3/s, 3840 B each, decode=none')
  })

  it('forwards each counted frame to the decode sink (the worker client seam)', () => {
    const port = new FakePort()
    const sink = vi.fn()
    const s = attachSession(port, sink)
    port.emit(frameMsg())
    port.emit(frameMsg())
    port.emit({ t: 'frame', d: 'not-a-buffer' }) // junk: neither counted nor forwarded
    expect(s.frames()).toBe(2)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer)
  })
})

/** Scripted VadLike: isDetected() per push (true = in-speech). */
function fakeVad(detected: boolean[]): {
  vad: { acceptWaveform: (s: Float32Array) => void; isDetected: () => boolean }
  fed: number[]
} {
  const fed: number[] = []
  let i = -1
  return {
    fed,
    vad: {
      acceptWaveform: (s: Float32Array) => {
        i++
        fed.push(s.length)
      },
      isDetected: () => detected[i] ?? false
    }
  }
}

describe('createFrameProcessor — silero VAD endpoint accelerator (V5)', () => {
  it('forces a final once VAD-silence accumulates past the threshold with pending text', () => {
    // Speech on frames 0-1 (partial appears), VAD silence from frame 2 on. With 120 ms
    // frames and a 300 ms threshold, the 3rd consecutive silent frame (≥360 ms) finalizes.
    const script = Array.from({ length: 6 }, () => ({ text: 'hello world' }))
    const { rec, calls } = fakeRecognizer(script)
    const { vad } = fakeVad([true, true, false, false, false, false])
    const post = vi.fn()
    const proc = createFrameProcessor(rec, post, { vad, frameMs: 120, vadFinalizeMs: 300 })
    for (let i = 0; i < 5; i++) proc.push(frameOf([0]))
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      { t: 'partial', text: 'hello world' },
      { t: 'final', text: 'hello world' } // fired on frame index 4 (3rd silent frame)
    ])
    expect(calls).toContain('reset')
  })

  it('never VAD-finalizes without pending text (leading silence)', () => {
    const script = Array.from({ length: 10 }, () => ({ text: '' }))
    const { rec, calls } = fakeRecognizer(script)
    const { vad } = fakeVad(Array(10).fill(false))
    const post = vi.fn()
    const proc = createFrameProcessor(rec, post, { vad, vadFinalizeMs: 300 })
    for (let i = 0; i < 10; i++) proc.push(frameOf([0]))
    expect(post).not.toHaveBeenCalled()
    expect(calls).not.toContain('reset')
  })

  it('speech resets the silence accumulator (mid-utterance pauses never split)', () => {
    // silent, silent, SPEECH, silent, silent — never ≥3 consecutive silent frames.
    const script = Array.from({ length: 5 }, () => ({ text: 'hi' }))
    const { rec } = fakeRecognizer(script)
    const { vad } = fakeVad([false, false, true, false, false])
    const post = vi.fn()
    const proc = createFrameProcessor(rec, post, { vad, frameMs: 120, vadFinalizeMs: 300 })
    for (let i = 0; i < 5; i++) proc.push(frameOf([0]))
    expect(post.mock.calls.map((c) => c[0])).toEqual([{ t: 'partial', text: 'hi' }])
  })

  it('feeds the VAD the same float frame the recognizer gets', () => {
    const { rec } = fakeRecognizer([{ text: '' }])
    const { vad, fed } = fakeVad([true])
    createFrameProcessor(rec, vi.fn(), { vad }).push(frameOf([1, 2, 3, 4]))
    expect(fed).toEqual([4])
  })

  it('a sherpa endpoint still resets the VAD silence accumulator', () => {
    // Frame 0: endpoint fires with text (sherpa rule) → reset. Frames 1-2 silent but the
    // accumulator restarted at the endpoint → no premature second final.
    const { rec } = fakeRecognizer([{ text: 'done', endpoint: true }, { text: '' }, { text: '' }])
    const { vad } = fakeVad([false, false, false])
    const post = vi.fn()
    const proc = createFrameProcessor(rec, post, { vad, frameMs: 120, vadFinalizeMs: 300 })
    for (let i = 0; i < 3; i++) proc.push(frameOf([0]))
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      { t: 'partial', text: 'done' },
      { t: 'final', text: 'done' }
    ])
  })
})

describe('buildRecognizerConfig', () => {
  it('pins 16 kHz features, greedy search, and the V5-tuned endpoint rules', () => {
    const cfg = buildRecognizerConfig({
      encoder: 'E',
      decoder: 'D',
      joiner: 'J',
      tokens: 'T'
    }) as Record<string, unknown>
    expect(cfg).toMatchObject({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: 'E', decoder: 'D', joiner: 'J' },
        tokens: 'T',
        provider: 'cpu'
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      // V5 tuning: snappier finals (finals only append to the draft, never submit).
      rule2MinTrailingSilence: 1.0
    })
  })
})

describe('buildVadConfig', () => {
  it('pins the silero v4 shape: 512-sample windows at 16 kHz, single thread', () => {
    const cfg = buildVadConfig('C:/models/silero_vad.onnx') as Record<string, unknown>
    expect(cfg).toMatchObject({
      sileroVad: { model: 'C:/models/silero_vad.onnx', windowSize: 512 },
      sampleRate: 16000,
      numThreads: 1,
      provider: 'cpu'
    })
  })
})

describe('createKwsProcessor (J5 wake word)', () => {
  interface FakeKws {
    accepted: number[]
    resets: number
    queue: string[] // getResult answers, consumed decode-by-decode
  }
  const makeFakeSpotter = (): {
    spotter: import('./voiceEngineHost').KeywordSpotterLike
    state: FakeKws
  } => {
    const state: FakeKws = { accepted: 0 as unknown as number[], resets: 0, queue: [] }
    let pending = 0
    let accepted = 0
    const spotter: import('./voiceEngineHost').KeywordSpotterLike = {
      createStream: () => ({
        acceptWaveform: (w: { samples: Float32Array }) => {
          accepted += w.samples.length
          pending++
        }
      }),
      isReady: () => pending > 0,
      decode: () => {
        pending--
      },
      reset: () => {
        state.resets++
      },
      getResult: () => ({ keyword: state.queue.shift() ?? '' })
    }
    Object.defineProperty(state, 'accepted', { get: () => accepted })
    return { spotter, state }
  }

  it('posts {t:"wake"} on a detection and resets the stream, then keeps listening', () => {
    const { spotter, state } = makeFakeSpotter()
    const posted: Array<{ t: string; keyword: string }> = []
    const proc = createKwsProcessor(spotter, (m) => posted.push(m))
    state.queue.push('', 'HEY JARVIS', '')
    proc.push(new Int16Array(1920).buffer)
    proc.push(new Int16Array(1920).buffer)
    proc.push(new Int16Array(1920).buffer)
    expect(posted).toEqual([{ t: 'wake', keyword: 'HEY JARVIS' }])
    expect(state.resets).toBe(1)
    expect(proc.frames()).toBe(3)
  })

  it('a null spotter counts frames only (model-less degrade)', () => {
    const posted: unknown[] = []
    const proc = createKwsProcessor(null, (m) => posted.push(m))
    proc.push(new Int16Array(1920).buffer)
    expect(proc.frames()).toBe(1)
    expect(posted).toEqual([])
  })

  it('buildKwsConfig wires the transducer trio + the keywords file', () => {
    const cfg = buildKwsConfig({
      encoder: 'e.onnx',
      decoder: 'd.onnx',
      joiner: 'j.onnx',
      tokens: 't.txt',
      keywords: 'k.txt'
    }) as {
      modelConfig: { transducer: { encoder: string }; tokens: string }
      keywordsFile: string
      keywordsThreshold: number
    }
    expect(cfg.modelConfig.transducer.encoder).toBe('e.onnx')
    expect(cfg.modelConfig.tokens).toBe('t.txt')
    expect(cfg.keywordsFile).toBe('k.txt')
    expect(cfg.keywordsThreshold).toBeCloseTo(0.25)
  })
})
