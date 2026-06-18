/**
 * setOrchestrationSyncProvider seam (Agent Orchestration · P3) — same harness as
 * pty.recapenv.test.ts: mock electron + node-pty so no real shell launches, drive `pty:spawn`,
 * and assert the provider is consulted at spawn time AND that a provider error never breaks a spawn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => {
  function makePort() {
    const port = {
      posted: [] as unknown[],
      on() {},
      start() {},
      close() {},
      postMessage(m: unknown) {
        port.posted.push(m)
      }
    }
    return port
  }
  class MessageChannelMain {
    port1 = makePort()
    port2 = makePort()
  }
  return { MessageChannelMain }
})

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn((_shell: string, _args: string[], _opts: unknown) => ({
    pid: 9999,
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
vi.mock('./ptyOutput', () => ({
  MAX_OUTPUT_PAGE: 500,
  pageOutput: vi.fn(() => ({ lines: [], cursor: 0, droppedOlder: false })),
  stripAnsi: vi.fn((s: string) => s)
}))

import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'

function buildIpc() {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
  const ipcMain = {
    handle: (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
      void handlers.set(ch, fn)
  } as unknown as IpcMain
  const event = { senderFrame: undefined } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(event, ...args)
  }
  return { ipcMain, invoke }
}
const makeGetWin = (): (() => BrowserWindow) => {
  const win = { webContents: { postMessage: vi.fn() } }
  return () => win as unknown as BrowserWindow
}

describe('setOrchestrationSyncProvider', () => {
  beforeEach(() => spawnSpy.mockClear())
  afterEach(async () => {
    const { setOrchestrationSyncProvider } = await import('./pty')
    setOrchestrationSyncProvider(undefined)
  })

  it('consults the provider at spawn time with the board id, launchCommand, and cwd', async () => {
    const { setOrchestrationSyncProvider, registerPtyHandlers } = await import('./pty')
    const seen: unknown[] = []
    setOrchestrationSyncProvider((o) => void seen.push(o))

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())
    await invoke('pty:spawn', { id: 'b1', launchCommand: 'claude' })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 'b1', launchCommand: 'claude' })
    expect((seen[0] as { cwd: string }).cwd).toEqual(expect.any(String))
  })

  it('runs before the launch line is written to the PTY', async () => {
    const { setOrchestrationSyncProvider, registerPtyHandlers } = await import('./pty')
    const order: string[] = []
    setOrchestrationSyncProvider(() => void order.push('sync'))

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())
    await invoke('pty:spawn', { id: 'b1', launchCommand: 'claude' })

    const proc = spawnSpy.mock.results[0].value as { write: ReturnType<typeof vi.fn> }
    proc.write.mock.calls.forEach(() => order.push('write'))
    expect(order).toEqual(['sync', 'write'])
    expect(proc.write).toHaveBeenCalledWith('claude\r')
  })

  it('a throwing provider never breaks the spawn', async () => {
    const { setOrchestrationSyncProvider, registerPtyHandlers } = await import('./pty')
    setOrchestrationSyncProvider(() => {
      throw new Error('mint exploded')
    })
    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    const result = await invoke('pty:spawn', { id: 'b2', launchCommand: 'claude' })
    expect((result as { state: string }).state).toBe('running')
    expect(spawnSpy).toHaveBeenCalledTimes(1)
  })

  it('no provider set → spawn is unchanged', async () => {
    const { registerPtyHandlers } = await import('./pty')
    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())
    const result = await invoke('pty:spawn', { id: 'b3', launchCommand: 'claude' })
    expect((result as { state: string }).state).toBe('running')
  })
})
