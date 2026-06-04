import { describe, it, expect, vi, afterEach } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join, sep, basename } from 'path'
import { tmpdir } from 'os'
import { isForeignSender, isUnsafeProjectDir, registerProjectHandlers } from './projectIpc'
import { touchRecent } from './recentProjects'

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

  it('surfaces (does not silently swallow) a read failure of the most-recent project', () => {
    const userDataDir = mkTmp('canvas-ud-')
    const projDir = mkTmp('canvas-proj-') // exists, but has NO canvas.json → readProject fails
    touchRecent(userDataDir, projDir, 'proj', 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = register(userDataDir).get('project:current')!(synthetic)

    expect(result).toBeNull()
    expect(warn).toHaveBeenCalled() // project-current-readproject-swallow: the error is logged, not dropped
  })

  it('rejects an unsafe most-recent path (traversal) before touching the filesystem', () => {
    const userDataDir = mkTmp('canvas-ud-')
    const projDir = mkTmp('canvas-proj-')
    writeFileSync(
      join(projDir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [] })
    )
    // An un-normalized path with a `..` segment that the OS would still resolve to the real
    // project — without the guard, readProject would happily load it.
    const unsafe = `${projDir}${sep}..${sep}${basename(projDir)}`
    touchRecent(userDataDir, unsafe, 'proj', 1)

    const result = register(userDataDir).get('project:current')!(synthetic)

    // project-current-skips-unsafe-dir-guard: guarded like project:open → not loaded.
    expect(result).toBeNull()
  })

  it('loads a valid most-recent project on reopen', () => {
    const userDataDir = mkTmp('canvas-ud-')
    const projDir = mkTmp('canvas-proj-')
    writeFileSync(
      join(projDir, 'canvas.json'),
      JSON.stringify({ schemaVersion: 2, viewport: null, boards: [] })
    )
    touchRecent(userDataDir, projDir, 'proj', 1)

    const result = register(userDataDir).get('project:current')!(synthetic) as { ok: boolean }

    expect(result).not.toBeNull()
    expect(result.ok).toBe(true)
  })
})
