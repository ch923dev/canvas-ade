import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock simple-git so boardGitDiff unit-tests in isolation (no real git, no child process,
// and no electron/node-pty import graph — cwd is injected, not read from pty.ts).
//
// The instance mirrors the (subset of the) simple-git surface boardGitDiff drives:
// `checkIsRepo`, `diff`, `raw` (ls-files + diff --no-index), and the fluent `outputHandler`
// setter (a no-op here — the byte-bound stream tap is exercised in gitDiff.integration.test.ts
// against real git). `outputHandler` MUST return the instance to preserve the fluent chain.
const checkIsRepo = vi.fn()
const diff = vi.fn()
const raw = vi.fn()
const outputHandler = vi.fn()
vi.mock('simple-git', () => ({
  // The instance is built lazily inside the `vi.fn` body (called only when `simpleGit(cwd)`
  // runs at test time), so the hoisted-but-not-yet-initialized consts are read after init.
  // The instance mirrors the surface boardGitDiff drives: checkIsRepo / diff / raw, plus the
  // fluent `outputHandler` setter (a no-op here — the stream tap is covered by the real-git
  // integration test).
  default: vi.fn(() => ({ checkIsRepo, diff, raw, outputHandler }))
}))

import simpleGit from 'simple-git'
import { boardGitDiff } from './gitDiff'

const simpleGitFactory = simpleGit as unknown as ReturnType<typeof vi.fn>

describe('boardGitDiff (PR-2)', () => {
  beforeEach(() => {
    checkIsRepo.mockReset()
    diff.mockReset()
    raw.mockReset()
    outputHandler.mockReset()
    simpleGitFactory.mockClear()
    // Default: no untracked files (ls-files returns ''), so the tracked diff is returned as-is
    // unless a test overrides `raw`.
    raw.mockResolvedValue('')
  })

  it('returns "" when the board has no known cwd (never reaches git)', async () => {
    expect(await boardGitDiff('t1', () => undefined)).toBe('')
    expect(checkIsRepo).not.toHaveBeenCalled()
  })

  it('returns "" when the cwd is not a git repo', async () => {
    checkIsRepo.mockResolvedValue(false)
    expect(await boardGitDiff('t1', () => '/tmp/notrepo')).toBe('')
    expect(diff).not.toHaveBeenCalled()
  })

  it('returns the working-tree diff vs HEAD for a repo', async () => {
    checkIsRepo.mockResolvedValue(true)
    diff.mockResolvedValue('DIFF-HEAD')
    expect(await boardGitDiff('t1', () => '/repo')).toBe('DIFF-HEAD')
    expect(diff).toHaveBeenCalledWith(['HEAD'])
  })

  it('falls back to the unstaged diff when HEAD is absent (no commits yet)', async () => {
    checkIsRepo.mockResolvedValue(true)
    diff.mockImplementation(async (args?: string[]) => {
      if (args && args[0] === 'HEAD') throw new Error('fatal: bad revision HEAD')
      return 'UNSTAGED'
    })
    expect(await boardGitDiff('t1', () => '/repo')).toBe('UNSTAGED')
  })

  it('re-throws a non-HEAD failure instead of masking it with the unstaged fallback', async () => {
    checkIsRepo.mockResolvedValue(true)
    diff.mockRejectedValue(new Error('fatal: unable to read tree object (corrupt)'))
    await expect(boardGitDiff('t1', () => '/repo')).rejects.toThrow(/corrupt/)
  })

  it('appends a synthesized new-file diff for each untracked, non-ignored file (GAP-001)', async () => {
    checkIsRepo.mockResolvedValue(true)
    diff.mockResolvedValue('TRACKED\n')
    raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'ls-files') return 'new-a.txt\0new-b.txt\0' // -z NUL-separated
      // diff --no-index /dev/null <file> — exit 1 in real git, but the mock resolves with
      // the synthesized addition; boardGitDiff returns the captured output either way.
      if (args[0] === 'diff' && args[1] === '--no-index') {
        const file = args[3]
        return `diff --git a/${file} b/${file}\nnew file mode 100644\n`
      }
      return ''
    })
    const out = await boardGitDiff('t1', () => '/repo')
    // Tracked diff comes first; each untracked file's synthesized addition is appended after.
    expect(out).toContain('TRACKED')
    expect(out).toContain('new-a.txt')
    expect(out).toContain('new-b.txt')
    expect(out).toContain('new file mode')
    expect(out.indexOf('TRACKED')).toBeLessThan(out.indexOf('new-a.txt'))
    expect(raw).toHaveBeenCalledWith(['ls-files', '--others', '--exclude-standard', '-z'])
  })

  it('returns the tracked diff alone when there are no untracked files', async () => {
    checkIsRepo.mockResolvedValue(true)
    diff.mockResolvedValue('ONLY-TRACKED')
    raw.mockResolvedValue('') // empty ls-files
    expect(await boardGitDiff('t1', () => '/repo')).toBe('ONLY-TRACKED')
  })

  it('degrades to the tracked diff when ls-files fails (untracked enumeration is best-effort)', async () => {
    checkIsRepo.mockResolvedValue(true)
    diff.mockResolvedValue('TRACKED-ONLY')
    raw.mockRejectedValue(new Error('ls-files exploded'))
    expect(await boardGitDiff('t1', () => '/repo')).toBe('TRACKED-ONLY')
  })

  it('configures the instance with an abort signal and a block timeout (GAP-002/007)', async () => {
    checkIsRepo.mockResolvedValue(true)
    diff.mockResolvedValue('D')
    await boardGitDiff('t1', () => '/repo')
    expect(simpleGitFactory).toHaveBeenCalledTimes(1)
    const opts = simpleGitFactory.mock.calls[0][1] as {
      abort?: AbortSignal
      timeout?: { block: number }
    }
    expect(opts.abort).toBeInstanceOf(AbortSignal)
    expect(typeof opts.timeout?.block).toBe('number')
    expect(opts.timeout?.block).toBeGreaterThan(0)
  })
})
