import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi } from 'vitest'
import { performGuardedQuit, makeCrashHandler, performWindowCloseCleanup } from './quit'

describe('performGuardedQuit (before-quit-flush-no-catch)', () => {
  it('flushes, then runs shutdown, then exits when the flush resolves', async () => {
    const order: string[] = []
    const flush = vi.fn(async () => {
      order.push('flush')
    })
    const shutdown = vi.fn(async () => {
      order.push('shutdown')
    })
    const exit = vi.fn(() => {
      order.push('exit')
    })

    await performGuardedQuit({ flush, shutdown, exit })

    expect(order).toEqual(['flush', 'shutdown', 'exit'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('STILL runs shutdown and exits when the flush REJECTS (the bug — teardown must not be skipped)', async () => {
    const shutdown = vi.fn(async () => {})
    const exit = vi.fn()
    const onFlushError = vi.fn()
    const flush = vi.fn(async () => {
      throw new Error('renderer wedged')
    })

    await performGuardedQuit({ flush, shutdown, exit, onFlushError })

    // A flush rejection must NOT orphan the PTY tree: shutdown() has to run anyway.
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    expect(onFlushError).toHaveBeenCalledTimes(1)
    expect(onFlushError.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('still exits even if shutdown itself rejects, and does not leave the returned promise rejected (quit-reject-catch)', async () => {
    const exit = vi.fn()
    const onShutdownError = vi.fn()

    // No .catch() at the call site — the whole point of the fix is that the returned promise
    // must resolve on its own, since index.ts invokes this fire-and-forget (`void performGuardedQuit(...)`)
    // from a synchronous before-quit handler and can't await/catch it.
    await performGuardedQuit({
      flush: async () => {},
      shutdown: async () => {
        throw new Error('drain failed')
      },
      exit,
      onShutdownError
    })

    expect(exit).toHaveBeenCalledWith(0)
    expect(onShutdownError).toHaveBeenCalledTimes(1)
    expect(onShutdownError.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})

describe('makeCrashHandler (crash/signal cleanup #50)', () => {
  it('runs shutdown then exits with the given code on the first crash', () => {
    const order: string[] = []
    const shutdown = vi.fn(async () => {
      order.push('shutdown')
    })
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`)
    })
    const crash = makeCrashHandler({ shutdown, exit })

    crash(1)

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    // shutdown is fired before exit (best-effort tree-kill, not awaited).
    expect(order).toEqual(['shutdown', 'exit:1'])
  })

  it('is idempotent — a cascading second crash is a no-op (first crash wins)', () => {
    const shutdown = vi.fn(async () => {})
    const exit = vi.fn()
    const crash = makeCrashHandler({ shutdown, exit })

    crash(1)
    crash(0) // e.g. a SIGTERM arriving while the uncaughtException teardown is mid-flight

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1) // the first code, not the second
  })

  it('logs the error when one is provided, and not when omitted (signals)', () => {
    const logError = vi.fn()
    makeCrashHandler({ shutdown: async () => {}, exit: vi.fn(), logError })(1, new Error('boom'))
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][0]).toBeInstanceOf(Error)

    const logError2 = vi.fn()
    makeCrashHandler({ shutdown: async () => {}, exit: vi.fn(), logError: logError2 })(0)
    expect(logError2).not.toHaveBeenCalled()
  })

  it('passes the exit code through (0 for signals, 1 for uncaught)', () => {
    const exit = vi.fn()
    makeCrashHandler({ shutdown: async () => {}, exit })(0)
    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('performWindowCloseCleanup (macOS PTY-orphan fix)', () => {
  const makeDeps = (platform: NodeJS.Platform) => ({
    platform,
    disposeOsr: vi.fn<() => void>(),
    disposeDiagramWorker: vi.fn<() => void>(),
    disposePtys: vi.fn<() => Promise<void>>(async () => {})
  })

  it('ALWAYS disposes the OSR renderers and the diagram worker (every platform)', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
      const deps = makeDeps(platform)
      performWindowCloseCleanup(deps)
      expect(deps.disposeOsr).toHaveBeenCalledTimes(1)
      expect(deps.disposeDiagramWorker).toHaveBeenCalledTimes(1)
    }
  })

  it('reaps the PTY trees on darwin — where window-close never reaches before-quit', () => {
    const deps = makeDeps('darwin')
    performWindowCloseCleanup(deps)
    // The whole point of the fix: macOS window-close orphans the agent PTYs unless we reap here.
    expect(deps.disposePtys).toHaveBeenCalledTimes(1)
  })

  it('does NOT reap PTYs on win32/linux — the awaited before-quit drain owns that (no double-dispose)', () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      const deps = makeDeps(platform)
      performWindowCloseCleanup(deps)
      // Disposing here would clear the session maps first, making the awaited
      // before-quit disposeAllPtys() a no-op and moving the real tree-kill off the
      // awaited path — re-orphaning on the platforms that currently get it right.
      expect(deps.disposePtys).not.toHaveBeenCalled()
    }
  })

  it('does not throw when disposePtys returns void (fire-and-forget) rather than a promise', () => {
    const deps = { ...makeDeps('darwin'), disposePtys: vi.fn<() => void>(() => undefined) }
    expect(() => performWindowCloseCleanup(deps)).not.toThrow()
    expect(deps.disposePtys).toHaveBeenCalledTimes(1)
  })
})

/**
 * Orchestration S2 · failure case B. The whole guarantee is an ORDER: `shutdown()` must bank every
 * un-settled worker's result into its run ledger BEFORE the PTY drain kills the boards those
 * results are read from. There is no runtime seam to assert that on — `shutdown()` lives in
 * `index.ts`, which imports Electron at module scope and owns the app's process lifetime, so it
 * cannot be imported into a unit test, and every tier below it (`swarmWatch.drain()`,
 * `drainRuns()`, `performGuardedQuit`) is already green with the calls in EITHER order.
 *
 * So this reads the source. A text assertion is a blunt instrument and it will need updating if
 * these calls are renamed — that is the point: a rename is a conscious edit, while a silent
 * REORDER (the regression that would cost a run its salvaged results, with nothing failing) is
 * exactly what nothing else catches. The alternative is extracting the quit sequence out of
 * `index.ts`, which is a larger refactor of the most delicate chain in MAIN.
 */
describe('shutdown() ordering — the S2 drain runs while the boards still exist', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
  const body = source.slice(source.indexOf('function shutdown(): Promise<void> {'))

  it('calls swarmHandlers.drainRuns() BEFORE the PTY drain', () => {
    const drainRuns = body.indexOf('swarmHandlers?.drainRuns()')
    const ptyDrain = body.indexOf('quitPtyDrain()')
    expect(drainRuns, 'shutdown() still calls swarmHandlers.drainRuns()').toBeGreaterThan(-1)
    expect(ptyDrain, 'shutdown() still calls quitPtyDrain()').toBeGreaterThan(-1)
    expect(
      drainRuns,
      'the swarm run drain must precede the PTY drain — a worker killed first has no result left to salvage'
    ).toBeLessThan(ptyDrain)
  })
})
