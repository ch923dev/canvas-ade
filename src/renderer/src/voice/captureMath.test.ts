import { describe, expect, it } from 'vitest'
import {
  createCapturePipeline,
  createSilenceWatchdog,
  floatTo16BitPCM,
  frameRms,
  FRAME_SAMPLES,
  LinearResampler,
  SILENT_FRAMES_THRESHOLD,
  TARGET_SAMPLE_RATE
} from './captureMath'

/** Deterministic pseudo-audio (sin) so chunking equivalence tests have non-trivial data. */
function toneChunk(start: number, length: number, rate: number, hz = 440): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * hz * (start + i)) / rate)
  return out
}

describe('LinearResampler', () => {
  it('decimates exactly at an integer ratio (48k → 16k picks every 3rd sample)', () => {
    const r = new LinearResampler(48000, 16000)
    const input = Float32Array.from({ length: 30 }, (_, i) => i) // ramp 0..29
    const out = r.push(input)
    expect(Array.from(out)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27])
  })

  it('is continuous across arbitrary chunk boundaries (split ≡ whole)', () => {
    const whole = new LinearResampler(48000, 16000)
    const split = new LinearResampler(48000, 16000)
    const input = toneChunk(0, 1000, 48000)
    const wholeOut = Array.from(whole.push(input))
    const splitOut: number[] = []
    // Uneven splits — 128-sample quanta plus a ragged tail — must reproduce the same stream.
    for (const [from, to] of [
      [0, 128],
      [128, 256],
      [256, 999],
      [999, 1000]
    ]) {
      splitOut.push(...Array.from(split.push(input.subarray(from, to))))
    }
    expect(splitOut.length).toBe(wholeOut.length)
    for (let i = 0; i < wholeOut.length; i++) {
      expect(splitOut[i]).toBeCloseTo(wholeOut[i], 6)
    }
  })

  it('interpolates linearly at a non-integer ratio (44.1k → 16k)', () => {
    const r = new LinearResampler(44100, 16000)
    // A linear ramp resamples to a linear ramp: out[k] = k * step.
    const input = Float32Array.from({ length: 4410 }, (_, i) => i)
    const out = r.push(input)
    const step = 44100 / 16000
    expect(out.length).toBe(Math.floor((input.length - 1) / step) + 1)
    for (const k of [0, 1, 7, 100, out.length - 1]) {
      expect(out[k]).toBeCloseTo(k * step, 3)
    }
  })

  it('produces ~outRate samples per second of input', () => {
    const r = new LinearResampler(44100, TARGET_SAMPLE_RATE)
    let total = 0
    for (let s = 0; s < 44100; s += 441) total += r.push(toneChunk(s, 441, 44100)).length
    expect(total).toBeGreaterThanOrEqual(TARGET_SAMPLE_RATE - 2)
    expect(total).toBeLessThanOrEqual(TARGET_SAMPLE_RATE + 2)
  })

  it('rejects nonsensical rates', () => {
    expect(() => new LinearResampler(0, 16000)).toThrow()
    expect(() => new LinearResampler(48000, -1)).toThrow()
  })
})

describe('floatTo16BitPCM', () => {
  it('maps the normalized range onto Int16 with clamping', () => {
    const out = floatTo16BitPCM(Float32Array.from([0, 1, -1, 0.5, 2, -2]))
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, 32767, -32768])
  })
})

describe('frameRms', () => {
  it('is exactly 0 for an all-zeros frame (the electron#42714 signature)', () => {
    expect(frameRms(new Int16Array(FRAME_SAMPLES))).toBe(0)
  })

  it('is 1 for a full-scale square wave and ~a/√2 for a sine of amplitude a', () => {
    expect(frameRms(Int16Array.from({ length: 64 }, () => -32768))).toBe(1)
    const sine = floatTo16BitPCM(toneChunk(0, 1600, 16000, 100).map((v) => v * 0.5))
    expect(frameRms(sine)).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })
})

describe('createCapturePipeline', () => {
  it('emits one 1920-sample frame per 5760 input samples at 48k (45 quanta ≈ 120 ms)', () => {
    const p = createCapturePipeline(48000)
    const frames: number[] = []
    for (let q = 0; q < 90; q++) {
      for (const f of p.push(toneChunk(q * 128, 128, 48000))) frames.push(f.frame.length)
    }
    expect(frames).toEqual([FRAME_SAMPLES, FRAME_SAMPLES]) // 90 quanta = 11520 in → 3840 out
  })

  it('carries DC level through resample + Int16 conversion', () => {
    const p = createCapturePipeline(48000)
    const dc = new Float32Array(5760).fill(0.5)
    const [emitted] = p.push(dc)
    expect(emitted.frame[0]).toBe(16384)
    expect(emitted.frame[FRAME_SAMPLES - 1]).toBe(16384)
    expect(emitted.rms).toBeCloseTo(0.5, 3)
  })

  it('reports rms exactly 0 for a silent stream and emits distinct frame buffers', () => {
    const p = createCapturePipeline(48000)
    const [a] = p.push(new Float32Array(5760))
    const [b] = p.push(new Float32Array(5760))
    expect(a.rms).toBe(0)
    expect(b.rms).toBe(0)
    expect(a.frame.buffer).not.toBe(b.frame.buffer) // each frame transferable independently
  })
})

describe('createSilenceWatchdog', () => {
  it(`trips only after ${SILENT_FRAMES_THRESHOLD} consecutive zero frames by default`, () => {
    const w = createSilenceWatchdog()
    for (let i = 0; i < SILENT_FRAMES_THRESHOLD - 1; i++) expect(w.push(0)).toBe(false)
    expect(w.push(0)).toBe(true)
    expect(w.push(0)).toBe(true) // stays tripped while zeros continue
  })

  it('clears immediately on any non-zero frame and restarts the count', () => {
    const w = createSilenceWatchdog(3)
    expect(w.push(0)).toBe(false)
    expect(w.push(0)).toBe(false)
    expect(w.push(0.2)).toBe(false) // real audio → counter resets
    expect(w.push(0)).toBe(false)
    expect(w.push(0)).toBe(false)
    expect(w.push(0)).toBe(true)
    expect(w.push(0.001)).toBe(false) // recovery (e.g. OS grant given mid-session)
  })

  it('reset() clears an in-progress count', () => {
    const w = createSilenceWatchdog(2)
    expect(w.push(0)).toBe(false)
    w.reset()
    expect(w.push(0)).toBe(false)
    expect(w.push(0)).toBe(true)
  })
})
