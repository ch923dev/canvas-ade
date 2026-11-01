/**
 * `applyGroups` through the REAL canvas store (spatial C5, I1): the command routes through
 * `applySpatialMcpCommand` → `groupsMcpApply` → `canvasStore.applyGroupOps`, lands every approved
 * row, and ONE undo reverts all of it. Plus the renderer's all-or-nothing re-validation.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { applySpatialMcpCommand } from './spatialMcpApply'
import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'

type ApplyGroups = Extract<McpCommand, { type: 'applyGroups' }>
const apply = (create: ApplyGroups['create'], edits: ApplyGroups['edits'] = []): McpCommandAck =>
  applySpatialMcpCommand({ type: 'applyGroups', create, edits })

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: [],
    tool: 'select',
    past: [],
    future: []
  })
  const s = useCanvasStore.getState()
  for (const id of ['t1', 'b1', 't2', 't3']) s.addBoard('terminal', { x: 0, y: 0 }, { id })
  s.addBoard('swarm', { x: 0, y: 0 }, { id: 'sw' })
  s.addBoard('terminal', { x: 0, y: 0 }, { id: 'docked' })
  s.updateBoard('docked', { dockedIn: 'sw' })
  // A pre-existing group the edits act on, then a clean history so undo counts start at zero.
  s.addGroup('Billing', ['t2', 't3'])
  useCanvasStore.setState({ past: [], future: [] })
})

const groups = (): Array<{ name: string; boardIds: string[] }> =>
  useCanvasStore.getState().groups.map(({ name, boardIds }) => ({ name, boardIds }))

describe('applyGroups (MCP) — one undo step for every approved row', () => {
  it('creates the groups, returns their ids, and ONE undo removes them all', () => {
    const ack = apply([
      { name: 'Auth flow', boardIds: ['t1', 'b1'] },
      { name: 'Solo', boardIds: ['t3'] }
    ])
    expect(ack.ok).toBe(true)
    const ids = ack.ok ? (ack.groupIds ?? []) : []
    expect(ids).toHaveLength(2)
    const state = useCanvasStore.getState()
    expect(state.groups.filter((g) => ids.includes(g.id)).map((g) => g.name)).toEqual([
      'Auth flow',
      'Solo'
    ])
    expect(state.past).toHaveLength(1)
    state.undo()
    expect(groups()).toEqual([{ name: 'Billing', boardIds: ['t2', 't3'] }])
  })

  it('edits fold in order as ONE step, and one undo restores the group exactly', () => {
    const gid = useCanvasStore.getState().groups[0].id
    const ack = apply(
      [],
      [
        { op: 'rename', groupId: gid, name: 'Billing v2' },
        { op: 'add', groupId: gid, boardIds: ['t1'] },
        { op: 'remove', groupId: gid, boardIds: ['t3'] }
      ]
    )
    expect(ack).toEqual({ ok: true, type: 'applyGroups', groupIds: [] })
    expect(groups()).toEqual([{ name: 'Billing v2', boardIds: ['t2', 't1'] }])
    expect(useCanvasStore.getState().past).toHaveLength(1)
    useCanvasStore.getState().undo()
    expect(groups()).toEqual([{ name: 'Billing', boardIds: ['t2', 't3'] }])
  })

  it('create + ungroup in one command is still ONE undo step', () => {
    const gid = useCanvasStore.getState().groups[0].id
    apply([{ name: 'New', boardIds: ['t1'] }], [{ op: 'ungroup', groupId: gid }])
    expect(groups()).toEqual([{ name: 'New', boardIds: ['t1'] }])
    useCanvasStore.getState().undo()
    expect(groups()).toEqual([{ name: 'Billing', boardIds: ['t2', 't3'] }])
  })
})

describe('applyGroups (MCP) — 🔒 renderer re-validation, all-or-nothing', () => {
  const unchanged = (): void => {
    expect(groups()).toEqual([{ name: 'Billing', boardIds: ['t2', 't3'] }])
    expect(useCanvasStore.getState().past).toHaveLength(0)
  }

  it('an unknown or docked board anywhere refuses the WHOLE command', () => {
    for (const boardIds of [['t1', 'ghost'], ['t1', 'docked'], [], [42]]) {
      const ack = apply([
        { name: 'Fine', boardIds: ['t1'] },
        { name: 'Bad', boardIds: boardIds as string[] }
      ])
      expect(ack).toEqual({ ok: false, error: 'applyGroups: unknown or docked board in create[1]' })
      unchanged()
    }
  })

  it('a name the shared sanitizer would still change (tampered) is refused', () => {
    for (const name of ['', ' padded', 'bidi‮', 'x'.repeat(81), 7]) {
      const ack = apply([{ name: name as string, boardIds: ['t1'] }])
      expect(ack.ok).toBe(false)
      unchanged()
    }
  })

  it('an edit on an unknown group, or after this batch removed it, is refused', () => {
    const gid = useCanvasStore.getState().groups[0].id
    expect(apply([], [{ op: 'rename', groupId: 'nope', name: 'X' }]).ok).toBe(false)
    expect(
      apply(
        [],
        [
          { op: 'ungroup', groupId: gid },
          { op: 'rename', groupId: gid, name: 'X' }
        ]
      )
    ).toEqual({ ok: false, error: 'applyGroups: unknown group in edits[1]' })
    expect(
      apply(
        [],
        [
          { op: 'remove', groupId: gid, boardIds: ['t2', 't3'] },
          { op: 'add', groupId: gid, boardIds: ['t1'] }
        ]
      ).ok
    ).toBe(false)
    unchanged()
  })

  it('an off-enum op, a docked add or a malformed envelope is refused', () => {
    const gid = useCanvasStore.getState().groups[0].id
    expect(apply([], [{ op: 'explode', groupId: gid } as never]).ok).toBe(false)
    expect(apply([], [{ op: 'add', groupId: gid, boardIds: ['docked'] }]).ok).toBe(false)
    expect(apply([], []).ok).toBe(false)
    expect(
      applySpatialMcpCommand({ type: 'applyGroups', create: 'x', edits: [] } as never).ok
    ).toBe(false)
    unchanged()
  })

  it('removing a docked member from a group is allowed (cleanup)', () => {
    const gid = useCanvasStore.getState().groups[0].id
    useCanvasStore.setState((s) => ({
      groups: s.groups.map((g) => ({ ...g, boardIds: [...g.boardIds, 'docked'] }))
    }))
    expect(apply([], [{ op: 'remove', groupId: gid, boardIds: ['docked'] }]).ok).toBe(true)
    expect(groups()).toEqual([{ name: 'Billing', boardIds: ['t2', 't3'] }])
  })
})
