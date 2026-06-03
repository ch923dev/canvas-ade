import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Mock the store + recent-projects modules so handlers are exercised in isolation ──
// `vi.hoisted` so the mock factories (also hoisted) can reference these stubs.
const { store, recents, electronDialog } = vi.hoisted(() => ({
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
  }
}))

vi.mock('./projectStore', () => store)
vi.mock('./recentProjects', () => recents)
vi.mock('electron', () => ({
  dialog: electronDialog,
  BrowserWindow: class {}
}))

import { registerProjectHandlers } from './projectIpc'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'

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
