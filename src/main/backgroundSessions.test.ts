/**
 * `backgroundSessions.ts` — the background-project WIRING (audit R9 / finding SM-3: "and
 * `backgroundSessions.ts` has no test file at all despite being actively churned").
 *
 * The registry's own policy — cap eviction, idle TTL, two-strike warn→grace→close, busy-probe
 * deferral, forever-keeps — is already covered in depth by `projectSessions.test.ts` (541 lines)
 * and is deliberately NOT re-tested here. What has never been covered is everything this module
 * adds on top, all of which is invisible to that file because it lives in the config object and
 * the sweep:
 *
 *   1. the Low-RAM getters (read fresh per call, so a mode decided at boot needs no rebuild),
 *   2. `foregroundOsr` being a COMPOSITION — foreground, then trim resident renderers to the
 *      budget — which is the H4 fix and is silently lost if someone passes the bare function,
 *   3. the ring-tail flush wiring (the C1 data-loss fix),
 *   4. the forever-keep file parse, which must tolerate garbage,
 *   5. the sweep's timer discipline (idempotent arm, no stacked ticks, unref, clean stop),
 *   6. the user-facing fan-out: a renderer push per lifecycle kind + an OS notification that is
 *      MUTED under the headless harnesses.
 *
 * The module builds its registry at IMPORT time, so the `createProjectSessions` mock captures the
 * config object; every assertion about (1)–(4) is made by calling the captured callbacks. Every
 * native/Electron dependency is stubbed — `./pty` alone would pull node-pty into a node test run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BackgroundProjectInfo } from './projectSessions'

type SessionsConfig = {
  maxBackground: () => number
  idleTtlMs: () => number
  graceMs: () => number
  foregroundOsr: (dir: string) => number
  persistRingTails: (dir: string) => void
  loadForeverKeeps: () => string[]
  saveForeverKeeps: (dirs: string[]) => void
  activityAt: (dir: string) => number
  isBusy: (dir: string) => boolean
}

const h = vi.hoisted(() => ({
  captured: null as SessionsConfig | null,
  lowRam: false,
  // Registry surface the sweep drives.
  listBackgroundProjects: vi.fn<() => BackgroundProjectInfo[]>(),
  reapIdle:
    vi.fn<
      (
        p: Iterable<string>
      ) => Promise<{ closed: string[]; warned: { dir: string }[]; capEvicted: string[] }>
    >(),
  // Collaborators the config wires through.
  foregroundProjectOsr: vi.fn<(dir: string) => number>(),
  trimOsrToBudget: vi.fn<(n: number) => void>(),
  persistBackgroundRingTails: vi.fn(),
  projectSessionPids: vi.fn<(dir: string) => number[]>(),
  projectActivityAt: vi.fn<(dir: string) => number>(),
  busyUpdate: vi.fn<(roots: Map<string, number[]>) => Promise<void>>(),
  busyIsBusy: vi.fn<(dir: string) => boolean>(),
  getCurrentDir: vi.fn<() => string | null>(),
  readFileSync: vi.fn<() => string>(),
  writeFileSync: vi.fn(),
  notificationShow: vi.fn(),
  notificationCtor: vi.fn(),
  notificationSupported: true,
  // Audit P2-6: the OS layer honors the notifications master switch (renderer push stays ungated).
  notifEnabled: true,
  notifConfigThrow: false
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/userData' },
  Notification: Object.assign(
    class {
      constructor(opts: unknown) {
        h.notificationCtor(opts)
      }
      show(): void {
        h.notificationShow()
      }
    },
    { isSupported: () => h.notificationSupported }
  )
}))

vi.mock('node:fs', () => ({
  readFileSync: (...a: unknown[]) => h.readFileSync(...(a as [])),
  writeFileSync: (...a: unknown[]) => h.writeFileSync(...(a as []))
}))

vi.mock('./projectSessions', () => ({
  createProjectSessions: (cfg: SessionsConfig) => {
    h.captured = cfg
    return {
      listBackgroundProjects: h.listBackgroundProjects,
      reapIdle: h.reapIdle
    }
  }
}))

vi.mock('./pty', () => ({
  parkProjectSessions: vi.fn(),
  disposeProjectPtys: vi.fn(),
  countProjectSessions: vi.fn(),
  reapUndoParks: vi.fn(),
  persistBackgroundRingTails: (...a: unknown[]) => h.persistBackgroundRingTails(...(a as [])),
  projectActivityAt: (d: string) => h.projectActivityAt(d),
  projectSessionPids: (d: string) => h.projectSessionPids(d)
}))
vi.mock('./terminalSnapshot', () => ({ appendTerminalSnapshot: vi.fn() }))
vi.mock('./bgBusyProbe', () => ({
  createBusyProbe: () => ({ update: h.busyUpdate, isBusy: h.busyIsBusy })
}))
vi.mock('./previewOsrBackground', () => ({
  backgroundProjectOsr: vi.fn(),
  foregroundProjectOsr: (d: string) => h.foregroundProjectOsr(d),
  disposeProjectOsr: vi.fn(),
  countProjectOsr: vi.fn(),
  trimOsrToBudget: (n: number) => h.trimOsrToBudget(n)
}))
vi.mock('./previewOsr', () => ({ GLOBAL_OSR_MAX: 8 }))
vi.mock('./projectStore', () => ({ getCurrentDir: () => h.getCurrentDir() }))
vi.mock('./lowRamConfig', () => ({ isLowRam: () => h.lowRam }))
vi.mock('./notificationsConfig', () => ({
  readNotificationsConfig: () => {
    if (h.notifConfigThrow) throw new Error('unreadable config')
    return { enabled: h.notifEnabled }
  }
}))

import { startBackgroundIdleSweep, stopBackgroundIdleSweep } from './backgroundSessions'

/** The registry config, built at import time. */
const cfg = (): SessionsConfig => h.captured as SessionsConfig

const SWEEP_MS = 60_000

function resident(dir: string): BackgroundProjectInfo {
  return {
    dir,
    name: dir.split('/').pop() as string,
    terminalsRunning: 1,
    previews: 0,
    backgroundedAt: 0
  }
}

/** A fake window whose sends are observable. */
function fakeWin(over?: { winDestroyed?: boolean; wcDestroyed?: boolean }) {
  const send = vi.fn()
  return {
    send,
    win: {
      isDestroyed: () => over?.winDestroyed === true,
      webContents: { isDestroyed: () => over?.wcDestroyed === true, send }
    }
  }
}

beforeEach(() => {
  h.lowRam = false
  h.notificationSupported = true
  h.notifEnabled = true
  h.notifConfigThrow = false
  h.listBackgroundProjects.mockReset().mockReturnValue([])
  h.reapIdle.mockReset().mockResolvedValue({ closed: [], warned: [], capEvicted: [] })
  h.foregroundProjectOsr.mockReset().mockReturnValue(2)
  h.trimOsrToBudget.mockReset()
  h.persistBackgroundRingTails.mockReset()
  h.projectSessionPids.mockReset().mockReturnValue([100])
  h.projectActivityAt.mockReset().mockReturnValue(42)
  h.busyUpdate.mockReset().mockResolvedValue(undefined)
  h.busyIsBusy.mockReset().mockReturnValue(false)
  h.getCurrentDir.mockReset().mockReturnValue(null)
  h.readFileSync.mockReset().mockReturnValue('[]')
  h.writeFileSync.mockReset()
  h.notificationShow.mockReset()
  h.notificationCtor.mockReset()
  delete process.env.CANVAS_E2E
  delete process.env.CANVAS_SMOKE
})

afterEach(() => {
  stopBackgroundIdleSweep()
  vi.useRealTimers()
})

describe('registry budget wiring (the knobs index.ts can never see)', () => {
  it('full-RAM defaults: 3 residents, 30 min TTL, a 2-sweep grace', () => {
    expect(cfg().maxBackground()).toBe(3)
    expect(cfg().idleTtlMs()).toBe(30 * 60_000)
    // Two-strike grace = 2 sweeps: a warned resident gets a full extra tick to prove it is busy.
    expect(cfg().graceMs()).toBe(2 * SWEEP_MS)
  })

  it('Low-RAM tightens cap and TTL LIVE — the getters are read per call, not captured at build', () => {
    h.lowRam = true
    // Same registry object, no rebuild: this is the whole reason they are getters.
    expect(cfg().maxBackground()).toBe(1)
    expect(cfg().idleTtlMs()).toBe(12 * 60_000)
  })

  it('foregroundOsr is a COMPOSITION: foreground the incoming dir, THEN trim to the budget (H4)', () => {
    expect(cfg().foregroundOsr('C:/A')).toBe(2)
    expect(h.foregroundProjectOsr).toHaveBeenCalledWith('C:/A')
    // Full-RAM budget is the existence ceiling — a no-op for power users, no reload churn.
    expect(h.trimOsrToBudget).toHaveBeenCalledWith(8)
  })

  it('Low-RAM sheds frozen renderers at the switch (budget 3, not the ceiling)', () => {
    h.lowRam = true
    cfg().foregroundOsr('C:/A')
    expect(h.trimOsrToBudget).toHaveBeenCalledWith(3)
  })

  it('persistRingTails wires the snapshot appender (C1: flush BEFORE the PTYs are disposed)', () => {
    cfg().persistRingTails('C:/A')
    expect(h.persistBackgroundRingTails).toHaveBeenCalledWith(expect.any(Function), 'C:/A')
  })

  it('activity + busy verdicts come from the PTY plane and the probe respectively', () => {
    expect(cfg().activityAt('C:/A')).toBe(42)
    expect(cfg().isBusy('C:/A')).toBe(false)
    h.busyIsBusy.mockReturnValue(true)
    expect(cfg().isBusy('C:/A')).toBe(true)
  })
})

describe('forever-keep store (userData, never the project folder)', () => {
  it('reads the persisted dirs', () => {
    h.readFileSync.mockReturnValue('["C:/A","C:/B"]')
    expect(cfg().loadForeverKeeps()).toEqual(['C:/A', 'C:/B'])
  })

  it('filters non-strings out of a hand-edited file rather than trusting the JSON', () => {
    h.readFileSync.mockReturnValue('["C:/A", 7, null, {"dir":"C:/B"}]')
    expect(cfg().loadForeverKeeps()).toEqual(['C:/A'])
  })

  it('a non-array payload reads as no keeps', () => {
    h.readFileSync.mockReturnValue('{"C:/A":true}')
    expect(cfg().loadForeverKeeps()).toEqual([])
  })

  it('saves as JSON to userData — the file is an app preference, not canvas data', () => {
    cfg().saveForeverKeeps(['C:/A'])
    expect(h.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('background-keep.json'),
      '["C:/A"]',
      'utf8'
    )
  })
})

describe('the idle sweep — timer discipline', () => {
  beforeEach(() => vi.useFakeTimers())

  it('does not sweep before the first interval elapses', async () => {
    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS - 1)
    expect(h.listBackgroundProjects).not.toHaveBeenCalled()
  })

  it('sweeps once per interval', async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 3)
    expect(h.reapIdle).toHaveBeenCalledTimes(3)
  })

  it('arming twice does not double the sweep rate (idempotent)', async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    startBackgroundIdleSweep()
    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS)
    expect(h.reapIdle).toHaveBeenCalledTimes(1)
  })

  it('stop() prevents any later tick, and is safe to call twice', async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    startBackgroundIdleSweep()
    stopBackgroundIdleSweep()
    stopBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 5)
    expect(h.reapIdle).not.toHaveBeenCalled()
  })

  it('unrefs the interval so the sweep can never hold the app open', () => {
    const unref = vi.fn()
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)
    startBackgroundIdleSweep()
    expect(unref).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('a SLOW sweep never stacks ticks — the next tick is skipped, not queued', async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    let release = (): void => undefined
    h.busyUpdate.mockImplementation(
      () =>
        new Promise<void>((r) => {
          release = r
        })
    )
    startBackgroundIdleSweep()

    // Three intervals pass while the first process-table sample is still outstanding.
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 3)
    expect(h.busyUpdate).toHaveBeenCalledTimes(1)
    expect(h.reapIdle).not.toHaveBeenCalled()

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reapIdle).toHaveBeenCalledTimes(1)
  })

  it('a throwing sweep is swallowed and the NEXT tick still runs', async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    h.reapIdle.mockRejectedValueOnce(new Error('registry blew up'))
    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS * 2)
    expect(h.reapIdle).toHaveBeenCalledTimes(2)
  })
})

describe('the idle sweep — what one tick does', () => {
  beforeEach(() => vi.useFakeTimers())

  it('with no residents it returns before touching the probe or the registry', async () => {
    h.listBackgroundProjects.mockReturnValue([])
    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS)
    // The probe samples the whole process table — never pay for that with nothing resident.
    expect(h.busyUpdate).not.toHaveBeenCalled()
    expect(h.reapIdle).not.toHaveBeenCalled()
  })

  it("refreshes the busy probe over every resident's process roots BEFORE reaping", async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A'), resident('C:/B')])
    h.projectSessionPids.mockImplementation((d) => (d === 'C:/A' ? [11, 12] : [21]))
    const order: string[] = []
    h.busyUpdate.mockImplementation(async () => void order.push('probe'))
    h.reapIdle.mockImplementation(async () => {
      order.push('reap')
      return { closed: [], warned: [], capEvicted: [] }
    })

    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS)

    // Reaping on stale verdicts is how a working agent gets killed — the refresh must come first.
    expect(order).toEqual(['probe', 'reap'])
    expect(h.busyUpdate.mock.calls[0][0]).toEqual(
      new Map([
        ['C:/A', [11, 12]],
        ['C:/B', [21]]
      ])
    )
  })

  it('protects the ACTIVE project from the reap', async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    h.getCurrentDir.mockReturnValue('C:/active')
    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS)
    expect(h.reapIdle).toHaveBeenCalledWith(['C:/active'])
  })

  it('passes an EMPTY protected set when no project is open (boot / welcome screen)', async () => {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    h.getCurrentDir.mockReturnValue(null)
    startBackgroundIdleSweep()
    await vi.advanceTimersByTimeAsync(SWEEP_MS)
    expect(h.reapIdle).toHaveBeenCalledWith([])
  })
})

describe('lifecycle fan-out (project:bgLifecycle + the OS notification)', () => {
  beforeEach(() => vi.useFakeTimers())

  async function sweepWith(
    result: { closed: string[]; warned: { dir: string }[]; capEvicted: string[] },
    win?: ReturnType<typeof fakeWin>
  ): Promise<void> {
    h.listBackgroundProjects.mockReturnValue([resident('C:/A')])
    h.reapIdle.mockResolvedValue(result)
    startBackgroundIdleSweep(win ? () => win.win as never : undefined)
    await vi.advanceTimersByTimeAsync(SWEEP_MS)
  }

  it('pushes one renderer event per outcome, carrying kind + dir + display name', async () => {
    const w = fakeWin()
    await sweepWith(
      {
        closed: ['C:/proj/closed'],
        warned: [{ dir: 'C:/proj/warned' }],
        capEvicted: ['C:/proj/eviced']
      },
      w
    )

    // Every warn/close/evict is surfaced — the old sweep told nobody but the console.
    expect(w.send).toHaveBeenCalledTimes(3)
    expect(w.send).toHaveBeenCalledWith('project:bgLifecycle', {
      kind: 'warned',
      dir: 'C:/proj/warned',
      name: 'warned'
    })
    expect(w.send).toHaveBeenCalledWith('project:bgLifecycle', {
      kind: 'closed',
      dir: 'C:/proj/closed',
      name: 'closed'
    })
    expect(w.send).toHaveBeenCalledWith('project:bgLifecycle', {
      kind: 'evicted',
      dir: 'C:/proj/eviced',
      name: 'eviced'
    })
  })

  it('warns BEFORE it closes within a tick (the two-strike story reads in order)', async () => {
    const w = fakeWin()
    await sweepWith({ closed: ['C:/proj/b'], warned: [{ dir: 'C:/proj/a' }], capEvicted: [] }, w)
    const kinds = w.send.mock.calls.map((c) => (c[1] as { kind: string }).kind)
    expect(kinds).toEqual(['warned', 'closed'])
  })

  it('raises an OS notification per outcome — the user is focused elsewhere by definition', async () => {
    await sweepWith({ closed: ['C:/proj/gone'], warned: [], capEvicted: [] })
    expect(h.notificationShow).toHaveBeenCalledTimes(1)
    expect(h.notificationCtor).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Background project closed' })
    )
  })

  it('master switch OFF ⇒ NO OS notification, but the renderer consequence push still fires (audit P2-6)', async () => {
    h.notifEnabled = false
    const w = fakeWin()
    await sweepWith({ closed: ['C:/proj/gone'], warned: [], capEvicted: [] }, w)
    expect(h.notificationCtor).not.toHaveBeenCalled()
    expect(w.send).toHaveBeenCalledWith(
      'project:bgLifecycle',
      expect.objectContaining({ kind: 'closed' })
    )
  })

  it('an unreadable notifications config default-NOTIFIES (a broken prefs file must not mute the close report)', async () => {
    h.notifConfigThrow = true
    await sweepWith({ closed: ['C:/proj/gone'], warned: [], capEvicted: [] })
    expect(h.notificationCtor).toHaveBeenCalledTimes(1)
  })

  it('an idle WARNING tells the user how to keep the project alive', async () => {
    await sweepWith({ closed: [], warned: [{ dir: 'C:/proj/x' }], capEvicted: [] })
    expect(h.notificationCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Background project idle',
        body: expect.stringContaining('Switch back to keep it running')
      })
    )
  })

  it("a cap EVICTION says memory, not idleness (it was not the resident's fault)", async () => {
    await sweepWith({ closed: [], warned: [], capEvicted: ['C:/proj/x'] })
    expect(h.notificationCtor).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('free memory') })
    )
  })

  it('the OS layer is MUTED under the harnesses, but the renderer push still fires', async () => {
    process.env.CANVAS_E2E = '1'
    const w = fakeWin()
    await sweepWith({ closed: ['C:/proj/x'], warned: [], capEvicted: [] }, w)
    // e2e/smoke must never pop a real desktop notification; specs still assert via the toast.
    expect(h.notificationShow).not.toHaveBeenCalled()
    expect(w.send).toHaveBeenCalledTimes(1)
  })

  it('an unsupported / throwing Notification never breaks the sweep', async () => {
    h.notificationSupported = false
    const w = fakeWin()
    await sweepWith({ closed: ['C:/proj/x'], warned: [], capEvicted: [] }, w)
    expect(h.notificationShow).not.toHaveBeenCalled()
    expect(w.send).toHaveBeenCalledTimes(1)
  })

  it('a destroyed window is skipped without throwing (shutdown race)', async () => {
    const w = fakeWin({ winDestroyed: true })
    await sweepWith({ closed: ['C:/proj/x'], warned: [], capEvicted: [] }, w)
    expect(w.send).not.toHaveBeenCalled()
    // The OS notification still goes out — the user has no window to see the toast in.
    expect(h.notificationShow).toHaveBeenCalledTimes(1)
  })

  it('a destroyed webContents is skipped too', async () => {
    const w = fakeWin({ wcDestroyed: true })
    await sweepWith({ closed: ['C:/proj/x'], warned: [], capEvicted: [] }, w)
    expect(w.send).not.toHaveBeenCalled()
  })

  it('no window at all (headless / pre-createWindow) is fine', async () => {
    await sweepWith({ closed: ['C:/proj/x'], warned: [], capEvicted: [] })
    expect(h.notificationShow).toHaveBeenCalledTimes(1)
  })
})
