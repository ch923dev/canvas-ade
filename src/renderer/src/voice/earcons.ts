/**
 * Jarvis J2 — earcons: tiny synthesized cues (no asset files — two sine blips beat a
 * 5 KB WAV). Played through the TTS player's master gain so a barge-in ducks them with
 * everything else. The envelope specs are pure data, unit-testable; only `playEarcon`
 * touches Web Audio.
 */

export type EarconKind = 'listen' | 'ack' | 'done'

export interface EarconNote {
  /** Sine frequency, Hz. */
  freq: number
  /** Onset relative to the earcon start, seconds. */
  at: number
  /** Note length, seconds (attack 5 ms, then exponential decay to the end). */
  dur: number
  /** Peak gain — well under speech level so cues never startle. */
  peak: number
}

/** listen = rising pair (mic armed) · ack = single low tick (request accepted) ·
 *  done = falling pair (work finished). All under 200 ms. */
export const EARCONS: Record<EarconKind, EarconNote[]> = {
  listen: [
    { freq: 660, at: 0, dur: 0.07, peak: 0.16 },
    { freq: 880, at: 0.08, dur: 0.09, peak: 0.16 }
  ],
  ack: [{ freq: 520, at: 0, dur: 0.06, peak: 0.14 }],
  done: [
    { freq: 880, at: 0, dur: 0.07, peak: 0.15 },
    { freq: 660, at: 0.08, dur: 0.1, peak: 0.13 }
  ]
}

/** Total length of an earcon in seconds (its last note's end). */
export function earconDuration(notes: readonly EarconNote[]): number {
  return notes.reduce((end, n) => Math.max(end, n.at + n.dur), 0)
}

export function playEarcon(kind: EarconKind, ctx: AudioContext, out: AudioNode): void {
  const t0 = ctx.currentTime + 0.01
  for (const n of EARCONS[kind]) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = n.freq
    env.gain.setValueAtTime(0.0001, t0 + n.at)
    env.gain.linearRampToValueAtTime(n.peak, t0 + n.at + 0.005)
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur)
    osc.connect(env)
    env.connect(out)
    osc.start(t0 + n.at)
    osc.stop(t0 + n.at + n.dur + 0.02)
  }
}
