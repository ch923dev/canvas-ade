/**
 * Unit tests for mcpBoardProjects.ts — the board → mint-time project-dir map behind
 * cross-project visualize_plan routing.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordBoardProject,
  boardProjectDir,
  __clearBoardProjectsForTest
} from './mcpBoardProjects'

beforeEach(() => {
  __clearBoardProjectsForTest()
})

describe('mcpBoardProjects', () => {
  it('records and resolves a board to its mint-time project dir', () => {
    recordBoardProject('term-1', 'C:\\proj\\a')
    expect(boardProjectDir('term-1')).toBe('C:\\proj\\a')
  })

  it('an unknown board resolves null', () => {
    expect(boardProjectDir('never-minted')).toBeNull()
  })

  it('a null dir (no project open at mint) records nothing', () => {
    recordBoardProject('term-1', null)
    expect(boardProjectDir('term-1')).toBeNull()
  })

  it('an empty boardId records nothing', () => {
    recordBoardProject('', 'C:\\proj\\a')
    expect(boardProjectDir('')).toBeNull()
  })

  it('a re-mint OVERWRITES the entry (the orchestration-sync pseudo board rotates projects)', () => {
    recordBoardProject('orchestration-sync', 'C:\\proj\\a')
    recordBoardProject('orchestration-sync', 'C:\\proj\\b')
    expect(boardProjectDir('orchestration-sync')).toBe('C:\\proj\\b')
  })

  it('evicts the OLDEST entry past the cap; a refreshed entry survives', () => {
    recordBoardProject('first', 'C:\\proj\\first')
    for (let i = 0; i < 499; i++) recordBoardProject(`b${i}`, 'C:\\proj\\x')
    // 500 entries now. Refresh 'first' so 'b0' becomes the oldest, then overflow by one.
    recordBoardProject('first', 'C:\\proj\\first')
    recordBoardProject('overflow', 'C:\\proj\\y')
    expect(boardProjectDir('first')).toBe('C:\\proj\\first')
    expect(boardProjectDir('b0')).toBeNull()
    expect(boardProjectDir('overflow')).toBe('C:\\proj\\y')
  })
})
