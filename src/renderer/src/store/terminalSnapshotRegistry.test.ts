import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerTerminalSnapshotter,
  unregisterTerminalSnapshotter,
  flushAllTerminalSnapshots
} from './terminalSnapshotRegistry'

const writeSnapshot =
  vi.fn<(id: string, text: string, sync?: boolean, expectedDir?: string) => Promise<boolean>>()

beforeEach(() => {
  writeSnapshot.mockReset().mockResolvedValue(true)
  ;(globalThis as unknown as { window: unknown }).window = { api: { terminal: { writeSnapshot } } }
  // Clean the module-level registry between tests (ids are unique per test anyway).
  for (const id of ['a', 'b', 'c', 'empty', 'boom']) unregisterTerminalSnapshotter(id)
})

describe('terminalSnapshotRegistry', () => {
  it('flushes every registered terminal to its sidecar (default: async / non-blocking write)', async () => {
    registerTerminalSnapshotter('a', () => 'AAA')
    registerTerminalSnapshotter('b', () => 'BBB')
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).toHaveBeenCalledTimes(2)
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'AAA', false, undefined)
    expect(writeSnapshot).toHaveBeenCalledWith('b', 'BBB', false, undefined)
  })

  it('BUG-040: forwards sync:true for the before-quit flush (guaranteed-land write)', async () => {
    registerTerminalSnapshotter('a', () => 'AAA')
    await flushAllTerminalSnapshots({ sync: true })
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'AAA', true, undefined)
  })

  it('skips empty / whitespace-only buffers (no blank sidecar for an untouched idle board)', async () => {
    registerTerminalSnapshotter('a', () => 'real')
    registerTerminalSnapshotter('empty', () => '')
    registerTerminalSnapshotter('b', () => '   \n\t')
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'real', false, undefined)
  })

  it('skips a null serializer result', async () => {
    registerTerminalSnapshotter('a', () => null)
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).not.toHaveBeenCalled()
  })

  it('unregister removes a terminal from the flush set', async () => {
    registerTerminalSnapshotter('a', () => 'AAA')
    unregisterTerminalSnapshotter('a')
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).not.toHaveBeenCalled()
  })

  it('is best-effort per board — one serializer throwing never blocks the others', async () => {
    registerTerminalSnapshotter('boom', () => {
      throw new Error('serialize blew up')
    })
    registerTerminalSnapshotter('b', () => 'BBB')
    await expect(flushAllTerminalSnapshots()).resolves.toBeUndefined()
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
    expect(writeSnapshot).toHaveBeenCalledWith('b', 'BBB', false, undefined)
  })

  it('swallows a rejected writeSnapshot (a wedged IPC never rejects the flush)', async () => {
    writeSnapshot.mockRejectedValue(new Error('ipc down'))
    registerTerminalSnapshotter('a', () => 'AAA')
    await expect(flushAllTerminalSnapshots()).resolves.toBeUndefined()
  })

  it('R2 dir-pin: forwards expectedDir so MAIN can reject a flush that raced a switch', async () => {
    registerTerminalSnapshotter('a', () => 'AAA')
    await flushAllTerminalSnapshots({ expectedDir: '/proj/alpha' })
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'AAA', false, '/proj/alpha')
  })
})
