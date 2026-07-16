/**
 * Jarvis J3 — jarvisIpc unit tests: frame guard, config round-trip + changed-push, turn
 * lifecycle against the CANVAS_LLM_MOCK brain (start → delta/done pushes, history modes,
 * supersede-on-new-turn, cancel), and history get/clear. Electron-free: jarvisIpc takes
 * everything injected, so a tiny fake IpcMain/BrowserWindow harness suffices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerJarvisHandlers, type JarvisIpcDeps, type JarvisTurnEvent } from './jarvisIpc'
import { mockJarvisReply, type JarvisStreamDeps } from './jarvisBrain'
import { jarvisDefaults } from './jarvisConfig'
import {
  jarvisHistoryFileFor,
  readJarvisHistory,
  readJarvisHistoryConsent
} from './jarvisHistoryStore'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

interface Harness {
  handlers: Record<string, Handler>
  sent: Array<{ channel: string; payload: unknown }>
  ownEvent: IpcMainInvokeEvent
  foreignEvent: IpcMainInvokeEvent
  invoke: (channel: string, ...args: unknown[]) => unknown
  dir: string
}

function makeHarness(
  over: {
    getProjectKey?: () => string | null
    stream?: JarvisStreamDeps
    getAppModel?: JarvisIpcDeps['getAppModel']
    win?: (mainFrame: object, sent: Array<{ channel: string; payload: unknown }>) => BrowserWindow
    /** D4′ tests: the consent-ask seam (default deps.confirm denies). */
    confirm?: JarvisIpcDeps['confirm']
    /** D4′ tests: reuse a userData dir across registrations (relaunch simulation). */
    dir?: string
  } = {}
): Harness {
  const handlers: Record<string, Handler> = {}
  const ipcMain = {
    handle: (channel: string, fn: Handler): void => {
      handlers[channel] = fn
    }
  } as unknown as IpcMain
  const sent: Array<{ channel: string; payload: unknown }> = []
  const mainFrame = { id: 'main' }
  const win = over.win
    ? over.win(mainFrame, sent)
    : ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          mainFrame,
          send: (channel: string, payload: unknown) => sent.push({ channel, payload })
        }
      } as unknown as BrowserWindow)
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), 'jarvisipc-'))
  registerJarvisHandlers(ipcMain, () => win, {
    getUserData: () => dir,
    getProjectKey: over.getProjectKey ?? (() => 'M:/proj'),
    getAppModel: over.getAppModel,
    confirm: over.confirm,
    stream: over.stream ?? { fetch: vi.fn(), env: { CANVAS_LLM_MOCK: '1' } }
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

  // ── The coverage the header always claimed (BRAIN-4) + the review-wave crash class ──

  it('supersede-on-new-turn: a second start cancels the first, which settles cancelled', async () => {
    const r1 = h.invoke('jarvis:turn:start', { text: 'first thought' }) as { id: number }
    const r2 = h.invoke('jarvis:turn:start', { text: 'actually, this' }) as { id: number }
    const done1 = (await waitForDone(h, r1.id)).find((ev) => ev.kind === 'done') as Extract<
      JarvisTurnEvent,
      { kind: 'done' }
    >
    expect(done1.cancelled).toBe(true)
    const done2 = (await waitForDone(h, r2.id)).find((ev) => ev.kind === 'done') as Extract<
      JarvisTurnEvent,
      { kind: 'done' }
    >
    expect(done2.cancelled).toBe(false)
    expect(done2.text).toBe(mockJarvisReply('actually, this'))
  })

  it('cancel aborts the in-flight turn (barge-in), settling it as a cancelled done', async () => {
    const r = h.invoke('jarvis:turn:start', { text: 'long answer please' }) as { id: number }
    expect(h.invoke('jarvis:turn:cancel')).toEqual({ ok: true })
    const done = (await waitForDone(h, r.id)).find((ev) => ev.kind === 'done') as Extract<
      JarvisTurnEvent,
      { kind: 'done' }
    >
    expect(done.cancelled).toBe(true)
  })

  it('a barge-in during the getAppModel await never issues the provider request (BRAIN-1)', async () => {
    let releaseModel: () => void = () => {}
    const modelGate = new Promise<null>((res) => {
      releaseModel = () => res(null)
    })
    const fetchSpy = vi.fn()
    const hb = makeHarness({
      stream: { fetch: fetchSpy as never, env: { ANTHROPIC_API_KEY: 'test-key' } },
      getAppModel: () => modelGate
    })
    const r = hb.invoke('jarvis:turn:start', { text: 'hello' }) as { ok: boolean; id: number }
    expect(r.ok).toBe(true)
    hb.invoke('jarvis:turn:cancel') // lands while the turn body awaits the manifest
    releaseModel()
    const done = (await waitForDone(hb, r.id)).find((ev) => ev.kind === 'done') as Extract<
      JarvisTurnEvent,
      { kind: 'done' }
    >
    expect(done.cancelled).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled() // the dead turn paid nothing
    rmSync(hb.dir, { recursive: true, force: true })
  })

  it('a window destroyed mid-stream never crashes the turn body (BRAIN-2)', async () => {
    // The nasty real shape (index.ts 'closed'): isDestroyed() still false, but the
    // webContents GETTER itself throws. Pre-fix this rethrew out of the void'd turn
    // body → unhandledRejection → crashShutdown(1).
    let destroyed = false
    const hb = makeHarness({
      win: (mainFrame, sent) =>
        ({
          isDestroyed: () => false,
          get webContents() {
            if (destroyed) throw new Error('Object has been destroyed')
            return {
              isDestroyed: () => false,
              mainFrame,
              send: (channel: string, payload: unknown) => {
                sent.push({ channel, payload })
                if ((payload as JarvisTurnEvent).kind === 'delta') destroyed = true
              }
            }
          }
        }) as unknown as BrowserWindow
    })
    const syntheticEvent = {} as IpcMainInvokeEvent // no senderFrame → in-process call, allowed
    const r = hb.handlers['jarvis:turn:start'](syntheticEvent, { text: 'stream then die' }) as {
      ok: boolean
      id: number
    }
    expect(r.ok).toBe(true)
    // Pushes die with the window — completion is observable through MAIN's history.
    await vi.waitFor(() => {
      expect(hb.handlers['jarvis:history:get'](syntheticEvent)).toHaveLength(2)
    })
    // The first delta reached the renderer; everything after the destroy was dropped.
    const kinds = hb.sent
      .filter((s) => s.channel === 'jarvis:turn:event')
      .map((s) => (s.payload as JarvisTurnEvent).kind)
    expect(kinds).toContain('delta')
    expect(kinds).not.toContain('done')
    rmSync(hb.dir, { recursive: true, force: true })
  })
})

// ── D4′ (J5): project-mode persistence — consent ask, restore-on-relaunch, clear ──

describe('jarvisIpc D4′ project-mode persistence', () => {
  const mkProject = (): string => mkdtempSync(join(tmpdir(), 'jarvisproj-'))

  it('first persist asks consent ONCE; approved → history lands on disk and grows', async () => {
    const project = mkProject()
    const confirm = vi.fn(async () => ({ approved: true }))
    const hp = makeHarness({ getProjectKey: () => project, confirm })
    hp.invoke('jarvis:config:set', { historyMode: 'project' })

    const r1 = hp.invoke('jarvis:turn:start', { text: 'persist me' }) as { id: number }
    await waitForDone(hp, r1.id)
    await vi.waitFor(() => {
      expect(readJarvisHistory(project).turns).toHaveLength(2)
    })
    expect(confirm).toHaveBeenCalledTimes(1)

    const r2 = hp.invoke('jarvis:turn:start', { text: 'and me' }) as { id: number }
    await waitForDone(hp, r2.id)
    await vi.waitFor(() => {
      expect(readJarvisHistory(project).turns).toHaveLength(4)
    })
    expect(confirm).toHaveBeenCalledTimes(1) // the stored grant is never re-asked
    rmSync(hp.dir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  it('declined consent → nothing on disk, decision stored, never re-asked', async () => {
    const project = mkProject()
    const confirm = vi.fn(async () => ({ approved: false }))
    const hp = makeHarness({ getProjectKey: () => project, confirm })
    hp.invoke('jarvis:config:set', { historyMode: 'project' })

    const r1 = hp.invoke('jarvis:turn:start', { text: 'do not persist' }) as { id: number }
    await waitForDone(hp, r1.id)
    const r2 = hp.invoke('jarvis:turn:start', { text: 'still no' }) as { id: number }
    await waitForDone(hp, r2.id)
    await new Promise((r) => setTimeout(r, 20)) // give a wrong write every chance to land

    expect(existsSync(jarvisHistoryFileFor(project))).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(readJarvisHistoryConsent(hp.dir, project)).toBe('declined')
    // In-memory session behavior is unchanged by the decline.
    expect(hp.invoke('jarvis:history:get')).toHaveLength(4)
    rmSync(hp.dir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  it('restore-on-relaunch: a fresh registration hydrates the persisted transcript', async () => {
    const project = mkProject()
    const confirm = vi.fn(async () => ({ approved: true }))
    const hp = makeHarness({ getProjectKey: () => project, confirm })
    hp.invoke('jarvis:config:set', { historyMode: 'project' })
    const r = hp.invoke('jarvis:turn:start', { text: 'remember across restarts' }) as {
      id: number
    }
    await waitForDone(hp, r.id)
    await vi.waitFor(() => {
      expect(readJarvisHistory(project).turns).toHaveLength(2)
    })

    // "Relaunch": new handler registration, SAME userData (consent + config) + project.
    const hp2 = makeHarness({ getProjectKey: () => project, confirm, dir: hp.dir })
    const restored = hp2.invoke('jarvis:history:get') as Array<{ role: string; text: string }>
    expect(restored).toHaveLength(2)
    expect(restored[0]).toEqual({ role: 'user', text: 'remember across restarts' })
    rmSync(hp.dir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })

  it('history:clear wipes the disk copy too', async () => {
    const project = mkProject()
    const confirm = vi.fn(async () => ({ approved: true }))
    const hp = makeHarness({ getProjectKey: () => project, confirm })
    hp.invoke('jarvis:config:set', { historyMode: 'project' })
    const r = hp.invoke('jarvis:turn:start', { text: 'soon gone' }) as { id: number }
    await waitForDone(hp, r.id)
    await vi.waitFor(() => {
      expect(existsSync(jarvisHistoryFileFor(project))).toBe(true)
    })

    expect(hp.invoke('jarvis:history:clear')).toEqual({ ok: true })
    expect(hp.invoke('jarvis:history:get')).toEqual([])
    expect(existsSync(jarvisHistoryFileFor(project))).toBe(false)
    rmSync(hp.dir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })
})

describe('jarvisIpc D4′ consent re-ask (review: a decline must not be permanent)', () => {
  it("re-choosing 'Per project' in Settings drops a stored decline and re-asks", async () => {
    const project = mkdtempSync(join(tmpdir(), 'jarvisproj-'))
    const confirm = vi.fn(async () => ({ approved: false }))
    const hp = makeHarness({ getProjectKey: () => project, confirm })
    hp.invoke('jarvis:config:set', { historyMode: 'project' })

    const r1 = hp.invoke('jarvis:turn:start', { text: 'first ask' }) as { id: number }
    await waitForDone(hp, r1.id)
    await vi.waitFor(() => {
      expect(readJarvisHistoryConsent(hp.dir, project)).toBe('declined')
    })
    expect(confirm).toHaveBeenCalledTimes(1)

    // Staying in project mode never re-asks…
    const r2 = hp.invoke('jarvis:turn:start', { text: 'no re-ask' }) as { id: number }
    await waitForDone(hp, r2.id)
    expect(confirm).toHaveBeenCalledTimes(1)

    // …but the explicit re-choose gesture (off → back to 'project') clears the decline.
    hp.invoke('jarvis:config:set', { historyMode: 'session' })
    hp.invoke('jarvis:config:set', { historyMode: 'project' })
    expect(readJarvisHistoryConsent(hp.dir, project)).toBeUndefined()

    confirm.mockImplementation(async () => ({ approved: true }))
    const r3 = hp.invoke('jarvis:turn:start', { text: 'asked again' }) as { id: number }
    await waitForDone(hp, r3.id)
    await vi.waitFor(() => {
      expect(readJarvisHistoryConsent(hp.dir, project)).toBe('enabled')
      expect(existsSync(jarvisHistoryFileFor(project))).toBe(true)
    })
    expect(confirm).toHaveBeenCalledTimes(2)
    rmSync(hp.dir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })
})
