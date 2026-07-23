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
// ptyOutput is pure; pass the real module through (incl. the PERF-06 output ring
// createRing/pushRing/readRing the spawn path uses) and stub only the paging helpers.
vi.mock('./ptyOutput', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ptyOutput')>()),
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

  describe('terminal-copy fix: baseline spawn env', () => {
    it('every spawn carries FORCE_HYPERLINK=1; alt-screen unset by default (T1d flicker-free ON)', async () => {
      const { registerPtyHandlers } = await import('./pty')
      const { ipcMain, invoke } = buildIpc()
      registerPtyHandlers(ipcMain, makeGetWin())

      await invoke('pty:spawn', { id: 'b5' })
      const spawnedEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>
      expect(spawnedEnv['FORCE_HYPERLINK']).toBe('1')
      // T1d: "Flicker-free terminals" defaults ON (isFlickerFree() unbound → the ON default here, no
      // terminalDisplayConfig bound in this test), so the CLI keeps its default alt-screen — the var
      // is NOT set. The forced-off path ('1' when flicker-free is OFF) is covered in ptySpawnEnv.test.ts.
      expect(spawnedEnv['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']).toBeUndefined()
    })

    it('the recap-env provider is merged LAST and can override the baseline', async () => {
      const { setRecapEnvProvider, registerPtyHandlers } = await import('./pty')
      setRecapEnvProvider(() => ({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' }))
      const { ipcMain, invoke } = buildIpc()
      registerPtyHandlers(ipcMain, makeGetWin())

      await invoke('pty:spawn', { id: 'b6' })
      const spawnedEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>
      expect(spawnedEnv['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']).toBe('0')
      expect(spawnedEnv['FORCE_HYPERLINK']).toBe('1')
    })

    it('nested-claude session identity vars are scrubbed from every spawn', async () => {
      // The app launched from inside a claude session (dev running `pnpm dev` in a claude
      // terminal) inherits the parent session's identity — a board's claude must not.
      const poisoned = {
        CLAUDECODE: '1',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ID: 'parent-session-id',
        CLAUDE_CODE_SSE_PORT: '12345',
        CLAUDE_CODE_ENTRYPOINT: 'cli'
      }
      const saved: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(poisoned)) {
        saved[k] = process.env[k]
        process.env[k] = v
      }
      try {
        const { registerPtyHandlers } = await import('./pty')
        const { ipcMain, invoke } = buildIpc()
        registerPtyHandlers(ipcMain, makeGetWin())

        await invoke('pty:spawn', { id: 'b11' })
        const spawnedEnv = spawnSpy.mock.calls[0][2].env as Record<string, string>
        for (const k of Object.keys(poisoned)) expect(spawnedEnv[k]).toBeUndefined()
        // FORCE_HYPERLINK is the deliberate baseline that survives the scrub. The alt-screen var is
        // NOT set here: T1d flicker-free defaults ON (no terminalDisplayConfig bound), so the CLI
        // keeps its default alt-screen (the var is only set on the forced-off / flicker-free-OFF path).
        expect(spawnedEnv['FORCE_HYPERLINK']).toBe('1')
        expect(spawnedEnv['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN']).toBeUndefined()
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    })
  })
})

describe('setRecapHookSyncProvider (cross-cwd recap capture — spawn-time hook install seam)', () => {
  beforeEach(() => {
    spawnSpy.mockClear()
  })

  afterEach(async () => {
    const { setRecapHookSyncProvider } = await import('./ptySpawnEnv')
    setRecapHookSyncProvider(undefined)
  })

  it('provider is consulted with the id + RESOLVED cwd on every spawn (even a bare shell)', async () => {
    const { setRecapHookSyncProvider } = await import('./ptySpawnEnv')
    const { registerPtyHandlers } = await import('./pty')
    const seen: { id: string; cwd: string }[] = []
    setRecapHookSyncProvider((o) => {
      seen.push(o)
    })

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    // No launchCommand: a bare shell board must still get the hook — a hand-typed `claude`
    // in it needs the cwd repo's hook exactly as a configured launch does.
    const cwd = process.cwd() // a real dir, so safeCwd resolves it verbatim
    await invoke('pty:spawn', { id: 'b7', cwd })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: 'b7', cwd })
  })

  it('provider runs BEFORE the launch line is written (hook on disk before the agent boots)', async () => {
    const { setRecapHookSyncProvider } = await import('./ptySpawnEnv')
    const { registerPtyHandlers } = await import('./pty')
    const provider = vi.fn()
    setRecapHookSyncProvider(provider)

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    await invoke('pty:spawn', { id: 'b8', launchCommand: 'claude' })

    const proc = spawnSpy.mock.results[0].value as { write: ReturnType<typeof vi.fn> }
    const launchWrite = proc.write.mock.invocationCallOrder[0]
    expect(provider).toHaveBeenCalledTimes(1)
    expect(provider.mock.invocationCallOrder[0]).toBeLessThan(launchWrite)
  })

  it('a throwing provider does NOT break the spawn', async () => {
    const { setRecapHookSyncProvider } = await import('./ptySpawnEnv')
    const { registerPtyHandlers } = await import('./pty')
    setRecapHookSyncProvider(() => {
      throw new Error('EACCES writing settings.local.json')
    })

    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    const result = await invoke('pty:spawn', { id: 'b9', launchCommand: 'claude' })
    expect((result as { state: string }).state).toBe('running')
    expect(spawnSpy).toHaveBeenCalledTimes(1)
  })

  it('no provider set (undefined) → spawn is unchanged', async () => {
    const { registerPtyHandlers } = await import('./pty')
    const { ipcMain, invoke } = buildIpc()
    registerPtyHandlers(ipcMain, makeGetWin())

    const result = await invoke('pty:spawn', { id: 'b10' })
    expect((result as { state: string }).state).toBe('running')
  })
})
