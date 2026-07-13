/**
 * Jarvis J2 — playback scheduling units: the pure ledger (gapless butt-joining, lead-in,
 * flush, speaking horizon) and the earcon envelope data. The AudioContext glue is thin
 * DOM plumbing exercised by the manual dev check; the math lives here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// ── Barge-in watermark + duck-restore against a fake audio graph (TTS-4 / DUCK-1) ──────

interface FakeSource {
  buffer: unknown
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
}

class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = {}
  created: FakeSource[] = []
  gainNode = {
    connect: vi.fn(),
    gain: {
      value: 1,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn()
    }
  }
  createGain(): unknown {
    return this.gainNode
  }
  createBuffer(_ch: number, len: number, rate: number): unknown {
    return { duration: len / rate, copyToChannel: vi.fn() }
  }
  createBufferSource(): FakeSource {
    const src: FakeSource = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null
    }
    this.created.push(src)
    return src
  }
  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

/** A silent one-second-ish PCM16 chunk message for utterance `id`. */
const chunkMsg = (id: number): unknown => ({
  t: 'tts:chunk',
  id,
  seq: 0,
  sampleRate: 4,
  pcm16: encodePcm16Base64(Float32Array.from([0.1, 0.2, 0.1, 0]))
})

/** Attach a fake port and return a `deliver` fn that plays a message into the player. */
const attachFakePort = (player: ReturnType<typeof createTtsPlayer>): ((m: unknown) => void) => {
  const port = { close: vi.fn(), onmessage: null } as unknown as MessagePort
  player.attach(port)
  return (m) =>
    (port as unknown as { onmessage: (e: { data: unknown }) => void }).onmessage({ data: m })
}

describe('barge-in flush watermark covers ACCEPTED utterances (TTS-4)', () => {
  let fakeCtx: FakeAudioContext
  beforeEach(() => {
    fakeCtx = new FakeAudioContext()
    // A real function (constructible) — `new` on an arrow throws.
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return fakeCtx
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('drops the chunks of an utterance accepted BEFORE the barge-in but heard after', () => {
    // The warmup window: speak() accepted id 1, zero chunks seen, user barges in.
    const player = createTtsPlayer()
    const deliver = attachFakePort(player)
    player.noteUtterance(1)
    player.duckAndFlush()
    deliver(chunkMsg(1)) // the cancelled clause arrives post-flush
    expect(fakeCtx.created).toHaveLength(0) // dropped — nothing scheduled at restored gain
    deliver(chunkMsg(2)) // the NEXT utterance still plays
    expect(fakeCtx.created).toHaveLength(1)
    player.dispose()
  })

  it('without noteUtterance the same chunk would have played (the pre-fix hole)', () => {
    const player = createTtsPlayer()
    const deliver = attachFakePort(player)
    player.duckAndFlush() // watermark = max SEEN = 0
    deliver(chunkMsg(1))
    expect(fakeCtx.created).toHaveLength(1) // documents why accepted-id reporting matters
    player.dispose()
  })
})

describe('overlapping duckAndFlush restores supersede (DUCK-1)', () => {
  let fakeCtx: FakeAudioContext
  beforeEach(() => {
    vi.useFakeTimers()
    fakeCtx = new FakeAudioContext()
    // A real function (constructible) — `new` on an arrow throws.
    vi.stubGlobal('AudioContext', function AudioContextStub() {
      return fakeCtx
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('a second duck inside the first restore window cancels the first restore', () => {
    const player = createTtsPlayer()
    const deliver = attachFakePort(player)
    deliver(chunkMsg(1))
    const first = fakeCtx.created[0]
    player.duckAndFlush()
    // Second barge-in lands mid-way through the first duck's restore window.
    vi.advanceTimersByTime(DUCK_SECONDS * 1000 * 0.5)
    deliver(chunkMsg(2))
    const second = fakeCtx.created[1]
    player.duckAndFlush()
    expect(first.stop).toHaveBeenCalled() // superseded batch stopped immediately
    const restoresBefore = fakeCtx.gainNode.gain.setValueAtTime.mock.calls.filter(
      (c: unknown[]) => c[0] === 1
    ).length
    // Advance past where the FIRST timer would have fired — no restore may land yet.
    vi.advanceTimersByTime(DUCK_SECONDS * 1000 * 0.5 + 25)
    const restoresMid = fakeCtx.gainNode.gain.setValueAtTime.mock.calls.filter(
      (c: unknown[]) => c[0] === 1
    ).length
    expect(restoresMid).toBe(restoresBefore) // the first restore never snaps the gain mid-duck
    // The SECOND duck's own timer restores once, after stopping its batch.
    vi.advanceTimersByTime(DUCK_SECONDS * 1000)
    expect(second.stop).toHaveBeenCalled()
    const restoresAfter = fakeCtx.gainNode.gain.setValueAtTime.mock.calls.filter(
      (c: unknown[]) => c[0] === 1
    ).length
    expect(restoresAfter).toBe(restoresBefore + 1)
    player.dispose()
  })
})
