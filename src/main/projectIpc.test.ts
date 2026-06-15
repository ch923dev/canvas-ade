import { describe, it, expect, vi, afterEach } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, sep, basename } from 'path'
import { tmpdir } from 'os'

// `electron` resolves to the binary PATH (a string) outside the Electron runtime, so its API
// objects are undefined under vitest's node env. Stub only what projectIpc.ts touches at runtime
// (`dialog`); existing tests here never call dialog, so this is inert for them and lets the
// BUG-006 dialog-approval flow drive a controllable showOpenDialog. (Same pattern as
// projectIpc.bug026.test.ts.)
const { electronDialog } = vi.hoisted(() => ({
  electronDialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  }
}))
vi.mock('electron', () => ({ dialog: electronDialog, BrowserWindow: class {} }))

import { isUnsafeProjectDir, isUnderApprovedRoot, registerProjectHandlers } from './projectIpc'
import { touchRecent } from './recentProjects'

// isForeignSender is now the shared guard — its branches live in ipcGuard.test.ts.

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

// BUG-006: isUnsafeProjectDir only proves a path is a clean absolute string — it does NOT
// constrain the target to a user-approved location. isUnderApprovedRoot is the equal-to-or-under
// containment check the create/open gate uses against the approved-root set.
describe('isUnderApprovedRoot (BUG-006)', () => {
  it('accepts a path equal to or under an approved root', () => {
    expect(isUnderApprovedRoot('/home/x/proj', '/home/x/proj')).toBe(true)
    expect(isUnderApprovedRoot('/home/x/proj/sub', '/home/x/proj')).toBe(true)
    expect(isUnderApprovedRoot('C:\\Users\\x\\proj', 'C:\\Users\\x\\proj')).toBe(true)
    expect(isUnderApprovedRoot('C:\\Users\\x\\proj\\sub', 'C:\\Users\\x\\proj')).toBe(true)
  })

  it('rejects a path outside every approved root', () => {
    expect(isUnderApprovedRoot('/etc/passwd', '/home/x/proj')).toBe(false)
    expect(isUnderApprovedRoot('C:\\Windows\\System32', 'C:\\Users\\x\\proj')).toBe(false)
  })

  it('rejects a sibling whose name only shares a prefix (segment-wise, not substring)', () => {
    // `/home/x/project` must NOT be treated as under `/home/x/proj`.
    expect(isUnderApprovedRoot('/home/x/project', '/home/x/proj')).toBe(false)
    expect(isUnderApprovedRoot('C:\\Users\\x\\project', 'C:\\Users\\x\\proj')).toBe(false)
  })

  it('is case-insensitive and trailing-separator-agnostic', () => {
    expect(isUnderApprovedRoot('C:\\Users\\X\\PROJ', 'c:\\users\\x\\proj')).toBe(true)
    expect(isUnderApprovedRoot('/home/x/proj', '/home/x/proj/')).toBe(true)
  })

  it('rejects a non-string / empty input', () => {
    expect(isUnderApprovedRoot('/home/x/proj', '')).toBe(false)
    expect(isUnderApprovedRoot(undefined as unknown as string, '/home/x/proj')).toBe(false)
    expect(isUnderApprovedRoot('/home/x/proj', null as unknown as string)).toBe(false)
  })
})

// BUG-006 (defense-in-depth): project:create / project:open must reject an absolute,
// traversal-free path that the user never approved (dialog pick / recents / current),
// while still allowing the legit dialog-pick and open-recent flows. Drives the REAL
// handlers + real recentProjects (only the OS dialog is stubbed).
describe('project:create / project:open approved-root guard (BUG-006)', () => {
  const tmp: string[] = []
  const mkTmp = (p: string): string => {
    const d = mkdtempSync(join(tmpdir(), p))
    tmp.push(d)
    return d
  }
  afterEach(() => {
    vi.restoreAllMocks()
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true })
  })

  type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const register = (userDataDir: string): Map<string, Handler> => {
    const handlers = new Map<string, Handler>()
    const ipcMain = {
      handle: (ch: string, fn: Handler) => handlers.set(ch, fn)
    } as unknown as IpcMain
    registerProjectHandlers(
      ipcMain,
      () => null,
      userDataDir,
      () => 1
    )
    return handlers
  }
  const synthetic = {} as IpcMainInvokeEvent

  it('rejects project:create at an absolute path the user never approved (no dialog/recents)', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const evilDir = mkTmp('canvas-evil-') // a real absolute, traversal-free path — but never approved
    // isUnsafeProjectDir(evilDir) === false, so the OLD guard would let createProject write here.
    expect(isUnsafeProjectDir(evilDir)).toBe(false)

    const result = await register(userDataDir).get('project:create')!(synthetic, {
      dir: evilDir,
      name: 'evil',
      opts: {}
    })

    expect(result).toEqual({ ok: false, error: 'invalid path' })
    // Fail-closed: no canvas.json was written into the unapproved dir.
    expect(() => readFileSync(join(evilDir, 'canvas.json'), 'utf8')).toThrow()
  })

  it('rejects project:open at an absolute path the user never approved', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const evilDir = mkTmp('canvas-evil-')
    // Even a perfectly valid canvas.json on disk must not open without prior approval.
    writeFileSync(
      join(evilDir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 9, viewport: null, boards: [] })
    )

    const result = await register(userDataDir).get('project:open')!(synthetic, evilDir)

    expect(result).toEqual({ ok: false, error: 'invalid path' })
  })

  it('allows the create-from-dialog flow: dialog:openFolder approves the picked path', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const pickedDir = mkTmp('canvas-pick-')
    // Stub the OS folder picker to return the path the user just selected.
    electronDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [pickedDir] })

    const handlers = register(userDataDir)
    // Renderer flow: pick a folder, THEN create the project in it.
    const picked = await handlers.get('dialog:openFolder')!(synthetic)
    expect(picked).toBe(pickedDir)

    const result = (await handlers.get('project:create')!(synthetic, {
      dir: pickedDir,
      name: 'pick',
      opts: {}
    })) as { ok: boolean }

    expect(result.ok).toBe(true)
    // The fresh canvas.json landed in the dialog-approved dir.
    expect(readFileSync(join(pickedDir, 'canvas.json'), 'utf8')).toContain('schemaVersion')
  })

  it('allows open-recent: a path already in the recents list is approved', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const recentDir = mkTmp('canvas-recent-')
    writeFileSync(
      join(recentDir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 9, viewport: null, boards: [] })
    )
    // The user opened this project before — it is on the durable MRU list (an approval record).
    await touchRecent(userDataDir, recentDir, 'recent', 1)

    const result = (await register(userDataDir).get('project:open')!(synthetic, recentDir)) as {
      ok: boolean
    }

    expect(result.ok).toBe(true)
  })
})

describe('project:current handler', () => {
  const tmp: string[] = []
  const mkTmp = (p: string): string => {
    const d = mkdtempSync(join(tmpdir(), p))
    tmp.push(d)
    return d
  }
  afterEach(() => {
    vi.restoreAllMocks()
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true })
  })

  // Capture the handlers registered against a fake ipcMain so we can drive them directly.
  const register = (userDataDir: string): Map<string, (e: IpcMainInvokeEvent) => unknown> => {
    const handlers = new Map<string, (e: IpcMainInvokeEvent) => unknown>()
    const ipcMain = {
      handle: (ch: string, fn: (e: IpcMainInvokeEvent) => unknown) => handlers.set(ch, fn)
    } as unknown as IpcMain
    registerProjectHandlers(
      ipcMain,
      () => null,
      userDataDir,
      () => 1
    )
    return handlers
  }
  // A synthetic event has no senderFrame → the foreign-sender guard allows it.
  const synthetic = {} as IpcMainInvokeEvent

  it('surfaces (does not silently swallow) a read failure of the most-recent project', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const projDir = mkTmp('canvas-proj-') // exists, but has NO canvas.json → readProject fails
    await touchRecent(userDataDir, projDir, 'proj', 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await register(userDataDir).get('project:current')!(synthetic)

    expect(result).toBeNull()
    expect(warn).toHaveBeenCalled() // project-current-readproject-swallow: the error is logged, not dropped
  })

  it('rejects an unsafe most-recent path (traversal) before touching the filesystem', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const projDir = mkTmp('canvas-proj-')
    writeFileSync(
      join(projDir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [] })
    )
    // An un-normalized path with a `..` segment that the OS would still resolve to the real
    // project — without the guard, readProject would happily load it.
    const unsafe = `${projDir}${sep}..${sep}${basename(projDir)}`
    await touchRecent(userDataDir, unsafe, 'proj', 1)

    const result = await register(userDataDir).get('project:current')!(synthetic)

    // project-current-skips-unsafe-dir-guard: guarded like project:open → not loaded.
    expect(result).toBeNull()
  })

  it('loads a valid most-recent project on reopen', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const projDir = mkTmp('canvas-proj-')
    writeFileSync(
      join(projDir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [] })
    )
    await touchRecent(userDataDir, projDir, 'proj', 1)

    const result = (await register(userDataDir).get('project:current')!(synthetic)) as {
      ok: boolean
    }

    expect(result).not.toBeNull()
    expect(result.ok).toBe(true)
  })
})

// BUG-009 (MAIN half): project:save wrote the posted doc to getCurrentDir()
// unconditionally — a save raced against a project switch cross-wrote one project's
// canvas into another's canvas.json. An optional expectedDir lets dir-aware callers
// (the autosaver) pin the doc to its project; a mismatch is rejected.
describe('project:save expectedDir guard (BUG-009)', () => {
  const tmp: string[] = []
  const mkTmp = (p: string): string => {
    const d = mkdtempSync(join(tmpdir(), p))
    tmp.push(d)
    return d
  }
  afterEach(() => {
    vi.restoreAllMocks()
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true })
  })

  type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const register = (userDataDir: string): Map<string, Handler> => {
    const handlers = new Map<string, Handler>()
    const ipcMain = {
      handle: (ch: string, fn: Handler) => handlers.set(ch, fn)
    } as unknown as IpcMain
    registerProjectHandlers(
      ipcMain,
      () => null,
      userDataDir,
      () => 1
    )
    return handlers
  }
  const synthetic = {} as IpcMainInvokeEvent

  it('rejects a save whose expectedDir mismatches the current dir; matching/omitted still save', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userDataDir = mkTmp('canvas-ud-')
    const projB = mkTmp('canvas-proj-b-')
    const projC = mkTmp('canvas-proj-c-')
    const seeded = JSON.stringify({ schemaVersion: 8, viewport: null, boards: [{ id: 'c1' }] })
    writeFileSync(join(projC, 'canvas.json'), seeded)
    // BUG-006: project:open now requires the target to be a user-approved location; seed C into
    // recents (a durable approval record) so this BUG-009 open is allowed, as it is in real use.
    await touchRecent(userDataDir, projC, 'c', 1)
    const handlers = register(userDataDir)
    await handlers.get('project:open')!(synthetic, projC) // currentDir = C

    const doc = { schemaVersion: 8, viewport: null, boards: [], connectors: [] }
    // The B-flavored save that lost the switch race must be rejected, leaving C intact.
    expect(await handlers.get('project:save')!(synthetic, doc, projB)).toBe(false)
    expect(readFileSync(join(projC, 'canvas.json'), 'utf8')).toBe(seeded)
    // A matching expectedDir saves; an omitted one keeps back-compat.
    expect(await handlers.get('project:save')!(synthetic, doc, projC)).toBe(true)
    expect(await handlers.get('project:save')!(synthetic, doc)).toBe(true)
  })
})

describe('project:removeRecent / project:clearRecents handlers', () => {
  const tmp: string[] = []
  const mkTmp = (p: string): string => {
    const d = mkdtempSync(join(tmpdir(), p))
    tmp.push(d)
    return d
  }
  afterEach(() => {
    vi.restoreAllMocks()
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true })
  })

  type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const register = (userDataDir: string): Map<string, Handler> => {
    const handlers = new Map<string, Handler>()
    const ipcMain = {
      handle: (ch: string, fn: Handler) => handlers.set(ch, fn)
    } as unknown as IpcMain
    registerProjectHandlers(
      ipcMain,
      () => null,
      userDataDir,
      () => 1
    )
    return handlers
  }
  const synthetic = {} as IpcMainInvokeEvent

  it('removeRecent drops the entry and returns the fresh list', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const a = mkTmp('canvas-proj-a-')
    const b = mkTmp('canvas-proj-b-')
    await touchRecent(userDataDir, a, 'a', 1)
    await touchRecent(userDataDir, b, 'b', 2)
    const handlers = register(userDataDir)

    const list = (await handlers.get('project:removeRecent')!(synthetic, b)) as {
      path: string
    }[]

    expect(list.map((r) => r.path)).toEqual([a])
  })

  it('removeRecent ignores a non-string path and returns the unchanged list', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const a = mkTmp('canvas-proj-a-')
    await touchRecent(userDataDir, a, 'a', 1)
    const handlers = register(userDataDir)

    const list = (await handlers.get('project:removeRecent')!(synthetic, 42)) as {
      path: string
    }[]

    expect(list.map((r) => r.path)).toEqual([a])
  })

  it('clearRecents wipes the list and returns []', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const a = mkTmp('canvas-proj-a-')
    await touchRecent(userDataDir, a, 'a', 1)
    const handlers = register(userDataDir)

    expect(await handlers.get('project:clearRecents')!(synthetic)).toEqual([])
    expect(await handlers.get('project:recents')!(synthetic)).toEqual([])
  })
})
