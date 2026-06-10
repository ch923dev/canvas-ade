import { describe, it, expect, vi, afterEach } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, sep, basename } from 'path'
import { tmpdir } from 'os'
import { isUnsafeProjectDir, registerProjectHandlers } from './projectIpc'
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
