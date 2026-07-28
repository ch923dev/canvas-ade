import { describe, it, expect, vi, afterEach } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Audit Phase 3 gate: "sync-fs count per `project:open` drops from 14+2N".
 *
 * The `2N` term was `rehydrateMissingSummaries` asking "does this board have a cached summary?"
 * with `readBoard(id) === undefined` — an `existsSync` plus a full `readFileSync` per board, on
 * MAIN's IPC thread, discarding the content it just read. Presence is a directory question, so
 * DL-2 asks the directory once.
 *
 * This counts real fs calls through a counting proxy over the `fs` module (both projectStore.ts
 * and canvasMemory.ts import from `'fs'`), and asserts the property that matters and survives
 * refactoring: the count does NOT grow with board count. An absolute number would be a brittle
 * restatement of today's implementation; "flat in N" is the actual claim.
 */
const { counts, electronDialog } = vi.hoisted(() => ({
  counts: { existsSync: 0, readFileSync: 0, readdirSync: 0, total: 0 },
  electronDialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }
}))

vi.mock('electron', () => ({ dialog: electronDialog, BrowserWindow: class {} }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const wrap = <A extends unknown[], R>(name: keyof typeof counts, fn: (...a: A) => R) =>
    ((...a: A): R => {
      counts[name]++
      counts.total++
      return fn(...a)
    }) as (...a: A) => R
  return {
    ...actual,
    default: actual,
    existsSync: wrap('existsSync', actual.existsSync),
    readFileSync: wrap('readFileSync', actual.readFileSync),
    readdirSync: wrap('readdirSync', actual.readdirSync)
  }
})

import { registerProjectHandlers } from './projectIpc'
import { touchRecent } from './recentProjects'

type Handler = (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown

describe('project:open sync-fs cost (audit DL-2)', () => {
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

  const register = (userDataDir: string, rehydrated?: string[][]): Map<string, Handler> => {
    const handlers = new Map<string, Handler>()
    registerProjectHandlers(
      { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) } as unknown as IpcMain,
      () => null,
      userDataDir,
      () => 1,
      rehydrated
        ? {
            observe: () => {},
            reset: () => {},
            rehydrate: (ids) => rehydrated.push([...ids])
          }
        : undefined
    )
    return handlers
  }
  const synthetic = {} as IpcMainInvokeEvent

  /** A project with `n` boards, none of which has a cached summary on disk. */
  const seedProject = (n: number): string => {
    const dir = mkTmp('canvas-fs-count-')
    const boards = Array.from({ length: n }, (_, i) => ({ id: `board${i}`, type: 'planning' }))
    mkdirSync(join(dir, '.canvas'), { recursive: true })
    writeFileSync(
      join(dir, '.canvas', 'canvas.json'),
      JSON.stringify({ schemaVersion: 8, viewport: null, boards })
    )
    return dir
  }

  const openAndCount = async (boardCount: number): Promise<number> => {
    const userDataDir = mkTmp('canvas-ud-')
    const dir = seedProject(boardCount)
    await touchRecent(userDataDir, dir, 'p', 1) // BUG-006: an approved location
    const handlers = register(userDataDir)
    counts.existsSync = counts.readFileSync = counts.readdirSync = counts.total = 0
    const r = (await handlers.get('project:open')!(synthetic, dir)) as { ok: boolean }
    expect(r.ok).toBe(true)
    return counts.total
  }

  it('does not grow with board count — the 2N per-board term is gone', async () => {
    const at0 = await openAndCount(0)
    const at8 = await openAndCount(8)
    const at24 = await openAndCount(24)
    // Restoring `readBoard(id) === undefined` puts back 2 calls per board: this reads
    // 16 and 48 over the 0-board baseline, and the assertion fails.
    expect(at8 - at0).toBe(0)
    expect(at24 - at0).toBe(0)
  })

  // The cheap form is only worth anything if it still gives the RIGHT answer: the batched
  // directory listing has to identify exactly the boards whose `board-<id>.md` is absent, and
  // must not confuse them with the `board-<id>.recap.json` sidecars sharing the prefix.
  it('still rehydrates exactly the boards whose summary file is missing', async () => {
    const userDataDir = mkTmp('canvas-ud-')
    const dir = seedProject(24)
    const memDir = join(dir, '.canvas', 'memory')
    mkdirSync(memDir, { recursive: true })
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(memDir, `board-board${i}.md`), '# summary')
      // A recap sidecar for a board with NO summary — same prefix, different family. Counting it
      // as a summary would silently stop board12 from ever being re-summarized.
      writeFileSync(join(memDir, `board-board${i + 12}.recap.json`), '{}')
    }
    await touchRecent(userDataDir, dir, 'p', 1)
    const rehydrated: string[][] = []
    const handlers = register(userDataDir, rehydrated)
    counts.existsSync = counts.readFileSync = counts.readdirSync = counts.total = 0
    await handlers.get('project:open')!(synthetic, dir)
    expect(rehydrated).toHaveLength(1)
    expect(rehydrated[0].sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `board${i + 12}`).sort()
    )
    // The old form paid 24 existsSync + 12 readFileSync for those summaries alone.
    expect(counts.existsSync).toBeLessThan(24)
  })
})
