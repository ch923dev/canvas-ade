/**
 * B0 hotfix — voiceIpc SESSION PINNING (B0.2) + converse-forces-local (B0.1), against the REAL
 * engines (the local sherpa host over a faked utilityProcess child, the cloud STT/TTS composites).
 * deps.engine is deliberately NOT injected: that seam collapses both domains onto one fake handle,
 * which is exactly what hid the bug — the old per-call router re-read the live config on every
 * method, so a Settings flip (or the OpenAI key going away) mid-session sent `stop` to the OTHER
 * engine, a no-op there, and the real session (the hot mic) lived on.
 *
 * The tells: the local host posts {t:'session:start' | 'session:stop' | 'tts:*'} to its child,
 * while a cloud composite holds the session port itself (its release posts {t:'stop'} on it — the
 * renderer's only mic-release signal for a cloud session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  class FakePort {
    handler: ((e: { data: unknown }) => void) | null = null
    posted: unknown[] = []
    closed = false
    on(_ev: 'message', cb: (e: { data: unknown }) => void): this {
      this.handler = cb
      return this
    }
    start(): void {}
    postMessage(m: unknown): void {
      this.posted.push(m)
    }
    close(): void {
      this.closed = true
    }
    /** Feed an inbound message to whatever handler the engine registered. */
    send(m: unknown): void {
      this.handler?.({ data: m })
    }
  }
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  // The local host's utilityProcess child. It answers session:stop like the real host (after the
  // eos drain it would report its frame count) so a stop that REACHES the host resolves promptly.
  const listeners: Record<string, (m: unknown) => void> = {}
  const HOST_FRAMES = 4
  const child = {
    on: vi.fn((ev: string, cb: (m: unknown) => void) => {
      listeners[ev] = cb
      return child
    }),
    postMessage: vi.fn((m: { t?: string } | null) => {
      if (m?.t === 'session:stop') {
        queueMicrotask(() => listeners.message?.({ t: 'session:stopped', frames: HOST_FRAMES }))
      }
    }),
    kill: vi.fn(),
    stdout: null,
    stderr: null
  }
  return { FakePort, channels, child, listeners, HOST_FRAMES }
})

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/unused-userdata' },
  MessageChannelMain: class {
    port1 = new h.FakePort()
    port2 = new h.FakePort()
    constructor() {
      h.channels.push(this)
    }
  },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  utilityProcess: { fork: vi.fn(() => h.child) }
}))

import { registerVoiceHandlers, disposeVoiceSession, type VoiceIpcDeps } from './voiceIpc'
import { repairVoiceConfig, writeVoiceConfig } from './voiceConfig'
import type { TranscribeFetch } from './openaiTranscribe'
import type { SpeakFetch } from './openaiSpeak'
import type { SymbolProvider } from './voiceSymbols'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const fakeSymbols: SymbolProvider = {
  get: () => ({ bias: [], dict: [] }),
  refresh: () => {},
  reset: () => {}
}
const okFetch: TranscribeFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ text: 'dictated words' })
})
/** Never exercised for real here — a pending stream would be fine too; routing is the subject. */
const idleSpeakFetch: SpeakFetch = async () => ({
  ok: true,
  status: 200,
  body: null,
  text: async () => ''
})

interface Harness {
  handlers: Record<string, Handler>
  ownEvent: IpcMainInvokeEvent
  ops: { status: ReturnType<typeof vi.fn> }
  ttsOps: { status: ReturnType<typeof vi.fn> }
  send: ReturnType<typeof vi.fn>
  /** Flip key presence live (the key store is read on every routing decision). */
  key: { present: boolean }
}

function harness(userData: string, opts: { modelStatus?: 'ready' | 'absent' } = {}): Harness {
  const handlers: Record<string, Handler> = {}
  const mainFrame = {}
  const send = vi.fn()
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, mainFrame, postMessage: vi.fn(), send }
  } as unknown as BrowserWindow
  const ownEvent = { senderFrame: mainFrame } as IpcMainInvokeEvent
  const key = { present: true }
  const ops = {
    status: vi.fn(async () => opts.modelStatus ?? ('ready' as const)),
    paths: vi.fn(() => ({ encoder: 'E', decoder: 'D', joiner: 'J', tokens: 'T' })),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    sweep: vi.fn(async () => {})
  }
  const ttsOps = {
    status: vi.fn(async () => 'ready' as const),
    paths: vi.fn(() => ({ model: 'M', tokens: 'T', espeak: 'E' })),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
  const ipcMain = { handle: (ch: string, fn: Handler) => (handlers[ch] = fn) } as unknown as IpcMain
  registerVoiceHandlers(ipcMain, () => win, {
    getUserData: () => userData,
    modelOps: ops,
    ttsModelOps: ttsOps as unknown as VoiceIpcDeps['ttsModelOps'],
    keyStore: {
      hasKey: () => key.present,
      getKey: () => (key.present ? 'sk-test' : undefined)
    },
    symbols: fakeSymbols,
    transcribeFetch: okFetch,
    speakFetch: idleSpeakFetch
  })
  return { handlers, ownEvent, ops, ttsOps, send, key }
}

/** Messages the local host's child received, by type. */
const childGot = (t: string): number =>
  h.child.postMessage.mock.calls.filter((c) => (c[0] as { t?: string } | null)?.t === t).length

const frame = (): { t: 'frame'; d: ArrayBuffer } => ({
  t: 'frame',
  d: new Uint8Array([1, 2, 3, 4]).buffer
})

let userData: string
let savedEnvKey: string | undefined

beforeEach(() => {
  h.channels.length = 0
  h.child.postMessage.mockClear()
  userData = mkdtempSync(join(tmpdir(), 'voice-pin-'))
  // The routing gate reads process.env as a store-less key fallback — pin it off for determinism.
  savedEnvKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
})
afterEach(() => {
  disposeVoiceSession()
  rmSync(userData, { recursive: true, force: true })
  if (savedEnvKey !== undefined) process.env.OPENAI_API_KEY = savedEnvKey
})

const config = (patch: Record<string, unknown>): void =>
  writeVoiceConfig(userData, repairVoiceConfig(patch))

describe('B0.2 — an STT session is pinned to the engine that started it', () => {
  it('local → cloud flip mid-recording: stop still reaches the LOCAL host that owns the session', async () => {
    config({ engine: 'sherpa-onnx' })
    const t = harness(userData)
    await t.handlers['voice:session:start'](t.ownEvent)
    expect(childGot('session:start')).toBe(1)
    await t.handlers['voice:config:set'](t.ownEvent, { engine: 'cloud' }) // Settings flip, mic hot
    const stopped = await t.handlers['voice:session:stop'](t.ownEvent)
    // Pre-fix the stop went to the cloud engine (no session there → {frames:0}) and the host — and
    // with it the renderer capture — never heard it.
    expect(childGot('session:stop')).toBe(1)
    expect(stopped).toEqual({ ok: true, frames: h.HOST_FRAMES })
  })

  it('cloud → local flip mid-recording: stop reaches the CLOUD engine — {t:"stop"} posted, audio still transcribed', async () => {
    config({ engine: 'cloud' })
    const t = harness(userData)
    await t.handlers['voice:session:start'](t.ownEvent)
    const port = h.channels[0].port1
    port.send(frame())
    port.send(frame())
    port.send(frame())
    await t.handlers['voice:config:set'](t.ownEvent, { engine: 'sherpa-onnx' })
    const stopP = t.handlers['voice:session:stop'](t.ownEvent) as Promise<unknown>
    // The cloud release is the ONLY path that tells the renderer capture to tear down (mic + the
    // AudioContext) — pre-fix it never ran and useVoiceCapture kept the mic forever.
    expect(port.posted).toContainEqual({ t: 'stop' })
    port.send({ t: 'eos' }) // the renderer's dispose sentinel
    await expect(stopP).resolves.toEqual({ ok: true, frames: 3 })
    expect(childGot('session:stop')).toBe(0) // the idle local host was never involved
    await vi.waitFor(() =>
      expect(t.send).toHaveBeenCalledWith('voice:transcript', {
        kind: 'final',
        text: 'dictated words'
      })
    )
  })

  it('the OpenAI key disappearing mid cloud recording does not strand it', async () => {
    config({ engine: 'cloud' })
    const t = harness(userData)
    await t.handlers['voice:session:start'](t.ownEvent)
    const port = h.channels[0].port1
    port.send(frame())
    t.key.present = false // useCloud() now says "local" — the session must not care
    const stopP = t.handlers['voice:session:stop'](t.ownEvent) as Promise<unknown>
    expect(port.posted).toContainEqual({ t: 'stop' })
    port.send({ t: 'eos' })
    await expect(stopP).resolves.toEqual({ ok: true, frames: 1 })
  })

  it('a crash re-broker restarts on the PINNED engine, not the newly selected one', async () => {
    config({ engine: 'sherpa-onnx' })
    const t = harness(userData)
    await t.handlers['voice:session:start'](t.ownEvent)
    await t.handlers['voice:config:set'](t.ownEvent, { engine: 'cloud' })
    h.listeners.exit?.(1) // the host dies mid-session → restart-once policy re-brokers
    expect(childGot('session:start')).toBe(2) // re-brokered onto the (respawned) local host
    expect(t.send).toHaveBeenCalledWith('voice:engine:event', { kind: 'restarted' })
  })

  it('a start with no stop in between, across engines, releases the old engine session', async () => {
    config({ engine: 'cloud' })
    const t = harness(userData)
    await t.handlers['voice:session:start'](t.ownEvent)
    const cloudPort = h.channels[0].port1
    await t.handlers['voice:config:set'](t.ownEvent, { engine: 'sherpa-onnx' })
    await t.handlers['voice:session:start'](t.ownEvent) // e.g. the flyout's Restart
    expect(cloudPort.posted).toContainEqual({ t: 'stop' }) // the cloud capture is told to let go
    expect(childGot('session:start')).toBe(1) // the new session runs on the local host
  })
})

describe('B0.1 — a converse session always runs on LOCAL STT', () => {
  it('cloud selected + converse → the local host, and the result reports the override', async () => {
    config({ engine: 'cloud' })
    const t = harness(userData, { modelStatus: 'absent' })
    const res = await t.handlers['voice:session:start'](t.ownEvent, { converse: true })
    // modelStatus is the LOCAL model's real state — 'absent' + converseLocal is the renderer's
    // fail-visibly signal (a cloud user asked for an on-device model must be told why).
    expect(res).toMatchObject({
      ok: true,
      modelStatus: 'absent',
      cloud: false,
      converseLocal: true
    })
    expect(t.ops.status).toHaveBeenCalled()
    expect(childGot('session:start')).toBe(1)
  })

  it('local selected + converse → no override to explain', async () => {
    config({ engine: 'sherpa-onnx' })
    const t = harness(userData)
    const res = await t.handlers['voice:session:start'](t.ownEvent, { converse: true })
    expect(res).toMatchObject({ ok: true, cloud: false, converseLocal: false })
  })

  it('a dictation (non-converse) start still honours cloud', async () => {
    config({ engine: 'cloud' })
    const t = harness(userData)
    const res = await t.handlers['voice:session:start'](t.ownEvent, { converse: false })
    expect(res).toMatchObject({ ok: true, modelStatus: 'ready', cloud: true, converseLocal: false })
    expect(childGot('session:start')).toBe(0)
  })

  it('a malformed options payload is a plain start (only a literal true means converse)', async () => {
    config({ engine: 'cloud' })
    const t = harness(userData)
    const res = await t.handlers['voice:session:start'](t.ownEvent, { converse: 'yes' })
    expect(res).toMatchObject({ cloud: true })
  })

  it('a converse start over a LIVE cloud dictation replaces it with a local session', async () => {
    config({ engine: 'cloud' })
    const t = harness(userData)
    await t.handlers['voice:session:start'](t.ownEvent) // dictating on cloud
    const cloudPort = h.channels[0].port1
    cloudPort.send(frame())
    await t.handlers['voice:session:start'](t.ownEvent, { converse: true }) // Jarvis arms
    expect(cloudPort.posted).toContainEqual({ t: 'stop' })
    expect(childGot('session:start')).toBe(1)
    // The dictation that was in flight is not lost: its eos still transcribes it.
    cloudPort.send({ t: 'eos' })
    await vi.waitFor(() =>
      expect(t.send).toHaveBeenCalledWith(
        'voice:transcript',
        expect.objectContaining({ kind: 'final' })
      )
    )
  })
})

describe('B0.2 — a TTS session is pinned, and retired when its engine changes', () => {
  it('a ttsEngine toggle ends the live session on ITS engine and tells the renderer', async () => {
    config({ ttsEngine: 'kokoro' })
    const t = harness(userData)
    await t.handlers['voice:tts:start'](t.ownEvent)
    expect(childGot('tts:session:start')).toBe(1)
    await t.handlers['voice:config:set'](t.ownEvent, { ttsEngine: 'cloud' })
    // Pre-fix nothing ended it, and the next speak went to the cloud engine — which holds no port —
    // so Jarvis went silently mute while reporting every speak accepted.
    expect(childGot('tts:session:stop')).toBe(1)
    expect(t.send).toHaveBeenCalledWith('voice:tts:event', {
      kind: 'error',
      reason: 'engine-changed'
    })
    await expect(t.handlers['voice:tts:speak'](t.ownEvent, { text: 'hi' })).resolves.toEqual({
      ok: false,
      error: 'no tts session'
    })
    // The renderer's lazy re-open lands on the newly selected engine (cloud: no host session).
    await t.handlers['voice:tts:start'](t.ownEvent)
    expect(childGot('tts:session:start')).toBe(1)
    await expect(t.handlers['voice:tts:speak'](t.ownEvent, { text: 'hi' })).resolves.toMatchObject({
      ok: true
    })
    expect(childGot('tts:speak')).toBe(0)
  })

  it('an unrelated config write never retires the session; speak/cancel reach the pinned engine', async () => {
    config({ ttsEngine: 'kokoro' })
    const t = harness(userData)
    await t.handlers['voice:tts:start'](t.ownEvent)
    await t.handlers['voice:config:set'](t.ownEvent, { ttsVoice: 'nova' })
    expect(childGot('tts:session:stop')).toBe(0)
    await expect(t.handlers['voice:tts:speak'](t.ownEvent, { text: 'hi' })).resolves.toMatchObject({
      ok: true
    })
    await t.handlers['voice:tts:cancel'](t.ownEvent)
    expect(childGot('tts:speak')).toBe(1)
    expect(childGot('tts:cancel')).toBe(1)
  })

  it('the OpenAI key disappearing under a live cloud TTS session retires it at the next speak', async () => {
    config({ ttsEngine: 'cloud' })
    const t = harness(userData)
    await t.handlers['voice:tts:start'](t.ownEvent)
    const cloudPort = h.channels[0].port1
    t.key.present = false
    await expect(t.handlers['voice:tts:speak'](t.ownEvent, { text: 'hi' })).resolves.toEqual({
      ok: false,
      error: 'engine-changed'
    })
    expect(cloudPort.closed).toBe(true) // ended on the engine that owned it
    expect(t.send).toHaveBeenCalledWith('voice:tts:event', {
      kind: 'error',
      reason: 'engine-changed'
    })
  })

  it('stop closes the PINNED cloud session even after the key went away', async () => {
    config({ ttsEngine: 'cloud' })
    const t = harness(userData)
    await t.handlers['voice:tts:start'](t.ownEvent)
    const cloudPort = h.channels[0].port1
    t.key.present = false
    await t.handlers['voice:tts:stop'](t.ownEvent)
    expect(cloudPort.closed).toBe(true) // pre-fix: routed to the local host, cloud port left open
    expect(childGot('tts:session:stop')).toBe(0)
  })
})
