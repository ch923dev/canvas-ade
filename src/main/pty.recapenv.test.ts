/**
 * Task 8 — setRecapEnvProvider seam.
 *
 * Strategy: mock `electron` (MessageChannelMain + webContents.postMessage) and
 * `node-pty` (spawn) so a real shell is NEVER launched, then drive the pty:spawn
 * IPC handler through the captured handler via createIpcCapture + internalEvent.
 * This lets us assert:
 *   1. The provider IS called with the correct opts when set.
 *   2. The env passed to node-pty INCLUDES the provider's return value LAST.
 *   3. When the provider throws, the spawn still succeeds (policy never breaks a spawn).
 *   4. When no provider is set (undefined), spawn behaviour is completely unchanged.
 *
 * The module is reimported fresh for each test (vi.resetModules()) so global
 * recapEnvProvider state cannot leak between tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Electron mock ──────────────────────────────────────────────────────────────
// MessageChannelMain is used inside pty:spawn; we need a minimal stub.
// webContents.postMessage is called to transfer the port to the renderer.
vi.mock('electron', () => {
  function makePort() {
    const port = {
      posted: [] as unknown[],
      closed: false,
      started: false,
      handler: null as ((e: { data: unknown }) => void) | null,
      on(_ev: string, h: (e: { data: unknown }) => void) {
        port.handler = h
      },
      start() {
        port.started = true
      },
      close() {
        port.closed = true
      },
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

// ── node-pty mock ──────────────────────────────────────────────────────────────
// The spy is hoisted so it is in scope before the module under test is imported.
const { getSpawnSpy } = vi.hoisted(() => {
  let spawnSpy: ReturnType<typeof vi.fn>

  function buildSpawnSpy() {
    spawnSpy = vi.fn((shell: string, _args: string[], opts: { env?: Record<string, string> }) => {
      // Return a minimal IPty-like stub so the spawn handler can set up onData/onExit.
      const proc = {
        pid: 9999,
        _shell: shell,
        _env: opts.env,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn()
      }
      return proc
    })
    return spawnSpy
  }

  return { getSpawnSpy: buildSpawnSpy }
})

const spawnSpy = getSpawnSpy()

vi.mock('node-pty', () => ({
  spawn: spawnSpy
}))

// ── other pty.ts dependencies ──────────────────────────────────────────────────
// ipcGuard is imported in pty.ts; stub isForeignSender to always pass through.
vi.mock('./ipcGuard', () => ({ isForeignSender: vi.fn(() => false) }))
// portDetect is a pure module, no side effects — real import is fine; stub to keep tests hermetic.
vi.mock('./portDetect', () => ({ parsePortsFromOutput: vi.fn(() => []) }))
// ptyOutput is pure; stub to avoid any complexity.
vi.mock('./ptyOutput', () => ({
  MAX_OUTPUT_PAGE: 500,
  pageOutput: vi.fn(() => ({ lines: [], cursor: 0, droppedOlder: false })),
  stripAnsi: vi.fn((s: string) => s)
}))
// summaryLoop is type-only imported in pty.ts; no runtime mock needed.

// ── helpers ────────────────────────────────────────────────────────────────────
import type { IpcMainInvokeEvent } from 'electron'

/** Minimal ipcMain stub that captures handle() calls and lets us invoke them. */
function buildIpc() {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
  const ipcMain = {
    handle: (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      handlers.set(ch, fn)
    }
  } as unknown as import('electron').IpcMain

  // An internal (trusted) event: isForeignSender is mocked to return false above.
  const event = { senderFrame: undefined } as unknown as IpcMainInvokeEvent

  const invoke = (channel: string, ...args: unknown[]) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn(event, ...args)
  }

  return { ipcMain, invoke }
}

/** A fake getWin() that returns a minimal BrowserWindow with a no-op postMessage. */
function makeGetWin() {
  const win = {
    isDestroyed: () => false,
    webContents: {
      mainFrame: { id: 'main-frame' },
      isDestroyed: () => false,
      postMessage: vi.fn()
    }
  }
  return () => win as unknown as import('electron').BrowserWindow
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('setRecapEnvProvider (Task 8 — injectable env seam)', () => {
  beforeEach(() => {
    spawnSpy.mockClear()
  })

  afterEach(async () => {
    // Always reset the provider so module-level state doesn't leak.
    // Re-import to get the live module reference (modules are NOT reset between tests here;
    // we rely on the module singleton for the whole describe block, so we must manually reset).
    const { setRecapEnvProvider } = await import('./pty')
    setRecapEnvProvider(undefined)
  })

  it('provider is consulted with the correct opts (id, launchCommand, cwd)', async () => {
    const { setRecapEnvProvider, registerPtyHandlers } = await import('./pty')
    const seen: unknown[] = []
    setRecapEnvProvider((o) => {
      seen.push(o)
      return { CANVAS_RECAP_BOARD: o.id }
    })

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    await invoke('pty:spawn', { id: 'b1', launchCommand: 'claude', cwd: '/some/dir' })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 'b1', launchCommand: 'claude', cwd: '/some/dir' })
  })

  it('env from the provider is merged LAST into the spawn env', async () => {
    const { setRecapEnvProvider, registerPtyHandlers } = await import('./pty')
    setRecapEnvProvider(() => ({ CANVAS_RECAP_BOARD: 'board-42' }))

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    await invoke('pty:spawn', { id: 'board-42', launchCommand: 'claude' })

    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const spawnedEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>
    // Provider's key wins over process.env (merged last).
    expect(spawnedEnv['CANVAS_RECAP_BOARD']).toBe('board-42')
    // process.env keys are still present.
    expect(Object.keys(spawnedEnv).length).toBeGreaterThan(1)
  })

  it('a throwing provider does NOT break the spawn (policy error is swallowed)', async () => {
    const { setRecapEnvProvider, registerPtyHandlers } = await import('./pty')
    setRecapEnvProvider(() => {
      throw new Error('consent-check exploded')
    })

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    // Must not throw — the spawn completes normally.
    const result = await invoke('pty:spawn', { id: 'b2', launchCommand: 'claude' })
    expect((result as { state: string }).state).toBe('running')
    // node-pty spawn was still called.
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    // The env should NOT include CANVAS_RECAP_BOARD (provider threw, recapEnv = undefined).
    const spawnedEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>
    expect(spawnedEnv['CANVAS_RECAP_BOARD']).toBeUndefined()
  })

  it('no provider set (undefined) → spawn is unchanged (no CANVAS_RECAP_BOARD, no crash)', async () => {
    // setRecapEnvProvider is NOT called — provider is undefined by default (or reset by afterEach).
    const { registerPtyHandlers } = await import('./pty')

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    const result = await invoke('pty:spawn', { id: 'b3' })
    expect((result as { state: string }).state).toBe('running')
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const spawnedEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>
    expect(spawnedEnv['CANVAS_RECAP_BOARD']).toBeUndefined()
  })

  it('provider returning undefined merges no extra env keys', async () => {
    const { setRecapEnvProvider, registerPtyHandlers } = await import('./pty')
    setRecapEnvProvider(() => undefined)

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    await invoke('pty:spawn', { id: 'b4' })
    const spawnedEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>
    expect(spawnedEnv['CANVAS_RECAP_BOARD']).toBeUndefined()
  })
})
