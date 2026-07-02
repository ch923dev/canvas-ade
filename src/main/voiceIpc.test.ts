/**
 * Voice V2 — voiceIpc unit tests: session handlers against an injected fake engine +
 * model ops (frame guard, port transfer to the engine host, model status in the start
 * result), the models IPC surface (list/status/download/delete, progress throttling,
 * single-flight), and the fake-media switch mapping. Electron primitives mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import type { VoiceEngineHandle } from './voiceEngine'
import type { DownloadProgress } from './voiceModels'

const h = vi.hoisted(() => {
  class FakePort {
    started = false
    closed = false
    posted: unknown[] = []
    on(): this {
      return this
    }
    start(): void {
      this.started = true
    }
    postMessage(msg: unknown): void {
      this.posted.push(msg)
    }
    close(): void {
      this.closed = true
    }
  }
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  const getMediaAccessStatus = vi.fn<(t: string) => string>(() => 'granted')
  return { FakePort, channels, getMediaAccessStatus }
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
  systemPreferences: { getMediaAccessStatus: h.getMediaAccessStatus },
  utilityProcess: { fork: vi.fn() }
}))

import {
  applyFakeMediaSwitches,
  disposeVoiceSession,
  registerVoiceHandlers,
  type VoiceIpcDeps
} from './voiceIpc'
import { DEFAULT_VOICE_MODEL_ID, VOICE_MODEL_CATALOG } from './voiceModels'

describe('applyFakeMediaSwitches', () => {
  it('is a no-op without CANVAS_FAKE_MEDIA', () => {
    const appendSwitch = vi.fn()
    expect(applyFakeMediaSwitches({}, { appendSwitch })).toBe(false)
    expect(applyFakeMediaSwitches({ CANVAS_FAKE_MEDIA: '' }, { appendSwitch })).toBe(false)
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('appends the fake device switch, plus the WAV source when given', () => {
    const appendSwitch = vi.fn()
    expect(applyFakeMediaSwitches({ CANVAS_FAKE_MEDIA: '1' }, { appendSwitch })).toBe(true)
    expect(appendSwitch.mock.calls).toEqual([['use-fake-device-for-media-stream']])
    appendSwitch.mockClear()
    applyFakeMediaSwitches(
      { CANVAS_FAKE_MEDIA: '1', CANVAS_FAKE_MEDIA_WAV: 'C:/t/silence.wav%noloop' },
      { appendSwitch }
    )
    expect(appendSwitch.mock.calls).toEqual([
      ['use-fake-device-for-media-stream'],
      ['use-file-for-fake-audio-capture', 'C:/t/silence.wav%noloop']
    ])
  })
})

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface Harness {
  handlers: Record<string, Handler>
  postMessage: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  ownEvent: IpcMainInvokeEvent
  engine: {
    startSession: ReturnType<typeof vi.fn>
    stopSession: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }
  ops: NonNullable<VoiceIpcDeps['modelOps']> & {
    status: ReturnType<typeof vi.fn>
    download: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
  }
}

function makeHarness(overrides: { win?: null } = {}): Harness {
  const handlers: Record<string, Handler> = {}
  const postMessage = vi.fn()
  const send = vi.fn()
  const mainFrame = {}
  const win =
    overrides.win === null
      ? null
      : ({
          isDestroyed: () => false,
          webContents: { isDestroyed: () => false, mainFrame, postMessage, send }
        } as unknown as BrowserWindow)
  const ownEvent = { senderFrame: mainFrame } as IpcMainInvokeEvent
  const engine = {
    startSession: vi.fn(),
    stopSession: vi.fn(async () => ({ frames: 0 })),
    dispose: vi.fn()
  }
  const ops = {
    status: vi.fn(async () => 'absent' as const),
    paths: vi.fn(() => ({ encoder: 'E', decoder: 'D', joiner: 'J', tokens: 'T' })),
    download: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    sweep: vi.fn(async () => {})
  }
  const ipcMain = {
    handle: (ch: string, fn: Handler) => {
      handlers[ch] = fn
    }
  } as unknown as IpcMain
  registerVoiceHandlers(ipcMain, () => win, {
    engine: engine as unknown as VoiceEngineHandle,
    getUserData: () => 'C:/test-userdata',
    modelOps: ops
  })
  return { handlers, postMessage, send, ownEvent, engine, ops }
}

beforeEach(() => {
  h.channels.length = 0
  h.getMediaAccessStatus.mockReset().mockReturnValue('granted')
})

afterEach(() => disposeVoiceSession())

describe('voice:session:start / stop handlers', () => {
  it('denies a foreign frame on both channels', async () => {
    const t = makeHarness()
    const foreign = { senderFrame: {} } as IpcMainInvokeEvent
    await expect(t.handlers['voice:session:start'](foreign)).resolves.toEqual({
      ok: false,
      micStatus: 'unknown',
      modelStatus: 'absent'
    })
    await expect(t.handlers['voice:session:stop'](foreign)).resolves.toEqual({
      ok: false,
      frames: 0
    })
    expect(t.postMessage).not.toHaveBeenCalled()
    expect(t.engine.startSession).not.toHaveBeenCalled()
  })

  it('start brokers a channel: engine gets port1 + null model when absent, port2 → renderer', async () => {
    const t = makeHarness()
    await expect(t.handlers['voice:session:start'](t.ownEvent)).resolves.toEqual({
      ok: true,
      micStatus: 'granted',
      modelStatus: 'absent'
    })
    expect(h.channels).toHaveLength(1)
    expect(t.engine.startSession).toHaveBeenCalledWith(h.channels[0].port1, null)
    expect(t.postMessage).toHaveBeenCalledWith('voice:port', {}, [h.channels[0].port2])
    expect(t.ops.status).toHaveBeenCalledWith('C:/test-userdata', DEFAULT_VOICE_MODEL_ID)
  })

  it('start hands the engine the model paths when the default model is ready', async () => {
    const t = makeHarness()
    t.ops.status.mockResolvedValue('ready')
    await expect(t.handlers['voice:session:start'](t.ownEvent)).resolves.toMatchObject({
      modelStatus: 'ready'
    })
    expect(t.engine.startSession).toHaveBeenCalledWith(h.channels[0].port1, {
      encoder: 'E',
      decoder: 'D',
      joiner: 'J',
      tokens: 'T'
    })
  })

  it('stop resolves the engine frame count', async () => {
    const t = makeHarness()
    t.engine.stopSession.mockResolvedValue({ frames: 17 })
    await expect(t.handlers['voice:session:stop'](t.ownEvent)).resolves.toEqual({
      ok: true,
      frames: 17
    })
  })

  it('reports micStatus unknown where getMediaAccessStatus is absent/throws (Linux)', async () => {
    const t = makeHarness()
    h.getMediaAccessStatus.mockImplementation(() => {
      throw new Error('unsupported')
    })
    await expect(t.handlers['voice:session:start'](t.ownEvent)).resolves.toMatchObject({
      ok: true,
      micStatus: 'unknown'
    })
  })

  it('start fails closed when the window is gone', async () => {
    const t = makeHarness({ win: null })
    const synthetic = { senderFrame: null } as unknown as IpcMainInvokeEvent
    await expect(t.handlers['voice:session:start'](synthetic)).resolves.toEqual({
      ok: false,
      micStatus: 'unknown',
      modelStatus: 'absent'
    })
    expect(t.engine.startSession).not.toHaveBeenCalled()
  })
})

describe('voice:models handlers', () => {
  it('list maps the catalog with per-model status and the default flag', async () => {
    const t = makeHarness()
    t.ops.status.mockImplementation(async (_u: string, id: string) =>
      id === DEFAULT_VOICE_MODEL_ID ? 'ready' : 'absent'
    )
    const list = (await t.handlers['voice:models:list'](t.ownEvent)) as Array<{
      id: string
      isDefault: boolean
      status: string
    }>
    expect(list).toHaveLength(VOICE_MODEL_CATALOG.length)
    const def = list.find((m) => m.isDefault)!
    expect(def.id).toBe(DEFAULT_VOICE_MODEL_ID)
    expect(def.status).toBe('ready')
    expect(list.filter((m) => m.isDefault)).toHaveLength(1)
  })

  it('status guards foreign frames and non-string ids', async () => {
    const t = makeHarness()
    const foreign = { senderFrame: {} } as IpcMainInvokeEvent
    await expect(t.handlers['voice:models:status'](foreign, 'x')).resolves.toBe('absent')
    await expect(t.handlers['voice:models:status'](t.ownEvent, 42)).resolves.toBe('absent')
    t.ops.status.mockResolvedValue('ready')
    await expect(
      t.handlers['voice:models:status'](t.ownEvent, 'kroko-en-2025-08-06')
    ).resolves.toBe('ready')
  })

  it('download streams throttled progress (≥512 KB or completion) and resolves ok', async () => {
    const t = makeHarness()
    t.ops.download.mockImplementation(
      async (_u: string, id: string, deps: { onProgress?: (p: DownloadProgress) => void }) => {
        const total = 2_000_000
        for (const received of [100_000, 300_000, 700_000, 1_400_000, total]) {
          deps.onProgress?.({
            id,
            receivedBytes: received,
            totalBytes: total,
            fileIndex: 1,
            fileCount: 1
          })
        }
      }
    )
    await expect(t.handlers['voice:models:download'](t.ownEvent, 'm1')).resolves.toEqual({
      ok: true
    })
    // 100k (skipped: <512k), 300k (skipped), 700k (sent), 1.4M (sent), 2M (completion — sent).
    const sent = t.send.mock.calls.map((c) => (c[1] as DownloadProgress).receivedBytes)
    expect(sent).toEqual([700_000, 1_400_000, 2_000_000])
  })

  it('download single-flights: a concurrent second download is refused', async () => {
    const t = makeHarness()
    let release!: () => void
    t.ops.download.mockImplementation(() => new Promise<void>((r) => (release = () => r())))
    const first = t.handlers['voice:models:download'](t.ownEvent, 'm1') as Promise<unknown>
    await expect(t.handlers['voice:models:download'](t.ownEvent, 'm2')).resolves.toEqual({
      ok: false,
      error: 'download already in progress'
    })
    release()
    await expect(first).resolves.toEqual({ ok: true })
    // Slot freed after completion.
    t.ops.download.mockResolvedValue(undefined)
    await expect(t.handlers['voice:models:download'](t.ownEvent, 'm3')).resolves.toEqual({
      ok: true
    })
  })

  it('download surfaces failures as {ok:false, error}', async () => {
    const t = makeHarness()
    t.ops.download.mockRejectedValue(new Error('voice model integrity failure: enc.onnx'))
    await expect(t.handlers['voice:models:download'](t.ownEvent, 'm1')).resolves.toEqual({
      ok: false,
      error: 'voice model integrity failure: enc.onnx'
    })
  })

  it('delete refuses while that model is downloading, then works', async () => {
    const t = makeHarness()
    let release!: () => void
    t.ops.download.mockImplementation(() => new Promise<void>((r) => (release = () => r())))
    const dl = t.handlers['voice:models:download'](t.ownEvent, 'm1') as Promise<unknown>
    await expect(t.handlers['voice:models:delete'](t.ownEvent, 'm1')).resolves.toEqual({
      ok: false,
      error: 'download in progress'
    })
    release()
    await dl
    await expect(t.handlers['voice:models:delete'](t.ownEvent, 'm1')).resolves.toEqual({
      ok: true
    })
    expect(t.ops.remove).toHaveBeenCalledWith('C:/test-userdata', 'm1')
  })
})
