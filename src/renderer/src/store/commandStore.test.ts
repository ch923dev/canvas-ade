import { describe, it, expect, beforeEach } from 'vitest'
import {
  useCommandStore,
  commandStoreDefaults,
  tasksInColumn,
  type CommandTask,
  type TaskStatus
} from './commandStore'

beforeEach(() => {
  // The store is a global singleton (one orchestrator face) — reset to defaults per test.
  useCommandStore.setState(commandStoreDefaults())
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

describe('commandStore — dispatch fields (Phase C)', () => {
  const get = (): ReturnType<typeof useCommandStore.getState> => useCommandStore.getState()

  it('addTask stores the requested composition (omitted ⇒ undefined = terminal-only)', () => {
    const a = get().addTask('plain')!
    const b = get().addTask('rich', { planning: true, browser: true })!
    const tasks = get().tasks
    expect(tasks.find((t) => t.id === a)?.composition).toBeUndefined()
    expect(tasks.find((t) => t.id === b)?.composition).toEqual({ planning: true, browser: true })
  })

  it('setTaskGroup attaches the spawned worker group', () => {
    const id = get().addTask('x')!
    get().setTaskGroup(id, { groupId: 'g', terminalId: 't', planningId: 'p' })
    expect(get().tasks[0].group).toEqual({ groupId: 'g', terminalId: 't', planningId: 'p' })
  })

  it('retryTask clears the old group so the dispatch pump re-spawns a fresh one', () => {
    const id = get().addTask('x')!
    get().setTaskGroup(id, { groupId: 'g', terminalId: 't' })
    get().setTaskStatus(id, 'failed')
    get().retryTask(id)
    expect(get().tasks[0].status).toBe('queued')
    expect(get().tasks[0].group).toBeUndefined()
  })
})

describe('commandStore — config dialog (C2d)', () => {
  const get = (): ReturnType<typeof useCommandStore.getState> => useCommandStore.getState()

  it('setTaskPrompt stores the engineered prompt + smart zone name', () => {
    const id = get().addTask('do an indepth review')!
    get().setTaskPrompt(id, 'Analyze the repo and summarize it.', 'Project Analysis')
    expect(get().tasks[0].prompt).toBe('Analyze the repo and summarize it.')
    expect(get().tasks[0].zoneName).toBe('Project Analysis')
  })

  it('setConfiguring sets and clears the single-at-a-time dialog lock', () => {
    const id = get().addTask('x')!
    get().setConfiguring(id)
    expect(get().configuringTaskId).toBe(id)
    get().setConfiguring(null)
    expect(get().configuringTaskId).toBeNull()
  })

  it('setTaskConfig commits the chosen launchCommand + the edited prompt (marks ready)', () => {
    const id = get().addTask('x')!
    get().setTaskPrompt(id, 'engineered', 'Zone')
    expect(get().tasks[0].launchCommand).toBeUndefined() // not yet dispatchable
    get().setTaskConfig(id, { launchCommand: 'claude --yolo', prompt: 'edited' })
    expect(get().tasks[0].launchCommand).toBe('claude --yolo')
    expect(get().tasks[0].prompt).toBe('edited')
  })

  it('setLastWorkerConfig remembers the config to pre-fill the next dispatch', () => {
    const cfg = { presetId: 'codex', values: { 'full-auto': true }, rawOverride: null }
    get().setLastWorkerConfig(cfg)
    expect(get().lastWorkerConfig).toEqual(cfg)
  })

  it('retryTask KEEPS the launchCommand + prompt so the retry reuses the config', () => {
    const id = get().addTask('x')!
    get().setTaskConfig(id, { launchCommand: 'claude --yolo', prompt: 'go' })
    get().setTaskGroup(id, { groupId: 'g', terminalId: 't' })
    get().setTaskStatus(id, 'failed')
    get().retryTask(id)
    expect(get().tasks[0].status).toBe('queued')
    expect(get().tasks[0].group).toBeUndefined()
    expect(get().tasks[0].launchCommand).toBe('claude --yolo') // config preserved
    expect(get().tasks[0].prompt).toBe('go')
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
