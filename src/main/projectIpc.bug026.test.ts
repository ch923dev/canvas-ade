/**
 * Regression tests for BUG-026.
 *
 * BUG-026: touchRecent throws (e.g. ENOSPC / EPERM) propagate uncaught through remember() and
 *          the project:current direct call, leaving currentDir mutated while the renderer
 *          receives an IPC rejection.
 *          Fix: wrap touchRecent calls in try/catch; a recents-write failure is non-fatal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted stubs (same pattern as projectIpc.integration.test.ts) ──
const { store026, canvasMemory026, electronDialog026, recents026 } = vi.hoisted(() => ({
  store026: {
    readProject: vi.fn(),
    readBak: vi.fn(),
    writeProject: vi.fn(),
    createProject: vi.fn(),
    getCurrentDir: vi.fn(),
    setCurrentDir: vi.fn(),
    projectName: vi.fn((dir: string) => dir.split(/[/\\]/).pop() ?? dir),
    collectAssetIds: vi.fn(() => new Set<string>()),
    gcAssets: vi.fn(),
    writeAsset: vi.fn(),
    readAsset: vi.fn()
  },
  canvasMemory026: {
    scaffoldProjectMemory: vi.fn(),
    createCanvasMemory: vi.fn(),
    safeBoardId: vi.fn(
      (id: string) =>
        typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id)
    )
  },
  electronDialog026: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  },
  recents026: {
    // listRecents returns an empty array by default (no recents).
    listRecents: vi.fn().mockResolvedValue([]),
    // Default: touchRecent throws to simulate EPERM/ENOSPC on the userData dir.
    touchRecent: vi.fn(() => {
      throw new Error('EPERM: operation not permitted')
    })
  }
}))

vi.mock('./projectStore', () => store026)
vi.mock('./canvasMemory', () => canvasMemory026)
vi.mock('electron', () => ({ dialog: electronDialog026, BrowserWindow: class {} }))
vi.mock('./recentProjects', () => recents026)

import { registerProjectHandlers } from './projectIpc'
import { createIpcCapture } from './ipcTestHarness'

describe('BUG-026: touchRecent errors are swallowed — never abort an open or reject the IPC call', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    store026.readBak.mockReturnValue({ ok: false, error: 'no bak' })
    store026.projectName.mockImplementation((dir: string) => dir.split(/[/\\]/).pop() ?? dir)
    // Every touchRecent call throws (simulates EPERM/ENOSPC on the userData dir).
    recents026.touchRecent.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted')
    })
    // listRecents returns empty (no prior recents), as a resolved Promise (it's now async).
    recents026.listRecents.mockResolvedValue([])
  })

  it('BUG-026 red→green: project:open resolves to ok:true even when touchRecent throws (EPERM)', async () => {
    store026.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: {} })

    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, () => null, '/userData')

    // Pre-fix: the EPERM throw propagates out of remember() → the sync IPC handler throws →
    // Electron converts to an IPC rejection → this await throws instead of resolving.
    // Post-fix: remember() wraps touchRecent in try/catch → handler resolves to { ok: true }.
    const result = (await cap.invoke('project:open', '/proj')) as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  it('BUG-026: project:create resolves to ok:true even when touchRecent throws (ENOSPC)', async () => {
    store026.createProject.mockResolvedValue({ ok: true, dir: '/proj', name: 'proj', doc: {} })

    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, () => null, '/userData')

    // Pre-fix: ENOSPC throw propagates through remember() in the async project:create handler.
    const result = (await cap.invoke('project:create', {
      dir: '/proj',
      name: 'proj',
      opts: {}
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  it('BUG-026: project:current returns the loaded project even when touchRecent throws', async () => {
    recents026.listRecents.mockResolvedValue([{ path: '/proj', name: 'proj', lastOpenedAt: 1 }])
    store026.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: {} })

    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, () => null, '/userData')

    // Pre-fix: the EPERM throw at project:current's direct touchRecent call propagates out.
    // Post-fix: the direct touchRecent call in project:current is wrapped in try/catch.
    const result = (await cap.invoke('project:current')) as { ok: boolean } | null
    expect(result).not.toBeNull()
    expect(result!.ok).toBe(true)
  })

  it('BUG-026: setCurrentDir is called even when touchRecent throws — MAIN state is consistent', async () => {
    store026.readProject.mockReturnValue({ ok: true, dir: '/proj', name: 'proj', doc: {} })

    const cap = createIpcCapture()
    registerProjectHandlers(cap.ipcMain, () => null, '/userData')

    // setCurrentDir must be called despite the touchRecent throw.
    // The recents list can't update, but MAIN's currentDir is still set correctly.
    await cap.invoke('project:open', '/proj')
    expect(store026.setCurrentDir).toHaveBeenCalledWith('/proj')
  })
})
