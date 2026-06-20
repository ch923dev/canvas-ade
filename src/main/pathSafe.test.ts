import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveWithinRoot, realResolveWithinRoot } from './pathSafe'

// A realpath'd tmp root (callers always pass a realpath'd root; on macOS os.tmpdir() is a
// /var → /private/var symlink, so realpath here keeps the boundary math honest).
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pathsafe-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveWithinRoot — lexical containment', () => {
  // ── MUST REJECT ──
  const REJECT: Array<[string, string]> = [
    ['parent traversal', '../etc/passwd'],
    ['re-escaping traversal', 'a/../../b'],
    ['posix absolute', '/etc/passwd'],
    ['windows drive absolute', 'C:\\Windows\\win.ini'],
    ['drive-relative (path.isAbsolute is false for this)', 'C:foo'],
    ['UNC share', '\\\\srv\\share\\x'],
    ['extended/device prefix', '\\\\?\\C:\\x'],
    ['trailing dot on component (Windows strips it)', 'secret.txt.'],
    ['trailing space on component (Windows strips it)', 'secret.txt '],
    ['reserved device name CON', 'CON'],
    ['reserved device name with ext NUL.txt', 'nul.txt'],
    ['alternate data stream colon', 'x.txt:ads'],
    // Prefix-collision sibling: a path that resolves to <root>-evil/x must NOT count as
    // "within <root>" — the classic startsWith(root) bug. `../<basename>-evil/x` resolves
    // to a sibling dir sharing the root's name prefix.
    ['prefix-collision sibling', `../${'x'}-evil/x`]
  ]
  for (const [label, input] of REJECT) {
    it(`rejects ${label}: ${JSON.stringify(input)}`, () => {
      expect(() => resolveWithinRoot(root, input)).toThrow()
    })
  }

  it('rejects a NUL byte in the path', () => {
    expect(() => resolveWithinRoot(root, 'foo\0.txt')).toThrow()
  })

  it('rejects a prefix-collision sibling that resolves to <root>-evil', () => {
    // Construct an input that path.resolve(root, input) lands exactly at `${root}-evil/x`.
    const sibling = `../${root.split(/[\\/]/).pop()}-evil/x`
    expect(() => resolveWithinRoot(root, sibling)).toThrow()
  })

  // ── MUST ACCEPT ──
  const ACCEPT: Array<[string, string]> = [
    ['a top-level file', 'README.md'],
    ['a nested file', 'src/a.ts'],
    ['empty string maps to root', ''],
    ['dot maps to root', '.'],
    ['in-bounds traversal', 'a/b/../c.txt'],
    ['a name with spaces', 'My File.txt'],
    // `%` is a legal filename char and Node fs never URL-decodes — must be accepted, and a
    // literal `%2e%2e` segment is a real dir name (contained), NOT `..` traversal.
    ['a literal percent in the name', 'report%20final.pdf'],
    ['a literal %2e%2e directory (not traversal)', '%2e%2e/x'],
    // Windows only strips TRAILING dot/space; a space before the extension is a distinct name.
    ['a space before the extension', 'foo .txt']
  ]
  for (const [label, input] of ACCEPT) {
    it(`accepts ${label}: ${JSON.stringify(input)}`, () => {
      const out = resolveWithinRoot(root, input)
      // Always an absolute path equal-to-or-under the root.
      expect(out === root || out.startsWith(root)).toBe(true)
    })
  }

  it('empty and dot both resolve to the root itself', () => {
    expect(resolveWithinRoot(root, '')).toBe(root)
    expect(resolveWithinRoot(root, '.')).toBe(root)
  })
})

describe('realResolveWithinRoot — physical (symlink/junction) layer', () => {
  it('accepts an existing in-root file', async () => {
    writeFileSync(join(root, 'README.md'), 'hi')
    const out = await realResolveWithinRoot(root, 'README.md')
    expect(out).toBe(realpathSync(join(root, 'README.md')))
  })

  it('accepts a not-yet-existing write target (realpaths the parent)', async () => {
    mkdirSync(join(root, 'sub'))
    const out = await realResolveWithinRoot(root, 'sub/new.txt')
    expect(out).toBe(join(realpathSync(join(root, 'sub')), 'new.txt'))
  })

  it('rejects an in-root symlink that points OUTSIDE the root', async () => {
    // Create a target dir OUTSIDE the root, then a symlink inside the root → it.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'pathsafe-outside-')))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'top secret')
      let symlinkable = true
      try {
        symlinkSync(outside, join(root, 'link'), 'junction')
      } catch {
        // Windows without the privilege / a CI sandbox can't create links — skip gracefully.
        symlinkable = false
      }
      if (!symlinkable) return
      await expect(realResolveWithinRoot(root, 'link/secret.txt')).rejects.toThrow()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
