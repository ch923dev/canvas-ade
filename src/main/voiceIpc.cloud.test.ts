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
    on(): this {
      return this
    }
    start(): void {}
    postMessage(): void {}
    close(): void {}
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
} {
  const handlers: Record<string, Handler> = {}
  const mainFrame = {}
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, mainFrame, postMessage: vi.fn(), send: vi.fn() }
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
  return { handlers, ownEvent, ops }
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
})
