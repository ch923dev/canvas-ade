import { describe, it, expect, vi } from 'vitest'
import { performGuardedQuit, makeCrashHandler } from './quit'

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

  it('still exits even if shutdown itself rejects', async () => {
    const exit = vi.fn()
    await performGuardedQuit({
      flush: async () => {},
      shutdown: async () => {
        throw new Error('drain failed')
      },
      exit
    }).catch(() => {})

    expect(exit).toHaveBeenCalledWith(0)
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
