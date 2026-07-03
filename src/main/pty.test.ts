import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isStaleExit,
  parkCore,
  adoptCore,
  reapParkedCore,
  cleanupCore,
  disposeAllPtysCore,
  drainPtyCore,
  killTreeCommand,
  writeToPtyCore,
  getTerminalRuntimeCore,
  getTerminalActivityStaleMsCore,
  getTerminalBootInfoCore,
  isValidResize,
  clampSpawnDim,
  attachPortInput
} from './pty'
import {
  canonicalizeShellPath,
  clearShellCache,
  enumerateShells,
  resolveShell,
  safeCwd
} from './ptyShells'
import { createRing, pushRing } from './ptyOutput'
import type { ShellInfo } from './ptyShells'

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

// PERF-06: the output ring's chunk-deque (createRing/pushRing/readRing) now lives in
// ptyOutput.ts and is unit-tested there (ptyOutput.test.ts › OutputRing).

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

// Finding 1 (perf): enumerateShells ran a full blocking-sync FS probe set on EVERY
// pty:spawn on the MAIN thread, though installed shells don't change mid-session. It
// is now memoized for the process lifetime; clearShellCache resets the cache. Assert
// the reference-identity memoization behavior only — the probe set is OS-dependent, so
// we do NOT assert platform-specific shell contents, only a non-empty ShellInfo[].
describe('enumerateShells memoization (perf)', () => {
  // beforeEach resets the cache so each test starts fresh (no intra-block contamination);
  // afterEach stops a cached list leaking into other test files.
  beforeEach(() => clearShellCache())
  afterEach(() => clearShellCache())

  it('returns the SAME array reference on repeated calls (memoized)', () => {
    const first = enumerateShells()
    expect(enumerateShells()).toBe(first) // same reference → cached, no re-probe
  })

  it('re-probes after clearShellCache (a fresh, non-empty ShellInfo[])', () => {
    const cached = enumerateShells()
    clearShellCache()
    const fresh = enumerateShells()
    expect(fresh).not.toBe(cached) // different reference → re-probed
    expect(Array.isArray(fresh)).toBe(true)
    expect(fresh.length).toBeGreaterThan(0)
    for (const s of fresh) {
      expect(typeof s.path).toBe('string')
      expect(typeof s.label).toBe('string')
    }
  })
})

// M6: the foreign-sender guard is now the shared ./ipcGuard — its branches (incl. the
// destroyed-window case) live in ipcGuard.test.ts.

// T5: the OS process-tree kill command builder. Extracted pure so the actual
// argv/signal (previously buried in the private killTree) is asserted directly —
// agentic CLIs spawn child trees; a bare kill leaves orphans.
describe('killTreeCommand (T5 — process-tree kill builder)', () => {
  it('builds `taskkill /PID <pid> /T /F` on win32', () => {
    expect(killTreeCommand('win32', 1234)).toEqual({
      kind: 'taskkill',
      file: 'taskkill',
      args: ['/PID', '1234', '/T', '/F']
    })
  })

  it('targets the negative pgid with SIGKILL on linux', () => {
    expect(killTreeCommand('linux', 1234)).toEqual({
      kind: 'pgid',
      pgid: -1234,
      signal: 'SIGKILL'
    })
  })

  it('targets the negative pgid with SIGKILL on darwin', () => {
    expect(killTreeCommand('darwin', 999)).toEqual({
      kind: 'pgid',
      pgid: -999,
      signal: 'SIGKILL'
    })
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
    const buf = createRing(256 * 1024)
    pushRing(buf, 'hello')
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
    const buf = createRing(256 * 1024)
    pushRing(buf, 'scrollback-text')
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
      ['t', { proc, buf: createRing(256 * 1024), timer: setTimeout(() => {}, 100000) }]
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

describe('attachPortInput (Finding 3 — single renderer→PTY write guard)', () => {
  it('starts the port and registers the message handler', () => {
    const port = makePort()
    const { proc } = makeProc(700)
    attachPortInput(port as any, proc as any)
    expect(port.started).toBe(true)
    expect(typeof port.handler).toBe('function')
  })

  it('forwards an input message to proc.write', () => {
    const port = makePort()
    const { proc } = makeProc(701)
    attachPortInput(port as any, proc as any)
    port.handler?.({ data: { t: 'input', d: 'ls\r' } })
    expect(proc.write).toHaveBeenCalledWith('ls\r')
  })

  it('forwards a VALID resize to proc.resize', () => {
    const port = makePort()
    const { proc } = makeProc(702)
    attachPortInput(port as any, proc as any)
    port.handler?.({ data: { t: 'resize', cols: 100, rows: 30 } })
    expect(proc.resize).toHaveBeenCalledWith(100, 30)
  })

  it('drops an out-of-bound resize (cols=0) — clamp holds', () => {
    const port = makePort()
    const { proc } = makeProc(703)
    attachPortInput(port as any, proc as any)
    port.handler?.({ data: { t: 'resize', cols: 0, rows: 30 } })
    expect(proc.resize).not.toHaveBeenCalled()
  })

  it('drops an out-of-bound resize (rows=0) — both axes are clamped at the forwarding layer', () => {
    const port = makePort()
    const { proc } = makeProc(706)
    attachPortInput(port as any, proc as any)
    port.handler?.({ data: { t: 'resize', cols: 80, rows: 0 } })
    expect(proc.resize).not.toHaveBeenCalled()
  })

  it('drops a non-integer resize (cols=80.5) — clamp holds', () => {
    const port = makePort()
    const { proc } = makeProc(704)
    attachPortInput(port as any, proc as any)
    port.handler?.({ data: { t: 'resize', cols: 80.5, rows: 24 } })
    expect(proc.resize).not.toHaveBeenCalled()
  })

  it('BUG-023: clamps a legit OVERSIZED resize instead of dropping it (rows keep applying)', () => {
    const port = makePort()
    const { proc } = makeProc(707)
    attachPortInput(port as any, proc as any)
    port.handler?.({ data: { t: 'resize', cols: 1200, rows: 40 } })
    expect(proc.resize).toHaveBeenCalledWith(1000, 40)
    port.handler?.({ data: { t: 'resize', cols: 1200, rows: 55 } })
    expect(proc.resize).toHaveBeenLastCalledWith(1000, 55)
  })

  it('swallows a throw from proc.write (would crash main via uncaughtException)', () => {
    const port = makePort()
    const { proc } = makeProc(705)
    attachPortInput(port as any, proc as any)
    proc.write.mockImplementationOnce(() => {
      throw new Error('exited')
    })
    expect(() => port.handler?.({ data: { t: 'input', d: 'x' } })).not.toThrow()
  })
})

describe('reapParkedCore (T1)', () => {
  it('cancels the TTL timer and kills the process tree', async () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const { proc } = makeProc(444)
    const timer = setTimeout(fired, 1000)
    const killTree = vi.fn(() => Promise.resolve())
    const parked = new Map<string, any>([['p', { proc, buf: createRing(256 * 1024), timer }]])

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
    const onReap = vi.fn()
    await reapParkedCore('nope', new Map(), { killTree } as any, onReap)
    expect(killTree).not.toHaveBeenCalled()
    expect(onReap).not.toHaveBeenCalled() // FIND-009: no cleanup when nothing was reaped
  })

  it('FIND-009: fires onReap(id) when a parked session IS reaped (boardCwds cleanup hook)', async () => {
    const { proc } = makeProc(444)
    const killTree = vi.fn(() => Promise.resolve())
    const onReap = vi.fn()
    const parked = new Map<string, any>([
      ['p', { proc, buf: createRing(256 * 1024), timer: setTimeout(() => {}, 100000) }]
    ])
    await reapParkedCore('p', parked, { killTree } as any, onReap)
    expect(onReap).toHaveBeenCalledWith('p')
  })
})

describe('cleanupCore (T1)', () => {
  it('tears down the live session and kills its proc on an explicit kill (no proc arg)', async () => {
    const port = makePort()
    const { proc } = makeProc(555)
    const killTree = vi.fn(() => Promise.resolve())
    const sessions = new Map<string, any>([['k', { proc, port, buf: createRing(256 * 1024) }]])

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
    const sessions = new Map<string, any>([
      ['k', { proc: newProc, port, buf: createRing(256 * 1024) }]
    ])

    await cleanupCore('k', sessions, { killTree } as any, oldProc as any)

    // The new session survives a late OLD-proc exit.
    expect(sessions.has('k')).toBe(true)
    expect(killTree).not.toHaveBeenCalled()
    expect(port.closed).toBe(false)
  })

  // BUG-022: natural-exit path must NOT tree-kill the already-dead root PID to
  // avoid the PID-reuse race window (taskkill against a recycled PID harms an
  // unrelated process tree). It DOES still call node-pty's own kill(), which
  // disposes the ConPTY handle/conout worker deterministically and closes the
  // pseudoconsole (reaping still-attached children) without touching the PID.
  it('BUG-022: skips killTree but disposes via proc.kill on natural exit', async () => {
    const port = makePort()
    const { proc } = makeProc(556)
    const sessionProc = { ...proc, kill: vi.fn() }
    const killTree = vi.fn(() => Promise.resolve())
    const sessions = new Map<string, any>([
      ['k', { proc: sessionProc, port, buf: createRing(256 * 1024), state: 'exited' as const }]
    ])

    // Pass the SAME proc (identity match = natural exit, not stale) so the
    // identity guard passes and we reach the skip-kill branch.
    await cleanupCore('k', sessions, { killTree } as any, sessionProc as any)

    expect(sessions.has('k')).toBe(false) // session is removed
    expect(killTree).not.toHaveBeenCalled() // no tree-kill on an already-exited proc
    expect(sessionProc.kill).toHaveBeenCalledTimes(1) // ConPTY disposed deterministically
    expect(port.closed).toBe(true) // port is still closed
  })

  it('BUG-022: still tree-kills on explicit pty:kill (no proc arg) even when state is exited', async () => {
    const port = makePort()
    const { proc } = makeProc(557)
    const killTree = vi.fn(() => Promise.resolve())
    const sessions = new Map<string, any>([
      ['k', { proc, port, buf: createRing(256 * 1024), state: 'exited' as const }]
    ])

    // No proc argument = explicit kill path; always tears down regardless of state.
    await cleanupCore('k', sessions, { killTree } as any)

    expect(sessions.has('k')).toBe(false)
    expect(killTree).toHaveBeenCalledWith(proc)
    expect(port.closed).toBe(true)
  })
})

// BUG-024: adoptCore must reap a live same-id session before replacing it,
// mirroring the Bug #13 guard on the spawn path. Without this, the displaced
// proc escapes both maps and outlives disposeAllPtys/quit.
describe('adoptCore BUG-024 (symmetric Bug #13 guard)', () => {
  it('reaps the live same-id session before adopting the parked one', async () => {
    const port1 = makePort()
    const port2 = makePort()
    const { proc: liveProc } = makeProc(500)
    const { proc: parkedProc } = makeProc(501)
    const livePort = makePort()
    const buf = createRing(256 * 1024)
    pushRing(buf, 'scrollback')
    const timer = setTimeout(() => {}, 100000)
    const sessions = new Map<string, any>([
      ['t', { proc: liveProc, port: livePort, buf: createRing(256 * 1024), state: 'running' }]
    ])
    const parked = new Map<string, any>([['t', { proc: parkedProc, buf, timer }]])
    const killTree = vi.fn(() => Promise.resolve())
    const newChannel = vi.fn(() => ({ port1, port2 }))

    const res = adoptCore('t', sessions, parked, { newChannel, killTree } as any, (() => {}) as any)

    // The adopt must succeed and use the parked proc.
    expect(res).toEqual({ adopted: true, pid: 501 })
    // The displaced live proc must have been reaped.
    expect(killTree).toHaveBeenCalledWith(liveProc)
    expect(livePort.closed).toBe(true)
    // The adopted session holds the parked proc, not the live one.
    expect(sessions.get('t')?.proc).toBe(parkedProc)
    clearTimeout(timer)
  })

  it('does not call killTree when no live session exists for the id', async () => {
    const port1 = makePort()
    const port2 = makePort()
    const { proc: parkedProc } = makeProc(502)
    const buf = createRing(256 * 1024)
    const timer = setTimeout(() => {}, 100000)
    const sessions = new Map<string, any>()
    const parked = new Map<string, any>([['t', { proc: parkedProc, buf, timer }]])
    const killTree = vi.fn(() => Promise.resolve())
    const newChannel = vi.fn(() => ({ port1, port2 }))

    adoptCore('t', sessions, parked, { newChannel, killTree } as any, (() => {}) as any)

    expect(killTree).not.toHaveBeenCalled()
    clearTimeout(timer)
  })
})

// ── BUG-001: drainPty must PIN its own proc across the grace window ─────────
// drainPty graceful-closes a session, then waits a grace window for a natural
// exit before a hard tree-kill. If a `pty:spawn` REPLACES the session under the
// same id during that window, the drain must NOT reap the replacement: the early
// return must be gated on process IDENTITY (not mere `sessions.has(id)`), and the
// final hard-kill must pass the PINNED old proc to the identity-aware cleanup
// (cleanupCore's isStaleExit no-ops when the stored proc differs). The injected
// `cleanup` is the REAL cleanupCore so the identity guard under test is genuine.
describe('drainPtyCore (BUG-001 — pin proc across the grace window)', () => {
  it('does NOT kill a session that respawned under the same id during the grace window', async () => {
    const killTree = vi.fn(() => Promise.resolve())
    const oldPort = makePort()
    const newPort = makePort()
    const { proc: oldProc } = makeProc(100)
    const { proc: newProc } = makeProc(200)
    const sessions = new Map<string, any>([
      ['t', { proc: oldProc, port: oldPort, buf: createRing(256 * 1024), state: 'running' }]
    ])

    // First grace-poll `sleep`: simulate a `pty:spawn` replacing the session
    // under the SAME id (old proc exited + a fresh one took over). The drain must
    // notice its OWN proc has left and bail — without killing the replacement.
    let replaced = false
    const sleep = vi.fn(async () => {
      if (!replaced) {
        replaced = true
        sessions.set('t', {
          proc: newProc,
          port: newPort,
          buf: createRing(256 * 1024),
          state: 'running'
        })
      }
    })

    await drainPtyCore(
      't',
      sessions,
      { cleanup: (id, proc) => cleanupCore(id, sessions, { killTree } as any, proc), sleep },
      600
    )

    // The replacement survives — never torn down, never killed.
    expect(sessions.get('t').proc).toBe(newProc)
    expect(killTree).not.toHaveBeenCalled()
    expect(newPort.closed).toBe(false)
  })

  it('hard tree-kills the ORIGINAL proc when it outlives the grace window (no respawn)', async () => {
    const killTree = vi.fn(() => Promise.resolve())
    const port = makePort()
    const { proc } = makeProc(300)
    const sessions = new Map<string, any>([
      ['t', { proc, port, buf: createRing(256 * 1024), state: 'running' }]
    ])
    // graceMs=0 → no grace poll; goes straight to the hard kill of OUR proc.
    await drainPtyCore(
      't',
      sessions,
      { cleanup: (id, p) => cleanupCore(id, sessions, { killTree } as any, p), sleep: vi.fn() },
      0
    )

    expect(sessions.has('t')).toBe(false)
    expect(killTree).toHaveBeenCalledWith(proc)
    expect(port.closed).toBe(true)
  })

  it('sends Ctrl-C + exit to the proc, then returns early if it exits within the window (no kill)', async () => {
    const killTree = vi.fn(() => Promise.resolve())
    const port = makePort()
    const { proc } = makeProc(400)
    const sessions = new Map<string, any>([
      ['t', { proc, port, buf: createRing(256 * 1024), state: 'running' }]
    ])
    // First poll: the proc exits cleanly → drops out of the map (onExit/cleanup).
    const sleep = vi.fn(async () => {
      sessions.delete('t')
    })

    await drainPtyCore(
      't',
      sessions,
      { cleanup: (id, p) => cleanupCore(id, sessions, { killTree } as any, p), sleep },
      600
    )

    expect(proc.write).toHaveBeenCalledWith('\x03')
    expect(proc.write).toHaveBeenCalledWith('exit\r')
    expect(killTree).not.toHaveBeenCalled()
  })

  it('is a no-op for an id with no live session', async () => {
    const cleanup = vi.fn(() => Promise.resolve())
    await drainPtyCore('ghost', new Map(), { cleanup, sleep: vi.fn() }, 600)
    expect(cleanup).not.toHaveBeenCalled()
  })
})

describe('disposeAllPtysCore (T1)', () => {
  it('drains BOTH maps — reaps parked and tears down live sessions', async () => {
    const killTree = vi.fn(() => Promise.resolve())
    const liveProc = makeProc(10).proc
    const parkProc = makeProc(20).proc
    const livePort = makePort()
    const sessions = new Map<string, any>([
      ['live', { proc: liveProc, port: livePort, buf: createRing(256 * 1024) }]
    ])
    const parked = new Map<string, any>([
      ['park', { proc: parkProc, buf: createRing(256 * 1024), timer: setTimeout(() => {}, 100000) }]
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
/* eslint-disable @typescript-eslint/no-explicit-any */
// ── T4.3 (🔒 dispatch write primitive): writeToPty writes into a LIVE terminal
// session's proc. Keyed on the `sessions` map (only terminals have sessions), so a
// non-terminal / absent / unknown id has no session → false (no write, never crashes).
describe('writeToPtyCore (T4.3 — dispatch write primitive)', () => {
  it('writes the text to the live session proc and returns true', () => {
    const { proc } = makeProc(900)
    const sessions = new Map<string, any>([['t', { proc, buf: createRing(256 * 1024) }]])
    expect(writeToPtyCore('t', 'echo hi\r', sessions)).toBe(true)
    expect(proc.write).toHaveBeenCalledWith('echo hi\r')
  })

  it('returns false (no write) when no session holds the id (absent / non-terminal)', () => {
    const sessions = new Map<string, any>()
    expect(writeToPtyCore('ghost', 'x', sessions)).toBe(false)
  })

  it('returns false when the proc write throws (a just-exited proc never crashes main)', () => {
    const { proc } = makeProc(901)
    proc.write.mockImplementationOnce(() => {
      throw new Error('exited')
    })
    const sessions = new Map<string, any>([['t', { proc, buf: createRing(256 * 1024) }]])
    expect(writeToPtyCore('t', 'x', sessions)).toBe(false)
  })
})

describe('getTerminalRuntimeCore (T-F1 — runtime snapshot for the Context summary)', () => {
  it('returns the live session runtime (state + lastActivityAt + exitCode)', () => {
    const sessions = new Map<string, any>([
      ['t', { state: 'running', lastActivityAt: 1700, exitCode: undefined }]
    ])
    expect(getTerminalRuntimeCore('t', sessions)).toEqual({
      state: 'running',
      lastActivityAt: 1700,
      exitCode: undefined
    })
  })

  it('carries the exit code for an exited session', () => {
    const sessions = new Map<string, any>([
      ['t', { state: 'exited', lastActivityAt: 9, exitCode: 1 }]
    ])
    expect(getTerminalRuntimeCore('t', sessions)).toEqual({
      state: 'exited',
      lastActivityAt: 9,
      exitCode: 1
    })
  })

  it('returns undefined for an absent id (non-terminal / closed / parked-not-live)', () => {
    expect(getTerminalRuntimeCore('ghost', new Map())).toBeUndefined()
  })
})

describe('getTerminalActivityStaleMsCore (BUG-007 — output-silence dormancy for awaitSettled)', () => {
  it('returns ms since the last PTY output against the injected clock', () => {
    const sessions = new Map<string, any>([['t', { lastActivityAt: 1_000 }]])
    expect(getTerminalActivityStaleMsCore('t', sessions, 61_000)).toBe(60_000)
  })

  it('clamps to 0 for a future/equal lastActivityAt (never negative)', () => {
    const sessions = new Map<string, any>([['t', { lastActivityAt: 5_000 }]])
    expect(getTerminalActivityStaleMsCore('t', sessions, 5_000)).toBe(0)
    expect(getTerminalActivityStaleMsCore('t', sessions, 4_000)).toBe(0) // clock skew → 0, not negative
  })

  it('returns undefined for a board with no LIVE session (non-terminal / closed / parked)', () => {
    // undefined is awaitSettled's signal that there is no live PTY to measure.
    expect(getTerminalActivityStaleMsCore('ghost', new Map(), 1_000)).toBeUndefined()
  })
})

describe('getTerminalBootInfoCore (readiness gate — boot age + pid identity)', () => {
  it('returns the process age against the injected clock, plus the live pid', () => {
    const sessions = new Map<string, any>([['t', { spawnedAt: 1_000, proc: { pid: 42 } }]])
    expect(getTerminalBootInfoCore('t', sessions, 3_500)).toEqual({ ageMs: 2_500, pid: 42 })
  })

  it('an ADOPTED session (spawnedAt 0) reads as maximally old — the readiness floor passes immediately', () => {
    const sessions = new Map<string, any>([['t', { spawnedAt: 0, proc: { pid: 42 } }]])
    expect(getTerminalBootInfoCore('t', sessions, 60_000)!.ageMs).toBe(60_000)
  })

  it('clamps to 0 for clock skew (never a negative age)', () => {
    const sessions = new Map<string, any>([['t', { spawnedAt: 9_000, proc: { pid: 42 } }]])
    expect(getTerminalBootInfoCore('t', sessions, 8_000)!.ageMs).toBe(0)
  })

  it('returns undefined for a board with no LIVE session', () => {
    expect(getTerminalBootInfoCore('ghost', new Map(), 1_000)).toBeUndefined()
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── isValidResize (Wave-4 pty-resize-unbounded) ──────────────────────────────
// The guard used at BOTH MessagePort listener sites (spawn-time and adopt-time).
// Tests are written against the real exported helper — both listeners call it,
// so covering it here is real coverage of both code paths, not a replica.
describe('isValidResize (Wave-4 — bounded integer validation)', () => {
  it('accepts a normal terminal size (80×24)', () => {
    expect(isValidResize(80, 24)).toBe(true)
  })

  it('accepts the minimum valid size (1×1)', () => {
    expect(isValidResize(1, 1)).toBe(true)
  })

  it('accepts the maximum valid size (1000×1000)', () => {
    expect(isValidResize(1000, 1000)).toBe(true)
  })

  it('rejects a non-integer cols (80.5×24)', () => {
    expect(isValidResize(80.5, 24)).toBe(false)
  })

  it('rejects a non-integer rows (80×24.9)', () => {
    expect(isValidResize(80, 24.9)).toBe(false)
  })

  it('rejects zero cols (0×24)', () => {
    expect(isValidResize(0, 24)).toBe(false)
  })

  it('rejects zero rows (80×0)', () => {
    expect(isValidResize(80, 0)).toBe(false)
  })

  it('rejects negative cols (-1×24)', () => {
    expect(isValidResize(-1, 24)).toBe(false)
  })

  it('rejects negative rows (80×-1)', () => {
    expect(isValidResize(80, -1)).toBe(false)
  })

  it('rejects cols above the 1000 upper bound (1001×24)', () => {
    expect(isValidResize(1001, 24)).toBe(false)
  })

  it('rejects rows above the 1000 upper bound (80×1001)', () => {
    expect(isValidResize(80, 1001)).toBe(false)
  })

  it('rejects NaN for cols', () => {
    expect(isValidResize(NaN, 24)).toBe(false)
  })

  it('rejects NaN for rows', () => {
    expect(isValidResize(80, NaN)).toBe(false)
  })

  it('rejects undefined for cols (cast via unknown message payload)', () => {
    expect(isValidResize(undefined as unknown as number, 24)).toBe(false)
  })

  it('rejects undefined for rows (cast via unknown message payload)', () => {
    expect(isValidResize(80, undefined as unknown as number)).toBe(false)
  })

  it('rejects Infinity for cols', () => {
    expect(isValidResize(Infinity, 24)).toBe(false)
  })

  it('rejects Infinity for rows', () => {
    expect(isValidResize(80, Infinity)).toBe(false)
  })
})

// BUG-023: spawn must clamp cols/rows to [1, 1000] so the post-spawn resize path
// (gated on isValidResize) can always accept subsequent resizes. Without this, a
// >1000-col board spawns fine but EVERY resize (including row-only changes) is
// silently dropped by the isValidResize gate.
describe('clampSpawnDim (BUG-023 — spawn/resize bounds parity)', () => {
  it('returns the value unchanged when it is already within [1, 1000]', () => {
    expect(clampSpawnDim(80, 80)).toBe(80)
    expect(clampSpawnDim(1, 80)).toBe(1)
    expect(clampSpawnDim(1000, 80)).toBe(1000)
  })

  it('clamps values above 1000 to 1000', () => {
    expect(clampSpawnDim(1200, 80)).toBe(1000)
    expect(clampSpawnDim(9999, 80)).toBe(1000)
  })

  it('clamps values below 1 to 1', () => {
    expect(clampSpawnDim(0, 80)).toBe(1)
    expect(clampSpawnDim(-5, 80)).toBe(1)
  })

  it('truncates fractional values before clamping', () => {
    expect(clampSpawnDim(80.9, 80)).toBe(80)
    expect(clampSpawnDim(0.9, 80)).toBe(1) // trunc(0.9)=0 -> clamp to 1
  })

  it('uses the fallback for non-finite values (NaN, Infinity)', () => {
    expect(clampSpawnDim(NaN, 80)).toBe(80)
    expect(clampSpawnDim(Infinity, 24)).toBe(24)
  })

  it('result always passes isValidResize as one axis (spawn and resize are self-consistent)', () => {
    // Any value the renderer could send must produce a cols that isValidResize accepts.
    for (const raw of [0, 1, 80, 1000, 1001, 9999, -1, 80.5, NaN]) {
      const clamped = clampSpawnDim(raw, 80)
      expect(isValidResize(clamped, 24)).toBe(true)
    }
  })
})
