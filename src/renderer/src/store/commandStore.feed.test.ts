/**
 * The P4 external-worker feed inside `commandStore`.
 *
 * The single most important case here is `externalTaskFor`'s NEWEST-FIRST scan. A worker board is
 * reused across tasks, and a finished task keeps its group — so a first-match scan pins every later
 * report onto that board's first-ever task. That exact bug was a live `[critical]` in S2 and the
 * root of S3's `[critical]`; this suite is the third lane refusing to ship it again.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_FED_TASKS } from '../../../shared/commandFeedTypes'
import {
  commandStoreDefaults,
  evictFedTasks,
  externalTaskFor,
  feedStateToStatus,
  useCommandStore,
  type CommandTask
} from './commandStore'

const B = 'worker-board-1'
const reset = (): void => useCommandStore.setState(commandStoreDefaults())
const fed = (): CommandTask[] => useCommandStore.getState().tasks.filter((t) => t.external === true)
const task = (over: Partial<CommandTask> & { id: string }): CommandTask => ({
  title: 't',
  status: 'done',
  ...over
})

beforeEach(reset)

describe('feedStateToStatus', () => {
  it('maps the lifecycle states straight through', () => {
    for (const s of ['routing', 'executing', 'reporting', 'done', 'failed'] as const) {
      expect(feedStateToStatus(s)).toBe(s)
    }
  })

  it('🔒 lands `blocked` in `executing`, NOT a sixth column', () => {
    // The column axis is lifecycle, and a blocked worker is still executing — it just cannot
    // proceed. A sixth column would strand a finished-but-blocked worker outside Done and make
    // every column count lie.
    expect(feedStateToStatus('blocked')).toBe('executing')
  })
})

describe('externalTaskFor', () => {
  it('returns undefined when the board has no task', () => {
    expect(externalTaskFor([], B)).toBeUndefined()
    expect(
      externalTaskFor([task({ id: 'a', group: { groupId: 'g', terminalId: 'other' } })], B)
    ).toBeUndefined()
  })

  it('🔒 scans NEWEST-first, so a reused board resolves to its LATEST task', () => {
    const tasks = [
      task({ id: 'first', status: 'done', group: { groupId: 'g1', terminalId: B } }),
      task({ id: 'second', status: 'done', group: { groupId: 'g2', terminalId: B } })
    ]
    // A first-match scan would answer `first` forever: task 2's result would overwrite task 1's
    // while task 2 itself never left in-flight. This is the S2/S3 `[critical]` shape.
    expect(externalTaskFor(tasks, B)?.id).toBe('second')
  })

  it('prefers an OPEN task over a newer settled one', () => {
    const tasks = [
      task({ id: 'open', status: 'executing', group: { groupId: 'g1', terminalId: B } }),
      task({ id: 'settled', status: 'done', group: { groupId: 'g2', terminalId: B } })
    ]
    expect(externalTaskFor(tasks, B)?.id).toBe('open')
  })

  it('still finds the newest SETTLED task when none is open (a re-report)', () => {
    const tasks = [
      task({ id: 'old', status: 'failed', group: { groupId: 'g1', terminalId: B } }),
      task({ id: 'new', status: 'done', group: { groupId: 'g2', terminalId: B } })
    ]
    expect(externalTaskFor(tasks, B)?.id).toBe('new')
  })
})

describe('applyFeed', () => {
  it('creates a fed task on the first push, marked external and keyed by board id', () => {
    useCommandStore.getState().applyFeed({ boardId: B, state: 'executing' }, 'reviewer-1')
    const [t] = fed()
    expect(t).toMatchObject({ title: 'reviewer-1', status: 'executing', external: true })
    expect(t.group?.terminalId).toBe(B)
  })

  it('a bare result push (no state) parks the card in `reporting`, not done', () => {
    useCommandStore
      .getState()
      .applyFeed({ boardId: B, result: { summary: '3 findings' } }, 'reviewer-1')
    expect(fed()[0].status).toBe('reporting')
  })

  it('UPDATES the same card on the next push instead of opening a second one', () => {
    const s = useCommandStore.getState()
    s.applyFeed({ boardId: B, state: 'executing' }, 'reviewer-1')
    s.applyFeed({ boardId: B, state: 'done', result: { summary: 'ok' } }, 'reviewer-1')
    expect(fed()).toHaveLength(1)
    expect(fed()[0]).toMatchObject({ status: 'done', result: { summary: 'ok' } })
  })

  it('🔒 an absent field means UNCHANGED — a status push cannot wipe a reported result', () => {
    const s = useCommandStore.getState()
    s.applyFeed({ boardId: B, state: 'reporting', result: { summary: 'kept' } }, 'w')
    s.applyFeed({ boardId: B, state: 'done' }, 'w')
    expect(fed()[0].result).toEqual({ summary: 'kept' })
  })

  it('stamps finishedAt only on a terminal state (the recap TIMELINE sorts on it)', () => {
    const s = useCommandStore.getState()
    s.applyFeed({ boardId: B, state: 'executing' }, 'w')
    expect(fed()[0].finishedAt).toBeUndefined()
    s.applyFeed({ boardId: B, state: 'failed' }, 'w')
    expect(fed()[0].finishedAt).toBeGreaterThan(0)
  })

  it('carries the blocked tag only while blocked, and clears it on the next state', () => {
    const s = useCommandStore.getState()
    s.applyFeed({ boardId: B, state: 'blocked', blockedTag: 'needs_input' }, 'w')
    expect(fed()[0]).toMatchObject({ status: 'executing', blockedTag: 'needs_input' })
    // A stale reason must never outlive the block it described.
    s.applyFeed({ boardId: B, state: 'executing', blockedTag: 'needs_input' }, 'w')
    expect(fed()[0].blockedTag).toBeUndefined()
  })

  it('replaces the disclosure line each push (it describes THIS push, not history)', () => {
    const s = useCommandStore.getState()
    s.applyFeed({ boardId: B, state: 'reporting', disclose: 'unrecognized status "x"' }, 'w')
    expect(fed()[0].disclose).toBe('unrecognized status "x"')
    s.applyFeed({ boardId: B, state: 'done' }, 'w')
    expect(fed()[0].disclose).toBeUndefined()
  })

  it('🔒 REFUSES to touch a locally dispatched task on the same board', () => {
    // The local pump owns that task (it is parked on awaitSettled); a fed status would race it.
    // The fed half of the board is strictly additive to what the human dispatched here.
    useCommandStore.setState({
      tasks: [task({ id: 'local', status: 'executing', group: { groupId: 'g', terminalId: B } })]
    })
    useCommandStore.getState().applyFeed({ boardId: B, state: 'done' }, 'w')
    expect(useCommandStore.getState().tasks).toHaveLength(1)
    expect(useCommandStore.getState().tasks[0]).toMatchObject({ id: 'local', status: 'executing' })
  })
})

describe('evictFedTasks (the feed cap)', () => {
  const fedTask = (id: string, status: CommandTask['status']): CommandTask =>
    task({ id, status, external: true, group: { groupId: id, terminalId: id } })

  it('does nothing while under the cap', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => fedTask(`f${i}`, 'done'))
    expect(evictFedTasks(tasks)).toEqual({ tasks, dropped: 0 })
  })

  it('evicts the OLDEST SETTLED fed tasks once over the cap', () => {
    const tasks = Array.from({ length: MAX_FED_TASKS + 3 }, (_, i) => fedTask(`f${i}`, 'done'))
    const out = evictFedTasks(tasks)
    expect(out.dropped).toBe(3)
    expect(out.tasks).toHaveLength(MAX_FED_TASKS)
    expect(out.tasks.map((t) => t.id)).not.toContain('f0')
    expect(out.tasks.map((t) => t.id)).toContain(`f${MAX_FED_TASKS + 2}`)
  })

  it('🔒 never evicts a LIVE fed worker — dropping one erases the thing the board exists to show', () => {
    const live = Array.from({ length: MAX_FED_TASKS + 5 }, (_, i) => fedTask(`f${i}`, 'executing'))
    expect(evictFedTasks(live)).toEqual({ tasks: live, dropped: 0 })
  })

  it('never evicts a LOCALLY dispatched task — the human owns those', () => {
    const locals = Array.from({ length: 10 }, (_, i) => task({ id: `l${i}`, status: 'done' }))
    const feds = Array.from({ length: MAX_FED_TASKS + 2 }, (_, i) => fedTask(`f${i}`, 'done'))
    const out = evictFedTasks([...locals, ...feds])
    expect(out.dropped).toBe(2)
    expect(out.tasks.filter((t) => !t.external)).toHaveLength(10)
  })

  it('the store counts every drop, so the board can DISCLOSE the cap', () => {
    // A silently-capped feed is worse than no feed: absence reads as "nothing happened".
    const s = useCommandStore.getState()
    for (let i = 0; i < MAX_FED_TASKS + 4; i++) {
      s.applyFeed({ boardId: `b${i}`, state: 'done' }, `w${i}`)
    }
    expect(useCommandStore.getState().fedDropped).toBe(4)
    expect(fed()).toHaveLength(MAX_FED_TASKS)
  })

  it('clearTasks resets the drop count with its subject', () => {
    useCommandStore.setState({ fedDropped: 7 })
    useCommandStore.getState().clearTasks()
    expect(useCommandStore.getState().fedDropped).toBe(0)
  })
})
