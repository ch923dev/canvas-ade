import { beforeEach, describe, expect, it } from 'vitest'
import type { IpcMain, IpcMainEvent, BrowserWindow } from 'electron'
import {
  __setMirrorForTest,
  __setConnectorsForTest,
  __applySnapshotForTest,
  __clearStatusListenersForTest,
  listBoardMirror,
  listConnectors,
  sanitizeSnapshot,
  sanitizeConnectors,
  diffStatus,
  subscribeBoardStatus,
  registerBoardRegistryHandler,
  type BoardStatusChange
} from './boardRegistry'

describe('boardRegistry', () => {
  it('sanitizeSnapshot keeps well-formed entries and drops malformed ones', () => {
    const out = sanitizeSnapshot([
      { id: 'a', type: 'terminal', title: 'T' },
      { id: 'b', type: 'browser', title: 'B' },
      { id: 1, type: 'planning', title: 'P' }, // bad id
      { id: 'c', type: 'planning' }, // missing title
      'nope'
    ])
    expect(out).toEqual([
      { id: 'a', type: 'terminal', title: 'T' },
      { id: 'b', type: 'browser', title: 'B' }
    ])
  })

  it('keeps a valid status bucket and drops an invalid/absent one', () => {
    const out = sanitizeSnapshot([
      { id: 'a', type: 'terminal', title: 'T', status: 'running' },
      { id: 'b', type: 'browser', title: 'B', status: 'bogus-bucket' }, // invalid → dropped
      { id: 'c', type: 'planning', title: 'P', status: 123 }, // non-string → dropped
      { id: 'd', type: 'terminal', title: 'D' } // legacy, no status
    ])
    expect(out).toEqual([
      { id: 'a', type: 'terminal', title: 'T', status: 'running' },
      { id: 'b', type: 'browser', title: 'B' },
      { id: 'c', type: 'planning', title: 'P' },
      { id: 'd', type: 'terminal', title: 'D' }
    ])
  })

  it('listBoardMirror returns the last stored snapshot (empty by default)', () => {
    __setMirrorForTest([{ id: 'x', type: 'terminal', title: 'X' }])
    expect(listBoardMirror()).toEqual([{ id: 'x', type: 'terminal', title: 'X' }])
    __setMirrorForTest([])
    expect(listBoardMirror()).toEqual([])
  })

  it('sanitizeConnectors keeps well-formed edges and drops malformed/bad-kind ones', () => {
    const out = sanitizeConnectors([
      { id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' },
      { id: 'c2', sourceId: 'a', targetId: 'b', kind: 'preview' },
      { id: 'c3', sourceId: 'a', targetId: 'b', kind: 'bogus' }, // bad kind → dropped
      { id: 'c4', sourceId: 'a', kind: 'orchestration' }, // missing targetId → dropped
      { id: 5, sourceId: 'a', targetId: 'b', kind: 'orchestration' }, // bad id → dropped
      'nope'
    ])
    expect(out).toEqual([
      { id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' },
      { id: 'c2', sourceId: 'a', targetId: 'b', kind: 'preview' }
    ])
  })

  it('listConnectors returns the last stored connectors (empty by default)', () => {
    __setConnectorsForTest([{ id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' }])
    expect(listConnectors()).toEqual([
      { id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' }
    ])
    __setConnectorsForTest([])
    expect(listConnectors()).toEqual([])
  })
})

describe('diffStatus', () => {
  it('emits changed + new-with-bucket, skips unchanged + bucketless-new, emits gone for any vanished id', () => {
    const prev = [
      { id: 'a', type: 'terminal', title: 'A', status: 'running' },
      { id: 'b', type: 'browser', title: 'B', status: 'idle' },
      { id: 'c', type: 'planning', title: 'C' } // bucketless
    ]
    const next = [
      { id: 'a', type: 'terminal', title: 'A', status: 'idle' }, // changed
      { id: 'b', type: 'browser', title: 'B', status: 'idle' }, // unchanged
      { id: 'd', type: 'terminal', title: 'D', status: 'running' } // new, bucketed
      // c vanished
    ]
    expect(diffStatus(prev, next)).toEqual([
      { id: 'a', status: 'idle' },
      { id: 'd', status: 'running' },
      { id: 'c', status: 'gone' }
    ])
  })

  it('emits nothing for an identical snapshot', () => {
    const s = [{ id: 'a', type: 'terminal', title: 'A', status: 'running' }]
    expect(diffStatus(s, s)).toEqual([])
  })

  it('skips a board that newly appears WITHOUT a bucket', () => {
    expect(diffStatus([], [{ id: 'x', type: 'planning', title: 'X' }])).toEqual([])
  })

  it('emits gone even when the vanished board had no bucket', () => {
    expect(diffStatus([{ id: 'x', type: 'planning', title: 'X' }], [])).toEqual([
      { id: 'x', status: 'gone' }
    ])
  })

  it('exports BoardStatusChange with an { id, status } shape', () => {
    const change: BoardStatusChange = { id: 'x', status: 'idle' }
    expect(change).toEqual({ id: 'x', status: 'idle' })
  })
})

// BUG-033 regression: registerBoardRegistryHandler must deny payloads when getWin()
// returns null (fail-OPEN in the old inline guard) and must not throw on a destroyed window.
describe('registerBoardRegistryHandler BUG-033 sender guard', () => {
  // Minimal ipcMain stub that captures 'on' handlers.
  function makeIpc(): { ipcMain: IpcMain; emit: (e: IpcMainEvent, payload: unknown) => void } {
    let handler: ((e: IpcMainEvent, payload: unknown) => void) | null = null
    const ipcMain = {
      on: (_ch: string, fn: (e: IpcMainEvent, payload: unknown) => void) => {
        handler = fn
      }
    } as unknown as IpcMain
    return {
      ipcMain,
      emit: (e, payload) => handler?.(e, payload)
    }
  }

  function makeWin(opts: {
    destroyed?: boolean
    wcDestroyed?: boolean
    frame?: object
  }): BrowserWindow {
    const frame = opts.frame ?? { id: 'main-frame' }
    return {
      isDestroyed: () => opts.destroyed ?? false,
      webContents: {
        isDestroyed: () => opts.wcDestroyed ?? false,
        mainFrame: frame
      }
    } as unknown as BrowserWindow
  }

  beforeEach(() => __setMirrorForTest([]))

  it('BUG-033: does not throw and denies payload when getWin() returns null (boot window)', () => {
    const { ipcMain, emit } = makeIpc()
    // getWin returns null — the old inline guard accepted the payload (fail-open)
    registerBoardRegistryHandler(ipcMain, () => null)
    const payload = [{ id: 'x', type: 'terminal', title: 'X' }]
    // isForeignSender with null window -> DENY; the mirror must NOT be updated
    expect(() =>
      emit({ senderFrame: { id: 'some-frame' } } as unknown as IpcMainEvent, payload)
    ).not.toThrow()
    expect(listBoardMirror()).toEqual([]) // payload rejected
  })

  it('BUG-033: does not throw when window is destroyed (was throw into uncaughtException)', () => {
    const { ipcMain, emit } = makeIpc()
    const win = makeWin({ destroyed: true })
    registerBoardRegistryHandler(ipcMain, () => win)
    expect(() =>
      emit(
        { senderFrame: { id: 'some-frame' } } as unknown as IpcMainEvent,
        [{ id: 'y', type: 'browser', title: 'Y' }]
      )
    ).not.toThrow()
    expect(listBoardMirror()).toEqual([])
  })

  it('accepts a payload from the main frame (legitimate sender)', () => {
    const { ipcMain, emit } = makeIpc()
    const frame = { id: 'main-frame' }
    const win = makeWin({ frame })
    registerBoardRegistryHandler(ipcMain, () => win)
    const boards = [{ id: 'a', type: 'terminal', title: 'A' }]
    emit({ senderFrame: frame } as unknown as IpcMainEvent, boards)
    expect(listBoardMirror()).toEqual([{ id: 'a', type: 'terminal', title: 'A' }])
  })
})

describe('subscribeBoardStatus', () => {
  beforeEach(() => {
    __clearStatusListenersForTest()
  })

  it('emits per-board changes on each snapshot apply, including gone; unsub stops delivery', () => {
    __setMirrorForTest([]) // reset the module baseline
    const seen: BoardStatusChange[] = []
    const unsub = subscribeBoardStatus((c) => seen.push(c))

    __applySnapshotForTest([
      { id: 'a', type: 'terminal', title: 'A', status: 'running' },
      { id: 'b', type: 'browser', title: 'B', status: 'idle' }
    ])
    __applySnapshotForTest([{ id: 'a', type: 'terminal', title: 'A', status: 'idle' }]) // a changed; b gone

    unsub()
    __applySnapshotForTest([{ id: 'a', type: 'terminal', title: 'A', status: 'running' }]) // ignored

    expect(seen).toEqual([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'idle' },
      { id: 'a', status: 'idle' },
      { id: 'b', status: 'gone' }
    ])
  })

  it('isolates a throwing listener from the others', () => {
    __setMirrorForTest([])
    const seen: BoardStatusChange[] = []
    const unsubBad = subscribeBoardStatus(() => {
      throw new Error('boom')
    })
    const unsubGood = subscribeBoardStatus((c) => seen.push(c))
    expect(() =>
      __applySnapshotForTest([{ id: 'a', type: 'terminal', title: 'A', status: 'idle' }])
    ).not.toThrow()
    expect(seen).toEqual([{ id: 'a', status: 'idle' }])
    unsubBad()
    unsubGood()
  })
})
