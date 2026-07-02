/**
 * Voice V2 — engine-host pure units: Int16→Float32 conversion, the per-session decode
 * loop (createFrameProcessor over a fake RecognizerLike), and the recognizer config
 * shape. The module's utilityProcess main block is guarded on `process.parentPort`, so
 * importing it under vitest is side-effect free.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildRecognizerConfig,
  createFrameProcessor,
  int16ToFloat32,
  type RecognizerLike,
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

describe('buildRecognizerConfig', () => {
  it('pins 16 kHz features, greedy search, and the plan-V2 endpoint rules', () => {
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
      rule2MinTrailingSilence: 1.2
    })
  })
})
