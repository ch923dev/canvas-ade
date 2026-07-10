import { describe, expect, it, vi } from 'vitest'
import { createChunkBatcher, drainBatch, ownedPort } from './ptyDataBatch'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('createChunkBatcher (M9 — micro-batch PTY chunks)', () => {
  it('joins chunks pushed within the same tick into one postMessage', async () => {
    const postMessage = vi.fn()
    const batcher = createChunkBatcher(() => ({ postMessage }))
    batcher.push('foo')
    batcher.push('bar')
    batcher.push('baz')
    expect(postMessage).not.toHaveBeenCalled() // not yet — flush is scheduled, not immediate
    await tick()
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ t: 'data', d: 'foobarbaz' })
  })

  it('a single pushed chunk posts without a join allocation (still one message)', async () => {
    const postMessage = vi.fn()
    const batcher = createChunkBatcher(() => ({ postMessage }))
    batcher.push('solo')
    await tick()
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ t: 'data', d: 'solo' })
  })

  it('a later batch of pushes after a flush schedules its own independent flush', async () => {
    const postMessage = vi.fn()
    const batcher = createChunkBatcher(() => ({ postMessage }))
    batcher.push('a')
    await tick()
    batcher.push('b')
    await tick()
    expect(postMessage).toHaveBeenNthCalledWith(1, { t: 'data', d: 'a' })
    expect(postMessage).toHaveBeenNthCalledWith(2, { t: 'data', d: 'b' })
  })

  it('flushNow() flushes synchronously and cancels the pending scheduled flush', async () => {
    const postMessage = vi.fn()
    const batcher = createChunkBatcher(() => ({ postMessage }))
    batcher.push('now')
    batcher.flushNow()
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ t: 'data', d: 'now' })
    // The scheduled setImmediate from push() must have been cancelled — waiting a tick must NOT
    // produce a second (empty or duplicate) flush.
    await tick()
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('flushNow() with nothing buffered is a silent no-op', () => {
    const postMessage = vi.fn()
    createChunkBatcher(() => ({ postMessage })).flushNow()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('drops the flush (no throw) when getLive() resolves to no target — e.g. parked mid-flight', async () => {
    const batcher = createChunkBatcher(() => undefined)
    batcher.push('vanishes')
    await expect(tick()).resolves.toBeUndefined()
  })

  it('a postMessage throw (closed port) is swallowed, not raised to the caller', async () => {
    const postMessage = vi.fn(() => {
      throw new Error('port closed')
    })
    const batcher = createChunkBatcher(() => ({ postMessage }))
    batcher.push('x')
    await expect(tick()).resolves.toBeUndefined()
    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('ownedPort (identity guard)', () => {
  const port = { postMessage: vi.fn() }

  it('returns the port when the live session still owns the given proc', () => {
    const proc = {}
    expect(ownedPort({ proc, port }, proc)).toBe(port)
  })

  it('returns undefined when a DIFFERENT proc now owns the session (stale/respawned)', () => {
    expect(ownedPort({ proc: {}, port }, {})).toBeUndefined()
  })

  it('returns undefined when there is no live session at all', () => {
    expect(ownedPort(undefined, {})).toBeUndefined()
  })
})

describe('drainBatch (M9 — teardown-side drain)', () => {
  it('synchronously flushes the pending batch via the carried flushData hook', () => {
    const postMessage = vi.fn()
    const batcher = createChunkBatcher(() => ({ postMessage }))
    batcher.push('last words')
    drainBatch({ flushData: () => batcher.flushNow() })
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ t: 'data', d: 'last words' })
  })

  it('no-ops on a session without the hook (mock/legacy shapes)', () => {
    expect(() => drainBatch({})).not.toThrow()
  })

  it('swallows a throwing flush — teardown must proceed', () => {
    expect(() =>
      drainBatch({
        flushData: () => {
          throw new Error('port closed')
        }
      })
    ).not.toThrow()
  })
})
