import { describe, it, expect, beforeEach } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import {
  __setWorkspacesForTest,
  listBoardMirror,
  listWorkspaces,
  registerBoardRegistryHandler,
  sanitizeSnapshot,
  sanitizeWorkspaces
} from './boardRegistry'

// v24 Project Workspaces — MAIN's mirror (`sanitizeWorkspaces`). `mcp:boards` is an IPC channel, so
// MAIN re-applies the shared workspace rules and bounds the scan like sanitizePorts/sanitizeGroups.

const API = { id: 'ws-api', name: 'API', goal: 'build auth', color: 'blue', root: 'api' }
const WT = {
  repoRoot: 'uploader',
  worktree: '.canvas/worktrees/uploader-storage',
  branch: 'ws/uploader-storage',
  baseRef: 'release',
  base: '0123456789abcdef0123456789abcdef01234567'
}

describe('sanitizeWorkspaces — rules', () => {
  it('keeps a well-formed workspace (worktree, archived, keepLayout) field-for-field', () => {
    const up = {
      id: 'ws-up',
      name: 'Uploader',
      goal: '',
      color: 'green',
      root: 'uploader',
      worktrees: [WT],
      state: 'archived',
      keepLayout: false
    }
    expect(sanitizeWorkspaces([API, up])).toEqual([API, up])
  })

  it('reads ONLY the known fields — nothing else on the payload reaches the mirror', () => {
    const [w] = sanitizeWorkspaces([
      { ...API, launchCommand: 'rm -rf /', worktrees: [{ ...WT, env: { X: '1' } }] }
    ])
    expect(w).toEqual({ ...API, worktrees: [WT] })
  })

  it('canonicalizes paths and coerces an unknown colour (the renderer read-time rules)', () => {
    const [w] = sanitizeWorkspaces([
      {
        ...API,
        root: './api//',
        color: 'chartreuse',
        worktrees: [{ ...WT, worktree: './.canvas/worktrees/x/' }]
      }
    ])
    expect(w.root).toBe('api')
    expect(w.color).toBe('blue')
    expect(w.worktrees?.[0].worktree).toBe('.canvas/worktrees/x')
  })

  it.each([
    ['non-object', 'API'],
    ['missing id', { ...API, id: undefined }],
    ['over-long id', { ...API, id: 'x'.repeat(201) }],
    ['blank name', { ...API, name: '' }],
    ['unsanitized name', { ...API, name: 'A\u202ePI' }],
    ['goal over 200', { ...API, goal: 'x'.repeat(201) }],
    ['multi-line goal', { ...API, goal: 'a\nb' }],
    ['non-string colour', { ...API, color: 3 }],
    ['absolute root', { ...API, root: '/etc' }],
    ['parent root', { ...API, root: '../x' }],
    ['drive-letter root', { ...API, root: 'C:/x' }],
    ['UNC root', { ...API, root: '\\\\h\\s' }],
    ['unknown state', { ...API, state: 'gone' }],
    ['non-boolean keepLayout', { ...API, keepLayout: 1 }],
    ['two worktrees', { ...API, worktrees: [WT, WT] }],
    ['non-array worktrees', { ...API, worktrees: WT }],
    ['escaping worktree', { ...API, worktrees: [{ ...WT, worktree: '../../tmp' }] }],
    ['worktree with an empty sha', { ...API, worktrees: [{ ...WT, base: '' }] }]
  ])('drops the WHOLE workspace on %s', (_label, entry) => {
    expect(sanitizeWorkspaces([entry, { ...API, id: 'ok', name: 'OK' }])).toEqual([
      { ...API, id: 'ok', name: 'OK' }
    ])
  })

  it('de-duplicates ids (first wins) and returns [] for a non-array', () => {
    expect(sanitizeWorkspaces([API, { ...API, name: 'Other' }])).toEqual([API])
    expect(sanitizeWorkspaces({ 0: API })).toEqual([])
    expect(sanitizeWorkspaces(undefined)).toEqual([])
  })
})

describe('sanitizeWorkspaces — bounds (the sanitizePorts discipline)', () => {
  it('keeps at most 200 workspaces', () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ ...API, id: `w${i}`, name: `W${i}` }))
    const out = sanitizeWorkspaces(many)
    expect(out).toHaveLength(200)
    expect(out[199].id).toBe('w199')
  })

  it('returns promptly on a forged sparse array (outer AND nested worktrees)', () => {
    const t0 = Date.now()
    expect(sanitizeWorkspaces(new Array(2 ** 32 - 1))).toEqual([])
    expect(sanitizeWorkspaces([{ ...API, worktrees: new Array(2 ** 32 - 1) }])).toEqual([])
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('a board workspaceId is a bounded id (over-length / non-string drops the field, not the board)', () => {
    const out = sanitizeSnapshot([
      { id: 'a', type: 'terminal', title: 'A', workspaceId: 'ws-api' },
      { id: 'b', type: 'terminal', title: 'B', workspaceId: 'x'.repeat(201) },
      { id: 'c', type: 'terminal', title: 'C', workspaceId: 7 }
    ])
    expect(out.map((b) => b.workspaceId)).toEqual(['ws-api', undefined, undefined])
  })
})

describe('mcp:boards handler — workspaces ride the snapshot payload', () => {
  function wire(): (payload: unknown) => void {
    let handler: ((e: IpcMainEvent, payload: unknown) => void) | null = null
    const ipcMain = {
      on: (_ch: string, fn: (e: IpcMainEvent, p: unknown) => void) => {
        handler = fn
      }
    } as unknown as IpcMain
    const frame = { id: 'main-frame' }
    const win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: frame }
    } as unknown as BrowserWindow
    registerBoardRegistryHandler(ipcMain, () => win)
    return (payload) => handler?.({ senderFrame: frame } as unknown as IpcMainEvent, payload)
  }

  beforeEach(() => __setWorkspacesForTest([]))

  it('a v24 payload lands sanitized in listWorkspaces() + the board mirror', () => {
    const emit = wire()
    emit({
      boards: [{ id: 't1', type: 'terminal', title: 'T', workspaceId: 'ws-api' }],
      connectors: [],
      groups: [],
      workspaces: [API, { ...API, id: 'bad', name: 'Bad', root: '../x' }]
    })
    expect(listWorkspaces()).toEqual([API])
    expect(listBoardMirror()[0].workspaceId).toBe('ws-api')
  })

  it('a pre-v24 payload (no workspaces key) or a legacy array clears the mirror', () => {
    const emit = wire()
    emit({ boards: [], connectors: [], groups: [], workspaces: [API] })
    emit({ boards: [], connectors: [], groups: [] })
    expect(listWorkspaces()).toEqual([])
    emit({ boards: [], connectors: [], workspaces: [API] })
    emit([])
    expect(listWorkspaces()).toEqual([])
  })
})
