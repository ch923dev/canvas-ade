import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryDoc } from '@ch923dev/canvas-ade-mcp'
import { getCurrentDir } from './projectStore'

/**
 * Read-only access to the project's persistent memory for the MCP layer (T1.7 🔒).
 *
 * The sibling Brain/Memory engine writes `<project>/.canvas/memory/` —
 * `MEMORY.md` (project index) + `board-<id>.md` (per-board summaries). That engine
 * ships on a separate track (its write side is deferred), so these files are usually
 * ABSENT; every read GRACEFULLY EMPTIES to `{ present: false, text: '' }` — never an
 * error. 🔒 PASSIVE context only: read-only, no write path, exposes no action; and the
 * board id (agent-controlled, arriving via the `canvas://board/{id}/summary` URI) is
 * validated against a strict charset so it can NEVER traverse out of the memory dir.
 */

/** Cap a single memory doc so a huge file can't be dumped in one read (defense-in-depth). */
const MAX_MEMORY_CHARS = 100_000

/** Board ids are uuid/nanoid-like; anything else (`.`, `/`, `\`, empty) is rejected. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/
/**
 * Upper bound on a board id (BUG-019), mirroring canvasMemory.ts's safeBoardId(). Without it,
 * an agent-controlled id of e.g. 100 000 valid chars passes the charset, reaches join(root,
 * `board-${id}.md`), and hands a ~100k-char path to existsSync/readFileSync — a wasted syscall
 * that fails with ERROR_FILENAME_EXCED_RANGE (Win) / ENAMETOOLONG (Linux). Real ids are uuid/
 * nanoid-sized, so 64 is generous.
 */
const MAX_ID_LEN = 64

/** E2E-only override of the project dir the reader resolves against (mirrors the smoke seams). */
let overrideDir: string | null = null
export function __setMemoryDirForTest(dir: string | null): void {
  overrideDir = dir
}

/** The `<project>/.canvas/memory` root, or null when no project is open. */
function memoryRoot(): string | null {
  const dir = overrideDir ?? getCurrentDir()
  return dir ? join(dir, '.canvas', 'memory') : null
}

/** Read one memory file → a capped doc; absent/unreadable → the empty shell. */
function readDoc(file: string | null): MemoryDoc {
  if (!file || !existsSync(file)) return { present: false, text: '' }
  try {
    const raw = readFileSync(file, 'utf8')
    const text = raw.length > MAX_MEMORY_CHARS ? raw.slice(0, MAX_MEMORY_CHARS) : raw
    return { present: true, text }
  } catch {
    return { present: false, text: '' }
  }
}

/** The project memory index (`MEMORY.md`), or the empty shell when absent. */
export function readProjectMemory(): MemoryDoc {
  const root = memoryRoot()
  return readDoc(root ? join(root, 'MEMORY.md') : null)
}

/** A board's memory summary (`board-<id>.md`), or the empty shell when absent/invalid id. */
export function readBoardSummary(id: string): MemoryDoc {
  const root = memoryRoot()
  if (!root || id.length > MAX_ID_LEN || !SAFE_ID.test(id)) return { present: false, text: '' }
  return readDoc(join(root, `board-${id}.md`))
}
