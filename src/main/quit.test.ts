import { describe, it, expect, vi } from 'vitest'
import { performGuardedQuit } from './quit'

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
