import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  canonicalizeShellPath,
  isStaleExit,
  appendRing,
  resolveShell,
  isForeignSender,
  parkCore,
  adoptCore,
  reapParkedCore,
  cleanupCore,
  disposeAllPtysCore,
  safeCwd,
  registerPtyHandlers
} from './pty'
import type { ShellInfo } from './pty'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

describe('safeCwd (SEC-1)', () => {
  it('returns an existing directory unchanged', () => {
    expect(safeCwd(os.tmpdir())).toBe(os.tmpdir())
  })
  it('falls back to homedir for a non-existent path', () => {
    expect(safeCwd(path.join(os.tmpdir(), 'definitely-not-real-xyzzy-9f3'))).toBe(os.homedir())
  })
  it('falls back to homedir for undefined cwd', () => {
    expect(safeCwd(undefined)).toBe(os.homedir())
  })
  it('falls back to homedir when cwd is a file, not a dir', () => {
    // process.execPath is the node/electron binary — exists, but is not a directory.
    expect(safeCwd(process.execPath)).toBe(os.homedir())
  })
})

describe('appendRing', () => {
  it('concatenates when the result is under the cap', () => {
    expect(appendRing('ab', 'cd', 10)).toBe('abcd')
  })
  it('returns exactly the input at the cap boundary', () => {
    expect(appendRing('abcd', 'ef', 6)).toBe('abcdef')
  })
  it('drops the oldest bytes when over the cap (keeps the last `cap`)', () => {
    expect(appendRing('abcd', 'efgh', 6)).toBe('cdefgh')
  })
  it('keeps only the last `cap` bytes when a single chunk exceeds the cap', () => {
    expect(appendRing('', 'abcdefgh', 4)).toBe('efgh')
  })
  it('is a no-op for an empty chunk', () => {
    expect(appendRing('abc', '', 10)).toBe('abc')
  })
})

// Pure identity-guard behind the restart/config-respawn race fix: a late
// onExit from an OLD pty process must not tear down the NEW session that has
// since respawned under the same board id. Uses opaque sentinels in place of
// real `pty.IPty` instances — only reference identity matters.
describe('isStaleExit', () => {
  const oldProc = { tag: 'old' }
  const newProc = { tag: 'new' }

  it('is NOT stale when the exiting proc IS the stored proc (normal exit)', () => {
    expect(isStaleExit(oldProc, oldProc)).toBe(false)
  })

  it('IS stale when a late OLD exit fires after a NEW proc took the id (the race)', () => {
    // sessions now holds newProc; oldProc's belated onExit must no-op.
    expect(isStaleExit(newProc, oldProc)).toBe(true)
  })

  it('is NOT stale for an explicit kill (no exiting proc) — always tears down', () => {
    expect(isStaleExit(oldProc, undefined)).toBe(false)
  })

  it('treats two distinct procs with equal shape as different (identity, not value)', () => {
    expect(isStaleExit({ tag: 'old' }, { tag: 'old' })).toBe(true)
  })
})

// Canonicalization behind the enumerateShells dedupe fix (#26): a non-canonical
// COMSPEC (8.3 short name / junction) and onPath('cmd') resolve to the SAME real
// cmd.exe, so they must collapse to one dedupe key. The realpath resolver is
// injected so the test is deterministic without touching the filesystem.
describe('canonicalizeShellPath', () => {
  const real = 'C:\\Windows\\System32\\cmd.exe'

  it('resolves a short-name / junction variant to its real path', () => {
    const resolver = (q: string): string =>
      q === 'C:\\PROGRA~0\\..\\Windows\\System32\\cmd.exe' ? real : q
    expect(canonicalizeShellPath('C:\\PROGRA~0\\..\\Windows\\System32\\cmd.exe', resolver)).toBe(
      real
    )
  })

  it('collapses two spellings of the same binary to one lowercased key', () => {
    const resolver = (): string => real
    const a = canonicalizeShellPath('C:\\COMSPEC-shortname\\cmd.exe', resolver).toLowerCase()
    const b = canonicalizeShellPath('C:\\Windows\\System32\\cmd.exe', resolver).toLowerCase()
    expect(a).toBe(b)
  })

  it('falls back to a normalized path when the target does not exist (resolver throws)', () => {
    const throwing = (): string => {
      throw new Error('ENOENT')
    }
    expect(canonicalizeShellPath('C:\\nope\\..\\gone\\cmd.exe', throwing)).toBe(
      path.normalize('C:\\nope\\..\\gone\\cmd.exe')
    )
  })
})

// M5: a corrupt/hand-edited canvas.json `shell` must not be able to spawn an
// arbitrary binary in main. resolveShell accepts the persisted shell ONLY when
// it matches an enumerated, system-discovered shell; otherwise the default.
describe('resolveShell (M5 — validate before spawn)', () => {
  // canonicalizeShellPath calls fs.realpathSync.native, which throws ENOENT for
  // these synthetic paths and falls back to path.normalize — so matching is by
  // normalized path. That is exactly the production behavior on a real list.
  const shells: ShellInfo[] = [
    { path: 'C:\\Windows\\System32\\cmd.exe', label: 'cmd', default: true },
    { path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', label: 'pwsh' }
  ]

  it('accepts an enumerated shell path verbatim', () => {
    expect(resolveShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe', shells)).toBe(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    )
  })

  it('matches an enumerated shell regardless of case (canonical key is lowercased)', () => {
    expect(resolveShell('c:\\windows\\system32\\CMD.EXE', shells)).toBe(
      'c:\\windows\\system32\\CMD.EXE'
    )
  })

  it('falls back to the default (shells[0]) for an arbitrary/unknown binary', () => {
    expect(resolveShell('C:\\evil\\payload.exe', shells)).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('falls back to the default when shell is undefined', () => {
    expect(resolveShell(undefined, shells)).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('falls back to the default for an empty string', () => {
    expect(resolveShell('', shells)).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

// M6: the foreign-sender guard. ipcMain channels are shared by ALL webContents.
// A synthetic/internal call (no senderFrame) is allowed; a real foreign frame is
// blocked; the trusted main frame is allowed; and a real sender with the window
// unresolved (destroyed/closing) is DENIED — we can't prove it's trusted.
describe('isForeignSender (M6 — frame guard)', () => {
  const mainFrame = { id: 'main' }
  const otherFrame = { id: 'other' }

  it('allows a synthetic/internal call (no senderFrame)', () => {
    expect(isForeignSender({ senderFrame: null } as never, () => mainFrame)).toBe(false)
  })

  it('blocks a real foreign frame', () => {
    expect(isForeignSender({ senderFrame: otherFrame } as never, () => mainFrame)).toBe(true)
  })

  it('allows the trusted main frame', () => {
    expect(isForeignSender({ senderFrame: mainFrame } as never, () => mainFrame)).toBe(false)
  })

  it('DENIES a real sender when the window/main-frame is unresolved (null)', () => {
    expect(isForeignSender({ senderFrame: otherFrame } as never, () => null)).toBe(true)
  })
})

// ── T1: park / adopt / reapParked / cleanup / disposeAllPtys core logic ─────
// Mock proc + port doubles — only reference identity and call-recording matter.
function makeProc(pid: number): {
  proc: { pid: number; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> }
} {
  return { proc: { pid, write: vi.fn(), resize: vi.fn() } }
}

function makePort(): {
  posted: unknown[]
  closed: boolean
  started: boolean
  handler: ((e: { data: unknown }) => void) | null
  on: (ev: string, h: (e: { data: unknown }) => void) => void
  start: () => void
  close: () => void
  postMessage: (m: unknown) => void
} {
  const port = {
    posted: [] as unknown[],
    closed: false,
    started: false,
    handler: null as ((e: { data: unknown }) => void) | null,
    on(_ev: string, h: (e: { data: unknown }) => void): void {
      port.handler = h
    },
    start(): void {
      port.started = true
    },
    close(): void {
      port.closed = true
    },
    postMessage(m: unknown): void {
      port.posted.push(m)
    }
  }
  return port
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('parkCore (T1)', () => {
  it('moves the session into the parked map and arms the TTL (no kill)', () => {
    vi.useFakeTimers()
    const reap = vi.fn()
    const port = makePort()
    const { proc } = makeProc(111)
    const buf = { data: 'hello' }
    const sessions = new Map<string, any>([['a', { proc, port, buf }]])
    const parked = new Map<string, any>()

    parkCore('a', sessions, parked, reap, 1000)

    expect(sessions.has('a')).toBe(false)
    expect(parked.has('a')).toBe(true)
    // Same boxed buffer + same proc reference travel into parked (identity).
    expect(parked.get('a').proc).toBe(proc)
    expect(parked.get('a').buf).toBe(buf)
    expect(port.closed).toBe(true)
    // TTL not yet fired.
    expect(reap).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(reap).toHaveBeenCalledWith('a')
    vi.useRealTimers()
  })

  it('is a no-op when no live session exists for the id', () => {
    const sessions = new Map<string, any>()
    const parked = new Map<string, any>()
    parkCore('missing', sessions, parked, vi.fn(), 1000)
    expect(parked.size).toBe(0)
  })
})

describe('adoptCore (T1)', () => {
  it('re-binds the SAME parked proc, replays scrollback, and re-emits running (no second spawn)', () => {
    const port1 = makePort()
    const port2 = makePort()
    const { proc } = makeProc(222)
    const buf = { data: 'scrollback-text' }
    const timer = setTimeout(() => {}, 100000)
    const sessions = new Map<string, any>()
    const parked = new Map<string, any>([['t', { proc, buf, timer }]])
    const newChannel = vi.fn(() => ({ port1, port2 }))
    const transferPort = vi.fn()

    const res = adoptCore('t', sessions, parked, { newChannel } as any, transferPort as any)

    // Identity preserved: the live pid is the parked proc's pid — NOT a new spawn.
    expect(res).toEqual({ adopted: true, pid: 222 })
    expect(parked.has('t')).toBe(false)
    expect(sessions.get('t').proc).toBe(proc)
    expect(sessions.get('t').buf).toBe(buf)
    // Renderer got the transferable port half.
    expect(transferPort).toHaveBeenCalledWith(port2)
    expect(port1.started).toBe(true)
    // Replay then running, in order.
    expect(port1.posted).toEqual([
      { t: 'data', d: 'scrollback-text' },
      { t: 'state', state: 'running' }
    ])
    clearTimeout(timer)
  })

  it('forwards input/resize from the new port to the SAME proc (and swallows throws)', () => {
    const port1 = makePort()
    const port2 = makePort()
    const { proc } = makeProc(333)
    const sessions = new Map<string, any>()
    const parked = new Map<string, any>([
      ['t', { proc, buf: { data: '' }, timer: setTimeout(() => {}, 100000) }]
    ])
    adoptCore(
      't',
      sessions,
      parked,
      { newChannel: () => ({ port1, port2 }) } as any,
      (() => {}) as any
    )
    // The port message handler routes to the adopted proc.
    port1.handler?.({ data: { t: 'input', d: 'ls\r' } })
    expect(proc.write).toHaveBeenCalledWith('ls\r')
    port1.handler?.({ data: { t: 'resize', cols: 100, rows: 30 } })
    expect(proc.resize).toHaveBeenCalledWith(100, 30)
    // A throw inside write must not escape (would crash main via uncaughtException).
    proc.write.mockImplementationOnce(() => {
      throw new Error('exited')
    })
    expect(() => port1.handler?.({ data: { t: 'input', d: 'x' } })).not.toThrow()
  })

  it('returns { adopted: false } when nothing is parked under the id', () => {
    const res = adoptCore(
      'none',
      new Map(),
      new Map(),
      { newChannel: vi.fn() } as any,
      vi.fn() as any
    )
    expect(res).toEqual({ adopted: false })
  })
})

describe('reapParkedCore (T1)', () => {
  it('cancels the TTL timer and kills the process tree', async () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const { proc } = makeProc(444)
    const timer = setTimeout(fired, 1000)
    const killTree = vi.fn(() => Promise.resolve())
    const parked = new Map<string, any>([['p', { proc, buf: { data: '' }, timer }]])

    await reapParkedCore('p', parked, { killTree } as any)

    expect(parked.has('p')).toBe(false)
    expect(killTree).toHaveBeenCalledWith(proc)
    // Timer was cleared — it must never fire after reap.
    vi.advanceTimersByTime(5000)
    expect(fired).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('is a no-op for an unknown id', async () => {
    const killTree = vi.fn(() => Promise.resolve())
    await reapParkedCore('nope', new Map(), { killTree } as any)
    expect(killTree).not.toHaveBeenCalled()
  })
})

describe('cleanupCore (T1)', () => {
  it('tears down the live session and kills its proc on an explicit kill (no proc arg)', async () => {
    const port = makePort()
    const { proc } = makeProc(555)
    const killTree = vi.fn(() => Promise.resolve())
    const sessions = new Map<string, any>([['k', { proc, port, buf: { data: '' } }]])

    await cleanupCore('k', sessions, { killTree } as any)

    expect(sessions.has('k')).toBe(false)
    expect(killTree).toHaveBeenCalledWith(proc)
    expect(port.closed).toBe(true)
  })

  it('no-ops on a STALE exit (stored proc differs from the exiting proc)', async () => {
    const port = makePort()
    const { proc: newProc } = makeProc(1)
    const { proc: oldProc } = makeProc(2)
    const killTree = vi.fn(() => Promise.resolve())
    const sessions = new Map<string, any>([['k', { proc: newProc, port, buf: { data: '' } }]])

    await cleanupCore('k', sessions, { killTree } as any, oldProc as any)

    // The new session survives a late OLD-proc exit.
    expect(sessions.has('k')).toBe(true)
    expect(killTree).not.toHaveBeenCalled()
    expect(port.closed).toBe(false)
  })
})

describe('disposeAllPtysCore (T1)', () => {
  it('drains BOTH maps — reaps parked and tears down live sessions', async () => {
    const killTree = vi.fn(() => Promise.resolve())
    const liveProc = makeProc(10).proc
    const parkProc = makeProc(20).proc
    const livePort = makePort()
    const sessions = new Map<string, any>([
      ['live', { proc: liveProc, port: livePort, buf: { data: '' } }]
    ])
    const parked = new Map<string, any>([
      ['park', { proc: parkProc, buf: { data: '' }, timer: setTimeout(() => {}, 100000) }]
    ])

    await disposeAllPtysCore(sessions, parked, { killTree } as any)

    expect(sessions.size).toBe(0)
    expect(parked.size).toBe(0)
    expect(killTree).toHaveBeenCalledWith(liveProc)
    expect(killTree).toHaveBeenCalledWith(parkProc)
    expect(killTree).toHaveBeenCalledTimes(2)
    expect(livePort.closed).toBe(true)
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */

// Checklist #17 + #20 (Browser↛PTY): the PTY control channel is shared by ALL
// webContents, including per-board preview WebContentsViews that load untrusted
// localhost pages. A foreign sender (anything that isn't the main window's main
// frame) must be REJECTED — a previewed page must never be able to spawn or kill
// a shell. This proves the guard is wired into the handlers, not just that the
// pure isForeignSender works.
describe('registerPtyHandlers — foreign-sender rejection (#17/#20 Browser↛PTY)', () => {
  const mainFrame = { id: 'main-frame' }
  // A preview/browser board's frame — a real sender that is NOT the main frame.
  const foreign = { senderFrame: { id: 'preview-board-frame' } } as unknown as IpcMainInvokeEvent

  function setup(): Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown> {
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown>()
    const ipcMain = {
      handle: (c: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
        handlers.set(c, fn)
    } as unknown as IpcMain
    const getWin = (): never => ({ webContents: { mainFrame } }) as never
    registerPtyHandlers(ipcMain, getWin)
    return handlers
  }

  it('pty:spawn throws for a foreign sender (no shell is spawned)', () => {
    const handlers = setup()
    expect(() => handlers.get('pty:spawn')!(foreign, { id: 'b1' })).toThrow(/forbidden sender/)
  })

  it('pty:kill returns false for a foreign sender', () => {
    const handlers = setup()
    expect(handlers.get('pty:kill')!(foreign, 'b1')).toBe(false)
  })

  it('pty:shells returns [] for a foreign sender (no shell enumeration leaked)', () => {
    const handlers = setup()
    expect(handlers.get('pty:shells')!(foreign)).toEqual([])
  })
})
