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

  it('rejects an unsafe board id rather than sanitizing/coalescing it', () => {
    expect(() => stageClipboardImage(proj, '../../evil id', Buffer.from([0]))).toThrow()
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

  it('cleanupStaged no-ops (never throws) on an unsafe board id', () => {
    expect(() => cleanupStaged(proj, '???')).not.toThrow()
  })

  it('BUG-039: two distinct unsafe ids that would have sanitized to the same fallback never collide', () => {
    // Both '???' and '!!!' strip to empty under the old ad hoc sanitizer and would have
    // coalesced onto the shared 'board' token. The fix rejects them outright instead.
    const png = Buffer.from([9])
    expect(() => stageClipboardImage(proj, '???', png)).toThrow()
    expect(() => stageClipboardImage(proj, '!!!', png)).toThrow()
    // A real (safe) board id staged alongside must be unaffected by cleanupStaged on either
    // unsafe id.
    const kept = stageClipboardImage(proj, 'a1b2c3', png)
    cleanupStaged(proj, '???')
    cleanupStaged(proj, '!!!')
    expect(existsSync(kept)).toBe(true)
  })

  it('BUG-026: staged filenames include a random component so same-board same-seq never collides', () => {
    // Even if two calls produce the same seq (e.g. across restarts where seq resets),
    // the random suffix should make names distinct. Within one session, seq is different
    // already, but we can verify the random part exists and varies between calls.
    const a = stageClipboardImage(proj, 'board1', Buffer.from([0]))
    const b = stageClipboardImage(proj, 'board1', Buffer.from([0]))
    // Both paths must be unique (they have different seq AND random suffix)
    expect(a).not.toBe(b)
    // Each filename must contain a hex random suffix (4 bytes = 8 hex chars) after the seq
    const baseName = (p: string) => p.split('/').pop()!.split('\\').pop()!
    // Pattern: paste-<safeId>-<seq>-<8hexchars>.png
    const re = /^paste-[a-zA-Z0-9_-]+-\d+-[0-9a-f]{8}\.png$/
    expect(baseName(a)).toMatch(re)
    expect(baseName(b)).toMatch(re)
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
