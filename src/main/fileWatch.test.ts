import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { createFileWatcher, shouldIgnore, toTreeEvent } from './fileWatch'

// Build inputs with path.join so they are native to the running OS (CI unit leg = Linux,
// local = Windows) — the helpers lean on path.relative, which is OS-specific, but the
// forward-slash output contract is not.
const ROOT = path.resolve('proj-root')
const at = (...segs: string[]): string => path.join(ROOT, ...segs)

describe('fileWatch.shouldIgnore', () => {
  it('never ignores the root itself', () => {
    expect(shouldIgnore(ROOT, ROOT)).toBe(false)
  })
  it('ignores .git / node_modules at any depth + canvas.json.bak', () => {
    expect(shouldIgnore(ROOT, at('node_modules', 'react', 'index.js'))).toBe(true)
    expect(shouldIgnore(ROOT, at('.git', 'config'))).toBe(true)
    expect(shouldIgnore(ROOT, at('packages', 'a', 'node_modules', 'x'))).toBe(true)
    expect(shouldIgnore(ROOT, at('canvas.json.bak'))).toBe(true)
  })
  it('watches real project files (incl. the live canvas.json)', () => {
    expect(shouldIgnore(ROOT, at('src', 'index.ts'))).toBe(false)
    expect(shouldIgnore(ROOT, at('canvas.json'))).toBe(false)
    expect(shouldIgnore(ROOT, at('README.md'))).toBe(false)
  })
})

describe('fileWatch.toTreeEvent', () => {
  it('emits a root-relative, forward-slashed path', () => {
    expect(toTreeEvent(ROOT, 'add', at('src', 'a.ts'))).toEqual({ type: 'add', path: 'src/a.ts' })
    expect(toTreeEvent(ROOT, 'change', at('readme.md'))).toEqual({
      type: 'change',
      path: 'readme.md'
    })
  })
  it('folds dir add/remove into add/unlink', () => {
    expect(toTreeEvent(ROOT, 'addDir', at('docs'))).toEqual({ type: 'add', path: 'docs' })
    expect(toTreeEvent(ROOT, 'unlinkDir', at('docs'))).toEqual({ type: 'unlink', path: 'docs' })
  })
  it('returns null for the root itself', () => {
    expect(toTreeEvent(ROOT, 'change', ROOT)).toBeNull()
  })
})

describe('createFileWatcher (FIND-003 — a failed chokidar import must not crash MAIN)', () => {
  it('watch() resolves (never rejects) when the lazy chokidar import fails', async () => {
    // Simulate a corrupt / asar-unresolvable ESM module: the dynamic `import('chokidar')` rejects.
    vi.doMock('chokidar', () => {
      throw new Error('simulated unresolvable chokidar ESM module')
    })
    try {
      const watcher = createFileWatcher(() => null)
      // The bug: index.ts calls `void fileWatcher?.watch(dir)` (fire-and-forget, no .catch), so a
      // rejection escapes to the global unhandledRejection sink → crashShutdown → app.exit(1).
      // The fix makes watch() own the error and degrade — it must RESOLVE, not reject.
      await expect(watcher.watch(path.resolve('proj-root'))).resolves.toBeUndefined()
    } finally {
      vi.doUnmock('chokidar')
    }
  })
})
