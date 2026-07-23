/**
 * Phase 2 — voiceIpc cloud-STT SELECTION gate. Verifies which engine a session:start brokers
 * based on config.engine + OpenAI key presence, WITHOUT deps.engine (that override bypasses the
 * gate). The tell: the local sherpa host posts {t:'session:start'} to its utilityProcess child,
 * while the cloud composite holds the port itself and never touches the child — so a spied
 * child.postMessage cleanly distinguishes cloud from local. The full transcribe flow lives in
 * cloudSttEngine.test.ts; this is only the routing.
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
    on(_ev: 'message', cb: (e: { data: unknown }) => void): this {
      this.handler = cb
      return this
    }
    start(): void {}
    postMessage(m: unknown): void {
      this.posted.push(m)
    }
    close(): void {}
    /** Feed an inbound message to whatever handler the engine registered. */
    send(m: unknown): void {
      this.handler?.({ data: m })
    }
  }
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  // The local host's utilityProcess child — session:start posts to it; cloud never does.
  const child = { on: vi.fn(), postMessage: vi.fn(), kill: vi.fn(), stdout: null, stderr: null }
  return { FakePort, channels, child }
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
import type { VoiceEngineHandle } from './voiceEngine'
import type { TranscribeFetch } from './openaiTranscribe'
import type { SymbolProvider } from './voiceSymbols'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const fakeSymbols: SymbolProvider = {
  get: () => ({ bias: ['contextIsolation'], dict: ['contextIsolation'] }),
  refresh: () => {},
  reset: () => {}
}
const okFetch: TranscribeFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ text: 'hi' })
})

function harness(opts: {
  userData: string
  hasKey: boolean
  keyOverrides?: Partial<VoiceIpcDeps>
}): {
  handlers: Record<string, Handler>
  ownEvent: IpcMainInvokeEvent
  ops: { status: ReturnType<typeof vi.fn> }
  postMessage: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
} {
  const handlers: Record<string, Handler> = {}
  const mainFrame = {}
  const postMessage = vi.fn()
  const send = vi.fn()
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, mainFrame, postMessage, send }
  } as unknown as BrowserWindow
  const ownEvent = { senderFrame: mainFrame } as IpcMainInvokeEvent
  const ops = {
    status: vi.fn(async () => 'absent' as const),
    paths: vi.fn(() => ({ encoder: 'E', decoder: 'D', joiner: 'J', tokens: 'T' })),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    sweep: vi.fn(async () => {})
  }
  const ipcMain = { handle: (ch: string, fn: Handler) => (handlers[ch] = fn) } as unknown as IpcMain
  registerVoiceHandlers(ipcMain, () => win, {
    getUserData: () => opts.userData,
    modelOps: ops,
    keyStore: { hasKey: () => opts.hasKey, getKey: () => (opts.hasKey ? 'sk-test' : undefined) },
    symbols: fakeSymbols,
    transcribeFetch: okFetch,
    ...opts.keyOverrides
  })
  return { handlers, ownEvent, ops, postMessage, send }
}

let userData: string
let savedEnvKey: string | undefined

beforeEach(() => {
  h.channels.length = 0
  h.child.postMessage.mockClear()
  userData = mkdtempSync(join(tmpdir(), 'voice-cloud-'))
  // The gate reads process.env as a store-less key fallback — pin it off for determinism.
  savedEnvKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
})
afterEach(() => {
  disposeVoiceSession()
  rmSync(userData, { recursive: true, force: true })
  if (savedEnvKey !== undefined) process.env.OPENAI_API_KEY = savedEnvKey
})

describe('voiceIpc cloud-STT selection gate', () => {
  it('cloud + key → cloud composite (ready, no local model check, host child untouched)', async () => {
    writeVoiceConfig(
      userData,
      repairVoiceConfig({ engine: 'cloud', sttModel: 'gpt-4o-transcribe' })
    )
    const t = harness({ userData, hasKey: true })
    const res = await t.handlers['voice:session:start'](t.ownEvent)
    expect(res).toMatchObject({ ok: true, modelStatus: 'ready' })
    expect(t.ops.status).not.toHaveBeenCalled() // cloud ignores the on-disk sherpa model
    expect(h.child.postMessage).not.toHaveBeenCalled() // cloud holds the port; no host session
  })

  it('cloud selected but NO key → falls back to local (host child gets session:start)', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ engine: 'cloud' }))
    const t = harness({ userData, hasKey: false })
    const res = await t.handlers['voice:session:start'](t.ownEvent)
    expect(res).toMatchObject({ ok: true, modelStatus: 'absent' }) // local model status flows through
    expect(t.ops.status).toHaveBeenCalled()
    expect(h.child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ t: 'session:start' }),
      expect.anything()
    )
  })

  it('engine sherpa-onnx → local regardless of key presence', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ engine: 'sherpa-onnx' }))
    const t = harness({ userData, hasKey: true })
    await t.handlers['voice:session:start'](t.ownEvent)
    expect(t.ops.status).toHaveBeenCalled()
    expect(h.child.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ t: 'session:start' }),
      expect.anything()
    )
  })

  // Phase 3 (bot [critical] fix): the STT and TTS cloud tiers are INDEPENDENT — the router keeps a
  // stable per-domain singleton and never rebuilds a live session, so toggling ttsEngine mid-STT
  // recording must not discard the in-flight STT buffer (a combined-key composite would have).
  it('a ttsEngine toggle mid cloud-STT session does NOT discard the STT recording', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ engine: 'cloud', ttsEngine: 'kokoro' }))
    const t = harness({ userData, hasKey: true })
    const res = await t.handlers['voice:session:start'](t.ownEvent)
    expect(res).toMatchObject({ ok: true, modelStatus: 'ready' })
    // The router built the STT-domain singleton and handed it this session's port.
    const port = h.channels[h.channels.length - 1].port1
    const frame = (): { t: 'frame'; d: ArrayBuffer } => ({
      t: 'frame',
      d: new Uint8Array([1, 2]).buffer
    })
    port.send(frame())
    port.send(frame())
    port.send(frame())
    // Toggle the OTHER (TTS) tier mid-recording — must NOT rebuild / discard the STT session.
    await t.handlers['voice:config:set'](t.ownEvent, { ttsEngine: 'cloud' })
    port.send({ t: 'eos' })
    // Stop routes to the SAME STT singleton → its 3 buffered frames come back (a rebuilt engine
    // would have a fresh, empty session → 0 frames).
    const stopped = await t.handlers['voice:session:stop'](t.ownEvent)
    expect(stopped).toMatchObject({ ok: true, frames: 3 })
  })

  // Review (PR #370): a cloud recording never runs on the local host, so a whole-host death (a
  // TTS/KWS-only failure) must NOT restart/interrupt it — unlike a local STT session, whose
  // decode thread shares that child.
  function fakeEngine(): { engine: VoiceEngineHandle; fail: (r: string) => void } {
    let failCb: ((r: string) => void) | null = null
    const engine = {
      startSession: vi.fn(),
      stopSession: vi.fn(async () => ({ frames: 0 })),
      onEngineFailure: vi.fn((cb: ((r: string) => void) | null) => {
        failCb = cb
      }),
      startTtsSession: vi.fn(),
      ttsSpeak: vi.fn(),
      ttsCancel: vi.fn(),
      stopTtsSession: vi.fn(),
      onTtsFailure: vi.fn(),
      startKwsSession: vi.fn(),
      stopKwsSession: vi.fn(async () => ({ frames: 0 })),
      onKwsFailure: vi.fn(),
      dispose: vi.fn()
    } as unknown as VoiceEngineHandle
    return { engine, fail: (r) => failCb?.(r) }
  }

  it('cloud session ignores a whole-host death — no restart, no engine:event', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ engine: 'cloud' }))
    const fe = fakeEngine()
    const t = harness({ userData, hasKey: true, keyOverrides: { engine: fe.engine } })
    await t.handlers['voice:session:start'](t.ownEvent)
    expect(t.postMessage).toHaveBeenCalledTimes(1) // the initial voice:port broker
    t.postMessage.mockClear()
    // A TTS/KWS-only host crash surfaces here as a whole-host failure while the cloud STT session
    // is live. It must be a no-op for the cloud recording.
    fe.fail('voice engine host exited unexpectedly')
    expect(t.postMessage).not.toHaveBeenCalled() // NOT re-brokered
    expect(t.send).not.toHaveBeenCalledWith('voice:engine:event', expect.anything())
  })

  it('local session STILL restarts once on a host death (the guard is cloud-only)', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ engine: 'sherpa-onnx' }))
    const fe = fakeEngine()
    const t = harness({ userData, hasKey: true, keyOverrides: { engine: fe.engine } })
    await t.handlers['voice:session:start'](t.ownEvent)
    t.postMessage.mockClear()
    fe.fail('voice engine host exited unexpectedly')
    expect(t.postMessage).toHaveBeenCalledTimes(1) // re-brokered once (transparent restart)
    expect(t.send).toHaveBeenCalledWith('voice:engine:event', { kind: 'restarted' })
  })
})
