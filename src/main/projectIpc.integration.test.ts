import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Mock the store + recent-projects modules so handlers are exercised in isolation ──
// `vi.hoisted` so the mock factories (also hoisted) can reference these stubs.
const { store, recents, electronDialog, canvasMemory } = vi.hoisted(() => ({
  store: {
    readProject: vi.fn(),
    readBak: vi.fn(),
    writeProject: vi.fn(),
    createProject: vi.fn(),
    // ADR 0009: project:open / project:current relocate a legacy-root project before reading.
    migrateProjectLayout: vi.fn(),
    getCurrentDir: vi.fn(),
    setCurrentDir: vi.fn(),
    projectName: vi.fn((dir: string) => dir.split(/[/\\]/).pop() ?? dir),
    // Open-time asset GC (T4): project:current sweeps orphan blobs after a successful
    // read. Stub both so the handler runs in isolation — collectAssetIds yields the live
    // id set, gcAssets is a no-op here (its own unit suite covers the sweep).
    collectAssetIds: vi.fn(() => new Set<string>()),
    gcAssets: vi.fn()
  },
  recents: {
    listRecents: vi.fn(),
    touchRecent: vi.fn()
  },
  electronDialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  },
  canvasMemory: {
    scaffoldProjectMemory: vi.fn(),
    createCanvasMemory: vi.fn(),
    // BUG-032: safeBoardId is imported by projectIpc.ts after the fix; provide a real
    // implementation in the mock so the guard works in integration tests.
    safeBoardId: vi.fn(
      (id: string) =>
        typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id)
    )
  }
}))

vi.mock('./projectStore', () => store)
vi.mock('./recentProjects', () => recents)
vi.mock('./canvasMemory', () => canvasMemory)
vi.mock('electron', () => ({
  dialog: electronDialog,
  BrowserWindow: class {}
}))

import { registerProjectHandlers } from './projectIpc'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'
import type { MemoryEngine } from './memoryEngine'
import type { RefreshOutcome } from './summaryLoop'

beforeEach(() => {
  vi.clearAllMocks()
  store.projectName.mockImplementation((dir: string) => dir.split(/[/\\]/).pop() ?? dir)
  // BUG-016: project:open and project:current now call readBak to collect backup asset ids
  // before gcAssets. Default to { ok: false } (no backup) so existing tests are unaffected.
  store.readBak.mockReturnValue({ ok: false, error: 'no bak' })
})

describe('registerProjectHandlers (T4)', () => {
  const getWin = (): null => null // no window — guard relies on synthetic senderFrame path

  it('project:save no-ops (returns false) when getCurrentDir() is null', async () => {
    store.getCurrentDir.mockReturnValue(null)
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const result = await cap.invoke('project:save', { schemaVersion: 2, boards: [] })
    // C3: a non-error rejection returns { ok:false } with NO errno.
    expect(result).toEqual({ ok: false })
    expect(store.writeProject).not.toHaveBeenCalled()
  })

  it('project:save writes when a current dir is set', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    store.writeProject.mockResolvedValue(undefined)
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const doc = { schemaVersion: 2, boards: [] }
    const result = await cap.invoke('project:save', doc)
    expect(result).toEqual({ ok: true })
    expect(store.writeProject).toHaveBeenCalledWith('/proj', doc)
  })

  it('project:save returns { ok:false, code } (no crash) when writeProject throws (SAVE-1/C3)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    // C3: an errno-bearing failure — the handler must propagate `err.code`, not swallow it.
    store.writeProject.mockRejectedValue(
      Object.assign(new Error('ENOSPC: disk full'), { code: 'ENOSPC' })
    )
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    // The handler must catch the I/O error and report failure to the renderer,
    // not let the rejection escape (which the renderer floats silently).
    await expect(cap.invoke('project:save', { schemaVersion: 2, boards: [] })).resolves.toEqual({
      ok: false,
      code: 'ENOSPC'
    })
  })

  it('project:current sets currentDir only on ok', async () => {
    recents.listRecents.mockReturnValue([{ path: '/proj', name: 'proj', lastOpenedAt: 1 }])
    store.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: {} })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const result = await cap.invoke('project:current')
    expect((result as { ok: boolean }).ok).toBe(true)
    expect(store.setCurrentDir).toHaveBeenCalledWith('/proj')
    expect(recents.touchRecent).toHaveBeenCalled()
    // ADR 0009: a legacy-root project is relocated into .canvas/ before the read.
    expect(store.migrateProjectLayout).toHaveBeenCalledWith('/proj')
  })

  it('project:open migrates the layout before reading (ADR 0009 wiring)', async () => {
    // Seed the dir into recents so the BUG-006 approved-root guard allows the open.
    recents.listRecents.mockReturnValue([{ path: '/proj', name: 'proj', lastOpenedAt: 1 }])
    store.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: {} })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    await cap.invoke('project:open', '/proj')
    expect(store.migrateProjectLayout).toHaveBeenCalledWith('/proj')
    // Migration runs BEFORE the read (the relocate-then-read order).
    expect(store.migrateProjectLayout.mock.invocationCallOrder[0]).toBeLessThan(
      store.readProject.mock.invocationCallOrder[0]
    )
  })

  it('project:current leaves currentDir unchanged when the recent folder is gone', async () => {
    recents.listRecents.mockReturnValue([{ path: '/gone', name: 'gone', lastOpenedAt: 1 }])
    store.readProject.mockReturnValue({ ok: false, error: 'No readable canvas.json in /gone' })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const result = await cap.invoke('project:current')
    expect(result).toBeNull()
    expect(store.setCurrentDir).not.toHaveBeenCalled()
    expect(recents.touchRecent).not.toHaveBeenCalled()
  })

  it('project:current returns null when there are no recents', async () => {
    recents.listRecents.mockReturnValue([])
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const result = await cap.invoke('project:current')
    expect(result).toBeNull()
    expect(store.readProject).not.toHaveBeenCalled()
  })

  // T5: project:reopenFromBak is a pure recovery read — it returns the .bak doc and must
  // NOT touch the current dir / recents / asset GC (the open project is unchanged).
  it('project:reopenFromBak returns the .bak doc (pure read, no currentDir/recents/gc)', async () => {
    const bakDoc = { schemaVersion: 2, viewport: null, boards: [{ ok: true }] }
    store.readBak.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: bakDoc })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const result = (await cap.invoke('project:reopenFromBak', '/proj')) as {
      ok: boolean
      doc?: unknown
    }
    expect(result.ok).toBe(true)
    expect(result.doc).toEqual(bakDoc)
    expect(store.readBak).toHaveBeenCalledWith('/proj')
    // Recovery probe: leaves the open-project bookkeeping alone.
    expect(store.setCurrentDir).not.toHaveBeenCalled()
    expect(recents.touchRecent).not.toHaveBeenCalled()
    expect(store.gcAssets).not.toHaveBeenCalled()
  })

  it('project:reopenFromBak rejects an unsafe dir before any store touch', async () => {
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const result = await cap.invoke('project:reopenFromBak', '../../etc')
    expect(result).toEqual({ ok: false, error: 'invalid path' })
    expect(store.readBak).not.toHaveBeenCalled()
  })

  // BUG-016: project:open must call gcAssets with the UNION of primary + backup asset ids.
  // Pre-fix: gcAssets was called with only the primary doc's ids — a backup-only asset
  // was quarantined before the renderer's deep-validation failure could trigger T5 recovery.
  it('BUG-016: project:open unions primary + backup asset ids before gcAssets — backup-only assets are protected', async () => {
    // Primary doc references asset A only.
    const primaryDoc = {
      schemaVersion: 5,
      viewport: null,
      boards: [{ id: 'p1', elements: [{ kind: 'image', assetId: 'assets/aaaa.png' }] }]
    }
    // Backup doc references asset B (backup-only — not in the primary).
    const bakDoc = {
      schemaVersion: 5,
      viewport: null,
      boards: [{ id: 'p1', elements: [{ kind: 'image', assetId: 'assets/bbbb.png' }] }]
    }
    store.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: primaryDoc })
    store.readBak.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: bakDoc })
    store.collectAssetIds
      .mockReturnValueOnce(new Set(['assets/aaaa.png'])) // primary
      .mockReturnValueOnce(new Set(['assets/bbbb.png'])) // backup
    // BUG-006: '/proj' must be an APPROVED open target (this test bypasses the OS dialog that would
    // approve it); seed it as a known recent so the new approved-roots guard admits the open.
    recents.listRecents.mockReturnValue([{ path: '/proj', name: 'proj', lastOpenedAt: 1 }])

    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    // project:open is now async (BUG-010 / BUG-026): await so gcAssets has been called.
    await cap.invoke('project:open', '/proj')

    // gcAssets must have been called with BOTH asset ids (the union).
    expect(store.gcAssets).toHaveBeenCalledTimes(1)
    const gcArg = store.gcAssets.mock.calls[0][1] as Set<string>
    expect(gcArg.has('assets/aaaa.png')).toBe(true) // primary asset retained
    expect(gcArg.has('assets/bbbb.png')).toBe(true) // backup-only asset also retained (BUG-016 fix)
  })
})

describe('export:save', () => {
  const getWin = (): null => null // no window — guard uses synthetic senderFrame path

  it('shows save dialog, writes bytes atomically, returns { ok: true, path }', async () => {
    const tmpFile = path.join(os.tmpdir(), `export-save-test-${Date.now()}.svg`)
    electronDialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: tmpFile })

    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const bytes = new TextEncoder().encode('<svg/>')
    const result = (await cap.invoke('export:save', {
      bytes,
      ext: 'svg',
      defaultName: 'board'
    })) as { ok: boolean; path?: string }

    expect(result.ok).toBe(true)
    expect(result.path).toBe(tmpFile)
    expect(fs.existsSync(tmpFile)).toBe(true)
    expect(fs.readFileSync(tmpFile, 'utf8')).toBe('<svg/>')

    // cleanup
    fs.rmSync(tmpFile, { force: true })
  })

  it('returns { ok: false, canceled: true } when dialog is canceled, writes nothing', async () => {
    const tmpFile = path.join(os.tmpdir(), `export-save-canceled-${Date.now()}.svg`)
    electronDialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })

    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const bytes = new TextEncoder().encode('<svg/>')
    const result = (await cap.invoke('export:save', {
      bytes,
      ext: 'svg',
      defaultName: 'board'
    })) as { ok: boolean; canceled?: boolean }

    expect(result.ok).toBe(false)
    expect(result.canceled).toBe(true)
    expect(fs.existsSync(tmpFile)).toBe(false)
  })
})

// Checklist #17: every project handler must reject a foreign sender before any fs
// or dialog touch. The pure isForeignSender is covered above; this proves the
// guard is wired into each handler with the documented rejection value.
describe('registerProjectHandlers — foreign-sender rejection (#17)', () => {
  function setup(): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, mainWin, '/userData')
    return cap
  }

  it('project:open rejects a foreign sender and touches no store', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'project:open', 'C:\\proj')
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    expect(store.readProject).not.toHaveBeenCalled()
  })

  it('project:save rejects a foreign sender and writes nothing', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'project:save', {
      schemaVersion: 2,
      boards: []
    })
    expect(result).toEqual({ ok: false })
    expect(store.writeProject).not.toHaveBeenCalled()
  })

  it('project:recents returns [] for a foreign sender', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'project:recents')).toEqual([])
    expect(recents.listRecents).not.toHaveBeenCalled()
  })

  it('asset:write rejects a foreign sender', async () => {
    const cap = setup()
    expect(
      await cap.invokeAs(foreignEvent, 'asset:write', { bytes: new Uint8Array(), ext: 'png' })
    ).toEqual({ error: 'forbidden' })
  })

  it('export:save rejects a foreign sender', async () => {
    const cap = setup()
    expect(
      await cap.invokeAs(foreignEvent, 'export:save', {
        bytes: new Uint8Array(),
        ext: 'svg',
        defaultName: 'x'
      })
    ).toEqual({ ok: false, error: 'forbidden' })
  })

  it('dialog:openFolder returns null for a foreign sender and does not open dialog', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'dialog:openFolder')
    expect(result).toBeNull()
    expect(electronDialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('project:create returns { ok: false, error: "forbidden" } for a foreign sender and does not call createProject', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'project:create', {
      dir: 'C:\\proj',
      name: 'p',
      opts: {}
    })
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    expect(store.createProject).not.toHaveBeenCalled()
  })

  it('project:current returns null for a foreign sender', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'project:current')).toBeNull()
  })

  it('project:reopenFromBak returns { ok: false, error: "forbidden" } for a foreign sender', async () => {
    const cap = setup()
    const result = await cap.invokeAs(foreignEvent, 'project:reopenFromBak', 'C:\\proj')
    expect(result).toEqual({ ok: false, error: 'forbidden' })
    expect(store.readBak).not.toHaveBeenCalled()
  })

  it('asset:read returns null for a foreign sender', () => {
    const cap = setup()
    expect(cap.invokeAs(foreignEvent, 'asset:read', 'someId')).toBeNull()
  })
})

// T-M2 (Context): registerProjectHandlers feeds saved docs into the MemoryEngine and
// re-baselines it on project switch/reopen. Injected engine over the module-mocked store.
describe('registerProjectHandlers — memory-engine wiring (T-M2)', () => {
  const getWin = (): null => null // no window — guard uses synthetic senderFrame path

  function harness(engine: MemoryEngine): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData', () => 0, engine)
    return cap
  }

  it('feeds the saved doc into the engine after a successful save', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    store.writeProject.mockResolvedValue(undefined)
    const observe = vi.fn()
    const engine: MemoryEngine = { observe, reset: vi.fn(), rehydrate: vi.fn() }
    const cap = harness(engine)

    const doc = { schemaVersion: 4, viewport: null, boards: [] }
    const ok = await cap.invoke('project:save', doc)
    expect(ok).toEqual({ ok: true })
    // M3: observe() is now deferred via setImmediate so it runs off the save's critical path —
    // await one tick for it to fire before asserting.
    await new Promise((resolve) => setImmediate(resolve))
    expect(observe).toHaveBeenCalledWith(doc)
  })

  it('a throwing engine.observe never fails the save (best-effort feed)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    store.writeProject.mockResolvedValue(undefined)
    const engine: MemoryEngine = {
      observe: () => {
        throw new Error('detector boom')
      },
      reset: vi.fn(),
      rehydrate: vi.fn()
    }
    const cap = harness(engine)

    const ok = await cap.invoke('project:save', { schemaVersion: 4, viewport: null, boards: [] })
    expect(ok).toEqual({ ok: true }) // save still succeeds despite the detector throwing
  })

  it('resets THEN baselines the engine with the loaded doc when a project is opened (switch)', async () => {
    const doc = { schemaVersion: 4, viewport: null, boards: [] }
    store.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc })
    const reset = vi.fn()
    const observe = vi.fn()
    const engine: MemoryEngine = { observe, reset, rehydrate: vi.fn() }
    const cap = harness(engine)

    // project:open is now async (BUG-010 / BUG-026): await to ensure engine calls have run.
    const r = (await cap.invoke('project:open', '/proj')) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(reset).toHaveBeenCalled()
    // F1: baseline from the loaded doc so the first post-open edit emits (not swallowed).
    expect(observe).toHaveBeenCalledWith(doc)
    // Order matters: reset() (primed=false) must precede observe() (baseline-not-emit).
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(observe.mock.invocationCallOrder[0])
    expect(canvasMemory.scaffoldProjectMemory).toHaveBeenCalledWith('/proj')
  })

  it('resets THEN baselines with the loaded doc on project:current (re-baseline on reopen)', async () => {
    const doc = { schemaVersion: 4, viewport: null, boards: [] }
    recents.listRecents.mockReturnValue([{ path: '/proj', name: 'proj', lastOpenedAt: 1 }])
    store.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc })
    const reset = vi.fn()
    const observe = vi.fn()
    const engine: MemoryEngine = { observe, reset, rehydrate: vi.fn() }
    const cap = harness(engine)

    const r = (await cap.invoke('project:current')) as { ok: boolean }
    expect(r.ok).toBe(true)
    expect(reset).toHaveBeenCalled()
    expect(observe).toHaveBeenCalledWith(doc)
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(observe.mock.invocationCallOrder[0])
  })
})

describe('memory:readBoards (T-M4 cached-prose read bridge)', () => {
  const getWin = (): null => null // no window — guard uses the synthetic senderFrame path

  function withReader(
    readBoard: (id: string) => string | undefined
  ): ReturnType<typeof createIpcCapture> {
    canvasMemory.createCanvasMemory.mockReturnValue({ readBoard })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')
    return cap
  }

  it('returns raw markdown for ids that have a cached file, omitting absent ones', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const cap = withReader((id) => (id === 't1' ? '# Dev\n\nprose t1\n' : undefined))

    const result = await cap.invoke('memory:readBoards', ['t1', 'b1'])
    expect(result).toEqual({ t1: '# Dev\n\nprose t1\n' })
  })

  it('returns {} when there is no current dir (never reads disk)', async () => {
    store.getCurrentDir.mockReturnValue(null)
    const cap = withReader(() => '# x\n\ny\n')

    expect(await cap.invoke('memory:readBoards', ['t1'])).toEqual({})
    expect(canvasMemory.createCanvasMemory).not.toHaveBeenCalled()
  })

  it('returns {} for a non-array ids payload', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const cap = withReader(() => '# x\n\ny\n')

    expect(await cap.invoke('memory:readBoards', 'not-an-array')).toEqual({})
  })

  it('rejects a foreign sender and reads nothing (#17)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    canvasMemory.createCanvasMemory.mockReturnValue({ readBoard: () => '# x\n\ny\n' })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, mainWin, '/userData')

    expect(await cap.invokeAs(foreignEvent, 'memory:readBoards', ['t1'])).toEqual({})
    expect(canvasMemory.createCanvasMemory).not.toHaveBeenCalled()
  })

  it('reuses ONE CanvasMemory across calls for the same dir (BUG-027)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const readBoard = vi.fn((id: string) => (id === 't1' ? 'prose' : undefined))
    canvasMemory.createCanvasMemory.mockReturnValue({ readBoard })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    await cap.invoke('memory:readBoards', ['t1'])
    await cap.invoke('memory:readBoards', ['t1'])
    await cap.invoke('memory:readBoards', ['t1'])
    // Pre-fix: one createCanvasMemory PER call (3). Memoized: built once, reused.
    expect(canvasMemory.createCanvasMemory).toHaveBeenCalledTimes(1)
  })

  it('re-builds the CanvasMemory when the open project dir changes (BUG-027)', async () => {
    canvasMemory.createCanvasMemory.mockReturnValue({ readBoard: () => 'prose' })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    store.getCurrentDir.mockReturnValue('/projA')
    await cap.invoke('memory:readBoards', ['t1'])
    store.getCurrentDir.mockReturnValue('/projB')
    await cap.invoke('memory:readBoards', ['t1'])
    expect(canvasMemory.createCanvasMemory).toHaveBeenCalledTimes(2)
    expect(canvasMemory.createCanvasMemory).toHaveBeenNthCalledWith(1, '/projA')
    expect(canvasMemory.createCanvasMemory).toHaveBeenNthCalledWith(2, '/projB')
  })

  it('caps the ids array — an over-limit request returns {} without touching disk (BUG-027)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const readBoard = vi.fn(() => 'prose')
    canvasMemory.createCanvasMemory.mockReturnValue({ readBoard })
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    // 257 ids (> the 256 cap) must short-circuit before any CanvasMemory / readBoard touch.
    const tooMany = Array.from({ length: 257 }, (_, i) => `id${i}`)
    expect(await cap.invoke('memory:readBoards', tooMany)).toEqual({})
    expect(canvasMemory.createCanvasMemory).not.toHaveBeenCalled()
    expect(readBoard).not.toHaveBeenCalled()

    // The boundary (exactly 256) is still serviced.
    const atCap = Array.from({ length: 256 }, (_, i) => `id${i}`)
    await cap.invoke('memory:readBoards', atCap)
    expect(canvasMemory.createCanvasMemory).toHaveBeenCalledTimes(1)
    expect(readBoard).toHaveBeenCalledTimes(256)
  })
})

describe('memory:refresh (T-F4 manual re-summary bridge)', () => {
  const getWin = (): null => null

  function withRefresh(
    onRefresh: (boardId: string) => Promise<RefreshOutcome | undefined>
  ): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData', undefined, undefined, onRefresh)
    return cap
  }

  it('calls onRefresh with the board id and returns {ok:true} when a project is open', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => undefined)
    const cap = withRefresh(onRefresh)

    expect(await cap.invoke('memory:refresh', 't1')).toEqual({ ok: true })
    expect(onRefresh).toHaveBeenCalledWith('t1')
  })

  // Recap-refresh fix: the sink's structured outcome rides the reply (additive `outcome` key)
  // so RecapView can say WHY a refresh regenerated nothing; a void-ish sink keeps {ok:true}.
  it('passes the onRefresh outcome through to the reply when the sink reports one', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const outcome: RefreshOutcome = { status: 'llm-unavailable', reason: 'no-provider' }
    const onRefresh = vi.fn(async () => outcome)
    const cap = withRefresh(onRefresh)

    expect(await cap.invoke('memory:refresh', 't1')).toEqual({ ok: true, outcome })
    expect(onRefresh).toHaveBeenCalledWith('t1')
  })

  it('no-ops ({ok:false}) when no project is open — never calls onRefresh', async () => {
    store.getCurrentDir.mockReturnValue(null)
    const onRefresh = vi.fn(async () => undefined)
    const cap = withRefresh(onRefresh)

    expect(await cap.invoke('memory:refresh', 't1')).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('rejects a non-string / empty board id ({ok:false}, no refresh)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => undefined)
    const cap = withRefresh(onRefresh)

    expect(await cap.invoke('memory:refresh', 123)).toEqual({ ok: false })
    expect(await cap.invoke('memory:refresh', '')).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  // BUG-032: memory:refresh only checks `typeof boardId !== 'string' || boardId.length === 0`
  // — a 1 MB string (or invalid charset) passes the guard and reaches onRefresh.
  // The fix adds a safeBoardId() check (MAX_ID_LEN=64, charset [A-Za-z0-9_-]) at IPC ingress.
  it('BUG-032: rejects an over-long boardId (>64 chars) before calling onRefresh', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => undefined)
    const cap = withRefresh(onRefresh)

    // 65-char id (one over the MAX_ID_LEN=64 limit).
    const longId = 'a'.repeat(65)
    expect(await cap.invoke('memory:refresh', longId)).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('BUG-032: rejects a boardId with invalid charset (non-nanoid chars) before calling onRefresh', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => undefined)
    const cap = withRefresh(onRefresh)

    // Space and slash are outside the [A-Za-z0-9_-] safe charset.
    expect(await cap.invoke('memory:refresh', 'board id with spaces')).toEqual({ ok: false })
    expect(await cap.invoke('memory:refresh', '../traversal')).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('BUG-032: still accepts a valid nanoid-style boardId (regression guard)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => undefined)
    const cap = withRefresh(onRefresh)

    // Valid nanoid: alphanumeric + _ + - within 64 chars.
    expect(await cap.invoke('memory:refresh', 'abc-123_XYZ')).toEqual({ ok: true })
    expect(onRefresh).toHaveBeenCalledWith('abc-123_XYZ')
  })

  it('rejects a foreign sender and never refreshes (#17)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => undefined)
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, mainWin, '/userData', undefined, undefined, onRefresh)

    expect(await cap.invokeAs(foreignEvent, 'memory:refresh', 't1')).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
