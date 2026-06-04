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

  it('🔒 rejects an over-length board id even when a matching file exists (BUG-019)', () => {
    // A 65-char id passes the charset but EXCEEDS the 64-char cap (mirroring
    // canvasMemory.safeBoardId). Seed a real file whose name uses that exact 65-char id:
    // the OLD code (no length cap) would find + return it (present:true); the FIXED guard
    // rejects the id BEFORE the fs touch, so it stays the empty shell.
    const overLen = 'a'.repeat(65)
    seedMemory({ [`board-${overLen}.md`]: 'should-not-be-readable' })
    expect(readBoardSummary(overLen)).toEqual({ present: false, text: '' })

    // The boundary (exactly 64) is still accepted: a real file at that id IS read.
    const atCap = 'b'.repeat(64)
    seedMemory({ [`board-${atCap}.md`]: 'cap-ok' })
    expect(readBoardSummary(atCap)).toEqual({ present: true, text: 'cap-ok' })
  })
})
