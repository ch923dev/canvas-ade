/**
 * Jarvis J2 — playback scheduling units: the pure ledger (gapless butt-joining, lead-in,
 * flush, speaking horizon) and the earcon envelope data. The AudioContext glue is thin
 * DOM plumbing exercised by the manual dev check; the math lives here.
 */
import { describe, expect, it } from 'vitest'
import {
  DUCK_SECONDS,
  SCHEDULE_LEAD_SECONDS,
  createPlaybackLedger,
  createTtsPlayer,
  nextChunkStart,
  pcm16Base64ToFloat32
} from './ttsPlayback'
import { EARCONS, earconDuration } from './earcons'

describe('createTtsPlayer.attached (the speakText re-broker signal)', () => {
  it('false before attach, true after, false again after dispose', () => {
    // A rebuilt player (effect re-run — dev HMR, React remount) starts portless while
    // the store still says sessionLive; speakText keys the voice:tts:start re-broker
    // on this flag (the stuck-"Synthesizing…" dev-check regression).
    const player = createTtsPlayer()
    expect(player.attached()).toBe(false)
    const stub = { close(): void {}, onmessage: null } as unknown as MessagePort
    player.attach(stub)
    expect(player.attached()).toBe(true)
    player.dispose()
    expect(player.attached()).toBe(false)
  })
})

/** Mirrors main/voiceEngineHost.floatToPcm16Base64 (renderer tests can't import the
 *  host module — it pulls worker_threads into the web project). Keep in lockstep. */
function encodePcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  let bin = ''
  const bytes = new Uint8Array(pcm.buffer)
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

describe('pcm16Base64ToFloat32 (the port chunk decoding)', () => {
  it('round-trips PCM within 16-bit quantization error', () => {
    const src = Float32Array.from([0, 0.5, -0.5, 0.999, -1, 0.0003])
    const out = pcm16Base64ToFloat32(encodePcm16Base64(src))
    expect(out).toHaveLength(src.length)
    for (let i = 0; i < src.length; i++) expect(out[i]).toBeCloseTo(src[i], 3)
  })

  it('decodes empty input to an empty buffer (no throw)', () => {
    expect(pcm16Base64ToFloat32('')).toHaveLength(0)
  })
})

describe('nextChunkStart', () => {
  it('starts a fresh burst just ahead of now', () => {
    expect(nextChunkStart(10, 0)).toBeCloseTo(10 + SCHEDULE_LEAD_SECONDS)
  })
  it('butt-joins to the horizon while audio is queued ahead', () => {
    expect(nextChunkStart(10, 12.5)).toBe(12.5)
  })
  it('re-leads when the horizon fell behind (queue drained)', () => {
    expect(nextChunkStart(20, 12.5)).toBeCloseTo(20 + SCHEDULE_LEAD_SECONDS)
  })
})

describe('createPlaybackLedger', () => {
  it('schedules chunks gaplessly and tracks the speaking horizon', () => {
    const l = createPlaybackLedger(0.03)
    const a = l.schedule(1, 2.0, 10)
    expect(a.startAt).toBeCloseTo(10.03)
    const b = l.schedule(1, 1.5, 10.5) // arrives while the first still plays
    expect(b.startAt).toBeCloseTo(12.03) // butt-joined, no gap and no overlap
    expect(l.speaking(13)).toBe(true)
    expect(l.remaining(13)).toBeCloseTo(0.53)
    expect(l.speaking(13.6)).toBe(false)
    expect(l.remaining(13.6)).toBe(0)
  })

  it('a second utterance queues after the first (clause boundary = chunk boundary)', () => {
    const l = createPlaybackLedger(0.03)
    l.schedule(1, 3.0, 0)
    const next = l.schedule(2, 1.0, 1.0)
    expect(next.startAt).toBeCloseTo(3.03)
  })

  it('flush resets the horizon — the next chunk starts fresh', () => {
    const l = createPlaybackLedger(0.03)
    l.schedule(1, 5.0, 0)
    expect(l.speaking(1)).toBe(true)
    l.flush()
    expect(l.speaking(1)).toBe(false)
    expect(l.schedule(2, 1.0, 1).startAt).toBeCloseTo(1.03)
  })
})

describe('duck + earcon envelopes', () => {
  it('the duck window stays inside the D6 ≤100 ms budget', () => {
    expect(DUCK_SECONDS).toBeLessThanOrEqual(0.1)
  })
  it('every earcon is a sub-200 ms low-peak cue', () => {
    for (const notes of Object.values(EARCONS)) {
      expect(earconDuration(notes)).toBeLessThanOrEqual(0.2)
      for (const n of notes) expect(n.peak).toBeLessThanOrEqual(0.2)
    }
  })
})
