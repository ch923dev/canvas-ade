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

const CANVAS_DIR = '.canvas'
const MEMORY_DIR = 'memory'
const AUDIT_DIR = 'audit'
const GITIGNORE = '.gitignore'

/** Default-private: ignore the whole `.canvas/` from git. */
const IGNORE_PRIVATE = '*\n'
/** Opt-in commit: keep the prose, ignore only the volatile audit log. */
const IGNORE_COMMITTED = 'audit/\n'

/** Board ids are nanoid-style; reject anything else to keep writes inside memory/. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/
export function safeBoardId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && SAFE_ID.test(id)
}

export interface CanvasMemoryPaths {
  root: string
  memoryDir: string
  auditDir: string
  gitignore: string
  index: string
  project: string
  board(id: string): string
}

export interface CanvasMemory {
  paths: CanvasMemoryPaths
  ensureScaffold(): void
  writeBoard(id: string, md: string): boolean
  writeIndex(md: string): void
  writeProject(md: string): void
  readBoard(id: string): string | undefined
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
    board: (id) => join(memoryDir, `board-${id}.md`)
  }

  return {
    paths,
    ensureScaffold() {
      mkdirSync(memoryDir, { recursive: true })
      mkdirSync(auditDir, { recursive: true })
      // Write the default-private ignore only if absent — never clobber a user opt-in.
      if (!existsSync(gitignore)) {
        writeFileAtomic.sync(gitignore, IGNORE_PRIVATE, 'utf8')
      }
    },
    writeBoard(id, md) {
      if (!safeBoardId(id)) return false
      mkdirSync(memoryDir, { recursive: true })
      writeFileAtomic.sync(paths.board(id), md, 'utf8')
      return true
    },
    writeIndex(md) {
      mkdirSync(memoryDir, { recursive: true })
      writeFileAtomic.sync(paths.index, md, 'utf8')
    },
    writeProject(md) {
      mkdirSync(memoryDir, { recursive: true })
      writeFileAtomic.sync(paths.project, md, 'utf8')
    },
    readBoard(id) {
      if (!safeBoardId(id)) return undefined
      return readMd(paths.board(id))
    },
    readIndex() {
      return readMd(paths.index)
    },
    readProject() {
      return readMd(paths.project)
    },
    setCommitOptIn(commit) {
      mkdirSync(root, { recursive: true })
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
