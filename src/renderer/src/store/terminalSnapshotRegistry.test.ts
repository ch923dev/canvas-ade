import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerTerminalSnapshotter,
  unregisterTerminalSnapshotter,
  flushAllTerminalSnapshots
} from './terminalSnapshotRegistry'

const writeSnapshot = vi.fn<(id: string, text: string) => Promise<boolean>>()

beforeEach(() => {
  writeSnapshot.mockReset().mockResolvedValue(true)
  ;(globalThis as unknown as { window: unknown }).window = { api: { terminal: { writeSnapshot } } }
  // Clean the module-level registry between tests (ids are unique per test anyway).
  for (const id of ['a', 'b', 'c', 'empty', 'boom']) unregisterTerminalSnapshotter(id)
})

describe('terminalSnapshotRegistry', () => {
  it('flushes every registered terminal to its sidecar', async () => {
    registerTerminalSnapshotter('a', () => 'AAA')
    registerTerminalSnapshotter('b', () => 'BBB')
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).toHaveBeenCalledTimes(2)
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'AAA')
    expect(writeSnapshot).toHaveBeenCalledWith('b', 'BBB')
  })

  it('skips empty / whitespace-only buffers (no blank sidecar for an untouched idle board)', async () => {
    registerTerminalSnapshotter('a', () => 'real')
    registerTerminalSnapshotter('empty', () => '')
    registerTerminalSnapshotter('b', () => '   \n\t')
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'real')
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
    expect(writeSnapshot).toHaveBeenCalledWith('b', 'BBB')
  })

  it('swallows a rejected writeSnapshot (a wedged IPC never rejects the flush)', async () => {
    writeSnapshot.mockRejectedValue(new Error('ipc down'))
    registerTerminalSnapshotter('a', () => 'AAA')
    await expect(flushAllTerminalSnapshots()).resolves.toBeUndefined()
  })
})
