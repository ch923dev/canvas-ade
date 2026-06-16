import { describe, it, expect, beforeEach } from 'vitest'
import { useCommandStore, tasksInColumn, type CommandTask, type TaskStatus } from './commandStore'

beforeEach(() => {
  // The store is a global singleton (one orchestrator face) — reset to defaults per test.
  useCommandStore.setState({ tasks: [], view: 'kanban', collapsed: false, expandedHeight: null })
})

describe('commandStore', () => {
  it('defaults to an empty kanban, expanded', () => {
    const s = useCommandStore.getState()
    expect(s.tasks).toEqual([])
    expect(s.view).toBe('kanban')
    expect(s.collapsed).toBe(false)
    expect(s.expandedHeight).toBeNull()
  })

  it('setView switches the seg selection', () => {
    useCommandStore.getState().setView('groups')
    expect(useCommandStore.getState().view).toBe('groups')
  })

  it('setCollapsed(true, h) collapses and remembers the expanded height', () => {
    useCommandStore.getState().setCollapsed(true, 440)
    expect(useCommandStore.getState().collapsed).toBe(true)
    expect(useCommandStore.getState().expandedHeight).toBe(440)
  })

  it('setCollapsed(false) keeps the remembered height for the next expand', () => {
    useCommandStore.getState().setCollapsed(true, 440)
    useCommandStore.getState().setCollapsed(false)
    expect(useCommandStore.getState().collapsed).toBe(false)
    expect(useCommandStore.getState().expandedHeight).toBe(440)
  })
})

describe('commandStore — task lifecycle (Phase B)', () => {
  const get = (): ReturnType<typeof useCommandStore.getState> => useCommandStore.getState()

  it('addTask enqueues a queued task and returns its id', () => {
    const id = get().addTask('Build the auth flow')
    expect(id).toBeTruthy()
    expect(get().tasks).toEqual([{ id, title: 'Build the auth flow', status: 'queued' }])
  })

  it('addTask trims the title and ignores a blank one (returns null, no task)', () => {
    expect(get().addTask('   ')).toBeNull()
    expect(get().tasks).toHaveLength(0)
    const id = get().addTask('  spaced  ')
    expect(get().tasks[0]).toMatchObject({ id, title: 'spaced', status: 'queued' })
  })

  it('setTaskStatus moves a task to a new lifecycle status', () => {
    const id = get().addTask('x')!
    get().setTaskStatus(id, 'executing')
    expect(get().tasks[0].status).toBe('executing')
  })

  it('retryTask re-queues a failed task only (no-op otherwise)', () => {
    const id = get().addTask('x')!
    get().setTaskStatus(id, 'failed')
    get().retryTask(id)
    expect(get().tasks[0].status).toBe('queued')
    get().setTaskStatus(id, 'executing')
    get().retryTask(id) // not failed → unchanged
    expect(get().tasks[0].status).toBe('executing')
  })

  it('clearTasks empties the queue', () => {
    get().addTask('a')
    get().addTask('b')
    get().clearTasks()
    expect(get().tasks).toEqual([])
  })
})

describe('tasksInColumn (failed → Done bucketing)', () => {
  const T = (status: TaskStatus): CommandTask => ({ id: status, title: status, status })
  const tasks = [T('queued'), T('routing'), T('executing'), T('reporting'), T('done'), T('failed')]

  it('returns the tasks whose status matches the column', () => {
    expect(tasksInColumn(tasks, 'queued').map((t) => t.id)).toEqual(['queued'])
    expect(tasksInColumn(tasks, 'executing').map((t) => t.id)).toEqual(['executing'])
  })

  it('buckets failed tasks into the Done column (no column of their own)', () => {
    expect(
      tasksInColumn(tasks, 'done')
        .map((t) => t.id)
        .sort()
    ).toEqual(['done', 'failed'])
  })
})
