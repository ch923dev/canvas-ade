// src/main/terminalSnapshot.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  terminalSnapshotDir,
  terminalSnapshotPath,
  writeTerminalSnapshot,
  writeTerminalSnapshotAsync,
  readTerminalSnapshot,
  deleteTerminalSnapshot,
  appendTerminalSnapshot,
  readTerminalSnapshotAsync,
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

  it('an oversized skip invalidates a prior successful snapshot instead of leaving it stale', () => {
    expect(writeTerminalSnapshot(proj, 'b', 'session N-1 output')).toBe(true)
    expect(readTerminalSnapshot(proj, 'b')).toBe('session N-1 output')

    const huge = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1)
    expect(writeTerminalSnapshot(proj, 'b', huge)).toBe(false)

    expect(readTerminalSnapshot(proj, 'b')).toBeNull()
    expect(existsSync(terminalSnapshotPath(proj, 'b')!)).toBe(false)
  })
})

// BUG-040: the async writer is what every non-quit caller now uses so a large snapshot can't block
// MAIN's event loop — same on-disk contract as the sync writer, just non-blocking.
describe('writeTerminalSnapshotAsync (BUG-040 — non-blocking write path)', () => {
  it('writes then reads back the exact ANSI text', async () => {
    const ansi = '\x1b[32m$ pnpm build\x1b[0m\r\n✓ done\r\n'
    await expect(writeTerminalSnapshotAsync(proj, 'b', ansi)).resolves.toBe(true)
    expect(readTerminalSnapshot(proj, 'b')).toBe(ansi)
  })

  it('creates the terminal/ dir lazily on first write', async () => {
    expect(existsSync(terminalSnapshotDir(proj))).toBe(false)
    await writeTerminalSnapshotAsync(proj, 'b', 'x')
    expect(existsSync(terminalSnapshotDir(proj))).toBe(true)
  })

  it('refuses a bad id without throwing', async () => {
    await expect(writeTerminalSnapshotAsync(proj, '../evil', 'x')).resolves.toBe(false)
  })

  it('skips an oversized blob rather than corrupting it', async () => {
    const huge = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1)
    await expect(writeTerminalSnapshotAsync(proj, 'b', huge)).resolves.toBe(false)
    expect(readTerminalSnapshot(proj, 'b')).toBeNull()
  })
})

// Bg sessions Phase 5: quit-time ring-tail append + the adopt-preface async read.
describe('appendTerminalSnapshot / readTerminalSnapshotAsync (Phase 5 continuity)', () => {
  it('appends a tail to an existing sidecar (snapshot + tail on read-back)', () => {
    writeTerminalSnapshot(proj, 'b1', 'SNAPSHOT')
    expect(appendTerminalSnapshot(proj, 'b1', '-TAIL')).toBe(true)
    expect(readTerminalSnapshot(proj, 'b1')).toBe('SNAPSHOT-TAIL')
  })

  it('creates the sidecar when none exists (the tail becomes the whole snapshot)', () => {
    expect(appendTerminalSnapshot(proj, 'b2', 'ONLY-TAIL')).toBe(true)
    expect(readTerminalSnapshot(proj, 'b2')).toBe('ONLY-TAIL')
  })

  it('skips WHOLE (never truncates) when existing + tail would exceed the cap', () => {
    writeTerminalSnapshot(proj, 'b3', 'x'.repeat(1024))
    const huge = 'y'.repeat(MAX_SNAPSHOT_BYTES)
    expect(appendTerminalSnapshot(proj, 'b3', huge)).toBe(false)
    expect(readTerminalSnapshot(proj, 'b3')).toBe('x'.repeat(1024)) // untouched
  })

  it('rejects an unsafe board id and an empty tail', () => {
    expect(appendTerminalSnapshot(proj, '../escape', 'data')).toBe(false)
    expect(appendTerminalSnapshot(proj, 'b4', '')).toBe(false)
  })

  it('readTerminalSnapshotAsync reads what the sync writer wrote; null when absent', async () => {
    writeTerminalSnapshot(proj, 'b5', 'ASYNC-READ')
    await expect(readTerminalSnapshotAsync(proj, 'b5')).resolves.toBe('ASYNC-READ')
    await expect(readTerminalSnapshotAsync(proj, 'nope')).resolves.toBeNull()
  })
})
