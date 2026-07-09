import { describe, it, expect } from 'vitest'
import {
  classifyHookEvent,
  parseLifecycleLine,
  createLifecycleScanner,
  lifecycleTitle,
  lifecycleBody,
  type LifecycleSignal
} from './agentLifecycle'

describe('lifecycleTitle', () => {
  it('folds the agent name into each event phrase', () => {
    expect(lifecycleTitle('done', 'claude')).toBe('Task done — claude')
    expect(lifecycleTitle('needs-input', 'claude')).toBe('claude needs your input')
    expect(lifecycleTitle('error', 'claude')).toBe('claude hit an error')
  })
  it('falls back to "agent" when the agent is unknown/blank', () => {
    expect(lifecycleTitle('done')).toBe('Task done — agent')
    expect(lifecycleTitle('needs-input', '  ')).toBe('agent needs your input')
  })
})

describe('lifecycleBody', () => {
  it('joins board title and detail on " · "', () => {
    expect(lifecycleBody('Backend', 'my-app')).toBe('Backend · my-app')
  })
  it('keeps whichever part is present', () => {
    expect(lifecycleBody('Backend', '')).toBe('Backend')
    expect(lifecycleBody(undefined, 'my-app')).toBe('my-app')
  })
  it('falls back to a click hint when both parts are empty', () => {
    expect(lifecycleBody()).toBe('Click to open the board')
    expect(lifecycleBody('', '  ')).toBe('Click to open the board')
  })
})

describe('classifyHookEvent', () => {
  it('maps Stop to done', () => {
    expect(classifyHookEvent('Stop')).toBe('done')
  })
  it('maps Notification to needs-input', () => {
    expect(classifyHookEvent('Notification')).toBe('needs-input')
  })
  it('does NOT treat SubagentStop as a lifecycle event (mid-run subagent, not task done)', () => {
    expect(classifyHookEvent('SubagentStop')).toBeNull()
  })
  it('returns null for non-lifecycle events', () => {
    expect(classifyHookEvent('SessionStart')).toBeNull()
    expect(classifyHookEvent('UserPromptSubmit')).toBeNull()
    expect(classifyHookEvent('')).toBeNull()
  })
})

describe('parseLifecycleLine', () => {
  const line = (o: Record<string, unknown>): string => JSON.stringify(o)

  it('parses a Stop line into a done signal with cwd', () => {
    const sig = parseLifecycleLine(line({ boardId: 'b1', hookEvent: 'Stop', cwd: '/home/me/proj' }))
    expect(sig).toEqual<LifecycleSignal>({ boardId: 'b1', event: 'done', cwd: '/home/me/proj' })
  })
  it('defaults cwd to empty string when absent', () => {
    expect(parseLifecycleLine(line({ boardId: 'b1', hookEvent: 'Notification' }))).toEqual({
      boardId: 'b1',
      event: 'needs-input',
      cwd: ''
    })
  })
  it('skips non-lifecycle events, blank lines, malformed JSON, and missing boardId', () => {
    expect(parseLifecycleLine(line({ boardId: 'b1', hookEvent: 'SessionStart' }))).toBeNull()
    expect(parseLifecycleLine('   ')).toBeNull()
    expect(parseLifecycleLine('{not json')).toBeNull()
    expect(parseLifecycleLine(line({ hookEvent: 'Stop' }))).toBeNull()
    expect(parseLifecycleLine(line({ boardId: '', hookEvent: 'Stop' }))).toBeNull()
  })
})

describe('createLifecycleScanner', () => {
  const stop = (id: string): string => JSON.stringify({ boardId: id, hookEvent: 'Stop', cwd: '/p' })
  const notif = (id: string): string =>
    JSON.stringify({ boardId: id, hookEvent: 'Notification', cwd: '/p' })

  it('baselines to existing history on first scan (no boot replay)', () => {
    const s = createLifecycleScanner()
    expect(s.scan(`${stop('old')}\n${notif('old')}\n`, 1000)).toEqual([])
  })

  it('emits only lines appended after the baseline', () => {
    const s = createLifecycleScanner()
    s.scan(`${stop('old')}\n`, 1000)
    const out = s.scan(`${stop('old')}\n${notif('b2')}\n`, 2000)
    expect(out).toEqual([{ boardId: 'b2', event: 'needs-input', cwd: '/p' }])
  })

  it('dedupes a (boardId, event) burst within the window', () => {
    const s = createLifecycleScanner(2000)
    s.scan('', 0)
    // Two rapid turn-end Stops for the same board arrive together → one emit.
    const burst = `${stop('b1')}\n${stop('b1')}\n`
    expect(s.scan(burst, 100)).toEqual([{ boardId: 'b1', event: 'done', cwd: '/p' }])
  })

  it('re-emits the same (boardId, event) once the window has passed', () => {
    const s = createLifecycleScanner(2000)
    s.scan('', 0)
    expect(s.scan(`${stop('b1')}\n`, 100)).toHaveLength(1)
    expect(s.scan(`${stop('b1')}\n${stop('b1')}\n`, 5000)).toHaveLength(1)
  })

  it('re-baselines on a shrink (prune) instead of replaying', () => {
    const s = createLifecycleScanner()
    s.scan(`${stop('a')}\n${stop('b')}\n${stop('c')}\n`, 0)
    // File rewritten smaller (consent-decline prune) — must not replay the survivors.
    expect(s.scan(`${stop('a')}\n`, 1000)).toEqual([])
    // A genuinely new append after the shrink still emits.
    expect(s.scan(`${stop('a')}\n${notif('d')}\n`, 2000)).toEqual([
      { boardId: 'd', event: 'needs-input', cwd: '/p' }
    ])
  })
})
