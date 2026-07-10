import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createCanvasMemory,
  safeBoardId,
  scaffoldProjectMemory,
  upgradeProjectGitignore
} from './canvasMemory'

// ADR 0009 ignore templates: default-private tracks ONLY canvas.json; committed also versions
// assets/ + memory/ and ignores only the volatile files.
const IGNORE_PRIVATE = '*\n!canvas.json\n'
const IGNORE_COMMITTED = 'audit/\ntmp/\nterminal/\ncanvas.json.bak\nsession.json\n'

describe('canvasMemory', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'canvasmem-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('paths', () => {
    it('resolves the .canvas tree under the project dir', () => {
      const m = createCanvasMemory(dir)
      expect(m.paths.root).toBe(join(dir, '.canvas'))
      expect(m.paths.memoryDir).toBe(join(dir, '.canvas', 'memory'))
      expect(m.paths.auditDir).toBe(join(dir, '.canvas', 'audit'))
      expect(m.paths.gitignore).toBe(join(dir, '.canvas', '.gitignore'))
      expect(m.paths.index).toBe(join(dir, '.canvas', 'memory', 'MEMORY.md'))
      expect(m.paths.project).toBe(join(dir, '.canvas', 'memory', 'project.md'))
      expect(m.paths.board('abc')).toBe(join(dir, '.canvas', 'memory', 'board-abc.md'))
    })
  })

  describe('ensureScaffold', () => {
    it('creates memory/ + audit/ dirs and a default-private .gitignore', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(statSync(m.paths.memoryDir).isDirectory()).toBe(true)
      expect(statSync(m.paths.auditDir).isDirectory()).toBe(true)
      expect(existsSync(m.paths.gitignore)).toBe(true)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_PRIVATE)
    })

    it('is idempotent and does NOT clobber an existing .gitignore', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      m.setCommitOptIn(true)
      const committed = readFileSync(m.paths.gitignore, 'utf8')
      m.ensureScaffold()
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(committed)
    })

    it('does NOT seed stub MEMORY.md / project.md content', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(existsSync(m.paths.index)).toBe(false)
      expect(existsSync(m.paths.project)).toBe(false)
    })
  })

  describe('board summaries', () => {
    it('round-trips a board markdown file under memory/', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      const ok = m.writeBoard('term1', '# Terminal\n\nRuns pnpm dev\n')
      expect(ok).toBe(true)
      expect(existsSync(m.paths.board('term1'))).toBe(true)
      expect(m.readBoard('term1')).toBe('# Terminal\n\nRuns pnpm dev\n')
    })

    it('returns undefined for a missing board file (never throws)', () => {
      const m = createCanvasMemory(dir)
      expect(m.readBoard('nope')).toBeUndefined()
    })

    it('creates memory/ on writeBoard even without ensureScaffold', () => {
      const m = createCanvasMemory(dir)
      expect(m.writeBoard('b1', 'hi')).toBe(true)
      expect(m.readBoard('b1')).toBe('hi')
    })

    it('rejects an unsafe board id (path-traversal defense)', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(m.writeBoard('../evil', 'x')).toBe(false)
      expect(m.writeBoard('a/b', 'x')).toBe(false)
      expect(m.writeBoard('', 'x')).toBe(false)
      expect(m.readBoard('../evil')).toBeUndefined()
      expect(existsSync(join(dir, 'evil'))).toBe(false)
      expect(existsSync(join(dir, '.canvas', 'evil'))).toBe(false)
    })
  })

  describe('index + project', () => {
    it('round-trips MEMORY.md', () => {
      const m = createCanvasMemory(dir)
      m.writeIndex('# Context memory\n\n- [Terminal](board-term1.md)\n')
      expect(m.readIndex()).toBe('# Context memory\n\n- [Terminal](board-term1.md)\n')
    })

    it('round-trips project.md', () => {
      const m = createCanvasMemory(dir)
      m.writeProject('# Project\n\nA canvas.\n')
      expect(m.readProject()).toBe('# Project\n\nA canvas.\n')
    })

    it('returns undefined for missing index/project (never throws)', () => {
      const m = createCanvasMemory(dir)
      expect(m.readIndex()).toBeUndefined()
      expect(m.readProject()).toBeUndefined()
    })

    it('writes only under the project dir, never elsewhere', () => {
      const m = createCanvasMemory(dir)
      m.writeIndex('x')
      m.writeProject('y')
      m.writeBoard('b', 'z')
      expect(m.paths.index.startsWith(join(dir, '.canvas'))).toBe(true)
      expect(m.paths.project.startsWith(join(dir, '.canvas'))).toBe(true)
      expect(m.paths.board('b').startsWith(join(dir, '.canvas'))).toBe(true)
    })
  })

  describe('commit toggle', () => {
    it('defaults to private (uncommitted) after scaffold', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      expect(m.isCommitted()).toBe(false)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_PRIVATE)
    })

    it('opt-in commit rewrites the ignore to track canvas.json + assets/ + memory/ (ADR 0009)', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      m.setCommitOptIn(true)
      expect(m.isCommitted()).toBe(true)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_COMMITTED)
    })

    it('opt-out restores private', () => {
      const m = createCanvasMemory(dir)
      m.setCommitOptIn(true)
      m.setCommitOptIn(false)
      expect(m.isCommitted()).toBe(false)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_PRIVATE)
    })

    it('BUG-017: setCommitOptIn on a fresh project creates the FULL scaffold (memory/ + audit/)', () => {
      // Pre-fix this only mkdir-ed root + wrote .gitignore, leaving memory/ and audit/ absent until
      // the next write — a partial, inconsistent on-disk tree.
      const m = createCanvasMemory(dir)
      m.setCommitOptIn(true) // no prior ensureScaffold
      expect(statSync(m.paths.memoryDir).isDirectory()).toBe(true)
      expect(statSync(m.paths.auditDir).isDirectory()).toBe(true)
      expect(existsSync(m.paths.gitignore)).toBe(true)
    })

    it('isCommitted is false when no .gitignore exists', () => {
      const m = createCanvasMemory(dir)
      expect(m.isCommitted()).toBe(false)
    })

    it('treats an empty / unrecognized .gitignore as private (safe default)', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      writeFileSync(m.paths.gitignore, '', 'utf8')
      expect(m.isCommitted()).toBe(false)
      writeFileSync(m.paths.gitignore, '# hand-edited\nnode_modules/\n', 'utf8')
      expect(m.isCommitted()).toBe(false)
    })
  })

  describe('scaffoldProjectMemory', () => {
    it('scaffolds like ensureScaffold on a valid dir', () => {
      scaffoldProjectMemory(dir)
      expect(existsSync(join(dir, '.canvas', 'memory'))).toBe(true)
      expect(existsSync(join(dir, '.canvas', 'audit'))).toBe(true)
    })

    it('swallows errors (never throws) — a project must still open', () => {
      // Point the "project dir" at a FILE: mkdir under it throws (ENOTDIR/EEXIST).
      // The guard must swallow it so project:open / createProject are never aborted.
      const f = join(dir, 'a-file')
      writeFileSync(f, 'x', 'utf8')
      expect(() => scaffoldProjectMemory(f)).not.toThrow()
      expect(existsSync(join(f, '.canvas'))).toBe(false)
    })
  })

  describe('upgradeProjectGitignore (ADR 0009)', () => {
    it('remaps the legacy `*` private ignore to the new private template', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      writeFileSync(m.paths.gitignore, '*\n', 'utf8') // pre-0009 private
      upgradeProjectGitignore(dir)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_PRIVATE)
    })

    it('remaps the legacy `audit/` committed ignore to the new committed template', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      writeFileSync(m.paths.gitignore, 'audit/\n', 'utf8') // pre-0009 committed
      upgradeProjectGitignore(dir)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_COMMITTED)
    })

    it('remaps the pre-S3 committed ignore (no terminal/) to the current template', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      writeFileSync(m.paths.gitignore, 'audit/\ntmp/\ncanvas.json.bak', 'utf8') // pre-S3 committed
      upgradeProjectGitignore(dir)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_COMMITTED)
    })

    it('M1: remaps the pre-session-sidecar committed ignore to ignore session.json', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      // The pre-M1 committed body (with terminal/, WITHOUT session.json).
      writeFileSync(m.paths.gitignore, 'audit/\ntmp/\nterminal/\ncanvas.json.bak', 'utf8')
      upgradeProjectGitignore(dir)
      const body = readFileSync(m.paths.gitignore, 'utf8')
      expect(body).toBe(IGNORE_COMMITTED)
      expect(body).toContain('session.json') // an opted-in project now ignores the machine-local sidecar
    })

    it('leaves a user-customised ignore untouched, and is a no-op when absent', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      writeFileSync(m.paths.gitignore, '# mine\n*.log\n', 'utf8')
      upgradeProjectGitignore(dir)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('# mine\n*.log\n')

      // Absent ignore: no throw, no file created (ensureScaffold writes the new private later).
      const bare = mkdtempSync(join(tmpdir(), 'cm-bare-'))
      try {
        expect(() => upgradeProjectGitignore(bare)).not.toThrow()
        expect(existsSync(join(bare, '.canvas', '.gitignore'))).toBe(false)
      } finally {
        rmSync(bare, { recursive: true, force: true })
      }
    })

    it('is symmetric: an already-new ignore is left as-is', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold() // writes the new private template
      upgradeProjectGitignore(dir)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe(IGNORE_PRIVATE)
    })
  })
})

describe('safeBoardId — length cap (T-M3)', () => {
  it('rejects an over-long id (> 64 chars) even if every char is in the alphabet', () => {
    expect(safeBoardId('a'.repeat(64))).toBe(true)
    expect(safeBoardId('a'.repeat(65))).toBe(false)
  })
})

describe('canvasMemory writers — non-fatal on a disk error (T-M3)', () => {
  it('writeBoard returns false (does not throw) when the project path is unwritable', () => {
    // projectDir points at a FILE, so mkdirSync(<file>/.canvas/memory) throws ENOTDIR/EEXIST.
    const dir = mkdtempSync(join(tmpdir(), 'cm-bad-'))
    const asFile = join(dir, 'not-a-dir')
    writeFileSync(asFile, 'x')
    try {
      const mem = createCanvasMemory(asFile)
      expect(() => mem.writeBoard('b1', '# hi')).not.toThrow()
      expect(mem.writeBoard('b1', '# hi')).toBe(false)
      expect(() => mem.writeIndex('# idx')).not.toThrow()
      expect(() => mem.writeProject('# proj')).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
