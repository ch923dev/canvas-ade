/**
 * FIND-002: file:writeText optimistic-concurrency guard. When the caller passes the mtime it last
 * read, MAIN refuses to blind-overwrite a file an external process changed since (a silent lost
 * update), reporting a conflict instead. Drives the REAL handler over a temp project root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ projectDir: '' }))
vi.mock('./projectStore', async (orig) => ({
  ...(await orig<typeof import('./projectStore')>()),
  getCurrentDir: () => state.projectDir
}))

import { registerFileIpc } from './fileIpc'
import { createIpcCapture, mainWin } from './ipcTestHarness'

type Stat = { size: number; mtimeMs: number; isDir: boolean }
type WriteResult = { ok: true; mtimeMs: number } | { ok: false; conflict: true; mtimeMs: number }

describe('file:writeText optimistic-concurrency guard (FIND-002)', () => {
  beforeEach(() => {
    state.projectDir = mkdtempSync(join(tmpdir(), 'fileipc-'))
  })
  afterEach(() => {
    rmSync(state.projectDir, { recursive: true, force: true })
  })

  const handlers = (): ReturnType<typeof createIpcCapture> => {
    const cap = createIpcCapture()
    registerFileIpc(cap.ipcMain, mainWin)
    return cap
  }

  it('rejects a blind overwrite when the file changed on disk since the expected mtime', async () => {
    const cap = handlers()
    writeFileSync(join(state.projectDir, 'foo.txt'), 'on disk')
    // A deliberately stale expected mtime (the real mtime is "now", never 1) → conflict, no write.
    const res = (await cap.invoke('file:writeText', {
      path: 'foo.txt',
      text: 'mine',
      expectedMtimeMs: 1
    })) as WriteResult
    expect(res.ok).toBe(false)
    expect((res as { conflict?: boolean }).conflict).toBe(true)
    expect(typeof res.mtimeMs).toBe('number')
    // The external content is preserved — NOT silently overwritten by the stale writer.
    expect(readFileSync(join(state.projectDir, 'foo.txt'), 'utf8')).toBe('on disk')
  })

  it('writes when the expected mtime matches the current on-disk mtime', async () => {
    const cap = handlers()
    writeFileSync(join(state.projectDir, 'foo.txt'), 'on disk')
    const st = (await cap.invoke('file:stat', 'foo.txt')) as Stat
    const res = (await cap.invoke('file:writeText', {
      path: 'foo.txt',
      text: 'mine',
      expectedMtimeMs: st.mtimeMs
    })) as WriteResult
    expect(res.ok).toBe(true)
    expect(readFileSync(join(state.projectDir, 'foo.txt'), 'utf8')).toBe('mine')
  })

  it('writes unconditionally when no expectedMtimeMs is passed (backward-compatible)', async () => {
    const cap = handlers()
    writeFileSync(join(state.projectDir, 'foo.txt'), 'on disk')
    const res = (await cap.invoke('file:writeText', {
      path: 'foo.txt',
      text: 'forced'
    })) as WriteResult
    expect(res.ok).toBe(true)
    expect(readFileSync(join(state.projectDir, 'foo.txt'), 'utf8')).toBe('forced')
  })

  it('treats a not-yet-existing file as no conflict (creates it)', async () => {
    const cap = handlers()
    const res = (await cap.invoke('file:writeText', {
      path: 'new.txt',
      text: 'created',
      expectedMtimeMs: 12345
    })) as WriteResult
    expect(res.ok).toBe(true)
    expect(readFileSync(join(state.projectDir, 'new.txt'), 'utf8')).toBe('created')
  })
})
