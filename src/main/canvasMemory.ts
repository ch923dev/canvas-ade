/**
 * T-M1: the persistent `<project>/.canvas/` memory engine. Resolves the memory paths and
 * provides atomic markdown writers/readers + a default-private `.gitignore` with an
 * opt-in-to-commit toggle. PROJECT data (rooted at the project folder, NOT userData) —
 * the opposite of llmConfig/llmKeyStore/llmBudget. Electron-free (explicit `projectDir`)
 * so it unit-tests without Electron. The Tier-2 loop (T-M3) writes through these; the
 * panel (T-M4) reads through them. Generated memory is UNTRUSTED PASSIVE context — it is
 * written + read/displayed and NEVER triggers an action. The API key is NEVER here.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import { isSafeId } from './safeId'

const CANVAS_DIR = '.canvas'
const MEMORY_DIR = 'memory'
const AUDIT_DIR = 'audit'
const GITIGNORE = '.gitignore'

/**
 * Default-private (ADR 0009): track ONLY the canvas document. The binary asset blobs, the
 * parse-fail backup, generated memory, the audit log, the terminal staging dir, and the terminal
 * scrollback snapshots (Phase 5 S3) stay ignored — `canvas.json` is text + diffable, the rest is
 * volatile or binary noise in the user's repo. (`*` already covers `terminal/`.)
 */
const IGNORE_PRIVATE = '*\n!canvas.json\n'
/**
 * Opt-in commit (ADR 0009): version the durable project content — `canvas.json` + `assets/` +
 * generated `memory/` — so a shared/checked-in canvas is complete with its images. Ignore only
 * volatile state (the audit log, the terminal staging dir, the terminal snapshots, and the
 * parse-fail backup).
 */
const IGNORE_COMMITTED = 'audit/\ntmp/\nterminal/\ncanvas.json.bak\nsession.json\n'

/** Old (pre-0009) ignore bodies, recognized + remapped to the new ones on migrate-on-open. */
const LEGACY_IGNORE_PRIVATE = '*'
const LEGACY_IGNORE_COMMITTED = 'audit/'
/** Pre-S3 committed body (no `terminal/`) — remapped to the current one so an already-opted-in
 *  project starts ignoring the new snapshot sidecars on its next open. */
const LEGACY_IGNORE_COMMITTED_V2 = 'audit/\ntmp/\ncanvas.json.bak'
/** M1: pre-session-sidecar committed body (no `session.json`) — remapped so an opted-in project
 *  starts ignoring the machine-local camera/backdrop sidecar on its next open. */
const LEGACY_IGNORE_COMMITTED_V3 = 'audit/\ntmp/\nterminal/\ncanvas.json.bak'

/** Board ids are nanoid-style; reject anything else (and over-long) to keep writes inside memory/.
 *  MCP-07: the regex + length cap now live in the shared `safeId` module so this and boardMemory.ts
 *  can't drift. Kept as a named export — projectIpc imports `safeBoardId` at the IPC ingress. */
export function safeBoardId(id: string): boolean {
  return isSafeId(id)
}

export interface CanvasMemoryPaths {
  root: string
  memoryDir: string
  auditDir: string
  gitignore: string
  index: string
  project: string
  board(id: string): string
  /** S1 (recap redesign): the structured recap sidecar the rebuilt RecapView renders. */
  boardRecap(id: string): string
}

export interface CanvasMemory {
  paths: CanvasMemoryPaths
  ensureScaffold(): void
  writeBoard(id: string, md: string): boolean
  writeIndex(md: string): void
  writeProject(md: string): void
  readBoard(id: string): string | undefined
  /** S1: JSON twin of writeBoard/readBoard for `board-<id>.recap.json` (same id guard). */
  writeBoardRecap(id: string, data: unknown): boolean
  readBoardRecap(id: string): unknown
  readIndex(): string | undefined
  readProject(): string | undefined
  setCommitOptIn(commit: boolean): void
  isCommitted(): boolean
}

function readMd(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export function createCanvasMemory(projectDir: string): CanvasMemory {
  const root = join(projectDir, CANVAS_DIR)
  const memoryDir = join(root, MEMORY_DIR)
  const auditDir = join(root, AUDIT_DIR)
  const gitignore = join(root, GITIGNORE)
  const paths: CanvasMemoryPaths = {
    root,
    memoryDir,
    auditDir,
    gitignore,
    index: join(memoryDir, 'MEMORY.md'),
    project: join(memoryDir, 'project.md'),
    board: (id) => join(memoryDir, `board-${id}.md`),
    boardRecap: (id) => join(memoryDir, `board-${id}.recap.json`)
  }

  // BUG-017: the canonical .canvas/ tree = memory/ + audit/. Both ensureScaffold and
  // setCommitOptIn must create the full set, not just root, so the on-disk scaffold is never left
  // in an inconsistent partial state (root + .gitignore but no memory/ or audit/).
  const ensureDirs = (): void => {
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(auditDir, { recursive: true })
  }

  return {
    paths,
    ensureScaffold() {
      ensureDirs()
      // Write the default-private ignore only if absent — never clobber a user opt-in.
      if (!existsSync(gitignore)) {
        writeFileAtomic.sync(gitignore, IGNORE_PRIVATE, 'utf8')
      }
    },
    writeBoard(id, md) {
      if (!safeBoardId(id)) return false
      try {
        mkdirSync(memoryDir, { recursive: true })
        writeFileAtomic.sync(paths.board(id), md, 'utf8')
        return true
      } catch (err) {
        console.warn('[canvasMemory] writeBoard failed (non-fatal)', err)
        return false
      }
    },
    writeIndex(md) {
      try {
        mkdirSync(memoryDir, { recursive: true })
        writeFileAtomic.sync(paths.index, md, 'utf8')
      } catch (err) {
        console.warn('[canvasMemory] writeIndex failed (non-fatal)', err)
      }
    },
    writeProject(md) {
      try {
        mkdirSync(memoryDir, { recursive: true })
        writeFileAtomic.sync(paths.project, md, 'utf8')
      } catch (err) {
        console.warn('[canvasMemory] writeProject failed (non-fatal)', err)
      }
    },
    readBoard(id) {
      if (!safeBoardId(id)) return undefined
      return readMd(paths.board(id))
    },
    writeBoardRecap(id, data) {
      if (!safeBoardId(id)) return false
      try {
        mkdirSync(memoryDir, { recursive: true })
        writeFileAtomic.sync(paths.boardRecap(id), JSON.stringify(data), 'utf8')
        return true
      } catch (err) {
        console.warn('[canvasMemory] writeBoardRecap failed (non-fatal)', err)
        return false
      }
    },
    readBoardRecap(id) {
      if (!safeBoardId(id)) return undefined
      const raw = readMd(paths.boardRecap(id))
      if (raw === undefined) return undefined
      try {
        return JSON.parse(raw)
      } catch {
        return undefined // corrupt/hand-edited sidecar reads as absent, never throws
      }
    },
    readIndex() {
      return readMd(paths.index)
    },
    readProject() {
      return readMd(paths.project)
    },
    setCommitOptIn(commit) {
      // BUG-017: create the full scaffold (memory/ + audit/), not just root, so toggling the commit
      // flag on a fresh project never leaves a partial tree (root + .gitignore but no memory/audit).
      ensureDirs()
      writeFileAtomic.sync(gitignore, commit ? IGNORE_COMMITTED : IGNORE_PRIVATE, 'utf8')
    },
    isCommitted() {
      // Symmetric with the write side: committed ONLY when the ignore matches the
      // committed value. An empty / corrupt / user-edited ignore reads as private (the
      // safe default), not as "committed" (which negating `*` would wrongly imply).
      const raw = readMd(gitignore)
      if (raw === undefined) return false
      return raw.trim() === IGNORE_COMMITTED.trim()
    }
  }
}

/**
 * ADR 0009: a project migrated from the legacy root layout still carries the OLD
 * `.canvas/.gitignore` (`*` = ignore everything), which would silently un-track the now-relocated
 * `canvas.json`. Map a RECOGNIZED old body to its new equivalent; leave an absent or
 * user-customised ignore file untouched (the safe default). Best-effort — never throws, so the
 * migration that calls it can't abort a project open.
 */
export function upgradeProjectGitignore(projectDir: string): void {
  try {
    const file = join(projectDir, CANVAS_DIR, GITIGNORE)
    const raw = readMd(file)
    if (raw === undefined) return // absent → ensureScaffold writes the new private when scaffolding
    const body = raw.trim()
    if (body === LEGACY_IGNORE_PRIVATE) writeFileAtomic.sync(file, IGNORE_PRIVATE, 'utf8')
    else if (
      body === LEGACY_IGNORE_COMMITTED ||
      body === LEGACY_IGNORE_COMMITTED_V2 ||
      body === LEGACY_IGNORE_COMMITTED_V3
    )
      writeFileAtomic.sync(file, IGNORE_COMMITTED, 'utf8')
    // else: already the new format, or user-customised → leave as-is.
  } catch (err) {
    console.warn('[canvasMemory] gitignore upgrade failed (non-fatal)', err)
  }
}

/**
 * Best-effort scaffold for the project lifecycle. Memory setup must NEVER block opening or
 * creating a project, so a permission/disk error (EACCES/ENOSPC on a read-only mount,
 * network share, or OneDrive-backed folder) is logged and swallowed — the project still
 * opens and the Tier-1 digest still works with no memory. Mirrors project:save's
 * try/catch error-safety discipline; the sync IPC open handlers must not propagate this.
 */
export function scaffoldProjectMemory(projectDir: string): void {
  try {
    createCanvasMemory(projectDir).ensureScaffold()
  } catch (err) {
    console.warn(
      '[canvasMemory] ensureScaffold failed — non-fatal, project opens without memory',
      err
    )
  }
}
