import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryDoc } from '@expanse-ade/mcp'
import { getCurrentDir } from './projectStore'
import { isSafeId } from './safeId'

/**
 * Read-only access to the project's persistent memory for the MCP layer (T1.7 🔒).
 *
 * The sibling Brain/Memory engine (Context subsystem, SHIPPED on `main`) writes
 * `<project>/.canvas/memory/` — `MEMORY.md` (project index) + `board-<id>.md` (per-board
 * summaries) via the Tier-2 summaryLoop. The files are present once a board has been
 * summarized, but every read still GRACEFULLY EMPTIES to `{ present: false, text: '' }` when
 * a file is absent (no key / not yet summarized / no project open) — never an error. 🔒 PASSIVE
 * context only: read-only, no write path, exposes no action; and the board id (agent-controlled,
 * arriving via the `canvas://board/{id}/summary` URI) is validated against a strict charset so it
 * can NEVER traverse out of the memory dir. ⚠️ The served summary is LLM-GENERATED → untrusted:
 * an agent consuming it can be prompt-injected by its content (see ADR 0003 › M-expose residual).
 */

/** Cap a single memory doc so a huge file can't be dumped in one read (defense-in-depth). */
const MAX_MEMORY_CHARS = 100_000

// MCP-07: the board-id charset + length cap (BUG-019) live in the shared `safeId` module so this
// MCP reader and canvasMemory's writer enforce the SAME path-safety contract. `isSafeId` rejects a
// non-string / empty / over-long / out-of-charset id before it can reach join() (no traversal, no
// ~100k-char path handed to existsSync/readFileSync → ENAMETOOLONG).

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
  if (!root || !isSafeId(id)) return { present: false, text: '' }
  return readDoc(join(root, `board-${id}.md`))
}
