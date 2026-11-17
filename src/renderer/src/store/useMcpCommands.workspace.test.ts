/**
 * WS-7 — the renderer half of workspace membership for agent spawns: MAIN puts the CALLER-derived
 * `workspaceId` on `addBoard` / `spawnGroup`, and the appliers land it in the same tick as the add
 * (one undo step) — or refuse the whole spawn when the workspace is gone, so an agent in a workspace
 * never silently gets a project-level board.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { applyMcpCommand } from './useMcpCommands'
import { applySpatialMcpCommand } from './spatialMcpApply'
import type { Workspace } from '../lib/workspaceSchema'

const API: Workspace = { id: 'ws-api', name: 'API', goal: '', color: 'blue', root: 'api' }

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    workspaces: [API],
    selectedId: null,
    selectedIds: [],
    past: [],
    future: []
  })
})

const board = (id: string) => useCanvasStore.getState().boards.find((b) => b.id === id)

describe('addBoard workspaceId', () => {
  it('lands the workspace on the new board in the add’s own undo step', () => {
    const ack = applyMcpCommand({
      type: 'addBoard',
      board: { id: 't-1', type: 'terminal', workspaceId: 'ws-api' }
    })
    expect(ack).toEqual({ ok: true, type: 'addBoard' })
    expect(board('t-1')).toMatchObject({ workspaceId: 'ws-api' })
    expect(useCanvasStore.getState().past).toHaveLength(1)
    useCanvasStore.getState().undo()
    expect(board('t-1')).toBeUndefined()
  })

  it('refuses a workspace the store no longer has — no board lands', () => {
    const ack = applyMcpCommand({
      type: 'addBoard',
      board: { id: 't-1', type: 'planning', workspaceId: 'ws-deleted' }
    })
    expect(ack).toEqual({ ok: false, error: 'addBoard: that workspace no longer exists' })
    expect(useCanvasStore.getState().boards).toEqual([])
  })

  it('refuses a malformed workspaceId before any side effect', () => {
    for (const workspaceId of ['', 42]) {
      const ack = applyMcpCommand({
        type: 'addBoard',
        board: { id: 't-1', type: 'terminal', workspaceId: workspaceId as string }
      })
      expect(ack).toEqual({ ok: false, error: 'invalid addBoard workspaceId' })
    }
    expect(useCanvasStore.getState().boards).toEqual([])
  })

  it('no workspaceId keeps today’s project-level board', () => {
    applyMcpCommand({ type: 'addBoard', board: { id: 't-1', type: 'terminal' } })
    expect(board('t-1')?.workspaceId).toBeUndefined()
  })
})

describe('spawnGroup workspaceId', () => {
  const cmd = (workspaceId?: unknown) => ({
    type: 'spawnGroup' as const,
    group: { id: 'grp-1', name: 'Auth' },
    members: { terminal: { id: 't-1' }, planning: { id: 'p-1' }, browser: { id: 'b-1' } },
    ...(workspaceId !== undefined ? { workspaceId: workspaceId as string } : {})
  })

  it('every member joins the workspace, still ONE undo step', () => {
    expect(applySpatialMcpCommand(cmd('ws-api'))).toEqual({ ok: true, type: 'spawnGroup' })
    for (const id of ['t-1', 'p-1', 'b-1']) expect(board(id)?.workspaceId).toBe('ws-api')
    expect(useCanvasStore.getState().past).toHaveLength(1)
  })

  it('refuses a gone or malformed workspace without building the zone', () => {
    expect(applySpatialMcpCommand(cmd('ws-deleted'))).toEqual({
      ok: false,
      error: 'spawnGroup: that workspace no longer exists'
    })
    expect(applySpatialMcpCommand(cmd(''))).toEqual({
      ok: false,
      error: 'invalid spawnGroup workspaceId'
    })
    expect(useCanvasStore.getState().boards).toEqual([])
    expect(useCanvasStore.getState().groups).toEqual([])
  })
})
