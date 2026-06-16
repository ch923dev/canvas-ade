import { describe, it, expect } from 'vitest'
import { routingEdges } from './routingEdges'
import { createBoard, type Board } from './boardSchema'
import type { CommandTask, TaskStatus, TaskGroup } from '../store/commandStore'

/** A canvas with the singleton Command board + the worker boards a group can spawn. */
const boards = (): Board[] => [
  createBoard('command', { id: 'cmd', x: 0, y: 0 }),
  createBoard('terminal', { id: 't1', x: 800, y: 0 }),
  createBoard('planning', { id: 'p1', x: 800, y: 600 }),
  createBoard('browser', { id: 'b1', x: 1600, y: 0 })
]

const task = (id: string, status: TaskStatus, group?: TaskGroup): CommandTask => ({
  id,
  title: id,
  status,
  group
})

describe('routingEdges', () => {
  it('draws an edge from the Command board to each present group member of an in-flight task', () => {
    const out = routingEdges(
      [task('task-1', 'executing', { groupId: 'g1', terminalId: 't1', planningId: 'p1' })],
      boards()
    )
    expect(out).toEqual([
      {
        id: 'routing-task-1-t1',
        source: 'cmd',
        target: 't1',
        type: 'routing',
        data: { phase: 'executing' }
      },
      {
        id: 'routing-task-1-p1',
        source: 'cmd',
        target: 'p1',
        type: 'routing',
        data: { phase: 'executing' }
      }
    ])
  })

  it('carries the lifecycle phase (routing renders fainter than executing)', () => {
    const out = routingEdges(
      [task('task-1', 'routing', { groupId: 'g', terminalId: 't1' })],
      boards()
    )
    expect(out).toEqual([
      {
        id: 'routing-task-1-t1',
        source: 'cmd',
        target: 't1',
        type: 'routing',
        data: { phase: 'routing' }
      }
    ])
  })

  it('ignores tasks that are not in flight (queued / reporting / done / failed)', () => {
    const grp: TaskGroup = { groupId: 'g', terminalId: 't1' }
    const tasks = [
      task('a', 'queued', grp),
      task('b', 'reporting', grp),
      task('c', 'done', grp),
      task('d', 'failed', grp)
    ]
    expect(routingEdges(tasks, boards())).toEqual([])
  })

  it('skips an in-flight task that has not been assigned a group yet', () => {
    expect(routingEdges([task('task-1', 'routing')], boards())).toEqual([])
  })

  it('skips a member board that is no longer on the canvas (dangling — no half-edge)', () => {
    const out = routingEdges(
      [task('task-1', 'executing', { groupId: 'g', terminalId: 't1', browserId: 'gone' })],
      boards()
    )
    expect(out.map((e) => e.target)).toEqual(['t1'])
  })

  it('returns no edges when there is no Command board on the canvas', () => {
    const noCommand = boards().filter((b) => b.type !== 'command')
    expect(
      routingEdges([task('task-1', 'executing', { groupId: 'g', terminalId: 't1' })], noCommand)
    ).toEqual([])
  })

  it('returns an empty array for no tasks', () => {
    expect(routingEdges([], boards())).toEqual([])
  })
})
