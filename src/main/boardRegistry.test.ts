import { beforeEach, describe, expect, it } from 'vitest'
import type { IpcMain, IpcMainEvent, BrowserWindow } from 'electron'
import {
  __setMirrorForTest,
  __setConnectorsForTest,
  __setGroupsForTest,
  __applySnapshotForTest,
  __clearStatusListenersForTest,
  listBoardMirror,
  listConnectors,
  listGroups,
  sanitizeSnapshot,
  sanitizeConnectors,
  sanitizeGroups,
  diffStatus,
  subscribeBoardStatus,
  registerBoardRegistryHandler,
  sanitizeView,
  sanitizeContextFields,
  getCanvasView,
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

  it('keeps a bounded agentKind + a strict-boolean monitorActivity, drops invalid ones (board kept)', () => {
    const longKind = 'x'.repeat(300)
    const out = sanitizeSnapshot([
      { id: 'a', type: 'terminal', title: 'A', agentKind: 'claude', monitorActivity: false },
      { id: 'b', type: 'terminal', title: 'B', agentKind: 123, monitorActivity: 'yes' }, // both invalid
      { id: 'c', type: 'terminal', title: 'C', agentKind: longKind }, // over-length → field dropped
      { id: 'd', type: 'terminal', title: 'D', monitorActivity: true }
    ])
    expect(out).toEqual([
      { id: 'a', type: 'terminal', title: 'A', agentKind: 'claude', monitorActivity: false },
      { id: 'b', type: 'terminal', title: 'B' }, // invalid fields dropped, board retained
      { id: 'c', type: 'terminal', title: 'C' },
      { id: 'd', type: 'terminal', title: 'D', monitorActivity: true }
    ])
  })

  it('keeps FINITE world-space geometry, drops non-finite/non-number (board kept) (P1)', () => {
    const out = sanitizeSnapshot([
      { id: 'a', type: 'planning', title: 'A', x: 120, y: 40, w: 640, h: 480 },
      // NaN / ∞ / non-number values drop the offending field but keep the board.
      { id: 'b', type: 'terminal', title: 'B', x: NaN, y: Infinity, w: '300', h: 200 }
    ])
    expect(out).toEqual([
      { id: 'a', type: 'planning', title: 'A', x: 120, y: 40, w: 640, h: 480 },
      { id: 'b', type: 'terminal', title: 'B', h: 200 } // only the finite-number h survives
    ])
  })

  it('keeps a file board path + planning fileRefs, drops malformed ones (board kept) (S5)', () => {
    const longPath = 'x'.repeat(300)
    const out = sanitizeSnapshot([
      { id: 'f1', type: 'file', title: 'main.ts', path: 'src/main.ts' },
      { id: 'f2', type: 'file', title: 'Bad', path: 123 }, // non-string path → dropped
      { id: 'f3', type: 'file', title: 'Empty', path: '' }, // empty path → dropped
      { id: 'f4', type: 'file', title: 'Long', path: longPath }, // over-length → dropped
      {
        id: 'p1',
        type: 'planning',
        title: 'Plan',
        fileRefs: [
          { path: 'a.ts', label: 'a.ts' },
          { path: 'b.ts' }, // missing label (non-string) → dropped
          { path: '', label: 'empty' }, // empty path → dropped
          { label: 'no-path' } // no path → dropped
        ]
      },
      { id: 'p2', type: 'planning', title: 'P2', fileRefs: 'nope' } // non-array → field dropped
    ])
    expect(out).toEqual([
      { id: 'f1', type: 'file', title: 'main.ts', path: 'src/main.ts' },
      { id: 'f2', type: 'file', title: 'Bad' },
      { id: 'f3', type: 'file', title: 'Empty' },
      { id: 'f4', type: 'file', title: 'Long' },
      { id: 'p1', type: 'planning', title: 'Plan', fileRefs: [{ path: 'a.ts', label: 'a.ts' }] },
      { id: 'p2', type: 'planning', title: 'P2' }
    ])
  })

  it('bounds fileRefs count and per-entry path/label length (S5)', () => {
    const longLabel = 'L'.repeat(300)
    const many = Array.from({ length: 600 }, (_, i) => ({ path: `f${i}.ts`, label: `f${i}` }))
    const out = sanitizeSnapshot([
      { id: 'p1', type: 'planning', title: 'P', fileRefs: many },
      {
        id: 'p2',
        type: 'planning',
        title: 'P2',
        fileRefs: [{ path: 'ok.ts', label: longLabel }] // over-length label → entry dropped → field absent
      }
    ])
    expect(out[0].fileRefs).toHaveLength(500) // MAX_FILEREFS cap
    expect('fileRefs' in out[1]).toBe(false)
  })

  it('keeps a kanban projection, drops malformed lanes/cards, wip only finite+positive (P3b)', () => {
    const out = sanitizeSnapshot([
      {
        id: 'k1',
        type: 'kanban',
        title: 'K',
        kanban: {
          columns: [
            { id: 'a', title: 'A', wip: 3 },
            { id: 'b', title: 'B', wip: 0 }, // wip 0 → dropped (not positive), column kept
            { id: 'c', title: 'C', wip: NaN }, // wip NaN → dropped, column kept
            { id: '', title: 'Empty' }, // empty id → column dropped
            { id: 'd' } // missing title → column dropped
          ],
          cards: [
            {
              id: 'c1',
              columnId: 'a',
              title: 'One',
              tag: 'feature',
              assignee: 'claude',
              ref: 'PR #1'
            },
            { id: 'c2', columnId: 'a' }, // missing title → dropped
            { id: 'c3', title: 'no-col' }, // missing columnId → dropped
            { columnId: 'a', title: 'no-id' } // missing id → dropped
          ]
        }
      },
      { id: 'k2', type: 'kanban', title: 'K2', kanban: 'nope' } // non-object → field dropped
    ])
    expect(out[0].kanban).toEqual({
      columns: [
        { id: 'a', title: 'A', wip: 3 },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C' }
      ],
      cards: [
        { id: 'c1', columnId: 'a', title: 'One', tag: 'feature', assignee: 'claude', ref: 'PR #1' }
      ]
    })
    expect('kanban' in out[1]).toBe(false)
  })

  it('keeps the v19 card-detail fields + board axis, keeps a long description at full fidelity (v19)', () => {
    const longDesc = 'x'.repeat(600) // >500 planning preview, ≤4000 write cap → mirrored WHOLE
    const out = sanitizeSnapshot([
      {
        id: 'k1',
        type: 'kanban',
        title: 'K',
        kanban: {
          columns: [{ id: 'a', title: 'A' }],
          cards: [
            {
              id: 'c1',
              columnId: 'a',
              title: 'One',
              description: longDesc,
              tags: ['feature', '', 'security'], // empty tag dropped
              fileRefs: [
                { path: 'src/x.ts', line: 4, endLine: 9 },
                { path: 'ok.ts' },
                { path: '', line: 2 }, // empty path → dropped
                { path: 'neg.ts', line: -1 } // non-positive line → line dropped, path kept
              ]
            }
          ],
          columnAxis: 'category',
          axisLabel: 'Subsystem'
        }
      }
    ])
    const card = out[0].kanban?.cards[0]
    expect(card?.description).toHaveLength(600) // full fidelity (≤4000), NOT truncated to the 500 preview
    expect(card?.tags).toEqual(['feature', 'security'])
    expect(card?.fileRefs).toEqual([
      { path: 'src/x.ts', line: 4, endLine: 9 },
      { path: 'ok.ts' },
      { path: 'neg.ts' }
    ])
    expect(out[0].kanban?.columnAxis).toBe('category')
    expect(out[0].kanban?.axisLabel).toBe('Subsystem')
  })

  it('normalizes mirror fileRef line/endLine (coupled + integer, matching the write gate) (v19)', () => {
    const out = sanitizeSnapshot([
      {
        id: 'k1',
        type: 'kanban',
        title: 'K',
        kanban: {
          columns: [{ id: 'a', title: 'A' }],
          cards: [
            {
              id: 'c1',
              columnId: 'a',
              title: 'One',
              fileRefs: [
                { path: 'frac.ts', line: 2.5 }, // fractional line → dropped
                { path: 'bare.ts', endLine: 9 }, // endLine without line → endLine dropped
                { path: 'rng.ts', line: 3, endLine: 3 }, // endLine == line → not a range, dropped
                { path: 'ok.ts', line: 4, endLine: 9 } // real range → kept
              ]
            }
          ]
        }
      }
    ])
    expect(out[0].kanban?.cards[0]?.fileRefs).toEqual([
      { path: 'frac.ts' },
      { path: 'bare.ts' },
      { path: 'rng.ts', line: 3 },
      { path: 'ok.ts', line: 4, endLine: 9 }
    ])
  })

  it('keeps a long (human-authored) fileRef path >256, drops one over the 1024 mirror cap (v19)', () => {
    const deepPath = 'src/' + 'nested/'.repeat(40) + 'File.ts' // ~290 chars — a real deep path
    const out = sanitizeSnapshot([
      {
        id: 'k1',
        type: 'kanban',
        title: 'K',
        kanban: {
          columns: [{ id: 'a', title: 'A' }],
          cards: [
            {
              id: 'c1',
              columnId: 'a',
              title: 'One',
              fileRefs: [{ path: deepPath, line: 3 }, { path: 'x/'.repeat(600) + 'huge.ts' }]
            }
          ]
        }
      }
    ])
    expect(deepPath.length).toBeGreaterThan(256)
    // the deep-but-realistic path survives; the pathological >1024 one is dropped
    expect(out[0].kanban?.cards[0]?.fileRefs).toEqual([{ path: deepPath, line: 3 }])
  })

  it('truncates a description over the 4000 write cap (memory bound, not dropped) (v19)', () => {
    const out = sanitizeSnapshot([
      {
        id: 'k1',
        type: 'kanban',
        title: 'K',
        kanban: {
          columns: [{ id: 'a', title: 'A' }],
          cards: [{ id: 'c1', columnId: 'a', title: 'One', description: 'y'.repeat(5000) }]
        }
      }
    ])
    expect(out[0].kanban?.cards[0]?.description).toHaveLength(4000) // cut to the cap, still present
  })

  it('keeps well-formed card attachments, drops malformed ones (#346)', () => {
    const out = sanitizeSnapshot([
      {
        id: 'k1',
        type: 'kanban',
        title: 'K',
        kanban: {
          columns: [{ id: 'a', title: 'A' }],
          cards: [
            {
              id: 'c1',
              columnId: 'a',
              title: 'One',
              attachments: [
                { assetId: 's1', name: 'a.png', kind: 'image', mime: 'image/png', size: 10 },
                { assetId: 's2', name: 'b.bin', kind: 'file' },
                { assetId: 's3', name: 'x', kind: 'bogus' }, // bad kind → dropped
                { assetId: '', name: 'y', kind: 'file' }, // empty assetId → dropped
                { assetId: 's5', name: 'z', kind: 'image', size: 0 } // size 0 → size dropped, entry kept
              ]
            }
          ]
        }
      }
    ])
    expect(out[0].kanban?.cards[0].attachments).toEqual([
      { assetId: 's1', name: 'a.png', kind: 'image', mime: 'image/png', size: 10 },
      { assetId: 's2', name: 'b.bin', kind: 'file' },
      { assetId: 's5', name: 'z', kind: 'image' }
    ])
  })

  it('drops a bad columnAxis enum + keeps a valid axis-only kanban projection (v19)', () => {
    const out = sanitizeSnapshot([
      {
        id: 'k1',
        type: 'kanban',
        title: 'K',
        kanban: { columns: [], cards: [], columnAxis: 'sideways' }
      }
    ])
    // Bad enum dropped; with no columns/cards/label either, the whole projection is omitted.
    expect('kanban' in out[0]).toBe(false)
  })

  it('count-caps kanban columns + cards and drops over-length fields (P3b)', () => {
    const longTitle = 'T'.repeat(300)
    const out = sanitizeSnapshot([
      {
        id: 'k',
        type: 'kanban',
        title: 'K',
        kanban: {
          columns: Array.from({ length: 60 }, (_, i) => ({ id: `col${i}`, title: `c${i}` })),
          cards: Array.from({ length: 400 }, (_, i) => ({
            id: `c${i}`,
            columnId: 'col0',
            title: `n${i}`
          }))
        }
      },
      {
        id: 'k2',
        type: 'kanban',
        title: 'K2',
        kanban: {
          columns: [{ id: 'a', title: longTitle }], // over-length title → column dropped
          cards: [{ id: 'c1', columnId: 'a', title: 'x', tag: longTitle }] // over-length tag → chip dropped
        }
      }
    ])
    expect(out[0].kanban?.columns).toHaveLength(50) // MAX_KANBAN_COLUMNS
    expect(out[0].kanban?.cards).toHaveLength(300) // MAX_KANBAN_CARDS
    // k2: the only column was dropped (over-length), but a valid card survives → projection kept.
    expect(out[1].kanban?.columns).toEqual([])
    expect(out[1].kanban?.cards).toEqual([{ id: 'c1', columnId: 'a', title: 'x' }]) // tag dropped
  })

  it('keeps a planning projection: element ids+kind + editable fields, truncates long text, drops id-less (S6)', () => {
    const longText = 'x'.repeat(700)
    const out = sanitizeSnapshot([
      {
        id: 'p1',
        type: 'planning',
        title: 'P',
        planning: {
          elements: [
            { id: 'n1', kind: 'note', text: 'Phase 1', tint: 'yellow' },
            {
              id: 'c1',
              kind: 'checklist',
              title: 'Progress',
              items: [
                { id: 'i1', label: 'a', done: true },
                { id: '', label: 'no-id' } // empty item id → item dropped
              ]
            },
            { id: 'big', kind: 'text', text: longText }, // long body → truncated to the preview cap
            { kind: 'note', text: 'no-id' }, // missing element id → dropped
            { id: 'x1' } // missing kind → dropped
          ]
        }
      },
      { id: 'p2', type: 'planning', title: 'P2', planning: 'nope' } // non-object → field dropped
    ])
    expect(out[0].planning?.elements).toEqual([
      { id: 'n1', kind: 'note', text: 'Phase 1', tint: 'yellow' },
      {
        id: 'c1',
        kind: 'checklist',
        title: 'Progress',
        items: [{ id: 'i1', label: 'a', done: true }]
      },
      { id: 'big', kind: 'text', text: 'x'.repeat(500) } // MAX_PLANNING_PREVIEW
    ])
    expect('planning' in out[1]).toBe(false)
  })

  it('count-caps planning elements (S6)', () => {
    const out = sanitizeSnapshot([
      {
        id: 'p',
        type: 'planning',
        title: 'P',
        planning: {
          elements: Array.from({ length: 350 }, (_, i) => ({
            id: `e${i}`,
            kind: 'note',
            text: `n${i}`
          }))
        }
      }
    ])
    expect(out[0].planning?.elements).toHaveLength(300) // MAX_PLANNING_ELEMENTS
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

  it('sanitizeGroups keeps well-formed groups and drops malformed ones (PR-5)', () => {
    const out = sanitizeGroups([
      { id: 'g1', name: 'Auth', boardIds: ['a', 'b'] },
      { id: 'g2', name: 'Empty', boardIds: [] }, // named-empty group is valid
      { id: 'g3', name: 'Mixed', boardIds: ['ok', 7, null, 'ok2'] }, // non-string members dropped
      { id: 'g4', boardIds: ['a'] }, // missing name → dropped
      { id: 'g5', name: 'NoArray', boardIds: 'a,b' }, // boardIds not an array → dropped
      { id: 9, name: 'BadId', boardIds: [] }, // non-string id → dropped
      'nope'
    ])
    expect(out).toEqual([
      { id: 'g1', name: 'Auth', boardIds: ['a', 'b'] },
      { id: 'g2', name: 'Empty', boardIds: [] },
      { id: 'g3', name: 'Mixed', boardIds: ['ok', 'ok2'] }
    ])
  })

  it('sanitizeGroups bounds group count, name length, and membership size', () => {
    const longName = 'x'.repeat(300)
    const manyGroups = Array.from({ length: 250 }, (_, i) => ({
      id: `g${i}`,
      name: 'G',
      boardIds: []
    }))
    expect(sanitizeGroups(manyGroups)).toHaveLength(200) // MAX_GROUPS
    expect(sanitizeGroups([{ id: 'g', name: longName, boardIds: [] }])).toEqual([]) // over-length name → dropped
    const bigMembers = {
      id: 'g',
      name: 'Big',
      boardIds: Array.from({ length: 600 }, (_, i) => `b${i}`)
    }
    expect(sanitizeGroups([bigMembers])[0].boardIds).toHaveLength(500) // MAX_GROUP_MEMBERS
  })

  it('listGroups returns the last stored groups (empty by default)', () => {
    __setGroupsForTest([{ id: 'g1', name: 'Auth', boardIds: ['a'] }])
    expect(listGroups()).toEqual([{ id: 'g1', name: 'Auth', boardIds: ['a'] }])
    __setGroupsForTest([])
    expect(listGroups()).toEqual([])
  })

  it('__applySnapshotForTest stores groups alongside boards/connectors (metadata-only)', () => {
    __applySnapshotForTest(
      [{ id: 'a', type: 'terminal', title: 'A', status: 'idle' }],
      [{ id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' }],
      [{ id: 'g1', name: 'Zone', boardIds: ['a'] }]
    )
    expect(listGroups()).toEqual([{ id: 'g1', name: 'Zone', boardIds: ['a'] }])
    // A later snapshot without groups replaces them (the renderer always sends the full set).
    __applySnapshotForTest([{ id: 'a', type: 'terminal', title: 'A', status: 'idle' }])
    expect(listGroups()).toEqual([])
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

  it('carries monitorActivity on each (non-gone) change (Phase B)', () => {
    expect(
      diffStatus(
        [],
        [{ id: 'a', type: 'terminal', title: 'A', status: 'blocked', monitorActivity: false }]
      )
    ).toEqual([{ id: 'a', status: 'blocked', monitorActivity: false }])
  })

  it('emits on a monitorActivity flip even when the status bucket is unchanged (Phase B)', () => {
    const prev = [
      { id: 'a', type: 'terminal', title: 'A', status: 'blocked', monitorActivity: true }
    ]
    const next = [
      { id: 'a', type: 'terminal', title: 'A', status: 'blocked', monitorActivity: false }
    ]
    expect(diffStatus(prev, next)).toEqual([{ id: 'a', status: 'blocked', monitorActivity: false }])
  })

  it('emits nothing when status AND monitorActivity are both unchanged (Phase B)', () => {
    const s = [{ id: 'a', type: 'terminal', title: 'A', status: 'running', monitorActivity: false }]
    expect(diffStatus(s, s)).toEqual([])
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
      emit({ senderFrame: { id: 'some-frame' } } as unknown as IpcMainEvent, [
        { id: 'y', type: 'browser', title: 'Y' }
      ])
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

  it('PR-5: routes {boards, connectors, groups} object payload through their sanitizers', () => {
    const { ipcMain, emit } = makeIpc()
    const frame = { id: 'main-frame' }
    const win = makeWin({ frame })
    registerBoardRegistryHandler(ipcMain, () => win)
    emit({ senderFrame: frame } as unknown as IpcMainEvent, {
      boards: [{ id: 'a', type: 'terminal', title: 'A' }],
      connectors: [{ id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' }],
      groups: [{ id: 'g1', name: 'Zone', boardIds: ['a'] }]
    })
    expect(listBoardMirror()).toEqual([{ id: 'a', type: 'terminal', title: 'A' }])
    expect(listConnectors()).toEqual([
      { id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' }
    ])
    expect(listGroups()).toEqual([{ id: 'g1', name: 'Zone', boardIds: ['a'] }])
    // A legacy bare-array payload resets connectors + groups to [].
    emit({ senderFrame: frame } as unknown as IpcMainEvent, [
      { id: 'a', type: 'terminal', title: 'A' }
    ])
    expect(listGroups()).toEqual([])
    expect(listConnectors()).toEqual([])
  })

  it('C1: routes a valid view through sanitizeView; a view-less / legacy payload clears it', () => {
    const { ipcMain, emit } = makeIpc()
    const frame = { id: 'main-frame' }
    registerBoardRegistryHandler(ipcMain, () => makeWin({ frame }))
    const view = { pane: { w: 1600, h: 900 }, dpr: 2, camera: { x: -100, y: 50, zoom: 0.5 } }
    emit({ senderFrame: frame } as unknown as IpcMainEvent, {
      boards: [{ id: 'a', type: 'terminal', title: 'A', cwd: '/repo/api' }],
      connectors: [],
      groups: [],
      view
    })
    expect(getCanvasView()).toEqual({
      ...view,
      visibleWorld: { x: 200, y: -100, w: 3200, h: 1800 }
    })
    expect(listBoardMirror()).toEqual([{ id: 'a', type: 'terminal', title: 'A', cwd: '/repo/api' }])
    // An object payload WITHOUT a view (a renderer with no Canvas mounted) -> no view.
    emit({ senderFrame: frame } as unknown as IpcMainEvent, { boards: [], connectors: [] })
    expect(getCanvasView()).toBeNull()
    // A bad view is dropped whole - the rest of the payload still lands.
    emit({ senderFrame: frame } as unknown as IpcMainEvent, {
      boards: [{ id: 'a', type: 'terminal', title: 'A' }],
      view: { ...view, dpr: NaN }
    })
    expect(getCanvasView()).toBeNull()
    expect(listBoardMirror()).toHaveLength(1)
    // The legacy bare-array payload is still accepted, view-less.
    emit({ senderFrame: frame } as unknown as IpcMainEvent, { boards: [], view })
    emit({ senderFrame: frame } as unknown as IpcMainEvent, [
      { id: 'b', type: 'browser', title: 'B' }
    ])
    expect(getCanvasView()).toBeNull()
    expect(listBoardMirror()).toEqual([{ id: 'b', type: 'browser', title: 'B' }])
  })
})

describe('C1 spatial mirror - sanitizeView (a bad view is dropped WHOLE)', () => {
  const good = { pane: { w: 1600, h: 900 }, dpr: 1.5, camera: { x: 10, y: -20, zoom: 1 } }
  const withPane = (pane: object) => ({ ...good, pane })
  const withCamera = (camera: object) => ({ ...good, camera })

  it('keeps a good view and derives visibleWorld from pane + camera (ignores the sent one)', () => {
    const v = sanitizeView({ ...good, visibleWorld: { x: 999, y: 999, w: 1, h: 1 } })
    expect(v).toEqual({ ...good, visibleWorld: { x: -10, y: 20, w: 1600, h: 900 } })
  })

  it('clamps in-domain values: pane into [1, 16384], zoom into [0.1, 2.5]', () => {
    expect(sanitizeView(withPane({ w: 20000, h: 0 }))?.pane).toEqual({ w: 16384, h: 1 })
    expect(sanitizeView(withPane({ w: 0.5, h: 900 }))?.pane).toEqual({ w: 1, h: 900 })
    expect(sanitizeView(withCamera({ x: 0, y: 0, zoom: 3 }))?.camera.zoom).toBe(2.5)
    expect(sanitizeView(withCamera({ x: 0, y: 0, zoom: 0.01 }))?.camera.zoom).toBe(0.1)
    // visibleWorld follows the CLAMPED values (zoom 5 -> 2.5).
    const vw = sanitizeView(withCamera({ x: 0, y: 0, zoom: 5 }))?.visibleWorld
    expect(vw?.w).toBe(640)
    expect(vw?.h).toBe(360)
  })

  it('accepts dpr in (0, 8]', () => {
    expect(sanitizeView({ ...good, dpr: 8 })?.dpr).toBe(8)
    expect(sanitizeView({ ...good, dpr: 0.25 })?.dpr).toBe(0.25)
  })

  it.each([
    ['NaN pane', withPane({ w: NaN, h: 900 })],
    ['Infinity camera', withCamera({ x: Infinity, y: 0, zoom: 1 })],
    ['-Infinity dpr', { ...good, dpr: -Infinity }],
    ['negative pane', withPane({ w: -1, h: 900 })],
    ['zero zoom', withCamera({ x: 0, y: 0, zoom: 0 })],
    ['negative zoom', withCamera({ x: 0, y: 0, zoom: -1 })],
    ['zero dpr', { ...good, dpr: 0 }],
    ['dpr above 8', { ...good, dpr: 9 }],
    ['huge pane', withPane({ w: 1e9, h: 900 })],
    ['huge camera', withCamera({ x: 1e12, y: 0, zoom: 1 })],
    ['string number', withPane({ w: '1600', h: 900 })],
    ['missing camera', { pane: good.pane, dpr: 1 }],
    ['missing pane.h', withPane({ w: 1600 })],
    ['missing dpr', { pane: good.pane, camera: good.camera }],
    ['array pane', withPane([1600, 900])],
    ['null', null],
    ['array', [good]],
    ['string', 'view']
  ])('drops a bad view whole: %s', (_label, input) => {
    expect(sanitizeView(input)).toBeNull()
  })
})

describe('C1 spatial mirror - per-board context fields', () => {
  it('keeps every well-formed context field (C1 + the C9 additions)', () => {
    const boards = [
      {
        id: 't1',
        type: 'terminal',
        title: 'API',
        cwd: 'C:/work/app/apps/api',
        dockedIn: 'sw1',
        agent: true,
        ports: [3000, 5173],
        lastFocusedAt: 1760000000000
      },
      { id: 'b1', type: 'browser', title: 'Web', previewSourceId: 't1', callsPorts: [3000] },
      { id: 'd1', type: 'dataflow', title: 'Flow', sourceBoardId: 'b1' }
    ]
    expect(sanitizeSnapshot(boards)).toEqual(boards)
  })

  it('bounds cwd at 1024 chars and id references at 200 (over-length DROPS, board kept)', () => {
    const ok = sanitizeContextFields({ cwd: 'c'.repeat(1024), previewSourceId: 'i'.repeat(200) })
    expect(ok.cwd).toHaveLength(1024)
    expect(ok.previewSourceId).toHaveLength(200)
    expect(
      sanitizeContextFields({
        cwd: 'c'.repeat(1025),
        previewSourceId: 'i'.repeat(201),
        dockedIn: 'd'.repeat(201),
        sourceBoardId: 's'.repeat(201)
      })
    ).toEqual({})
    expect(sanitizeContextFields({ cwd: '', dockedIn: 7, sourceBoardId: null })).toEqual({})
  })

  it('ports: integers 1..65535, de-duplicated, at most 8 - bad entries dropped', () => {
    expect(
      sanitizeContextFields({
        ports: [0, 1, 65535, 65536, 3000, 3000, 1.5, '8080', NaN, -1, null],
        callsPorts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      })
    ).toEqual({ ports: [1, 65535, 3000], callsPorts: [1, 2, 3, 4, 5, 6, 7, 8] })
    expect(sanitizeContextFields({ ports: [0, 70000], callsPorts: 'nope' })).toEqual({})
  })

  it('agent is a strict boolean; lastFocusedAt a finite non-negative epoch', () => {
    expect(sanitizeContextFields({ agent: 'true', lastFocusedAt: -1 })).toEqual({})
    expect(sanitizeContextFields({ agent: false, lastFocusedAt: Infinity })).toEqual({
      agent: false
    })
  })

  it('D9: a forged launch line / env on a board never reaches the mirror', () => {
    const out = sanitizeSnapshot([
      {
        id: 't1',
        type: 'terminal',
        title: 'T',
        launchCommand: 'OPENAI_API_KEY=sk-secret claude',
        env: { OPENAI_API_KEY: 'sk-secret' }
      }
    ])
    expect(out).toEqual([{ id: 't1', type: 'terminal', title: 'T' }])
    expect(JSON.stringify(out)).not.toContain('sk-secret')
  })

  it('legacy boards without any context field snapshot byte-identically', () => {
    const legacy = [
      { id: 'a', type: 'terminal', title: 'A', status: 'idle', x: 0, y: 0, w: 1, h: 1 }
    ]
    expect(sanitizeSnapshot(legacy)).toEqual(legacy)
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
