import { describe, it, expect } from 'vitest'
import {
  slotsFor,
  compositionOf,
  inFlightSlots,
  canDispatch,
  nextQueuedTask,
  memberTags,
  isFailureResult,
  isCapError,
  isWorkerNotReady,
  nextStatusForBoardChange,
  parseEngineeredDispatch,
  fallbackTitle,
  DEFAULT_COMPOSITION
} from './commandDispatch'
import type { CommandTask, Composition, TaskStatus } from '../store/commandStore'

const task = (
  id: string,
  status: TaskStatus,
  composition?: Composition,
  group?: CommandTask['group']
): CommandTask => ({ id, title: id, status, composition, group })

describe('slotsFor', () => {
  it('counts the terminal (always) + each opt-in member', () => {
    expect(slotsFor({ planning: false, browser: false })).toBe(1)
    expect(slotsFor({ planning: true, browser: false })).toBe(2)
    expect(slotsFor({ planning: false, browser: true })).toBe(2)
    expect(slotsFor({ planning: true, browser: true })).toBe(3)
  })
})

describe('compositionOf', () => {
  it('defaults an unset composition to terminal-only', () => {
    expect(compositionOf({ composition: undefined })).toEqual(DEFAULT_COMPOSITION)
    expect(compositionOf({ composition: { planning: true, browser: true } })).toEqual({
      planning: true,
      browser: true
    })
  })
})

describe('inFlightSlots', () => {
  it('sums slots for routing + executing tasks only', () => {
    const tasks = [
      task('a', 'routing', { planning: true, browser: false }), // 2
      task('b', 'executing', { planning: false, browser: false }), // 1
      task('c', 'queued', { planning: true, browser: true }), // ignored
      task('d', 'done'), // ignored
      task('e', 'failed') // ignored
    ]
    expect(inFlightSlots(tasks)).toBe(3)
  })
})

describe('canDispatch', () => {
  it('admits a task while slots remain, rejects at/over the cap', () => {
    const inFlight = [task('a', 'executing', { planning: false, browser: false })] // 1 slot
    expect(canDispatch(inFlight, { planning: false, browser: false }, 4)).toBe(true) // 1+1≤4
    expect(canDispatch(inFlight, { planning: true, browser: true }, 4)).toBe(true) // 1+3≤4
    expect(canDispatch(inFlight, { planning: true, browser: true }, 3)).toBe(false) // 1+3>3
  })
})

describe('nextQueuedTask', () => {
  it('returns the oldest queued task without a group; skips spawned + non-queued', () => {
    const tasks = [
      task('a', 'done'),
      task('b', 'queued', undefined, { groupId: 'g', terminalId: 't' }), // already spawned
      task('c', 'queued'),
      task('d', 'queued')
    ]
    expect(nextQueuedTask(tasks)?.id).toBe('c')
    expect(nextQueuedTask([task('x', 'executing')])).toBeUndefined()
  })
})

describe('memberTags', () => {
  it('lists terminal always + planning/browser when present', () => {
    expect(memberTags(undefined)).toEqual([])
    expect(memberTags({ groupId: 'g', terminalId: 't' })).toEqual(['term'])
    expect(memberTags({ groupId: 'g', terminalId: 't', planningId: 'p' })).toEqual(['term', 'plan'])
    expect(memberTags({ groupId: 'g', terminalId: 't', browserId: 'b' })).toEqual(['term', 'brow'])
    expect(memberTags({ groupId: 'g', terminalId: 't', planningId: 'p', browserId: 'b' })).toEqual([
      'term',
      'plan',
      'brow'
    ])
  })
})

describe('isFailureResult', () => {
  it('is true only for an explicit failure/error verdict', () => {
    expect(isFailureResult({ status: 'failure' })).toBe(true)
    expect(isFailureResult({ status: 'error' })).toBe(true)
    expect(isFailureResult({ status: 'success' })).toBe(false)
    expect(isFailureResult({ present: true })).toBe(false)
    expect(isFailureResult(undefined)).toBe(false)
    expect(isFailureResult(null)).toBe(false)
  })
})

describe('isCapError', () => {
  it('matches the MAIN concurrency-cap rejection, not other errors', () => {
    expect(isCapError(new Error('MCP spawn concurrency cap reached (4 live spawned boards)'))).toBe(
      true
    )
    expect(isCapError(new Error('spawn_group failed: no-window'))).toBe(false)
    expect(isCapError('not an error')).toBe(false)
    expect(isCapError(undefined)).toBe(false)
  })
})

describe('fallbackTitle', () => {
  it('takes the first few words of a short task verbatim', () => {
    expect(fallbackTitle('add a login form')).toBe('add a login form')
    expect(fallbackTitle('do an indepth review on this project')).toBe('do an indepth review on')
  })
  it('clamps a long first-5-words run with an ellipsis', () => {
    const t = fallbackTitle('implement comprehensive authentication authorization middleware now')
    expect(t.endsWith('…')).toBe(true)
    expect(t.length).toBeLessThanOrEqual(41)
  })
  it('never empties', () => {
    expect(fallbackTitle('   ')).toBe('Task')
  })
})

describe('parseEngineeredDispatch', () => {
  it('splits a TITLE: line into the zone name + the instruction body', () => {
    const r = parseEngineeredDispatch(
      { ok: true, text: 'TITLE: Project Analysis\n\nAnalyze the codebase and summarize it.' },
      'do an indepth review'
    )
    expect(r.title).toBe('Project Analysis')
    expect(r.prompt).toBe('Analyze the codebase and summarize it.')
  })
  it('strips surrounding quotes + clamps an over-long title', () => {
    const r = parseEngineeredDispatch({ ok: true, text: 'TITLE: "Auth Flow"\n\ndo it' }, 'x')
    expect(r.title).toBe('Auth Flow')
  })
  it('treats a reply with no TITLE line as the whole instruction (title from the task)', () => {
    const r = parseEngineeredDispatch({ ok: true, text: 'Just do the thing.' }, 'fix login bug')
    expect(r.title).toBe('fix login bug')
    expect(r.prompt).toBe('Just do the thing.')
  })
  it('falls back entirely to the raw task when the LLM is unavailable / empty', () => {
    expect(parseEngineeredDispatch({ ok: false }, 'login')).toEqual({
      title: 'login',
      prompt: 'login'
    })
    expect(parseEngineeredDispatch(null, 'login')).toEqual({ title: 'login', prompt: 'login' })
    expect(parseEngineeredDispatch({ ok: true, text: '   ' }, 'login')).toEqual({
      title: 'login',
      prompt: 'login'
    })
  })
})

describe('isWorkerNotReady', () => {
  it('matches the pre-gate readiness failures, not a post-gate denial', () => {
    expect(isWorkerNotReady(new Error('handoff_prompt: board not found: abc'))).toBe(true)
    expect(isWorkerNotReady(new Error('handoff_prompt: target is not a terminal (browser)'))).toBe(
      true
    )
    expect(isWorkerNotReady(new Error('handoff_prompt: denied by user'))).toBe(false)
    expect(isWorkerNotReady(new Error('write failed'))).toBe(false)
  })
})

describe('nextStatusForBoardChange', () => {
  it('fails an in-flight task whose worker board went gone', () => {
    expect(nextStatusForBoardChange('routing', 'gone')).toBe('failed')
    expect(nextStatusForBoardChange('executing', 'gone')).toBe('failed')
  })
  it('does NOT auto-advance on raw idle/running (the settle verdict comes from handoffPrompt)', () => {
    expect(nextStatusForBoardChange('executing', 'idle')).toBeNull()
    expect(nextStatusForBoardChange('executing', 'running')).toBeNull()
  })
  it('ignores a gone for a task that is not in flight', () => {
    expect(nextStatusForBoardChange('queued', 'gone')).toBeNull()
    expect(nextStatusForBoardChange('done', 'gone')).toBeNull()
  })
})
