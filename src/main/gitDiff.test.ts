import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock simple-git so boardGitDiff unit-tests in isolation (no real git, no child process,
// and no electron/node-pty import graph — cwd is injected, not read from pty.ts).
const checkIsRepo = vi.fn()
const diff = vi.fn()
vi.mock('simple-git', () => ({ default: vi.fn(() => ({ checkIsRepo, diff })) }))

import { boardGitDiff } from './gitDiff'

describe('boardGitDiff (PR-2)', () => {
  beforeEach(() => {
    checkIsRepo.mockReset()
    diff.mockReset()
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
})
