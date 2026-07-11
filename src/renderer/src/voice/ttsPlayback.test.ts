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
  nextChunkStart
} from './ttsPlayback'
import { EARCONS, earconDuration } from './earcons'

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
