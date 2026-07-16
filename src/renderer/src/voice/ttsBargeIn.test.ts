/**
 * Jarvis J2 — barge-in detector units (D6): the transcription gate with its echo filter
 * (self-capture partials never interrupt; real utterances do) and the half-duplex RMS
 * gate (sustained elevated bursts only). Pure — no audio, no store.
 */
import { describe, expect, it } from 'vitest'
import {
  RMS_BARGE_SUSTAIN_MS,
  RMS_BARGE_THRESHOLD,
  createBargeInDetector,
  looksLikeEcho,
  normalizeTokens
} from './ttsBargeIn'
import { SILENCE_RMS } from '../store/voiceStore'

describe('normalizeTokens / looksLikeEcho', () => {
  it('normalizes case, punctuation and whitespace', () => {
    expect(normalizeTokens("  Done — the AUTH terminal's running! ")).toEqual([
      'done',
      'the',
      'auth',
      "terminal's",
      'running'
    ])
  })

  it('flags a partial that is a fragment of the spoken text as echo', () => {
    const spoken = ['Done. The auth terminal is running in the top right group.']
    expect(looksLikeEcho('the auth terminal is running', spoken)).toBe(true)
    // STT re-casing AND word-dropping ("is" lost) — the skip-distance pair match.
    expect(looksLikeEcho('AUTH TERMINAL RUNNING', spoken)).toBe(true)
  })

  it('does not flag a genuinely different utterance', () => {
    const spoken = ['Done. The auth terminal is running in the top right group.']
    expect(looksLikeEcho('stop please', spoken)).toBe(false)
    expect(looksLikeEcho('open a browser on localhost', spoken)).toBe(false)
  })

  it('word-bag overlap is NOT echo: commands reusing spoken words still interrupt', () => {
    // The live-drill regression: the preview said "…and I will stop", the user said
    // "stop Stop, stop" — every token was in the spoken bag, but no word PAIR mirrors
    // the spoken order, so it must interrupt.
    const spoken = ['Keep talking over me at any time, and I will stop.']
    expect(looksLikeEcho('stop Stop, stop', spoken)).toBe(false)
    expect(looksLikeEcho('stop talking', spoken)).toBe(false) // words present, pair not
  })

  it('pairs never straddle a sentence boundary (the "stop right now" live regression)', () => {
    // Second live drill: the preview said "…and I will stop. Right now I am reading…";
    // the user said "Stop right now" repeatedly — the boundary-crossing pair
    // "stop right" plus the sentence-2 opener "right now" hit 4/5 bigrams and the
    // interrupt was swallowed for three consecutive partials.
    const spoken = [
      'Keep talking over me at any time, and I will stop. ' +
        'Right now I am reading a deliberately long passage.'
    ]
    expect(looksLikeEcho('Stop right now. Stop right now', spoken)).toBe(false)
    // A genuine echo of either single sentence still filters.
    expect(looksLikeEcho('right now I am reading a deliberately long', spoken)).toBe(true)
  })

  it('a single-word partial is never echo (one-word commands are the common interrupt)', () => {
    expect(looksLikeEcho('stop', ['and I will stop now'])).toBe(false)
    expect(looksLikeEcho('wait', ['wait for the build to finish'])).toBe(false)
  })

  it('an empty partial is vacuously echo (nothing to interrupt with)', () => {
    expect(looksLikeEcho('   ', ['whatever'])).toBe(true)
    expect(looksLikeEcho('!!', ['whatever'])).toBe(true)
  })
})

describe('createBargeInDetector — full duplex (transcription-gated)', () => {
  const spoken = ['One moment, tidying the canvas now.']

  it('interrupts on a real utterance, never on echo or sub-word noise', () => {
    const d = createBargeInDetector(() => 'full')
    expect(d.onPartial('hey stop', spoken)).toBe(true)
    expect(d.onPartial('tidying the canvas', spoken)).toBe(false) // echo
    expect(d.onPartial('a', spoken)).toBe(false) // below MIN_PARTIAL_CHARS
  })

  it('RMS safety net: sustained loud speech fires without a partial, on a longer sustain', () => {
    // AEC double-talk suppression / decoder CPU starvation can eat the partial
    // entirely — the live-drill "sometimes it does not capture" finding.
    const d = createBargeInDetector(() => 'full')
    expect(d.onLevel(RMS_BARGE_THRESHOLD, RMS_BARGE_SUSTAIN_MS)).toBe(false) // half-gate sustain: not yet
    expect(d.onLevel(RMS_BARGE_THRESHOLD, RMS_BARGE_SUSTAIN_MS)).toBe(true) // 480 ms sustained
    d.reset()
    expect(d.onLevel(0.001, 1000)).toBe(false) // quiet never fires, however long
  })
})

describe('createBargeInDetector — half duplex (RMS gate)', () => {
  it('requires a sustained elevated burst, well above the dictation silence floor', () => {
    expect(RMS_BARGE_THRESHOLD).toBeGreaterThan(SILENCE_RMS * 2)
    const d = createBargeInDetector(() => 'half')
    expect(d.onLevel(RMS_BARGE_THRESHOLD, 120)).toBe(false) // one frame — not yet
    expect(d.onLevel(RMS_BARGE_THRESHOLD, 120)).toBe(true) // 240 ms sustained
  })

  it('a gap below the threshold resets the accumulator (a door slam never trips it)', () => {
    const d = createBargeInDetector(() => 'half')
    expect(d.onLevel(0.9, RMS_BARGE_SUSTAIN_MS - 1)).toBe(false)
    expect(d.onLevel(0.001, 120)).toBe(false) // reset
    expect(d.onLevel(0.9, RMS_BARGE_SUSTAIN_MS - 1)).toBe(false)
  })

  it('ignores the transcription layer entirely in half mode', () => {
    const d = createBargeInDetector(() => 'half')
    expect(d.onPartial('hey stop right there', ['anything'])).toBe(false)
  })

  it('reset clears the accumulator; a live mode switch re-routes (Settings live-apply)', () => {
    let mode: 'full' | 'half' = 'half'
    const d = createBargeInDetector(() => mode)
    d.onLevel(0.9, 120)
    d.reset()
    expect(d.onLevel(0.9, 120)).toBe(false) // accumulator restarted
    mode = 'full'
    expect(d.onLevel(0.9, 120)).toBe(false) // full-mode net needs 480 ms, not 120
    expect(d.onPartial('hey stop', [])).toBe(true) // and transcription is on
  })
})
