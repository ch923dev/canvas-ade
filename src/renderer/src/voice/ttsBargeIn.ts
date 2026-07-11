/**
 * Jarvis J2 — barge-in detection (D6, pure — no DOM/audio). Two layers:
 *
 *  PRIMARY ('full' duplex, transcription-gated): the STT session keeps decoding while
 *  TTS speaks; a partial that is a *real utterance* interrupts. Raw VAD energy does not
 *  — coughs/backchannels never transcribe, and self-capture (Windows AEC is unreliable,
 *  electron#47043) is filtered by comparing the partial against the texts we just sent
 *  to the synthesizer: an echo transcript is (a fragment of) what we are saying.
 *
 *  FALLBACK ('half' duplex, RMS gate): mic frames are suppressed during playback (no
 *  transcription possible), so a sustained elevated-RMS burst is the interrupt signal
 *  instead. Threshold sits well above the dictation silence floor (SILENCE_RMS 0.015)
 *  so speaker bleed doesn't trip it.
 */

/** Elevated over SILENCE_RMS (0.015): the half-duplex gate must hear *speech at the
 *  mic*, not TTS bleed from speakers across the room. */
export const RMS_BARGE_THRESHOLD = 0.06

/** Sustained-burst requirement — two 120 ms capture frames; a door slam is one. */
export const RMS_BARGE_SUSTAIN_MS = 240

/** A partial shorter than this never interrupts (single-letter decode noise). */
export const MIN_PARTIAL_CHARS = 3

/** Token-overlap ratio at/above which a partial is judged to be TTS self-capture. */
export const ECHO_OVERLAP_THRESHOLD = 0.6

/** Lowercase, strip everything but letters/digits/apostrophes, split on whitespace. */
export function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/**
 * Does `partial` look like an echo of one of `spokenTexts`? True when ≥60 % of the
 * partial's tokens appear in a single spoken text (order-insensitive — STT mangles echo
 * enough that sequence matching underfires). An empty partial is vacuously "echo"
 * (nothing to interrupt with).
 */
export function looksLikeEcho(partial: string, spokenTexts: readonly string[]): boolean {
  const p = normalizeTokens(partial)
  if (p.length === 0) return true
  for (const spoken of spokenTexts) {
    const bag = new Set(normalizeTokens(spoken))
    if (bag.size === 0) continue
    const hits = p.filter((t) => bag.has(t)).length
    if (hits / p.length >= ECHO_OVERLAP_THRESHOLD) return true
  }
  return false
}

export interface BargeInDetector {
  /** 'full' layer: a changed partial while speaking. True → interrupt. */
  onPartial(partial: string, spokenTexts: readonly string[]): boolean
  /** 'half' layer: one capture frame's RMS while speaking. True → interrupt. */
  onLevel(rms: number, frameMs: number): boolean
  /** Clear accumulated state (fired on interrupt and when speech ends). */
  reset(): void
}

/** `mode` is read per event so a live Settings change re-routes without a rebuild. */
export function createBargeInDetector(mode: () => 'full' | 'half'): BargeInDetector {
  let loudMs = 0
  return {
    onPartial(partial, spokenTexts) {
      if (mode() !== 'full') return false
      const p = partial.trim()
      if (p.length < MIN_PARTIAL_CHARS) return false
      return !looksLikeEcho(p, spokenTexts)
    },
    onLevel(rms, frameMs) {
      if (mode() !== 'half') return false
      loudMs = rms >= RMS_BARGE_THRESHOLD ? loudMs + frameMs : 0
      return loudMs >= RMS_BARGE_SUSTAIN_MS
    },
    reset() {
      loudMs = 0
    }
  }
}
