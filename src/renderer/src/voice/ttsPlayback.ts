/**
 * Jarvis J2 — the renderer playback queue: streamed Float32 sentence chunks (the
 * voice:tts:port data plane) scheduled gaplessly into Web Audio, with the ≤100 ms
 * duck-then-flush barge-in ramp (D6).
 *
 * Shape: `createPlaybackLedger` is the PURE scheduling core (start-time horizon +
 * which utterances still have audio in flight — unit-tested without DOM audio);
 * `createTtsPlayer` is the thin AudioContext glue around it. Earcons and filler WAVs
 * play through the same master gain so a barge-in ducks them too.
 */

/** Barge-in duck: gain ramps to silence over this window, then the queue flushes.
 *  80 ms keeps us inside the D6 ≤100 ms budget with margin for the stop() tail. */
export const DUCK_SECONDS = 0.08

/** A fresh burst schedules slightly ahead of `currentTime` so the first buffer never
 *  starts in the past (a past start plays immediately but clips its head). */
export const SCHEDULE_LEAD_SECONDS = 0.03

/** Where the next chunk starts: butt-joined to the horizon, or just ahead of now. */
export function nextChunkStart(
  now: number,
  horizon: number,
  lead: number = SCHEDULE_LEAD_SECONDS
): number {
  return Math.max(now + lead, horizon)
}

export interface PlaybackLedger {
  /** Reserve a start time for a chunk of `durS` seconds; advances the horizon. */
  schedule(id: number, durS: number, now: number): { startAt: number }
  /** Barge-in / session loss: forget everything scheduled. */
  flush(): void
  /** Audio is scheduled beyond `now`. */
  speaking(now: number): boolean
  /** Seconds of scheduled audio remaining after `now` (0 when idle). */
  remaining(now: number): number
}

export function createPlaybackLedger(lead: number = SCHEDULE_LEAD_SECONDS): PlaybackLedger {
  let horizon = 0
  return {
    schedule(_id, durS, now) {
      const startAt = nextChunkStart(now, horizon, lead)
      horizon = startAt + durS
      return { startAt }
    },
    flush() {
      horizon = 0
    },
    speaking(now) {
      return horizon > now
    },
    remaining(now) {
      return Math.max(0, horizon - now)
    }
  }
}

/**
 * base64(PCM16LE) → Float32 [-1,1] — decodes the port-safe chunk encoding (see
 * main/voiceEngineHost.ts TtsOutMsg: only plain-JSON payloads survive the
 * worker→host→port hops in Electron's caged Node).
 */
export function pcm16Base64ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768
  return out
}

// ── DOM glue ───────────────────────────────────────────────────────────────────────────

/** The renderer-side view of a host TtsOutMsg (see main/voiceEngineHost.ts). */
interface TtsPortMsg {
  t?: string
  id?: number
  seq?: number
  sampleRate?: number
  pcm16?: string
  cancelled?: boolean
  error?: string
}

export interface TtsPlayer {
  /** Adopt a freshly forwarded voice:tts:port (replaces any previous one). */
  attach(port: MessagePort): void
  /** A live port is adopted. False after dispose() or before the first attach —
   *  speakText re-runs voice:tts:start when this is false even though the store says
   *  the session is live (a rebuilt player orphans the old port: MAIN keeps streaming
   *  into it and playback silently dies — the stuck-"Synthesizing…" dev-check bug). */
  attached(): boolean
  /** D6 barge-in: ramp the master gain to silence over DUCK_SECONDS, stop + drop
   *  everything scheduled, restore the gain for the next utterance. */
  duckAndFlush(): void
  /** Play a pre-decoded buffer (earcon/filler) through the master gain immediately. */
  playBuffer(buf: AudioBuffer): void
  /** The audio graph for earcon/filler modules (created lazily on first use). */
  graph(): { ctx: AudioContext; out: AudioNode }
  dispose(): void
}

export interface TtsPlayerCallbacks {
  onSpeakingChange?: (speaking: boolean) => void
  onUtteranceError?: (id: number, error: string) => void
}

export function createTtsPlayer(cb: TtsPlayerCallbacks = {}): TtsPlayer {
  let ctx: AudioContext | null = null
  let gain: GainNode | null = null
  let port: MessagePort | null = null
  const sources = new Set<AudioBufferSourceNode>()
  const ledger = createPlaybackLedger()
  let speaking = false
  let speakTimer: ReturnType<typeof setTimeout> | null = null
  // Utterance ids are monotonic (MAIN's speak counter). A barge-in flushes everything
  // up to the newest id seen — chunks from those utterances still in flight over the
  // port afterwards are dropped instead of playing into the restored gain.
  let maxSeenId = 0
  let flushedThroughId = 0

  const ensureGraph = (): { ctx: AudioContext; out: AudioNode } => {
    if (!ctx || !gain) {
      ctx = new AudioContext()
      gain = ctx.createGain()
      gain.connect(ctx.destination)
    }
    return { ctx, out: gain }
  }

  const setSpeaking = (on: boolean): void => {
    if (speaking === on) return
    speaking = on
    cb.onSpeakingChange?.(on)
  }

  // The speaking flag turns off on a timer parked at the horizon (re-armed every time a
  // new chunk extends it) — cheaper and steadier than per-source onended bookkeeping.
  const armSpeakTimer = (): void => {
    if (!ctx) return
    if (speakTimer) clearTimeout(speakTimer)
    const remainS = ledger.remaining(ctx.currentTime)
    if (remainS <= 0) {
      setSpeaking(false)
      return
    }
    setSpeaking(true)
    speakTimer = setTimeout(armSpeakTimer, remainS * 1000 + 60)
  }

  const onChunk = (m: TtsPortMsg): void => {
    if (typeof m.id !== 'number' || typeof m.pcm16 !== 'string' || !m.sampleRate) return
    maxSeenId = Math.max(maxSeenId, m.id)
    if (m.id <= flushedThroughId) return // tail of a barged-in utterance
    const { ctx: c, out } = ensureGraph()
    const f32 = pcm16Base64ToFloat32(m.pcm16)
    if (f32.length === 0) return
    const buf = c.createBuffer(1, f32.length, m.sampleRate)
    buf.copyToChannel(f32, 0)
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(out)
    const { startAt } = ledger.schedule(m.id, buf.duration, c.currentTime)
    src.onended = (): void => {
      sources.delete(src)
    }
    sources.add(src)
    src.start(startAt)
    armSpeakTimer()
  }

  return {
    attached(): boolean {
      return port !== null
    },
    attach(p: MessagePort): void {
      port?.close()
      port = p
      p.onmessage = (e: MessageEvent): void => {
        const m = e.data as TtsPortMsg | null
        if (m?.t === 'tts:chunk') onChunk(m)
        else if (m?.t === 'tts:error' && typeof m.id === 'number') {
          cb.onUtteranceError?.(m.id, m.error ?? 'synthesis failed')
        }
        // tts:done needs no action: the horizon timer settles `speaking`, and cancelled
        // utterances were already flushed by the barge-in that cancelled them.
      }
    },
    duckAndFlush(): void {
      flushedThroughId = maxSeenId
      if (!ctx || !gain) return
      const g = gain.gain
      const now = ctx.currentTime
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(0.0001, now + DUCK_SECONDS)
      const doomed = [...sources]
      sources.clear()
      ledger.flush()
      setSpeaking(false)
      if (speakTimer) clearTimeout(speakTimer)
      const c = ctx // dispose() may null the field before this timer fires
      setTimeout(
        () => {
          for (const s of doomed) {
            try {
              s.stop()
            } catch {
              /* never started / already ended */
            }
          }
          // Restore the gain only after the doomed sources are dead.
          if (c.state !== 'closed') g.setValueAtTime(1, c.currentTime)
        },
        DUCK_SECONDS * 1000 + 20
      )
    },
    playBuffer(buf: AudioBuffer): void {
      const { ctx: c, out } = ensureGraph()
      const src = c.createBufferSource()
      src.buffer = buf
      src.connect(out)
      const { startAt } = ledger.schedule(-1, buf.duration, c.currentTime)
      src.onended = (): void => {
        sources.delete(src)
      }
      sources.add(src)
      src.start(startAt)
      armSpeakTimer()
    },
    graph: ensureGraph,
    dispose(): void {
      port?.close()
      port = null
      if (speakTimer) clearTimeout(speakTimer)
      for (const s of sources) {
        try {
          s.stop()
        } catch {
          /* already ended */
        }
      }
      sources.clear()
      void ctx?.close().catch(() => {
        /* already closed */
      })
      ctx = null
      gain = null
    }
  }
}

// ── Module singleton (the useTtsPlayback hook registers; ttsSession/fillers read) ──────
let currentPlayer: TtsPlayer | null = null

export function setTtsPlayer(p: TtsPlayer | null): void {
  currentPlayer = p
}

export function getTtsPlayer(): TtsPlayer | null {
  return currentPlayer
}
