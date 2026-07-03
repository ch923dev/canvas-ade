import { describe, it, expect } from 'vitest'
import {
  computeRecapFacts,
  LAST_ASK_MAX_CHARS,
  TITLE_MAX_CHARS,
  FACT_LIST_MAX,
  COMMAND_LABEL_MAX,
  ERROR_EXCERPT_MAX,
  TODO_ACTIVE_MAX,
  AGENT_LABELS_MAX,
  type RecapFacts
} from './recapFacts'
import { IDLE_AFTER_MS, type TerminalRuntime } from './summaryLoop'

// ── fixture helpers ──────────────────────────────────────────────────────────
const T0 = Date.parse('2026-06-13T04:00:00.000Z')
const iso = (atSec: number): string => new Date(T0 + atSec * 1000).toISOString()
const line = (o: unknown): string => JSON.stringify(o)
const userLine = (text: string, atSec: number): string =>
  line({ type: 'user', timestamp: iso(atSec), message: { role: 'user', content: text } })
const asstLine = (content: unknown[], atSec: number): string =>
  line({ type: 'assistant', timestamp: iso(atSec), message: { role: 'assistant', content } })
const txt = (t: string): { type: string; text: string } => ({ type: 'text', text: t })
const tool = (
  name: string,
  input: Record<string, unknown> = {}
): { type: string; name: string; input: Record<string, unknown> } => ({
  type: 'tool_use',
  name,
  input
})
const jsonl = (...lines: string[]): string => lines.join('\n') + '\n'

const NOW = T0 + 600_000 // 10 min after session start
const running: TerminalRuntime = { state: 'running', lastActivityAt: NOW - 5_000 }

const facts = (
  tail: string,
  rt: TerminalRuntime | undefined = running,
  now: number = NOW
): RecapFacts => computeRecapFacts(tail, rt, now)

// ── basics ───────────────────────────────────────────────────────────────────
describe('computeRecapFacts basics', () => {
  it('empty input + no runtime -> sparse idle facts, never throws', () => {
    const f = computeRecapFacts('', undefined, NOW)
    expect(f).toEqual({
      v: 1,
      status: 'idle',
      live: false,
      turns: { user: 0, agent: 0 },
      files: [],
      commands: [],
      generatedAt: NOW
    })
  })

  it('skips malformed lines (incl. a partial tail-read first line) but keeps later ones', () => {
    const tail =
      '{"type":"assistant","message":{"role":"assist' + // partial first line
      '\nnot json at all\n' +
      userLine('hello', 10)
    const f = facts(tail)
    expect(f.turns).toEqual({ user: 1, agent: 0 })
    expect(f.lastAsk).toBe('hello')
  })

  it('extracts the session title from the LAST ai-title record', () => {
    const f = facts(
      jsonl(
        line({ type: 'ai-title', aiTitle: 'First title' }),
        userLine('go', 5),
        line({ type: 'ai-title', aiTitle: 'Second title' })
      )
    )
    expect(f.title).toBe('Second title')
  })

  it('caps an oversized ai-title record', () => {
    const longTitle = 'y'.repeat(TITLE_MAX_CHARS + 50)
    const f = facts(jsonl(line({ type: 'ai-title', aiTitle: longTitle })))
    expect(f.title).toBe('y'.repeat(TITLE_MAX_CHARS))
  })

  it('lastAsk prefers the last-prompt record, falls back to the last user turn, and is capped', () => {
    const withPrompt = facts(
      jsonl(userLine('typed ask', 5), line({ type: 'last-prompt', lastPrompt: 'recorded ask' }))
    )
    expect(withPrompt.lastAsk).toBe('recorded ask')

    const longAsk = 'x'.repeat(LAST_ASK_MAX_CHARS + 50)
    const fallback = facts(jsonl(userLine(longAsk, 5)))
    expect(fallback.lastAsk).toBe('x'.repeat(LAST_ASK_MAX_CHARS))
  })

  it('counts user TEXT turns only (tool_result-only records are plumbing) and agent turns once per record', () => {
    const toolResultOnly = line({
      type: 'user',
      timestamp: iso(20),
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
    })
    const f = facts(
      jsonl(
        userLine('do the thing', 10),
        asstLine([txt('on it'), tool('Bash', { command: 'ls', description: 'List' })], 15),
        toolResultOnly,
        asstLine([tool('Read', { file_path: 'a.ts' })], 25) // tool-only, still an agent turn
      )
    )
    expect(f.turns).toEqual({ user: 1, agent: 2 })
  })

  it('tracks sessionStart from the first timestamp and lastActivity from max(transcript, pty clock)', () => {
    const f = facts(jsonl(userLine('a', 0), userLine('b', 120)), {
      state: 'running',
      lastActivityAt: T0 + 300_000
    })
    expect(f.sessionStart).toBe(T0)
    expect(f.lastActivity).toBe(T0 + 300_000)

    const transcriptNewer = facts(jsonl(userLine('a', 0), userLine('b', 400)), {
      state: 'running',
      lastActivityAt: T0 + 300_000
    })
    expect(transcriptNewer.lastActivity).toBe(T0 + 400_000)
  })
})

// ── files + commands ─────────────────────────────────────────────────────────
describe('computeRecapFacts files + commands', () => {
  it('aggregates file edits by path; write is sticky over later edits; NotebookEdit uses notebook_path', () => {
    const f = facts(
      jsonl(
        asstLine([tool('Write', { file_path: 'new.ts' })], 10),
        asstLine([tool('Edit', { file_path: 'new.ts' })], 20),
        asstLine(
          [tool('Edit', { file_path: 'old.ts' }), tool('Edit', { file_path: 'old.ts' })],
          30
        ),
        asstLine([tool('NotebookEdit', { notebook_path: 'nb.ipynb' })], 40)
      )
    )
    expect(f.files).toEqual([
      { path: 'nb.ipynb', op: 'edit', count: 1 },
      { path: 'old.ts', op: 'edit', count: 2 },
      { path: 'new.ts', op: 'write', count: 2 }
    ])
  })

  it('labels commands by description, falls back to the command head, dedupes with counts', () => {
    const f = facts(
      jsonl(
        asstLine([tool('Bash', { command: 'pnpm test', description: 'Run tests' })], 10),
        asstLine([tool('Bash', { command: 'pnpm test -u', description: 'Run tests' })], 20),
        asstLine([tool('Bash', { command: 'git status --porcelain' })], 30)
      )
    )
    expect(f.commands).toEqual([
      { label: 'git status --porcelain', count: 1 },
      { label: 'Run tests', count: 2 }
    ])
  })

  it('caps a long tool_use description at COMMAND_LABEL_MAX, same as the fallback command head', () => {
    const longDescription = 'x'.repeat(COMMAND_LABEL_MAX + 50)
    const f = facts(
      jsonl(asstLine([tool('Bash', { command: 'ls', description: longDescription })], 10))
    )
    expect(f.commands).toEqual([{ label: 'x'.repeat(COMMAND_LABEL_MAX), count: 1 }])
  })

  it('caps files and commands at FACT_LIST_MAX, keeping the most recent', () => {
    const lines: string[] = []
    for (let i = 0; i < FACT_LIST_MAX + 4; i++) {
      lines.push(asstLine([tool('Edit', { file_path: `f${i}.ts` })], 10 + i))
    }
    const f = facts(jsonl(...lines))
    expect(f.files).toHaveLength(FACT_LIST_MAX)
    expect(f.files[0].path).toBe(`f${FACT_LIST_MAX + 3}.ts`) // newest first
    expect(f.files.some((x) => x.path === 'f0.ts')).toBe(false) // oldest dropped
  })
})

// ── status heuristic ─────────────────────────────────────────────────────────
describe('computeRecapFacts status', () => {
  it('waiting-on-you when the last event is an assistant question', () => {
    const f = facts(
      jsonl(userLine('clean up the docs', 10), asstLine([txt('Want me to run with that?')], 20))
    )
    expect(f.status).toBe('waiting-on-you')
  })

  it('NOT waiting when the only "?" sits before the question-tail window', () => {
    const text = 'is it ok? ' + 'x'.repeat(210) // "?" falls outside the last 200 chars
    const f = facts(jsonl(asstLine([txt(text)], 20)))
    expect(f.status).toBe('running') // recent activity, no open question
  })

  it('waiting-on-you on an AskUserQuestion tool_use with no later user turn; cleared by a user reply', () => {
    const pending = facts(
      jsonl(asstLine([txt('Pick a layout.'), tool('AskUserQuestion', { questions: [] })], 20))
    )
    expect(pending.status).toBe('waiting-on-you')

    const answered = facts(
      jsonl(
        asstLine([tool('AskUserQuestion', { questions: [] })], 20),
        userLine('option A', 30),
        asstLine([tool('Edit', { file_path: 'a.ts' })], 40)
      )
    )
    expect(answered.status).toBe('running')
  })

  it('a tool_result-only user record (the REAL AskUserQuestion answer) clears waiting + keeps live', () => {
    // In real Claude Code transcripts the answer to AskUserQuestion arrives as a tool_result
    // user record (no text block) → textFromContent === '' → the old code `continue`d before
    // clearing askPending, pinning status at waiting-on-you (live=false → Resume shown) while
    // the agent was actively working. Clearing the flag for ANY user record fixes it.
    const toolResult = line({
      type: 'user',
      timestamp: iso(30),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'option A' }]
      }
    })
    const f = facts(
      jsonl(
        asstLine([tool('AskUserQuestion', { questions: [] })], 20),
        toolResult,
        asstLine([tool('Edit', { file_path: 'a.ts' })], 40)
      )
    )
    expect(f.status).toBe('running') // not pinned at waiting-on-you
    expect(f.live).toBe(true) // Resume stays hidden while the agent works
    expect(f.turns.user).toBe(0) // a tool_result is plumbing, not a counted user turn
  })

  it('runtime exited / spawning / spawn-failed take precedence over the transcript heuristic', () => {
    const tail = jsonl(asstLine([txt('Should I continue?')], 20))
    const exited = facts(tail, { state: 'exited', exitCode: 1 })
    expect(exited.status).toBe('exited')
    expect(exited.exitCode).toBe(1)
    expect(facts(tail, { state: 'spawning' }).status).toBe('spawning')
    expect(facts(tail, { state: 'spawn-failed' }).status).toBe('spawn-failed')
  })

  it('live (Resume-gating) tracks AGENT activity, not the shell: running/spawning live; waiting/idle/exited not', () => {
    const active = jsonl(asstLine([txt('working on it')], 595)) // recent, no question
    const recentRt = { state: 'running' as const, lastActivityAt: NOW - 5_000 }
    expect(facts(active, recentRt).status).toBe('running')
    expect(facts(active, recentRt).live).toBe(true) // agent actively producing -> Resume hidden
    expect(facts(active, { state: 'spawning' }).live).toBe(true) // board starting up
    // A live shell whose agent ASKED then is quiet reads waiting -> NOT live -> Resume shows.
    const question = jsonl(asstLine([txt('Should I continue?')], 595))
    expect(facts(question, recentRt).status).toBe('waiting-on-you')
    expect(facts(question, recentRt).live).toBe(false)
    expect(facts(active, { state: 'exited', exitCode: 0 }).live).toBe(false)
    expect(facts(active, { state: 'spawn-failed' }).live).toBe(false)
  })

  it('running vs idle splits on IDLE_AFTER_MS over the merged activity clock', () => {
    const tail = jsonl(asstLine([tool('Edit', { file_path: 'a.ts' })], 0))
    const fresh = facts(tail, { state: 'running', lastActivityAt: NOW - IDLE_AFTER_MS + 1000 })
    expect(fresh.status).toBe('running')
    expect(fresh.live).toBe(true)
    const stale = facts(tail, { state: 'running', lastActivityAt: NOW - IDLE_AFTER_MS })
    expect(stale.status).toBe('idle')
    // KEY: a quiet (idle) board reads NOT live even though the SHELL is still running — so a
    // live shell whose agent has gone quiet/exited offers Resume. Liveness is the AGENT's
    // transcript activity, not the PTY lifecycle (the bug this guards against).
    expect(stale.live).toBe(false)
  })

  it('absent runtime = alive-unknown: transcript recency still yields running / waiting', () => {
    const recent = computeRecapFacts(jsonl(asstLine([txt('working on it')], 595)), undefined, NOW)
    expect(recent.status).toBe('running')
    const question = computeRecapFacts(jsonl(asstLine([txt('Which one?')], 595)), undefined, NOW)
    expect(question.status).toBe('waiting-on-you')
  })
})

// ── recap enrichment (P0-P2) ─────────────────────────────────────────────────
/** A user record carrying one tool_result block (the real transcript shape for tool replies). */
const resultLine = (content: unknown, atSec: number, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'user',
    timestamp: iso(atSec),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content, ...extra }]
    }
  })
/** A user tool-result record whose top-level toolUseResult carries an Edit/Write patch. */
const patchLine = (filePath: string, hunkLines: string[], atSec: number): string =>
  line({
    type: 'user',
    timestamp: iso(atSec),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]
    },
    toolUseResult: {
      filePath,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: hunkLines }]
    }
  })
const todoItem = (
  status: string,
  content: string,
  activeForm?: string
): Record<string, unknown> => ({ status, content, ...(activeForm ? { activeForm } : {}) })

describe('computeRecapFacts enrichment: todos (P0)', () => {
  it('reads done/total/active from the LAST TodoWrite (later entries win); activeForm preferred', () => {
    const f = facts(
      jsonl(
        asstLine([tool('TodoWrite', { todos: [todoItem('pending', 'a')] })], 10),
        asstLine(
          [
            tool('TodoWrite', {
              todos: [
                todoItem('completed', 'design'),
                todoItem('completed', 'parse'),
                todoItem('in_progress', 'wire registry', 'wiring terminalInputRegistry'),
                todoItem('pending', 'tests')
              ]
            })
          ],
          20
        )
      )
    )
    expect(f.todos).toEqual({ done: 2, total: 4, active: 'wiring terminalInputRegistry' })
  })

  it('falls back to content when the in-progress item has no activeForm; caps the label', () => {
    const long = 'y'.repeat(TODO_ACTIVE_MAX + 40)
    const f = facts(
      jsonl(asstLine([tool('TodoWrite', { todos: [todoItem('in_progress', long)] })], 10))
    )
    expect(f.todos?.active).toBe('y'.repeat(TODO_ACTIVE_MAX))
    expect(f.todos?.total).toBe(1)
    expect(f.todos?.done).toBe(0)
  })

  it('absent without a TodoWrite; malformed todos never throw; a later EMPTY list clears the plan', () => {
    expect(facts(jsonl(userLine('go', 5))).todos).toBeUndefined()
    expect(
      facts(jsonl(asstLine([tool('TodoWrite', { todos: 'not-an-array' })], 10))).todos
    ).toBeUndefined()
    const cleared = facts(
      jsonl(
        asstLine([tool('TodoWrite', { todos: [todoItem('pending', 'a')] })], 10),
        asstLine([tool('TodoWrite', { todos: [] })], 20)
      )
    )
    expect(cleared.todos).toBeUndefined()
  })
})

describe('computeRecapFacts enrichment: errors (P0)', () => {
  it('counts is_error tool_results only; last = the newest non-empty excerpt, whitespace-collapsed', () => {
    const f = facts(
      jsonl(
        resultLine('fine output', 10), // no is_error -> not counted
        resultLine('EACCES: denied', 20, { is_error: true }),
        resultLine('EBUSY: rename\n  locked file', 30, { is_error: true })
      )
    )
    expect(f.errors).toEqual({ count: 2, last: 'EBUSY: rename locked file' })
  })

  it('reads array-shaped tool_result content; an empty-content error still counts but keeps the previous last', () => {
    const f = facts(
      jsonl(
        resultLine([{ type: 'text', text: 'boom happened' }], 10, { is_error: true }),
        resultLine([], 20, { is_error: true })
      )
    )
    expect(f.errors).toEqual({ count: 2, last: 'boom happened' })
  })

  it('scrubs secrets from the excerpt and caps it at ERROR_EXCERPT_MAX', () => {
    const secret = facts(
      jsonl(resultLine('auth failed for sk-abc123DEF456ghi789jklMNO', 10, { is_error: true }))
    )
    expect(secret.errors?.last).toContain('[redacted]')
    expect(secret.errors?.last).not.toContain('sk-abc123DEF456ghi789jklMNO')

    // 'z' on purpose: an all-hex-chars run ('e'/'a'...) >= 40 chars is itself a redactSecrets
    // target (the long-hex-blob rule), which would collapse before the cap could apply.
    const long = facts(
      jsonl(resultLine('z'.repeat(ERROR_EXCERPT_MAX + 80), 10, { is_error: true }))
    )
    expect(long.errors?.last).toBe('z'.repeat(ERROR_EXCERPT_MAX))
    expect(facts(jsonl(userLine('all fine', 5))).errors).toBeUndefined()
  })
})

describe('computeRecapFacts enrichment: model / gitBranch / contextTokens (P0+P1)', () => {
  const asstMeta = (atSec: number, over: Record<string, unknown>): string =>
    line({
      type: 'assistant',
      timestamp: iso(atSec),
      ...(over.gitBranch !== undefined ? { gitBranch: over.gitBranch } : {}),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        ...(over.model !== undefined ? { model: over.model } : {}),
        ...(over.usage !== undefined ? { usage: over.usage } : {})
      }
    })

  it('model comes from the LATEST assistant metadata; non-strings ignored', () => {
    const f = facts(
      jsonl(asstMeta(10, { model: 'claude-opus-4-8' }), asstMeta(20, { model: 'claude-sonnet-5' }))
    )
    expect(f.model).toBe('claude-sonnet-5')
    expect(facts(jsonl(asstMeta(10, { model: 42 }))).model).toBeUndefined()
    expect(facts(jsonl(userLine('hi', 5))).model).toBeUndefined()
  })

  it('gitBranch reads the top-level record field on ANY record type; later wins', () => {
    const f = facts(
      jsonl(
        line({ type: 'user', gitBranch: 'main', message: { role: 'user', content: 'go' } }),
        asstMeta(20, { gitBranch: 'feat/voice-to-text' })
      )
    )
    expect(f.gitBranch).toBe('feat/voice-to-text')
    expect(facts(jsonl(userLine('hi', 5))).gitBranch).toBeUndefined()
  })

  it('contextTokens = LAST usage input + cache-read (a point metric); missing cache-read -> input only', () => {
    const f = facts(
      jsonl(
        asstMeta(10, { usage: { input_tokens: 9, cache_read_input_tokens: 1 } }),
        asstMeta(20, { usage: { input_tokens: 15_076, cache_read_input_tokens: 19_734 } })
      )
    )
    expect(f.contextTokens).toBe(34_810)
    expect(facts(jsonl(asstMeta(10, { usage: { input_tokens: 500 } }))).contextTokens).toBe(500)
    expect(
      facts(jsonl(asstMeta(10, { usage: { input_tokens: 'NaN-ish' } }))).contextTokens
    ).toBeUndefined()
    expect(facts(jsonl(userLine('hi', 5))).contextTokens).toBeUndefined()
  })
})

describe('computeRecapFacts enrichment: per-file adds/dels (P1)', () => {
  it('annotates the file entry from its structuredPatch and accumulates across results', () => {
    const f = facts(
      jsonl(
        asstLine([tool('Edit', { file_path: 'a.ts' })], 10),
        patchLine('a.ts', ['+one', '+two', '-gone', ' ctx'], 11),
        asstLine([tool('Edit', { file_path: 'a.ts' })], 20),
        patchLine('a.ts', ['+three'], 21)
      )
    )
    expect(f.files).toEqual([{ path: 'a.ts', op: 'edit', count: 2, adds: 3, dels: 1 }])
  })

  it('a result with no matching tool_use entry is dropped (never fabricates a phantom chip)', () => {
    const f = facts(jsonl(patchLine('orphan.ts', ['+x'], 10)))
    expect(f.files).toEqual([])
  })

  it('entries without a seen patch stay stat-less; malformed patches never throw', () => {
    const f = facts(
      jsonl(
        asstLine([tool('Edit', { file_path: 'plain.ts' })], 10),
        asstLine([tool('Edit', { file_path: 'bad.ts' })], 20),
        line({
          type: 'user',
          timestamp: iso(21),
          message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
          toolUseResult: { filePath: 'bad.ts', structuredPatch: [{ lines: 'not-an-array' }, null] }
        })
      )
    )
    expect(f.files).toEqual([
      { path: 'bad.ts', op: 'edit', count: 1 },
      { path: 'plain.ts', op: 'edit', count: 1 }
    ])
  })
})

describe('computeRecapFacts enrichment: agents (P2)', () => {
  it('counts Task spawns; labels deduped, recency-first, capped at AGENT_LABELS_MAX', () => {
    const f = facts(
      jsonl(
        asstLine([tool('Task', { description: 'explore auth' })], 10),
        asstLine([tool('Task', { description: 'review diff' })], 20),
        asstLine([tool('Task', { description: 'explore auth' })], 30),
        asstLine([tool('Task', { description: 'fix lints' })], 40),
        asstLine([tool('Task', { description: 'write docs' })], 50)
      )
    )
    expect(f.agents?.count).toBe(5)
    expect(f.agents?.labels).toEqual(['write docs', 'fix lints', 'explore auth'])
    expect(f.agents?.labels.length).toBeLessThanOrEqual(AGENT_LABELS_MAX)
  })

  it('absent without Task activity; a label-less Task still counts', () => {
    expect(facts(jsonl(userLine('go', 5))).agents).toBeUndefined()
    const f = facts(jsonl(asstLine([tool('Task', {})], 10)))
    expect(f.agents).toEqual({ count: 1, labels: [] })
  })
})

describe('computeRecapFacts enrichment: truncated-tail robustness', () => {
  it('a partial first line carrying every new field is dropped: fields absent, never a throw', () => {
    const full = line({
      type: 'assistant',
      timestamp: iso(10),
      gitBranch: 'feat/x',
      toolUseResult: { filePath: 'a.ts', structuredPatch: [{ lines: ['+x'] }] },
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 10, cache_read_input_tokens: 5 },
        content: [
          tool('TodoWrite', { todos: [todoItem('in_progress', 'a')] }),
          tool('Task', { description: 'sub' }),
          { type: 'tool_result', is_error: true, content: 'err' }
        ]
      }
    })
    // Simulate the tail read starting mid-record: the head half of the line is gone.
    const truncated = full.slice(Math.floor(full.length / 2)) + '\n' + userLine('hello', 20)
    const f = facts(truncated)
    expect(f.turns).toEqual({ user: 1, agent: 0 })
    expect(f.todos).toBeUndefined()
    expect(f.errors).toBeUndefined()
    expect(f.model).toBeUndefined()
    expect(f.gitBranch).toBeUndefined()
    expect(f.contextTokens).toBeUndefined()
    expect(f.agents).toBeUndefined()
    expect(f.files).toEqual([])
  })
})
