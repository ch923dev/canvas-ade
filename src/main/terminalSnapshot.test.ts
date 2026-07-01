// src/main/terminalSnapshot.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  terminalSnapshotDir,
  terminalSnapshotPath,
  writeTerminalSnapshot,
  readTerminalSnapshot,
  deleteTerminalSnapshot,
  MAX_SNAPSHOT_BYTES
} from './terminalSnapshot'

let proj: string
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'canvas-snap-'))
})
afterEach(() => {
  rmSync(proj, { recursive: true, force: true })
})

describe('terminalSnapshot paths', () => {
  it('resolves the sidecar under <project>/.canvas/terminal/<id>.snapshot', () => {
    expect(terminalSnapshotDir(proj)).toBe(join(proj, '.canvas', 'terminal'))
    expect(terminalSnapshotPath(proj, 'board1')).toBe(
      join(proj, '.canvas', 'terminal', 'board1.snapshot')
    )
  })

  it('rejects a non-path-safe id (traversal / separators) → null', () => {
    expect(terminalSnapshotPath(proj, '../../evil')).toBeNull()
    expect(terminalSnapshotPath(proj, 'a/b')).toBeNull()
    expect(terminalSnapshotPath(proj, '')).toBeNull()
  })
})

describe('terminalSnapshot write/read/delete round-trip', () => {
  it('writes then reads back the exact ANSI text', () => {
    const ansi = '\x1b[32m$ pnpm build\x1b[0m\r\n✓ done\r\n'
    expect(writeTerminalSnapshot(proj, 'b', ansi)).toBe(true)
    expect(existsSync(terminalSnapshotPath(proj, 'b')!)).toBe(true)
    expect(readTerminalSnapshot(proj, 'b')).toBe(ansi)
  })

  it('creates the terminal/ dir lazily on first write', () => {
    expect(existsSync(terminalSnapshotDir(proj))).toBe(false)
    writeTerminalSnapshot(proj, 'b', 'x')
    expect(existsSync(terminalSnapshotDir(proj))).toBe(true)
  })

  it('overwrites an existing snapshot (atomic replace)', () => {
    writeTerminalSnapshot(proj, 'b', 'old')
    writeTerminalSnapshot(proj, 'b', 'new')
    expect(readTerminalSnapshot(proj, 'b')).toBe('new')
  })

  it('reads null for an absent snapshot', () => {
    expect(readTerminalSnapshot(proj, 'missing')).toBeNull()
  })

  it('deletes the sidecar; delete of an absent one is a safe no-op', () => {
    writeTerminalSnapshot(proj, 'b', 'x')
    expect(existsSync(terminalSnapshotPath(proj, 'b')!)).toBe(true)
    deleteTerminalSnapshot(proj, 'b')
    expect(existsSync(terminalSnapshotPath(proj, 'b')!)).toBe(false)
    expect(() => deleteTerminalSnapshot(proj, 'b')).not.toThrow()
    expect(() => deleteTerminalSnapshot(proj, '../evil')).not.toThrow()
  })
})

describe('terminalSnapshot guards', () => {
  it('refuses a bad id on write/read/delete without throwing', () => {
    expect(writeTerminalSnapshot(proj, '../evil', 'x')).toBe(false)
    expect(readTerminalSnapshot(proj, '../evil')).toBeNull()
    expect(existsSync(join(proj, '.canvas', 'terminal'))).toBe(false)
  })

  it('refuses a non-string payload', () => {
    // @ts-expect-error — exercise the runtime guard against a non-string arriving over IPC
    expect(writeTerminalSnapshot(proj, 'b', 123)).toBe(false)
  })

  it('skips an oversized blob rather than corrupting it', () => {
    const huge = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1)
    expect(writeTerminalSnapshot(proj, 'b', huge)).toBe(false)
    expect(readTerminalSnapshot(proj, 'b')).toBeNull()
  })

  it('accepts a payload exactly at the cap', () => {
    const atCap = 'x'.repeat(MAX_SNAPSHOT_BYTES)
    expect(writeTerminalSnapshot(proj, 'b', atCap)).toBe(true)
    expect(readFileSync(terminalSnapshotPath(proj, 'b')!, 'utf8').length).toBe(MAX_SNAPSHOT_BYTES)
  })
})
