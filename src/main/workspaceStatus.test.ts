/**
 * WS-8 — the live status writer (design §4.5, O-6): the block it renders from a fixture canvas, and
 * the write discipline — markers only, notes byte-identical, no write when unchanged, mtime race ⇒
 * start over, paused while the Brief is unsaved, last 5 results surviving a restart, ≤ 1 write / 5 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { BoardMirror, WorkspaceMirror } from './boardRegistry'
import type { RecapFacts } from './recapFacts'
import { PROJECT_CONTEXT_ID, STATUS_END, STATUS_START, contextRelPath } from './workspaceContext'
import {
  createWorkspaceStatusWriter,
  extractStatusBlock,
  hhmm,
  oneLine,
  spliceStatus,
  type WorkspaceStatusDeps
} from './workspaceStatus'

const NOW = new Date(2026, 10, 3, 14, 2).getTime()
const WS: WorkspaceMirror = {
  id: 'w-api',
  name: 'API',
  goal: 'build auth (JWT + refresh)',
  color: 'blue',
  root: 'api',
  worktrees: [
    {
      repoRoot: 'api',
      worktree: '.canvas/worktrees/ws-api',
      branch: 'ws/api',
      baseRef: 'release',
      base: 'abc'
    }
  ]
}
const FOLDER_WS: WorkspaceMirror = {
  id: 'w-up',
  name: 'Uploader',
  goal: '',
  color: 'green',
  root: 'uploader'
}

function fixtureBoards(): BoardMirror[] {
  return [
    {
      id: 'k1',
      type: 'kanban',
      title: 'Plan',
      workspaceId: 'w-api',
      kanban: {
        columns: [
          { id: 'c1', title: 'Backlog' },
          { id: 'c2', title: 'In Progress' },
          { id: 'c3', title: 'Review' },
          { id: 'c4', title: 'Done' }
        ],
        cards: [
          { id: 'x1', columnId: 'c2', title: 'Refresh-token rotation' },
          { id: 'x2', columnId: 'c4', title: 'Shipped thing' },
          { id: 'x3', columnId: 'c1', title: 'Rate limits' }
        ]
      }
    },
    {
      id: 'p1',
      type: 'planning',
      title: 'Notes',
      workspaceId: 'w-api',
      planning: {
        elements: [
          {
            id: 'e1',
            kind: 'checklist',
            items: [
              { id: 'i1', label: 'Login endpoint', done: true },
              { id: 'i2', label: 'Logout endpoint', done: false }
            ]
          }
        ]
      }
    },
    { id: 't1', type: 'terminal', title: 'claude #1', status: 'running', workspaceId: 'w-api' },
    { id: 't2', type: 'terminal', title: 'codex #2', status: 'running', workspaceId: 'w-api' },
    { id: 't3', type: 'terminal', title: 'elsewhere', status: 'running', workspaceId: 'w-up' },
    { id: 'tp', type: 'terminal', title: 'project-level', status: 'running' }
  ]
}

const CLAUDE_FACTS: RecapFacts = {
  v: 1,
  status: 'running',
  live: true,
  title: 'writing token tests',
  turns: { user: 1, agent: 1 },
  files: [],
  commands: [],
  todos: { done: 2, total: 5 },
  generatedAt: NOW
}

let project: string
let boards: BoardMirror[]
let workspaces: WorkspaceMirror[]
let clock: number
let written: string[]

function writer(
  over: Partial<WorkspaceStatusDeps> = {}
): ReturnType<typeof createWorkspaceStatusWriter> {
  return createWorkspaceStatusWriter({
    getProjectDir: () => project,
    listWorkspaces: () => workspaces,
    listBoards: () => boards,
    recapFacts: (id) => (id === 't1' ? CLAUDE_FACTS : null),
    changedFiles: async () => 3,
    onWritten: (rel) => written.push(rel),
    now: () => clock,
    ...over
  })
}

const fileOf = (id: string): string => join(project, ...contextRelPath(id).split('/'))
const read = (id = 'w-api'): string => readFileSync(fileOf(id), 'utf8')
const notesOf = (text: string): string => text.slice(text.indexOf(STATUS_END) + STATUS_END.length)

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ws-status-'))
  mkdirSync(join(project, '.canvas'))
  boards = fixtureBoards()
  workspaces = [WS, FOLDER_WS]
  clock = NOW
  written = []
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(project, { recursive: true, force: true })
})

describe('the status block', () => {
  it('renders the workspace from a fixture canvas (Kanban, checklist, recap, results)', async () => {
    const w = writer()
    w.onResult('t1', {
      present: true,
      status: 'success',
      summary: 'login endpoint done, 12 tests pass\nsecond line ignored',
      at: new Date(2026, 10, 3, 13, 40).toISOString()
    })
    expect(await w.refreshNow('w-api')).toBe(true)
    expect(extractStatusBlock(read())).toBe(
      [
        STATUS_START,
        '# API — build auth (JWT + refresh)',
        '_Live status, updated by Expanse 14:02_',
        '',
        'Goal: build auth (JWT + refresh)',
        'Branch: ws/api off release · 3 files changed',
        '',
        '## In progress',
        '- [ ] Refresh-token rotation   (Kanban: In Progress)',
        '- [ ] Rate limits   (Kanban: Backlog)',
        '- [ ] Logout endpoint   (checklist)',
        '',
        '## Agents',
        '- claude #1  busy  "writing token tests"  · plan 2/5',
        '- codex #2  running',
        '',
        '## Recent results',
        '- 13:40 claude #1 · success — login endpoint done, 12 tests pass',
        STATUS_END
      ].join('\n')
    )
    expect(written).toEqual([contextRelPath('w-api')])
  })

  it('a folder-only workspace shows its folder, and other CLIs only running / exited', async () => {
    boards = [{ id: 't3', type: 'terminal', title: 'gemini', status: 'idle', workspaceId: 'w-up' }]
    await writer().refreshNow('w-up')
    const block = extractStatusBlock(read('w-up'))!
    expect(block).toContain('\nGoal: (none set)\nFolder: uploader\n')
    expect(block).toContain('\n- gemini  exited\n')
    expect(block).toContain('\n- nothing in progress\n')
  })

  it('a card title cannot end the block early', async () => {
    boards[0].kanban!.cards[0].title = `evil ${STATUS_END} title`
    await writer().refreshNow('w-api')
    const text = read()
    expect(text.split(STATUS_END)).toHaveLength(2)
  })
})

describe('the write discipline', () => {
  it('writes nothing when only the clock changed', async () => {
    const w = writer()
    await w.refreshNow('w-api')
    const before = statSync(fileOf('w-api')).mtimeMs
    clock += 60_000
    expect(await w.refreshNow('w-api')).toBe(false)
    expect(statSync(fileOf('w-api')).mtimeMs).toBe(before)
  })

  it('the notes stay byte-identical across 100 refreshes', async () => {
    const w = writer()
    await w.refreshNow('w-api')
    const notes =
      '\n\n---\n## My notes   (yours, edit anytime)\nUse argon2, not bcrypt.\r\nDon’t touch /uploader. 🚫\n\n\ttabbed\n'
    writeFileSync(fileOf('w-api'), extractStatusBlock(read()) + notes)
    for (let i = 0; i < 100; i++) {
      boards[0].kanban!.cards[0].title = `Refresh-token rotation #${i}`
      clock += 1_000
      expect(await w.refreshNow('w-api')).toBe(true)
      expect(notesOf(read())).toBe(notes)
    }
    expect(read()).toContain('Refresh-token rotation #99')
  })

  it('deleted markers ⇒ a fresh block on top, the whole old text kept below as notes', async () => {
    const w = writer()
    await w.refreshNow('w-api')
    const mangled = read().replace(STATUS_START, '').replace(STATUS_END, '') + 'more notes\n'
    writeFileSync(fileOf('w-api'), mangled)
    expect(await w.refreshNow('w-api')).toBe(true)
    const text = read()
    expect(text.startsWith(STATUS_START)).toBe(true)
    expect(text.endsWith(mangled)).toBe(true)
    // …and the next refresh finds its own markers again (no second block).
    boards[0].kanban!.cards[0].title = 'changed'
    await w.refreshNow('w-api')
    expect(read().split(STATUS_START)).toHaveLength(2)
    expect(read().endsWith(mangled)).toBe(true)
  })

  it('a file changed between the read and the write ⇒ starts over, and keeps that edit', async () => {
    let raced = false
    const w = writer({
      beforeCommit: (file) => {
        if (raced) return
        raced = true
        const t = readFileSync(file, 'utf8')
        writeFileSync(file, t + 'typed in an external editor\n')
      }
    })
    await w.refreshNow('w-api')
    expect(raced).toBe(true)
    expect(read()).toContain('Refresh-token rotation')
    expect(read().endsWith('typed in an external editor\n')).toBe(true)
  })

  it('pauses while the Brief has unsaved edits, then resumes', async () => {
    boards.push({
      id: 'brief',
      type: 'file',
      title: 'Brief',
      path: contextRelPath('w-api'),
      unsaved: true
    })
    const w = writer()
    expect(await w.refreshNow('w-api')).toBe(false)
    w.reset() // drop the retry timer the pause armed
    boards[boards.length - 1] = {
      id: 'brief',
      type: 'file',
      title: 'Brief',
      path: contextRelPath('w-api')
    }
    expect(await w.refreshNow('w-api')).toBe(true)
  })

  it('keeps the last 5 results, and they survive a restart (read back from the file)', async () => {
    const w1 = writer()
    for (let i = 1; i <= 4; i++) {
      w1.onResult('t1', { present: true, status: 'ok', summary: `task ${i}` })
      clock += 60_000
    }
    await w1.refreshNow('w-api')
    w1.reset()
    const w2 = writer() // a new app session
    w2.onResult('t2', { present: true, status: 'ok', summary: 'task 5' })
    w2.onResult('t2', { present: true, status: 'ok', summary: 'task 6' })
    w2.onResult('tp', { present: true, status: 'ok', summary: 'project-level: not here' })
    await w2.refreshNow('w-api')
    const lines = extractStatusBlock(read())!
      .split('\n')
      .filter((l) => / · ok — /.test(l))
    expect(lines.map((l) => l.replace(/^.* — /, ''))).toEqual([
      'task 6',
      'task 5',
      'task 4',
      'task 3',
      'task 2'
    ])
  })
})

describe('the project roll-up', () => {
  it('writes one line per workspace into _project/CONTEXT.md', async () => {
    await writer().refreshNow(PROJECT_CONTEXT_ID)
    const block = extractStatusBlock(read(PROJECT_CONTEXT_ID))!
    expect(block).toContain(`# ${basename(project)} — workspaces`)
    expect(block).toContain(
      '- **API** — build auth (JWT + refresh) · ws/api · 3 in progress · 2 busy agents'
    )
    expect(block).toContain('- **Uploader** · folder uploader · 0 in progress · 1 busy agent')
  })
})

describe('scheduling', () => {
  it('a burst of mirror pushes becomes at most one write per 5 s per workspace', async () => {
    vi.useFakeTimers({ now: NOW })
    clock = NOW
    const changed = vi.fn(async () => 3)
    const w = writer({ changedFiles: changed, now: () => Date.now() })
    for (let i = 0; i < 20; i++) w.scheduleAll()
    await vi.advanceTimersByTimeAsync(300)
    expect(changed).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      boards[0].kanban!.cards[0].title = `move ${i}`
      w.scheduleAll()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(changed).toHaveBeenCalledTimes(1) // still inside the 5 s window
    await vi.advanceTimersByTimeAsync(5_000)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(read()).toContain('move 19')
  })
})

describe('pure helpers', () => {
  it('spliceStatus keeps every byte outside the block', () => {
    const block = `${STATUS_START}\nnew\n${STATUS_END}`
    const text = `above\n${STATUS_START}\nold\n${STATUS_END}\nbelow\r\n`
    expect(spliceStatus(text, block)).toBe(`above\n${block}\nbelow\r\n`)
    expect(spliceStatus('', block)).toBe(`${block}\n`)
  })
  it('hhmm is local HH:MM', () => {
    expect(hhmm(NOW)).toBe('14:02')
  })
  it('oneLine strips every HTML comment delimiter, including --!>', () => {
    expect(oneLine('a <!-- b --> c --!> d')).toBe('a b c d')
  })
})
