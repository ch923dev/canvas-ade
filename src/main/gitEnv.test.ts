import { describe, it, expect, afterEach } from 'vitest'
import { repoScopedEnv } from './gitEnv'

/**
 * The shared MAIN git-env scrubber. It is the security primitive behind every read-only git seam
 * (boardGitDiff, file:gitPermalink): strip EVERY `GIT_*` var so git's directory discovery falls
 * back to the spawn path (no host-repo escape), which also clears the dangerous vars simple-git's
 * blockUnsafeOperationsPlugin would otherwise refuse to spawn on. See ./gitEnv for the full why.
 */
describe('repoScopedEnv (shared MAIN read-only git env)', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('strips every GIT_* var (case-insensitive) — the host-repo-escape fix', () => {
    process.env.GIT_DIR = '/host/.git'
    process.env.GIT_WORK_TREE = '/host'
    process.env.GIT_INDEX_FILE = '/host/.git/index'
    process.env.GIT_COMMON_DIR = '/host/.git'
    process.env.GIT_CEILING_DIRECTORIES = '/'
    process.env.git_dir = '/lower/.git' // lower-case variant must also go
    const env = repoScopedEnv()
    // The ONLY GIT_* key left is the one we deliberately re-add below.
    const leftover = Object.keys(env).filter((k) => /^GIT_/i.test(k) && k !== 'GIT_TERMINAL_PROMPT')
    expect(leftover).toEqual([])
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_WORK_TREE).toBeUndefined()
    expect((env as Record<string, string | undefined>).git_dir).toBeUndefined()
  })

  it('also clears the vars simple-git would block the spawn on (no allowUnsafe* needed)', () => {
    process.env.GIT_EDITOR = 'vim'
    process.env.GIT_SSH = '/usr/bin/ssh'
    process.env.GIT_SSH_COMMAND = 'ssh -i key'
    process.env.GIT_PAGER = 'less'
    process.env.GIT_ASKPASS = '/x/askpass'
    process.env.GIT_EXTERNAL_DIFF = 'meld'
    const env = repoScopedEnv()
    expect(env.GIT_EDITOR).toBeUndefined()
    expect(env.GIT_SSH).toBeUndefined()
    expect(env.GIT_SSH_COMMAND).toBeUndefined()
    expect(env.GIT_PAGER).toBeUndefined()
    expect(env.GIT_ASKPASS).toBeUndefined()
    expect(env.GIT_EXTERNAL_DIFF).toBeUndefined()
  })

  it('sets GIT_TERMINAL_PROMPT=0 (never block on a credential prompt) — overriding any inherited value', () => {
    delete process.env.GIT_TERMINAL_PROMPT
    expect(repoScopedEnv().GIT_TERMINAL_PROMPT).toBe('0')
    process.env.GIT_TERMINAL_PROMPT = '1'
    expect(repoScopedEnv().GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('preserves non-GIT vars — the child still needs PATH etc.', () => {
    process.env.CANVAS_GITENV_MARKER = 'keepme'
    const env = repoScopedEnv()
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.CANVAS_GITENV_MARKER).toBe('keepme')
  })

  it('returns a clone — process.env is NOT mutated', () => {
    process.env.GIT_DIR = '/host/.git'
    repoScopedEnv()
    expect(process.env.GIT_DIR).toBe('/host/.git') // still on the real env
  })
})
