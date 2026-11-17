/**
 * WS-8 — the shared-context paths: path guard, lazy scaffold, and the workspace lookups the Claude
 * rules are built from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoardMirror, WorkspaceMirror } from './boardRegistry'
import {
  PROJECT_CONTEXT_ID,
  STATUS_END,
  STATUS_START,
  claudeRulesForBoard,
  contextFilePath,
  contextRelPath,
  effectiveRootAbs,
  ensureScaffold,
  isWorkspaceContextId,
  listWorktreeDirs,
  readContext
} from './workspaceContext'

let project: string
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ws-ctx-'))
  mkdirSync(join(project, '.canvas'))
})
afterEach(() => rmSync(project, { recursive: true, force: true }))

const WS_ID = '3f0c9a1e-0000-4000-8000-000000000001'

describe('paths + guard', () => {
  it('a Brief binds to the project-relative POSIX path', () => {
    expect(contextRelPath(WS_ID)).toBe(`.canvas/workspaces/${WS_ID}/CONTEXT.md`)
  })

  it('refuses unsafe ids and the reserved project id as a workspace id', () => {
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '_project', 'x'.repeat(65)]) {
      expect(isWorkspaceContextId(bad), bad).toBe(false)
      if (bad !== PROJECT_CONTEXT_ID) expect(contextFilePath(project, bad), bad).toBeNull()
    }
    expect(contextFilePath(project, PROJECT_CONTEXT_ID)).toBe(
      join(project, '.canvas', 'workspaces', '_project', 'CONTEXT.md')
    )
  })

  it('refuses a link anywhere on the way down (an agent shell can plant a junction)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'ws-ctx-target-'))
    try {
      symlinkSync(elsewhere, join(project, '.canvas', 'workspaces'), 'junction')
      expect(contextFilePath(project, WS_ID)).toBeNull()
      expect(ensureScaffold(project, { id: WS_ID, name: 'API' })).toBeNull()
      expect(existsSync(join(elsewhere, WS_ID))).toBe(false)
    } finally {
      rmSync(join(project, '.canvas', 'workspaces'), { force: true, recursive: false })
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('ensureScaffold', () => {
  it('creates the file lazily: an empty status block, then the notes half', () => {
    const file = ensureScaffold(project, { id: WS_ID, name: 'API' })
    expect(file).toBe(join(project, '.canvas', 'workspaces', WS_ID, 'CONTEXT.md'))
    const text = readFileSync(file!, 'utf8')
    expect(text.startsWith(`${STATUS_START}\n# API\n`)).toBe(true)
    expect(text).toContain(`${STATUS_END}\n\n---\n## My notes   (yours, edit anytime)\n`)
    expect(readContext(project, WS_ID)).toBe(text)
  })

  it('the project roll-up gets a project-notes heading', () => {
    const file = ensureScaffold(project, { id: PROJECT_CONTEXT_ID, name: 'proj' })
    expect(readFileSync(file!, 'utf8')).toContain('## Project notes   (yours, edit anytime)')
  })

  it('never touches an existing file', () => {
    const dir = join(project, '.canvas', 'workspaces', WS_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CONTEXT.md'), 'my own words\n')
    ensureScaffold(project, { id: WS_ID, name: 'API' })
    expect(readFileSync(join(dir, 'CONTEXT.md'), 'utf8')).toBe('my own words\n')
  })
})

describe('workspace lookups for the Claude rules', () => {
  const api: WorkspaceMirror = {
    id: 'w-api',
    name: 'API',
    goal: '',
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
  const up: WorkspaceMirror = {
    id: 'w-up',
    name: 'Uploader',
    goal: '',
    color: 'green',
    root: 'uploader'
  }
  const boards: BoardMirror[] = [
    { id: 't-api', type: 'terminal', title: 'claude', workspaceId: 'w-api' },
    { id: 't-proj', type: 'terminal', title: 'claude' }
  ]

  it('effective root = the worktree when git-backed, else the folder', () => {
    expect(effectiveRootAbs(project, api)).toBe(join(project, '.canvas', 'worktrees', 'ws-api'))
    expect(effectiveRootAbs(project, up)).toBe(join(project, 'uploader'))
    expect(effectiveRootAbs(project, { ...up, root: '.' })).toBe(project)
  })

  it('lists the folders under .canvas/worktrees', () => {
    mkdirSync(join(project, '.canvas', 'worktrees', 'ws-api'), { recursive: true })
    mkdirSync(join(project, '.canvas', 'worktrees', 'builder-1'), { recursive: true })
    expect(listWorktreeDirs(project).sort()).toEqual(
      [
        join(project, '.canvas', 'worktrees', 'builder-1'),
        join(project, '.canvas', 'worktrees', 'ws-api')
      ].sort()
    )
  })

  it('a workspace board is confined; a project-level or archived-workspace board gets none', () => {
    const input = {
      projectDir: project,
      boards,
      workspaces: [api, up],
      worktreeDirs: [],
      platform: 'linux' as const
    }
    const rules = claudeRulesForBoard({ ...input, boardId: 't-api' })
    expect(rules.sandbox).toBe(true)
    expect(rules.deny.some((r) => r.endsWith('/uploader/**)'))).toBe(true)
    expect(rules.deny.some((r) => r.includes('/ws-api'))).toBe(false)
    expect(rules.deny.some((r) => r.endsWith('/.canvas/workspaces/**)'))).toBe(true)
    expect(claudeRulesForBoard({ ...input, boardId: 't-proj' })).toEqual({
      deny: [],
      sandbox: false
    })
    expect(
      claudeRulesForBoard({
        ...input,
        workspaces: [{ ...api, state: 'archived' }, up],
        boardId: 't-api'
      })
    ).toEqual({ deny: [], sandbox: false })
  })
})
