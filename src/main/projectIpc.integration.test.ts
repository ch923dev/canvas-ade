import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Mock the store + recent-projects modules so handlers are exercised in isolation ──
// `vi.hoisted` so the mock factories (also hoisted) can reference these stubs.
const { store, recents, electronDialog, canvasMemory } = vi.hoisted(() => ({
  store: {
    readProject: vi.fn(),
    writeProject: vi.fn(),
    createProject: vi.fn(),
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
    createCanvasMemory: vi.fn()
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

beforeEach(() => {
  vi.clearAllMocks()
  store.projectName.mockImplementation((dir: string) => dir.split(/[/\\]/).pop() ?? dir)
})

describe('registerProjectHandlers (T4)', () => {
  const getWin = (): null => null // no window — guard relies on synthetic senderFrame path

  it('project:save no-ops (returns false) when getCurrentDir() is null', async () => {
    store.getCurrentDir.mockReturnValue(null)
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const result = await cap.invoke('project:save', { schemaVersion: 2, boards: [] })
    expect(result).toBe(false)
    expect(store.writeProject).not.toHaveBeenCalled()
  })

  it('project:save writes when a current dir is set', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    store.writeProject.mockResolvedValue(undefined)
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    const doc = { schemaVersion: 2, boards: [] }
    const result = await cap.invoke('project:save', doc)
    expect(result).toBe(true)
    expect(store.writeProject).toHaveBeenCalledWith('/proj', doc)
  })

  it('project:save returns false (no crash) when writeProject throws (SAVE-1)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    store.writeProject.mockRejectedValue(new Error('ENOSPC: disk full'))
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData')

    // The handler must catch the I/O error and report failure to the renderer,
    // not let the rejection escape (which the renderer floats silently).
    await expect(cap.invoke('project:save', { schemaVersion: 2, boards: [] })).resolves.toBe(false)
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
    expect(result).toBe(false)
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
    expect(ok).toBe(true)
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
    expect(ok).toBe(true) // save still succeeds despite the detector throwing
  })

  it('resets THEN baselines the engine with the loaded doc when a project is opened (switch)', () => {
    const doc = { schemaVersion: 4, viewport: null, boards: [] }
    store.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc })
    const reset = vi.fn()
    const observe = vi.fn()
    const engine: MemoryEngine = { observe, reset, rehydrate: vi.fn() }
    const cap = harness(engine)

    const r = cap.invoke('project:open', '/proj') as { ok: boolean }
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
    onRefresh: (boardId: string) => Promise<void>
  ): ReturnType<typeof createIpcCapture> {
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, getWin, '/userData', undefined, undefined, onRefresh)
    return cap
  }

  it('calls onRefresh with the board id and returns {ok:true} when a project is open', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => {})
    const cap = withRefresh(onRefresh)

    expect(await cap.invoke('memory:refresh', 't1')).toEqual({ ok: true })
    expect(onRefresh).toHaveBeenCalledWith('t1')
  })

  it('no-ops ({ok:false}) when no project is open — never calls onRefresh', async () => {
    store.getCurrentDir.mockReturnValue(null)
    const onRefresh = vi.fn(async () => {})
    const cap = withRefresh(onRefresh)

    expect(await cap.invoke('memory:refresh', 't1')).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('rejects a non-string / empty board id ({ok:false}, no refresh)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => {})
    const cap = withRefresh(onRefresh)

    expect(await cap.invoke('memory:refresh', 123)).toEqual({ ok: false })
    expect(await cap.invoke('memory:refresh', '')).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('rejects a foreign sender and never refreshes (#17)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    const onRefresh = vi.fn(async () => {})
    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, mainWin, '/userData', undefined, undefined, onRefresh)

    expect(await cap.invokeAs(foreignEvent, 'memory:refresh', 't1')).toEqual({ ok: false })
    expect(onRefresh).not.toHaveBeenCalled()
  })
})
