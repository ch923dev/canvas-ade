/**
 * Jarvis J2 — barge-in detection (D6, pure — no DOM/audio). Two layers:
 *
 *  PRIMARY ('full' duplex, transcription-gated): the STT session keeps decoding while
 *  TTS speaks; a partial that is a *real utterance* interrupts. Raw VAD energy does not
 *  — coughs/backchannels never transcribe, and self-capture (Windows AEC is unreliable,
 *  electron#47043) is filtered by comparing the partial against the texts we just sent
 *  to the synthesizer: an echo transcript is (a fragment of) what we are saying.
 *  A slow RMS SAFETY NET backs the gate: during playback the transcription path can
 *  miss or lag badly — Chromium's AEC suppresses near-end speech during double-talk,
 *  and concurrent synthesis starves the decoder of CPU (the "sometimes it doesn't
 *  capture / takes too long" dev-check finding) — so sustained loud speech at the mic
 *  fires even when no partial ever lands. Its sustain is double the half-duplex gate's:
 *  transcription stays primary; the net only catches what STT drops.
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

/** Full-duplex safety-net sustain (four frames): slower than the half-duplex gate so
 *  the transcription path stays primary, fast enough to bound the worst-case interrupt
 *  when STT misses entirely. Post-AEC levels keep same-tab TTS bleed under threshold. */
export const RMS_BARGE_SUSTAIN_FULL_MS = 480

/** A partial shorter than this never interrupts (single-letter decode noise). */
export const MIN_PARTIAL_CHARS = 3

/** Bigram-overlap ratio at/above which a partial is judged to be TTS self-capture. */
export const ECHO_OVERLAP_THRESHOLD = 0.6

/** Skip distance for echo bigrams: a partial pair still counts as "mirroring" the
 *  spoken text when STT dropped one word between them ("terminal running" vs the
 *  spoken "terminal is running"). */
const ECHO_SKIP_DISTANCE = 2

/** Lowercase, strip everything but letters/digits/apostrophes, split on whitespace. */
export function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/**
 * Does `partial` look like an echo of one of `spokenTexts`? Echo mirrors CONTIGUOUS
 * fragments of what we said, so the test is word-ORDER aware: ≥60 % of the partial's
 * consecutive word pairs must appear in a single spoken text as pairs within skip
 * distance 2 (STT drops words from echo). A bag-of-words overlap is NOT enough — the
 * first live drill said "stop, stop" at a preview that contained "…and I will stop",
 * bag overlap hit 100 % and the interrupt was swallowed. Pairs are built PER SENTENCE
 * of the spoken text: real echo never straddles a sentence boundary, and cross-boundary
 * pairs manufacture false echoes — the second live drill said "stop right now" at a
 * preview containing "…I will stop. Right now I am…", and the boundary-crossing pair
 * "stop right" plus "right now" pushed the overlap past the threshold. Single-word
 * partials are NEVER echo: one-word commands ("stop") are the most common interrupt
 * there is, and a genuine echo transcript virtually never stays one word long. An
 * empty partial is vacuously "echo" (nothing to interrupt with).
 */
export function looksLikeEcho(partial: string, spokenTexts: readonly string[]): boolean {
  const p = normalizeTokens(partial)
  if (p.length === 0) return true
  if (p.length === 1) return false
  for (const spoken of spokenTexts) {
    const pairs = new Set<string>()
    for (const sentence of spoken.split(/[.!?;:\n]+/)) {
      const tokens = normalizeTokens(sentence)
      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j <= i + ECHO_SKIP_DISTANCE && j < tokens.length; j++) {
          pairs.add(`${tokens[i]} ${tokens[j]}`)
        }
      }
    }
    if (pairs.size === 0) continue
    let hits = 0
    for (let i = 0; i < p.length - 1; i++) {
      if (pairs.has(`${p[i]} ${p[i + 1]}`)) hits++
    }
    if (hits / (p.length - 1) >= ECHO_OVERLAP_THRESHOLD) return true
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
      loudMs = rms >= RMS_BARGE_THRESHOLD ? loudMs + frameMs : 0
      const sustain = mode() === 'half' ? RMS_BARGE_SUSTAIN_MS : RMS_BARGE_SUSTAIN_FULL_MS
      return loudMs >= sustain
    },
    reset() {
      loudMs = 0
    }
  }
}
