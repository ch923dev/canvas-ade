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
    expect(looksLikeEcho('AUTH TERMINAL RUNNING', spoken)).toBe(true) // STT re-casing
  })

  it('does not flag a genuinely different utterance', () => {
    const spoken = ['Done. The auth terminal is running in the top right group.']
    expect(looksLikeEcho('stop please', spoken)).toBe(false)
    expect(looksLikeEcho('open a browser on localhost', spoken)).toBe(false)
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

  it('ignores the RMS layer entirely in full mode', () => {
    const d = createBargeInDetector(() => 'full')
    expect(d.onLevel(1.0, 1000)).toBe(false)
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
    expect(d.onLevel(0.9, 120)).toBe(false) // now the RMS layer is off
    expect(d.onPartial('hey stop', [])).toBe(true) // and transcription is on
  })
})
