import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvasMemory, scaffoldProjectMemory } from './canvasMemory'

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
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('*\n')
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
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('*\n')
    })

    it('opt-in commit rewrites the ignore to ignore only audit/', () => {
      const m = createCanvasMemory(dir)
      m.ensureScaffold()
      m.setCommitOptIn(true)
      expect(m.isCommitted()).toBe(true)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('audit/\n')
    })

    it('opt-out restores private', () => {
      const m = createCanvasMemory(dir)
      m.setCommitOptIn(true)
      m.setCommitOptIn(false)
      expect(m.isCommitted()).toBe(false)
      expect(readFileSync(m.paths.gitignore, 'utf8')).toBe('*\n')
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
})
