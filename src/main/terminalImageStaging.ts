// src/main/terminalImageStaging.ts
/**
 * Stage clipboard/dropped images for the agent. A PTY carries only text, so an image
 * is written to <project>/.canvas/tmp/ and its file path is injected into the terminal
 * (Claude Code and most agents accept an image file-path reference). Self-contained
 * cleanup: prune-on-stage by age + per-board cleanup when the terminal is torn down.
 * MAIN-only; the renderer never writes files.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

let seq = 0
const PREFIX = 'paste-'
/** Default prune age: files older than this are removed when a new one is staged. */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000 // 1h

/** Sanitize a board id into a filename-safe token (no separators / dots). */
function safeId(boardId: string): string {
  return boardId.replace(/[^a-zA-Z0-9_-]/g, '') || 'board'
}

/** The per-project staging directory (created lazily on first stage). */
export function stagedDir(projectDir: string): string {
  return join(projectDir, '.canvas', 'tmp')
}

/**
 * Write `png` to the staging dir and return its absolute path. Also prunes any staged
 * file older than `maxAgeMs` (best-effort) so the dir can't grow unbounded.
 */
export function stageClipboardImage(
  projectDir: string,
  boardId: string,
  png: Buffer,
  maxAgeMs = DEFAULT_MAX_AGE_MS
): string {
  const dir = stagedDir(projectDir)
  mkdirSync(dir, { recursive: true })
  pruneOld(dir, maxAgeMs)
  seq += 1
  const file = join(dir, `${PREFIX}${safeId(boardId)}-${seq}.png`)
  writeFileSync(file, png)
  return file
}

/** Remove staged files older than `maxAgeMs`. Best-effort; never throws. */
function pruneOld(dir: string, maxAgeMs: number): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const n of names) {
    if (!n.startsWith(PREFIX)) continue
    const full = join(dir, n)
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full)
    } catch {
      /* best-effort */
    }
  }
}

/** Remove every staged file for `boardId` (called when its terminal is torn down). */
export function cleanupStaged(projectDir: string, boardId: string): void {
  const dir = stagedDir(projectDir)
  const token = `${PREFIX}${safeId(boardId)}-`
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith(token)) continue
    try {
      rmSync(join(dir, n))
    } catch {
      /* best-effort */
    }
  }
}
