// src/main/terminalImageStaging.ts
/**
 * Stage clipboard/dropped images for the agent. A PTY carries only text, so an image
 * is written to <project>/.canvas/tmp/ and its file path is injected into the terminal
 * (Claude Code and most agents accept an image file-path reference). Self-contained
 * cleanup: prune-on-stage by age + per-board cleanup when the terminal is torn down.
 * MAIN-only; the renderer never writes files.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs'
import { randomBytes } from 'node:crypto'
import { join } from 'path'
import { isSafeId } from './safeId'

// Module-level seq is kept for uniqueness WITHIN a single session (monotonic ordering).
// A random component is added per call to prevent collisions ACROSS restarts: board ids
// persist in canvas.json but seq resets on every launch (BUG-026).
let seq = 0
const PREFIX = 'paste-'
/** Default prune age: files older than this are removed when a new one is staged. */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000 // 1h

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
  // Reject (rather than coalesce onto a shared fallback token) so two distinct-but-unsafe
  // board ids can never collide onto the same filename prefix (BUG-039).
  if (!isSafeId(boardId)) throw new Error(`terminalImageStaging: unsafe boardId "${boardId}"`)
  const dir = stagedDir(projectDir)
  mkdirSync(dir, { recursive: true })
  pruneOld(dir, maxAgeMs)
  seq += 1
  // Append a short random hex suffix so filenames are collision-free across app restarts
  // (seq resets to 0 on every launch while board ids and staged files persist up to 1h).
  const rand = randomBytes(4).toString('hex')
  const file = join(dir, `${PREFIX}${boardId}-${seq}-${rand}.png`)
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
  // No-op on an unsafe/empty-after-sanitize id rather than coalescing onto a shared
  // 'board' fallback token, which would delete another board's still-live staged files
  // (BUG-039). Best-effort — never throws.
  if (!isSafeId(boardId)) return
  const dir = stagedDir(projectDir)
  const token = `${PREFIX}${boardId}-`
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
