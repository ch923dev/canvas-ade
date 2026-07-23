/**
 * Phase 3 — voiceIpc cloud-TTS SELECTION gate. Twin of voiceIpc.cloud.test.ts (STT), TTS-side:
 * which engine a voice:tts:start brokers based on config.ttsEngine + OpenAI key presence, and that
 * a cloud speak is immune to a whole-host death. The tell: the LOCAL host posts {t:'tts:session:start'}
 * to its utilityProcess child, while the cloud composite holds the port itself and never touches the
 * child — so a spied child.postMessage cleanly distinguishes cloud from local. The full synthesis
 * flow lives in cloudTtsEngine.test.ts; this is only the routing + the failure guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  class FakePort {
    on(): this {
      return this
    }
    start(): void {}
    postMessage(): void {}
    close(): void {}
  }
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
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
import type { SpeakFetch } from './openaiSpeak'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/** A speak transport that never gets exercised here (cloud routing is proven without a real call). */
const idleSpeakFetch: SpeakFetch = async () => ({
  ok: true,
  status: 200,
  body: null,
  text: async () => ''
})

function harness(opts: {
  userData: string
  hasKey: boolean
  ttsStatus: 'ready' | 'absent'
  keyOverrides?: Partial<VoiceIpcDeps>
}): {
  handlers: Record<string, Handler>
  ownEvent: IpcMainInvokeEvent
  ttsOps: { status: ReturnType<typeof vi.fn> }
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
  const ttsOps = {
    status: vi.fn(async () => opts.ttsStatus),
    paths: vi.fn(() => ({ model: 'M', tokens: 'T', espeak: 'E' })),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
  const ipcMain = { handle: (ch: string, fn: Handler) => (handlers[ch] = fn) } as unknown as IpcMain
  registerVoiceHandlers(ipcMain, () => win, {
    getUserData: () => opts.userData,
    ttsModelOps: ttsOps as unknown as VoiceIpcDeps['ttsModelOps'],
    keyStore: { hasKey: () => opts.hasKey, getKey: () => (opts.hasKey ? 'sk-test' : undefined) },
    speakFetch: idleSpeakFetch,
    ...opts.keyOverrides
  })
  return { handlers, ownEvent, ttsOps, postMessage, send }
}

let userData: string
let savedEnvKey: string | undefined

beforeEach(() => {
  h.channels.length = 0
  h.child.postMessage.mockClear()
  userData = mkdtempSync(join(tmpdir(), 'voice-ttscloud-'))
  savedEnvKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
})
afterEach(() => {
  disposeVoiceSession()
  rmSync(userData, { recursive: true, force: true })
  if (savedEnvKey !== undefined) process.env.OPENAI_API_KEY = savedEnvKey
})

const postedToChild = (t: string): boolean =>
  h.child.postMessage.mock.calls.some((c) => (c[0] as { t?: string } | null)?.t === t)

describe('voiceIpc cloud-TTS selection gate', () => {
  it('cloud TTS + key → cloud composite (ready, no local model check, host child untouched)', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ ttsEngine: 'cloud', ttsVoice: 'alloy' }))
    const t = harness({ userData, hasKey: true, ttsStatus: 'absent' })
    const res = await t.handlers['voice:tts:start'](t.ownEvent)
    expect(res).toMatchObject({ ok: true, modelStatus: 'ready' })
    expect(t.ttsOps.status).not.toHaveBeenCalled() // cloud ignores the on-disk Kokoro model
    expect(postedToChild('tts:session:start')).toBe(false) // cloud holds the port; no host session
    expect(t.postMessage).toHaveBeenCalledWith('voice:tts:port', {}, expect.anything())
  })

  it('cloud TTS selected but NO key → falls back to local (host child gets tts:session:start)', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ ttsEngine: 'cloud' }))
    const t = harness({ userData, hasKey: false, ttsStatus: 'ready' })
    const res = await t.handlers['voice:tts:start'](t.ownEvent)
    expect(res).toMatchObject({ ok: true, modelStatus: 'ready' })
    expect(t.ttsOps.status).toHaveBeenCalled() // local model gate runs
    expect(postedToChild('tts:session:start')).toBe(true)
  })

  it('ttsEngine kokoro → local regardless of key presence', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ ttsEngine: 'kokoro' }))
    const t = harness({ userData, hasKey: true, ttsStatus: 'ready' })
    await t.handlers['voice:tts:start'](t.ownEvent)
    expect(t.ttsOps.status).toHaveBeenCalled()
    expect(postedToChild('tts:session:start')).toBe(true)
  })

  it('cloud TTS selected + no key + local model ABSENT → fail-fast (no session)', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ ttsEngine: 'cloud' }))
    const t = harness({ userData, hasKey: false, ttsStatus: 'absent' })
    const res = await t.handlers['voice:tts:start'](t.ownEvent)
    expect(res).toMatchObject({ ok: false, modelStatus: 'absent' })
    expect(postedToChild('tts:session:start')).toBe(false)
  })

  // A cloud speak runs off the host (its own fetch + a MAIN-owned port), so a whole-host death is a
  // STT/KWS/local-TTS-only failure and must NOT push a tts error at the cloud session.
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

  it('cloud TTS session ignores a whole-host death — no voice:tts:event error', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ ttsEngine: 'cloud' }))
    const fe = fakeEngine()
    const t = harness({
      userData,
      hasKey: true,
      ttsStatus: 'ready',
      keyOverrides: { engine: fe.engine }
    })
    await t.handlers['voice:tts:start'](t.ownEvent)
    fe.fail('voice engine host exited unexpectedly')
    expect(t.send).not.toHaveBeenCalledWith('voice:tts:event', expect.anything())
  })

  it('LOCAL TTS session STILL fails on a host death (the guard is cloud-only)', async () => {
    writeVoiceConfig(userData, repairVoiceConfig({ ttsEngine: 'kokoro' }))
    const fe = fakeEngine()
    const t = harness({
      userData,
      hasKey: true,
      ttsStatus: 'ready',
      keyOverrides: { engine: fe.engine }
    })
    await t.handlers['voice:tts:start'](t.ownEvent)
    fe.fail('voice engine host exited unexpectedly')
    expect(t.send).toHaveBeenCalledWith(
      'voice:tts:event',
      expect.objectContaining({ kind: 'error' })
    )
  })
})
