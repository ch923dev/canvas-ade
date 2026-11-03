import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_COLORS,
  WORKSPACE_GOAL_MAX,
  effectiveRoot,
  isValidWorkspaceGoal,
  isValidWorkspaceRef,
  nextWorkspaceColor,
  normalizeWorkspaceRoot,
  sanitizeWorkspaceGoal
} from './workspaceRules'

describe('normalizeWorkspaceRoot — inside-the-project POSIX paths only (O-7)', () => {
  it.each([
    ['api', 'api'],
    ['packages/web', 'packages/web'],
    ['.', '.'],
    ['./api/', 'api'],
    ['api//x/./y/', 'api/x/y'],
    ['.canvas/worktrees/api-auth', '.canvas/worktrees/api-auth'],
    ['my repo/with space', 'my repo/with space'],
    ['v1.2/..x', 'v1.2/..x']
  ])('accepts %j as %j', (raw, want) => {
    expect(normalizeWorkspaceRoot(raw)).toBe(want)
  })

  it.each([
    ['empty', ''],
    ['absolute posix', '/etc'],
    ['double-slash absolute', '//server/share'],
    ['parent', '..'],
    ['parent prefix', '../uploader'],
    ['parent in the middle', 'api/../../outside'],
    ['dots Windows collapses into ..', '...'],
    ['dot-dot-space', 'api/.. /x'],
    ['dot-space-dot', '. .'],
    ['drive letter', 'C:/Users'],
    ['drive-relative', 'c:api'],
    ['NTFS stream', 'api:secret'],
    ['UNC', '\\\\server\\share'],
    ['backslash-rooted', '\\Windows'],
    ['backslash separator', 'api\\sub'],
    ['newline', 'api\nx'],
    ['NUL', 'api\u0000'],
    ['C1 control', 'api\u0085']
  ])('refuses %s (%j)', (_label, raw) => {
    expect(normalizeWorkspaceRoot(raw)).toBeNull()
  })

  it('refuses non-strings and over-length paths', () => {
    expect(normalizeWorkspaceRoot(42)).toBeNull()
    expect(normalizeWorkspaceRoot(undefined)).toBeNull()
    expect(normalizeWorkspaceRoot('a'.repeat(1025))).toBeNull()
    expect(normalizeWorkspaceRoot('a'.repeat(1024))).toBe('a'.repeat(1024))
  })
})

describe('workspace goal rules', () => {
  it('a goal is one line of at most 200 code units; empty is fine', () => {
    expect(isValidWorkspaceGoal('')).toBe(true)
    expect(isValidWorkspaceGoal('build auth')).toBe(true)
    expect(isValidWorkspaceGoal('x'.repeat(WORKSPACE_GOAL_MAX))).toBe(true)
    expect(isValidWorkspaceGoal('x'.repeat(WORKSPACE_GOAL_MAX + 1))).toBe(false)
    expect(isValidWorkspaceGoal('two\nlines')).toBe(false)
    expect(isValidWorkspaceGoal('tab\there')).toBe(false)
    expect(isValidWorkspaceGoal('esc\u001b[31m')).toBe(false)
    expect(isValidWorkspaceGoal(7)).toBe(false)
  })

  it('sanitizeWorkspaceGoal folds controls to spaces, trims, clamps — always valid', () => {
    expect(sanitizeWorkspaceGoal('  build\n\tauth  ')).toBe('build auth')
    expect(sanitizeWorkspaceGoal('a\u0007b')).toBe('a b')
    const long = sanitizeWorkspaceGoal('😀'.repeat(150))
    expect(long.length).toBeLessThanOrEqual(WORKSPACE_GOAL_MAX)
    expect(long).toBe('😀'.repeat(100)) // whole surrogate pairs only
    for (const raw of ['x'.repeat(500), 'a\r\nb', '\u0000']) {
      expect(isValidWorkspaceGoal(sanitizeWorkspaceGoal(raw))).toBe(true)
    }
  })
})

describe('workspace refs + colours', () => {
  it('a ref is a non-empty, bounded, control-free string', () => {
    expect(isValidWorkspaceRef('ws/api-auth')).toBe(true)
    expect(isValidWorkspaceRef('')).toBe(false)
    expect(isValidWorkspaceRef('x'.repeat(257))).toBe(false)
    expect(isValidWorkspaceRef('main\n')).toBe(false)
    expect(isValidWorkspaceRef(null)).toBe(false)
  })

  it('nextWorkspaceColor hands out the first unused token, then cycles', () => {
    expect(nextWorkspaceColor([])).toBe('blue')
    expect(nextWorkspaceColor([{ color: 'blue' }])).toBe('green')
    expect(nextWorkspaceColor([{ color: 'green' }])).toBe('blue')
    const all = WORKSPACE_COLORS.map((color) => ({ color }))
    expect(nextWorkspaceColor(all)).toBe(WORKSPACE_COLORS[0])
    expect(nextWorkspaceColor([...all, { color: 'blue' }])).toBe(WORKSPACE_COLORS[1])
  })
})

describe('effectiveRoot — the folder a workspace runs in (WS-3, §4.1)', () => {
  const wt = (repoRoot: string, worktree = '.canvas/worktrees/ws-a') => [{ repoRoot, worktree }]

  it.each([
    ['folder workspace = its root', { root: 'api' }, 'api'],
    ['folder workspace "." = the project', { root: '.' }, '.'],
    ['root is canonicalized', { root: './api//src/' }, 'api/src'],
    ['empty worktree list = the root', { root: 'api', worktrees: [] }, 'api'],
    [
      'polyrepo: root IS the repo ⇒ the worktree',
      { root: 'api', worktrees: wt('api') },
      '.canvas/worktrees/ws-a'
    ],
    [
      'polyrepo: subfolder of the repo',
      { root: 'api/src', worktrees: wt('api') },
      '.canvas/worktrees/ws-a/src'
    ],
    [
      'monorepo: project-repo subfolder',
      { root: 'packages/api', worktrees: wt('.') },
      '.canvas/worktrees/ws-a/packages/api'
    ],
    [
      'monorepo: whole project on a branch',
      { root: '.', worktrees: wt('.') },
      '.canvas/worktrees/ws-a'
    ]
  ] as const)('%s', (_label, ws, want) => {
    expect(effectiveRoot(ws)).toBe(want)
  })

  it.each([
    ['root escapes', { root: '../x' }],
    ['root absolute', { root: '/etc' }],
    ['root outside the worktree repo', { root: 'uploader', worktrees: wt('api') }],
    ['repo name is only a prefix of root', { root: 'api-v2', worktrees: wt('api') }],
    ['whole project, repo is a subfolder', { root: '.', worktrees: wt('api') }],
    ['worktree path escapes', { root: 'api', worktrees: wt('api', '../elsewhere') }],
    ['repoRoot escapes', { root: 'api', worktrees: wt('..') }]
  ] as const)('null when %s', (_label, ws) => {
    expect(effectiveRoot(ws)).toBeNull()
  })
})
