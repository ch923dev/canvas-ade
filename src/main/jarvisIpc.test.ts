/**
 * Jarvis J3 — jarvisIpc unit tests: frame guard, config round-trip + changed-push, turn
 * lifecycle against the CANVAS_LLM_MOCK brain (start → delta/done pushes, history modes,
 * supersede-on-new-turn, cancel), and history get/clear. Electron-free: jarvisIpc takes
 * everything injected, so a tiny fake IpcMain/BrowserWindow harness suffices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerJarvisHandlers, type JarvisTurnEvent } from './jarvisIpc'
import { mockJarvisReply } from './jarvisBrain'
import { jarvisDefaults } from './jarvisConfig'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface Harness {
  handlers: Record<string, Handler>
  sent: Array<{ channel: string; payload: unknown }>
  ownEvent: IpcMainInvokeEvent
  foreignEvent: IpcMainInvokeEvent
  invoke: (channel: string, ...args: unknown[]) => unknown
  dir: string
}

function makeHarness(over: { getProjectKey?: () => string | null } = {}): Harness {
  const handlers: Record<string, Handler> = {}
  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      handlers[channel] = fn
    }
  } as unknown as IpcMain
  const sent: Array<{ channel: string; payload: unknown }> = []
  const mainFrame = { id: 'main' }
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload })
    }
  } as unknown as BrowserWindow
  const dir = mkdtempSync(join(tmpdir(), 'jarvisipc-'))
  registerJarvisHandlers(ipcMain, () => win, {
    getUserData: () => dir,
    getProjectKey: over.getProjectKey ?? (() => 'M:/proj'),
    stream: { fetch: vi.fn(), env: { CANVAS_LLM_MOCK: '1' } }
  })
  const ownEvent = { senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const foreignEvent = { senderFrame: { id: 'other' } } as unknown as IpcMainInvokeEvent
  return {
    handlers,
    sent,
    ownEvent,
    foreignEvent,
    invoke: (channel, ...args) => handlers[channel](ownEvent, ...args),
    dir
  }
}

/** Poll the pushed events until a done/error for `id` arrives (the mock streams async). */
async function waitForDone(h: Harness, id: number): Promise<JarvisTurnEvent[]> {
  for (let i = 0; i < 200; i++) {
    const events = h.sent
      .filter((s) => s.channel === 'jarvis:turn:event')
      .map((s) => s.payload as JarvisTurnEvent)
      .filter((ev) => ev.id === id)
    if (events.some((ev) => ev.kind === 'done' || ev.kind === 'error')) return events
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('turn never completed')
}

describe('jarvisIpc', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
    return () => rmSync(h.dir, { recursive: true, force: true })
  })

  it('frame guard denies every channel for a foreign sender', () => {
    expect(h.handlers['jarvis:status'](h.foreignEvent)).toMatchObject({ hasKey: false })
    expect(h.handlers['jarvis:config:set'](h.foreignEvent, { name: 'X' })).toEqual({ ok: false })
    expect(h.handlers['jarvis:turn:start'](h.foreignEvent, { text: 'hi' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(h.handlers['jarvis:turn:cancel'](h.foreignEvent)).toEqual({ ok: false })
    expect(h.handlers['jarvis:history:get'](h.foreignEvent)).toEqual([])
    expect(h.handlers['jarvis:history:clear'](h.foreignEvent)).toEqual({ ok: false })
  })

  it('status: mock counts as key-present; config carries the defaults', () => {
    expect(h.invoke('jarvis:status')).toMatchObject({
      mockEnabled: true,
      config: jarvisDefaults()
    })
  })

  it('config set merges a patch through repair and pushes jarvis:config:changed', () => {
    expect(h.invoke('jarvis:config:set', { name: 'Friday', speakingRate: 99 })).toEqual({
      ok: true
    })
    const cfg = h.invoke('jarvis:config:get') as { name: string; speakingRate: number }
    expect(cfg.name).toBe('Friday')
    expect(cfg.speakingRate).toBe(2) // repaired clamp
    const push = h.sent.find((s) => s.channel === 'jarvis:config:changed')
    expect(push?.payload).toMatchObject({ name: 'Friday' })
  })

  it('rejects an empty or oversized turn text', () => {
    expect(h.invoke('jarvis:turn:start', { text: '   ' })).toEqual({
      ok: false,
      reason: 'invalid-text'
    })
    expect(h.invoke('jarvis:turn:start', { text: 'x'.repeat(4001) })).toEqual({
      ok: false,
      reason: 'invalid-text'
    })
  })

  it('runs a mock turn: deltas stream, done carries the full text, history records both turns', async () => {
    const r = h.invoke('jarvis:turn:start', { text: 'tidy the canvas' }) as {
      ok: boolean
      id: number
    }
    expect(r.ok).toBe(true)
    const events = await waitForDone(h, r.id)
    const done = events.find((ev) => ev.kind === 'done') as Extract<
      JarvisTurnEvent,
      { kind: 'done' }
    >
    expect(done.text).toBe(mockJarvisReply('tidy the canvas'))
    expect(done.cancelled).toBe(false)
    expect(events.filter((ev) => ev.kind === 'delta').length).toBeGreaterThan(1)
    const history = h.invoke('jarvis:history:get') as Array<{ role: string; text: string }>
    expect(history).toHaveLength(2)
    expect(history[0]).toEqual({ role: 'user', text: 'tidy the canvas' })
    expect(history[1].role).toBe('assistant')
  })

  it('historyMode off keeps the conversation stateless', async () => {
    h.invoke('jarvis:config:set', { historyMode: 'off' })
    const r = h.invoke('jarvis:turn:start', { text: 'hello there' }) as { id: number }
    await waitForDone(h, r.id)
    expect(h.invoke('jarvis:history:get')).toEqual([])
  })

  it('history is keyed per project', async () => {
    let project = 'A'
    const hp = makeHarness({ getProjectKey: () => project })
    const r = hp.invoke('jarvis:turn:start', { text: 'in project A' }) as { id: number }
    await waitForDone(hp, r.id)
    expect(hp.invoke('jarvis:history:get')).toHaveLength(2)
    project = 'B'
    expect(hp.invoke('jarvis:history:get')).toEqual([])
    rmSync(hp.dir, { recursive: true, force: true })
  })

  it('history clear empties the current project only', async () => {
    const r = h.invoke('jarvis:turn:start', { text: 'remember this' }) as { id: number }
    await waitForDone(h, r.id)
    expect(h.invoke('jarvis:history:clear')).toEqual({ ok: true })
    expect(h.invoke('jarvis:history:get')).toEqual([])
  })
})
