// src/main/terminalImageStaging.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { stagedDir, stageClipboardImage, cleanupStaged } from './terminalImageStaging'

let proj: string
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'canvas-stage-'))
})
afterEach(() => {
  rmSync(proj, { recursive: true, force: true })
})

describe('terminalImageStaging', () => {
  it('writes the PNG under <project>/.canvas/tmp and returns the absolute path', () => {
    const png = Buffer.from([1, 2, 3, 4])
    const p = stageClipboardImage(proj, 'board1', png)
    expect(p.startsWith(stagedDir(proj))).toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p)).toEqual(png)
  })

  it('uses a unique name per call (sequence)', () => {
    const a = stageClipboardImage(proj, 'b', Buffer.from([0]))
    const b = stageClipboardImage(proj, 'b', Buffer.from([0]))
    expect(a).not.toEqual(b)
  })

  it('sanitizes the board id in the filename', () => {
    const p = stageClipboardImage(proj, '../../evil id', Buffer.from([0]))
    expect(p.includes('..')).toBe(false)
    expect(p.startsWith(stagedDir(proj))).toBe(true)
  })

  it('cleanupStaged removes only the given board files', () => {
    const a = stageClipboardImage(proj, 'keep', Buffer.from([0]))
    const b = stageClipboardImage(proj, 'drop', Buffer.from([0]))
    cleanupStaged(proj, 'drop')
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(false)
  })

  it('cleanupStaged is a no-op when the dir does not exist', () => {
    expect(() => cleanupStaged(join(proj, 'nope'), 'x')).not.toThrow()
  })

  it('prunes staged files older than the given age on stage', () => {
    const old = stageClipboardImage(proj, 'old', Buffer.from([0]))
    // Force the file's mtime into the past.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(old, past, past)
    stageClipboardImage(proj, 'new', Buffer.from([0]), 60 * 60 * 1000) // 1h max age
    expect(existsSync(old)).toBe(false)
    expect(readdirSync(stagedDir(proj)).some((n) => n.includes('new'))).toBe(true)
  })
})
