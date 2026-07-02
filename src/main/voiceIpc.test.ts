/**
 * Voice V1 — voiceIpc unit tests: the engine-stub seam (frame counting + cadence logging +
 * dispose protocol), the fake-media switch mapping, and the registered start/stop handlers
 * (frame guard, port transfer, restart-idempotence) against mocked electron primitives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'

// Hoisted so the electron mock factory (hoisted by vitest) can reach them.
const h = vi.hoisted(() => {
  class FakePort {
    listeners: Array<(e: { data: unknown }) => void> = []
    started = false
    closed = false
    posted: unknown[] = []
    throwOnPost = false
    on(event: string, listener: (e: { data: unknown }) => void): this {
      if (event === 'message') this.listeners.push(listener)
      return this
    }
    start(): void {
      this.started = true
    }
    postMessage(msg: unknown): void {
      if (this.throwOnPost) throw new Error('port closed')
      this.posted.push(msg)
    }
    close(): void {
      this.closed = true
    }
    emit(data: unknown): void {
      for (const l of this.listeners) l({ data })
    }
  }
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  const getMediaAccessStatus = vi.fn<(t: string) => string>(() => 'granted')
  return { FakePort, channels, getMediaAccessStatus }
})

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = new h.FakePort()
    port2 = new h.FakePort()
    constructor() {
      h.channels.push(this)
    }
  },
  systemPreferences: { getMediaAccessStatus: h.getMediaAccessStatus }
}))

import {
  applyFakeMediaSwitches,
  attachEngineStub,
  disposeVoiceSession,
  registerVoiceHandlers
} from './voiceIpc'

const frameMsg = (bytes = 3840): { t: string; d: ArrayBuffer } => ({
  t: 'frame',
  d: new ArrayBuffer(bytes)
})

describe('attachEngineStub', () => {
  it('starts the port and counts only well-formed frame messages', () => {
    const port = new h.FakePort()
    const stub = attachEngineStub(port)
    expect(port.started).toBe(true)
    port.emit(frameMsg())
    port.emit(frameMsg())
    // Malformed / foreign shapes are ignored, never counted and never throw.
    port.emit(null)
    port.emit('junk')
    port.emit({ t: 'frame', d: 'not-a-buffer' })
    port.emit({ t: 'level', d: new ArrayBuffer(4) })
    expect(stub.frames()).toBe(2)
  })

  it('logs cadence every 8th frame under debug, with a rate from the injected clock', () => {
    const port = new h.FakePort()
    const log = vi.fn()
    let nowMs = 0
    attachEngineStub(port, { debug: true, log, now: () => nowMs })
    // One frame per 120 ms → after 8 frames, 7 intervals × 120 ms = 840 ms → 7/0.84 ≈ 8.3/s.
    for (let i = 0; i < 8; i++) {
      nowMs = (i + 1) * 120
      port.emit(frameMsg())
    }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toBe('[voice] stub: 8 frames, 8.3/s, 3840 B each')
    for (let i = 8; i < 16; i++) {
      nowMs = (i + 1) * 120
      port.emit(frameMsg())
    }
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('never logs without the debug flag', () => {
    const port = new h.FakePort()
    const log = vi.fn()
    attachEngineStub(port, { log })
    for (let i = 0; i < 32; i++) port.emit(frameMsg())
    expect(log).not.toHaveBeenCalled()
  })

  it('dispose posts {t:stop} then closes; a dead-port throw is swallowed', () => {
    const port = new h.FakePort()
    const stub = attachEngineStub(port)
    stub.dispose()
    expect(port.posted).toEqual([{ t: 'stop' }])
    expect(port.closed).toBe(true)
    const dead = new h.FakePort()
    dead.throwOnPost = true
    expect(() => attachEngineStub(dead).dispose()).not.toThrow()
    expect(dead.closed).toBe(true)
  })
})

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

describe('voice:session:start / stop handlers', () => {
  type Handler = (e: IpcMainInvokeEvent) => unknown
  let handlers: Record<string, Handler>
  let postMessage: ReturnType<typeof vi.fn>
  let win: BrowserWindow
  let ownEvent: IpcMainInvokeEvent

  beforeEach(() => {
    h.channels.length = 0
    h.getMediaAccessStatus.mockReset().mockReturnValue('granted')
    handlers = {}
    postMessage = vi.fn()
    const mainFrame = {}
    win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame, postMessage }
    } as unknown as BrowserWindow
    ownEvent = { senderFrame: mainFrame } as IpcMainInvokeEvent
    const ipcMain = {
      handle: (ch: string, fn: Handler) => {
        handlers[ch] = fn
      }
    } as unknown as IpcMain
    registerVoiceHandlers(ipcMain, () => win)
  })

  afterEach(() => disposeVoiceSession()) // module-level session state must not leak across tests

  it('denies a foreign frame on both channels', () => {
    const foreign = { senderFrame: {} } as IpcMainInvokeEvent
    expect(handlers['voice:session:start'](foreign)).toEqual({ ok: false, micStatus: 'unknown' })
    expect(handlers['voice:session:stop'](foreign)).toEqual({ ok: false, frames: 0 })
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('start brokers a channel: stub on port1, port2 transferred on voice:port', () => {
    const res = handlers['voice:session:start'](ownEvent)
    expect(res).toEqual({ ok: true, micStatus: 'granted' })
    expect(h.channels).toHaveLength(1)
    expect(h.channels[0].port1.started).toBe(true) // engine stub attached
    expect(postMessage).toHaveBeenCalledWith('voice:port', {}, [h.channels[0].port2])
  })

  it('stop reports the frames the stub received and tears the session down', () => {
    handlers['voice:session:start'](ownEvent)
    const port1 = h.channels[0].port1
    for (let i = 0; i < 5; i++) port1.emit(frameMsg())
    expect(handlers['voice:session:stop'](ownEvent)).toEqual({ ok: true, frames: 5 })
    expect(port1.posted).toEqual([{ t: 'stop' }]) // renderer told to release the mic
    expect(port1.closed).toBe(true)
    // Idempotent: a second stop finds no session.
    expect(handlers['voice:session:stop'](ownEvent)).toEqual({ ok: true, frames: 0 })
  })

  it('a second start replaces the live session (old engine end stopped + closed)', () => {
    handlers['voice:session:start'](ownEvent)
    handlers['voice:session:start'](ownEvent)
    expect(h.channels).toHaveLength(2)
    expect(h.channels[0].port1.posted).toEqual([{ t: 'stop' }])
    expect(h.channels[0].port1.closed).toBe(true)
    expect(h.channels[1].port1.closed).toBe(false)
  })

  it('reports micStatus unknown where getMediaAccessStatus is absent/throws (Linux)', () => {
    h.getMediaAccessStatus.mockImplementation(() => {
      throw new Error('unsupported')
    })
    expect(handlers['voice:session:start'](ownEvent)).toEqual({ ok: true, micStatus: 'unknown' })
  })

  it('start fails closed when the window is gone', () => {
    win = null as unknown as BrowserWindow
    // No senderFrame → synthetic/internal call (allowed by the guard) — the null window is
    // what must stop it.
    const synthetic = { senderFrame: null } as unknown as IpcMainInvokeEvent
    expect(handlers['voice:session:start'](synthetic)).toEqual({ ok: false, micStatus: 'unknown' })
  })
})
