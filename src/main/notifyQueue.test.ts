/**
 * notifyQueue.ts — the dead-window pending queue (audit P1-1 / P2-3): bounded ring, idempotent
 * drain, and the frame-guarded `notify:drain` IPC (a foreign sender gets `[]`, never the backlog).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ foreign: false }))
vi.mock('./ipcGuard', () => ({ isForeignSender: () => h.foreign }))

import {
  enqueuePendingNotify,
  drainPendingNotify,
  resetPendingNotify,
  registerNotifyDrainIpc,
  MAX_PENDING,
  type PendingNotify
} from './notifyQueue'

const life = (boardId: string): PendingNotify => ({
  t: 'lifecycle',
  at: 1,
  payload: { boardId, event: 'done' }
})

beforeEach(() => {
  resetPendingNotify()
  h.foreign = false
})

describe('queue mechanics', () => {
  it('drain returns the backlog in arrival order and clears it', () => {
    enqueuePendingNotify(life('a'))
    enqueuePendingNotify({ t: 'focus', at: 2, boardId: 'b' })
    const out = drainPendingNotify()
    expect(out.map((i) => (i.t === 'focus' ? i.boardId : i.payload.boardId))).toEqual(['a', 'b'])
    // Idempotent: the StrictMode double-effect's second drain replays nothing.
    expect(drainPendingNotify()).toEqual([])
  })

  it('caps at MAX_PENDING, dropping the OLDEST (the freshest events are the replayable ones)', () => {
    for (let i = 0; i < MAX_PENDING + 5; i++) enqueuePendingNotify(life(`b${i}`))
    const out = drainPendingNotify()
    expect(out).toHaveLength(MAX_PENDING)
    expect((out[0] as Extract<PendingNotify, { t: 'lifecycle' }>).payload.boardId).toBe('b5')
  })
})

describe('registerNotifyDrainIpc', () => {
  function handler(): (e: unknown) => PendingNotify[] {
    let captured: ((e: unknown) => PendingNotify[]) | null = null
    const ipcMain = {
      handle: (_ch: string, fn: (e: unknown) => PendingNotify[]) => {
        captured = fn
      }
    }
    registerNotifyDrainIpc(ipcMain as never, () => null)
    return captured!
  }

  it('registers notify:drain and returns + clears the backlog for the app frame', () => {
    enqueuePendingNotify(life('a'))
    const invoke = handler()
    expect(invoke({})).toHaveLength(1)
    expect(invoke({})).toEqual([])
  })

  it('a foreign sender gets [] and the backlog SURVIVES for the real frame', () => {
    enqueuePendingNotify(life('a'))
    h.foreign = true
    const invoke = handler()
    expect(invoke({})).toEqual([])
    h.foreign = false
    expect(invoke({})).toHaveLength(1)
  })
})
