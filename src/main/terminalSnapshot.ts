// src/main/terminalSnapshot.ts
/**
 * Phase 5 · S3 — persist a terminal's scrollback across app restarts.
 *
 * The renderer serializes the live xterm buffer (`@xterm/addon-serialize`) to a raw-ANSI string and
 * hands it here to write to a per-board sidecar `<project>/.canvas/terminal/<boardId>.snapshot`. On
 * reopen the renderer reads it back into a FROZEN (idle, no live PTY) terminal so the user sees their
 * last session's output read-only until they hit Start. This is the literal screen (shell-agnostic) —
 * distinct from recap, which parses an agent's JSONL transcript into a semantic summary.
 *
 * Storage (ADR 0009): the sidecar lives under the sanctioned `.canvas/` data dir, keyed by board id
 * (no `canvas.json` schema change — presence is derivable from the filesystem). git-ignored by
 * default like `assets/`/`tmp/`; bounded by the board's `scrollback` cap (Phase 3, ≤50k lines).
 *
 * MAIN-only + Electron-free (explicit `projectDir`) so it unit-tests without Electron. Every write is
 * atomic (`write-file-atomic`) and best-effort — a snapshot is regenerable session state, never fatal.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import { isSafeId } from './safeId'

const CANVAS_DIR = '.canvas'
const TERMINAL_DIR = 'terminal'
const EXT = '.snapshot'

/**
 * Hard ceiling on a persisted snapshot (bytes). `serialize()` is already bounded by the board's
 * scrollback cap (≤50k lines, ~70 MB worst case), so this is defense-in-depth: an oversized blob is
 * SKIPPED, never truncated — tail-truncating ANSI would slice an escape sequence mid-stream and
 * garble the restore. 64 MB sits below the worst case so a pathological buffer can't bloat the repo.
 */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

/** The per-project terminal snapshot dir (created lazily on first write). */
export function terminalSnapshotDir(projectDir: string): string {
  return join(projectDir, CANVAS_DIR, TERMINAL_DIR)
}

/**
 * Absolute sidecar path for a board, or null when the id is not a path-safe token. Board ids arrive
 * over IPC, so the same `isSafeId` guard the memory writers use keeps writes inside `terminal/`
 * (no `.`/`/`/`\` → no traversal; length-capped → no ENAMETOOLONG).
 */
export function terminalSnapshotPath(projectDir: string, boardId: string): string | null {
  if (!isSafeId(boardId)) return null
  return join(terminalSnapshotDir(projectDir), `${boardId}${EXT}`)
}

/**
 * Persist the serialized ANSI buffer. Returns true on write; false on a rejected id / non-string /
 * oversized blob / fs error (ENOSPC, EPERM, read-only mount — all non-fatal for regenerable state).
 */
export function writeTerminalSnapshot(projectDir: string, boardId: string, text: string): boolean {
  const file = terminalSnapshotPath(projectDir, boardId)
  if (!file || typeof text !== 'string') return false
  if (Buffer.byteLength(text, 'utf8') > MAX_SNAPSHOT_BYTES) {
    console.warn(`[terminalSnapshot] ${boardId} snapshot exceeds ${MAX_SNAPSHOT_BYTES}B — skipped`)
    return false
  }
  try {
    mkdirSync(terminalSnapshotDir(projectDir), { recursive: true })
    writeFileAtomic.sync(file, text, 'utf8')
    return true
  } catch (err) {
    console.warn('[terminalSnapshot] write failed (non-fatal)', err)
    return false
  }
}

/** Read a board's snapshot, or null when absent / unreadable / rejected id. Never throws. */
export function readTerminalSnapshot(projectDir: string, boardId: string): string | null {
  const file = terminalSnapshotPath(projectDir, boardId)
  if (!file || !existsSync(file)) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** Delete a board's snapshot (called when the board is removed). Safe no-op if absent / bad id. */
export function deleteTerminalSnapshot(projectDir: string, boardId: string): void {
  const file = terminalSnapshotPath(projectDir, boardId)
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* best-effort — a lingering sidecar is git-ignored noise, not a failure */
  }
}
