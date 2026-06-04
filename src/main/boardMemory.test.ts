import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { __setMemoryDirForTest, readBoardSummary, readProjectMemory } from './boardMemory'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canvas-mem-'))
})
afterEach(() => {
  __setMemoryDirForTest(null)
  rmSync(dir, { recursive: true, force: true })
})

function seedMemory(files: Record<string, string>): void {
  const root = join(dir, '.canvas', 'memory')
  mkdirSync(root, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, 'utf8')
  __setMemoryDirForTest(dir)
}

describe('boardMemory', () => {
  it('gracefully empties when no project dir is set', () => {
    __setMemoryDirForTest(null)
    expect(readProjectMemory()).toEqual({ present: false, text: '' })
    expect(readBoardSummary('b1')).toEqual({ present: false, text: '' })
  })

  it('gracefully empties when the .canvas/memory dir is absent', () => {
    __setMemoryDirForTest(dir) // dir exists but has no .canvas/memory
    expect(readProjectMemory()).toEqual({ present: false, text: '' })
    expect(readBoardSummary('b1')).toEqual({ present: false, text: '' })
  })

  it('reads the project memory index (MEMORY.md)', () => {
    seedMemory({ 'MEMORY.md': '# Project memory\n- board A' })
    expect(readProjectMemory()).toEqual({ present: true, text: '# Project memory\n- board A' })
  })

  it('reads a per-board summary (board-<id>.md)', () => {
    seedMemory({ 'board-b1.md': 'board b1: parser 80%' })
    expect(readBoardSummary('b1')).toEqual({ present: true, text: 'board b1: parser 80%' })
  })

  it('an absent per-board summary is the empty shell', () => {
    seedMemory({ 'MEMORY.md': 'x' })
    expect(readBoardSummary('nope')).toEqual({ present: false, text: '' })
  })

  it('🔒 rejects path-traversal / unsafe ids (no escape from .canvas/memory)', () => {
    seedMemory({ 'MEMORY.md': 'secret' })
    // None of these may resolve to a file outside the memory dir.
    expect(readBoardSummary('../MEMORY').present).toBe(false)
    expect(readBoardSummary('../../canvas').present).toBe(false)
    expect(readBoardSummary('a/b').present).toBe(false)
    expect(readBoardSummary('..').present).toBe(false)
    expect(readBoardSummary('').present).toBe(false)
  })
})
