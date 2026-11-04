/**
 * WS-3 — `pty:spawn` for a workspace board, end to end through the handler (design §4.2). Same
 * harness as pty.orchsync.test.ts: electron + node-pty mocked, so no real shell launches. Proves the
 * wiring, not just the pure helpers: MAIN resolves the root from its OWN workspace mirror, a cwd the
 * renderer resolved against a forged root never reaches node-pty, a refusal is a `spawn-failed` with
 * the sentence (never a `$HOME` spawn), and CANVAS_WORKSPACE_* reach ONLY workspace boards.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('electron', () => {
  function makePort() {
    return { on() {}, start() {}, close() {}, postMessage() {} }
  }
  class MessageChannelMain {
    port1 = makePort()
    port2 = makePort()
  }
  return { MessageChannelMain }
})

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn((_shell: string, _args: string[], _opts: unknown) => ({
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn()
  }))
}))
vi.mock('node-pty', () => ({ spawn: spawnSpy }))
vi.mock('./ipcGuard', () => ({ isForeignSender: vi.fn(() => false) }))
vi.mock('./portDetect', () => ({ parsePortsFromOutput: vi.fn(() => []) }))
vi.mock('./ptyOutput', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ptyOutput')>()),
  pageOutput: vi.fn(() => ({ lines: [], cursor: 0, droppedOlder: false })),
  stripAnsi: vi.fn((s: string) => s)
}))

import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { registerPtyHandlers } from './pty'
import { __setWorkspacesForTest } from './boardRegistry'
import { setCurrentDir } from './projectStore'

const WS_KEYS = ['CANVAS_WORKSPACE_ID', 'CANVAS_WORKSPACE_ROOT', 'CANVAS_WORKSPACE_CONTEXT']

let base: string
let project: string
let invoke: (channel: string, ...args: unknown[]) => unknown

type SpawnRes = { state: string; pid: number; error?: string }
const spawned = (): { cwd: string; env: Record<string, string> } => {
  const opts = spawnSpy.mock.calls[0][2] as { cwd: string; env: Record<string, string> }
  return { cwd: opts.cwd, env: opts.env }
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws3-ptyspawn-'))
  project = path.join(base, 'proj')
  fs.mkdirSync(path.join(project, 'api'), { recursive: true })
  fs.mkdirSync(path.join(project, 'uploader'), { recursive: true })
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
  const ipcMain = {
    handle: (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
      void handlers.set(ch, fn)
  } as unknown as IpcMain
  const win = { webContents: { postMessage: vi.fn() } } as unknown as BrowserWindow
  registerPtyHandlers(ipcMain, () => win)
  const event = { senderFrame: undefined } as unknown as IpcMainInvokeEvent
  invoke = (channel, ...args) => handlers.get(channel)!(event, ...args)
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

beforeEach(() => {
  spawnSpy.mockClear()
  setCurrentDir(project)
  __setWorkspacesForTest([{ id: 'ws-api', name: 'API', goal: '', color: 'blue', root: 'api' }])
})

afterEach(async () => {
  for (const id of ['w1', 'w2', 'p1']) await invoke('pty:kill', id)
  setCurrentDir(null)
  __setWorkspacesForTest([])
  for (const k of WS_KEYS) delete process.env[k]
})

describe('pty:spawn — workspace board (WS-3)', () => {
  it('starts in the MAIN-resolved root and exports CANVAS_WORKSPACE_*', async () => {
    const res = (await invoke('pty:spawn', { id: 'w1', workspaceId: 'ws-api' })) as SpawnRes
    expect(res.state).toBe('running')
    const { cwd, env } = spawned()
    expect(cwd).toBe(path.join(project, 'api'))
    expect(env.CANVAS_WORKSPACE_ID).toBe('ws-api')
    expect(env.CANVAS_WORKSPACE_ROOT).toBe(path.join(project, 'api'))
    expect(env.CANVAS_WORKSPACE_CONTEXT).toBe(
      path.join(project, '.canvas', 'workspaces', 'ws-api', 'CONTEXT.md')
    )
  })

  it('refuses a cwd resolved against a forged root — node-pty never runs', async () => {
    const forged = path.join(project, 'uploader')
    const res = (await invoke('pty:spawn', {
      id: 'w2',
      workspaceId: 'ws-api',
      cwd: forged
    })) as SpawnRes
    expect(res).toMatchObject({ state: 'spawn-failed', pid: -1 })
    expect(res.error).toMatch(/is outside Workspace "API"/)
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('a deleted root is a visible spawn-failed sentence, never a $HOME spawn', async () => {
    __setWorkspacesForTest([{ id: 'ws-api', name: 'API', goal: '', color: 'blue', root: 'gone' }])
    const res = (await invoke('pty:spawn', { id: 'w1', workspaceId: 'ws-api' })) as SpawnRes
    expect(res.state).toBe('spawn-failed')
    expect(res.error).toBe(
      'Workspace "API" folder is missing (gone/). Restore it or remove the workspace.'
    )
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('an id MAIN does not know is refused, even with a valid-looking cwd', async () => {
    const res = (await invoke('pty:spawn', {
      id: 'w1',
      workspaceId: 'ws-ghost',
      cwd: path.join(project, 'api')
    })) as SpawnRes
    expect(res.state).toBe('spawn-failed')
    expect(spawnSpy).not.toHaveBeenCalled()
  })
})

describe('pty:spawn — project-level board is unchanged', () => {
  it('no CANVAS_WORKSPACE_* — not even ones inherited from the app env', async () => {
    process.env.CANVAS_WORKSPACE_ID = 'parent-ws'
    process.env.CANVAS_WORKSPACE_ROOT = '/parent/root'
    const res = (await invoke('pty:spawn', { id: 'p1', cwd: project })) as SpawnRes
    expect(res.state).toBe('running')
    const { cwd, env } = spawned()
    expect(cwd).toBe(project)
    for (const k of WS_KEYS) expect(env[k]).toBeUndefined()
  })

  it('a missing cwd still falls back to the home dir (safeCwd behaviour kept)', async () => {
    await invoke('pty:spawn', { id: 'p1', cwd: path.join(project, 'gone') })
    expect(spawned().cwd).toBe(os.homedir())
  })
})
