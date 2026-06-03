import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

// ── Mock the store + recent-projects modules so handlers are exercised in isolation ──
// `vi.hoisted` so the mock factories (also hoisted) can reference these stubs.
const { store, recents } = vi.hoisted(() => ({
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
  }
}))

vi.mock('./projectStore', () => store)
vi.mock('./recentProjects', () => recents)

import { registerProjectHandlers, isForeignSender, isUnsafeProjectDir } from './projectIpc'

/** A minimal ipcMain stub that records handlers so a test can invoke them directly. */
function makeIpcMain(): {
  ipcMain: IpcMain
  invoke: (channel: string, ...args: unknown[]) => unknown
} {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  } as unknown as IpcMain
  // Synthetic event (no senderFrame) → guard treats it as an internal call → allowed.
  const e = { senderFrame: undefined } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(e, ...args)
  }
  return { ipcMain, invoke }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.projectName.mockImplementation((dir: string) => dir.split(/[/\\]/).pop() ?? dir)
})

describe('isForeignSender (BUG-M6)', () => {
  const sameFrame = { id: 'main' }

  it('allows a synthetic/internal call (no senderFrame)', () => {
    const e = { senderFrame: undefined } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(false)
  })

  it('blocks a foreign frame', () => {
    const e = { senderFrame: { id: 'other' } } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(true)
  })

  it('allows the same main frame', () => {
    const e = { senderFrame: sameFrame } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => sameFrame as never)).toBe(false)
  })

  it('blocks a real sender when the window is unresolved (getMainFrame → null)', () => {
    const e = { senderFrame: { id: 'real' } } as unknown as IpcMainInvokeEvent
    expect(isForeignSender(e, () => null)).toBe(true)
  })
})

describe('isUnsafeProjectDir (M-6)', () => {
  it('accepts a normal absolute path (Windows + POSIX)', () => {
    expect(isUnsafeProjectDir('C:\\Users\\x\\proj')).toBe(false)
    expect(isUnsafeProjectDir('/home/x/proj')).toBe(false)
  })

  it('rejects a relative path', () => {
    expect(isUnsafeProjectDir('proj')).toBe(true)
    expect(isUnsafeProjectDir('./proj')).toBe(true)
  })

  it('rejects an absolute path that still contains traversal', () => {
    expect(isUnsafeProjectDir('C:\\Users\\x\\..\\..\\evil')).toBe(true)
    expect(isUnsafeProjectDir('/home/x/../../etc')).toBe(true)
  })

  it('rejects empty / non-string input', () => {
    expect(isUnsafeProjectDir('')).toBe(true)
    expect(isUnsafeProjectDir(undefined as unknown as string)).toBe(true)
    expect(isUnsafeProjectDir(null as unknown as string)).toBe(true)
    expect(isUnsafeProjectDir(42 as unknown as string)).toBe(true)
  })
})

describe('registerProjectHandlers (T4)', () => {
  const getWin = (): null => null // no window — guard relies on synthetic senderFrame path

  it('project:save no-ops (returns false) when getCurrentDir() is null', async () => {
    store.getCurrentDir.mockReturnValue(null)
    const { ipcMain, invoke } = makeIpcMain()
    registerProjectHandlers(ipcMain, getWin, '/userData')

    const result = await invoke('project:save', { schemaVersion: 2, boards: [] })
    expect(result).toBe(false)
    expect(store.writeProject).not.toHaveBeenCalled()
  })

  it('project:save writes when a current dir is set', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    store.writeProject.mockResolvedValue(undefined)
    const { ipcMain, invoke } = makeIpcMain()
    registerProjectHandlers(ipcMain, getWin, '/userData')

    const doc = { schemaVersion: 2, boards: [] }
    const result = await invoke('project:save', doc)
    expect(result).toBe(true)
    expect(store.writeProject).toHaveBeenCalledWith('/proj', doc)
  })

  it('project:save returns false (no crash) when writeProject throws (SAVE-1)', async () => {
    store.getCurrentDir.mockReturnValue('/proj')
    store.writeProject.mockRejectedValue(new Error('ENOSPC: disk full'))
    const { ipcMain, invoke } = makeIpcMain()
    registerProjectHandlers(ipcMain, getWin, '/userData')

    // The handler must catch the I/O error and report failure to the renderer,
    // not let the rejection escape (which the renderer floats silently).
    await expect(invoke('project:save', { schemaVersion: 2, boards: [] })).resolves.toBe(false)
  })

  it('project:current sets currentDir only on ok', async () => {
    recents.listRecents.mockReturnValue([{ path: '/proj', name: 'proj', lastOpenedAt: 1 }])
    store.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: {} })
    const { ipcMain, invoke } = makeIpcMain()
    registerProjectHandlers(ipcMain, getWin, '/userData')

    const result = await invoke('project:current')
    expect((result as { ok: boolean }).ok).toBe(true)
    expect(store.setCurrentDir).toHaveBeenCalledWith('/proj')
    expect(recents.touchRecent).toHaveBeenCalled()
  })

  it('project:current leaves currentDir unchanged when the recent folder is gone', async () => {
    recents.listRecents.mockReturnValue([{ path: '/gone', name: 'gone', lastOpenedAt: 1 }])
    store.readProject.mockReturnValue({ ok: false, error: 'No readable canvas.json in /gone' })
    const { ipcMain, invoke } = makeIpcMain()
    registerProjectHandlers(ipcMain, getWin, '/userData')

    const result = await invoke('project:current')
    expect(result).toBeNull()
    expect(store.setCurrentDir).not.toHaveBeenCalled()
    expect(recents.touchRecent).not.toHaveBeenCalled()
  })

  it('project:current returns null when there are no recents', async () => {
    recents.listRecents.mockReturnValue([])
    const { ipcMain, invoke } = makeIpcMain()
    registerProjectHandlers(ipcMain, getWin, '/userData')

    const result = await invoke('project:current')
    expect(result).toBeNull()
    expect(store.readProject).not.toHaveBeenCalled()
  })
})
