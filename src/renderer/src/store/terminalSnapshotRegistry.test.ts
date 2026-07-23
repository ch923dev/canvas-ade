import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerTerminalSnapshotter,
  unregisterTerminalSnapshotter,
  flushAllTerminalSnapshots
} from './terminalSnapshotRegistry'

const writeSnapshot =
  vi.fn<
    (
      id: string,
      text: string,
      sync?: boolean,
      expectedDir?: string,
      watermark?: number
    ) => Promise<boolean>
  >()

beforeEach(() => {
  writeSnapshot.mockReset().mockResolvedValue(true)
  ;(globalThis as unknown as { window: unknown }).window = { api: { terminal: { writeSnapshot } } }
  // Clean the module-level registry between tests (ids are unique per test anyway).
  for (const id of ['a', 'b', 'c', 'empty', 'boom']) unregisterTerminalSnapshotter(id)
})

describe('terminalSnapshotRegistry', () => {
  it('flushes every registered terminal to its sidecar (default: async / non-blocking write)', async () => {
    registerTerminalSnapshotter('a', () => ({ text: 'AAA', watermark: 3 }))
    registerTerminalSnapshotter('b', () => ({ text: 'BBB', watermark: 7 }))
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).toHaveBeenCalledTimes(2)
    // T2·D2: the exact splice boundary rides through as the 5th arg.
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'AAA', false, undefined, 3)
    expect(writeSnapshot).toHaveBeenCalledWith('b', 'BBB', false, undefined, 7)
  })

  it('BUG-040: forwards sync:true for the before-quit flush (guaranteed-land write)', async () => {
    registerTerminalSnapshotter('a', () => ({ text: 'AAA', watermark: 3 }))
    await flushAllTerminalSnapshots({ sync: true })
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'AAA', true, undefined, 3)
  })

  it('skips empty / whitespace-only buffers (no blank sidecar for an untouched idle board)', async () => {
    registerTerminalSnapshotter('a', () => ({ text: 'real', watermark: 4 }))
    registerTerminalSnapshotter('empty', () => ({ text: '', watermark: 0 }))
    registerTerminalSnapshotter('b', () => ({ text: '   \n\t', watermark: 0 }))
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'real', false, undefined, 4)
  })

  it('skips a null serializer result', async () => {
    registerTerminalSnapshotter('a', () => null)
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).not.toHaveBeenCalled()
  })

  it('unregister removes a terminal from the flush set', async () => {
    registerTerminalSnapshotter('a', () => ({ text: 'AAA', watermark: 3 }))
    unregisterTerminalSnapshotter('a')
    await flushAllTerminalSnapshots()
    expect(writeSnapshot).not.toHaveBeenCalled()
  })

  it('is best-effort per board — one serializer throwing never blocks the others', async () => {
    registerTerminalSnapshotter('boom', () => {
      throw new Error('serialize blew up')
    })
    registerTerminalSnapshotter('b', () => ({ text: 'BBB', watermark: 7 }))
    await expect(flushAllTerminalSnapshots()).resolves.toBeUndefined()
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
    expect(writeSnapshot).toHaveBeenCalledWith('b', 'BBB', false, undefined, 7)
  })

  it('swallows a rejected writeSnapshot (a wedged IPC never rejects the flush)', async () => {
    writeSnapshot.mockRejectedValue(new Error('ipc down'))
    registerTerminalSnapshotter('a', () => ({ text: 'AAA', watermark: 3 }))
    await expect(flushAllTerminalSnapshots()).resolves.toBeUndefined()
  })

  it('R2 dir-pin: forwards expectedDir so MAIN can reject a flush that raced a switch', async () => {
    registerTerminalSnapshotter('a', () => ({ text: 'AAA', watermark: 3 }))
    await flushAllTerminalSnapshots({ expectedDir: '/proj/alpha' })
    expect(writeSnapshot).toHaveBeenCalledWith('a', 'AAA', false, '/proj/alpha', 3)
  })
})
