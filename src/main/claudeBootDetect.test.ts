import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { detectClaudeBootCwd, maybeEnsureClaudeHook } from './claudeBootDetect'
import { setRecapHookSyncProvider } from './ptySpawnEnv'

describe('detectClaudeBootCwd — the boot-banner working-dir parse', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-detect-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const banner = (cwd: string): string =>
    `PS M:\\somewhere> claude\r\nClaude Code v2.1.201\r\nSonnet 5 with xhigh effort · Claude Max\r\n${cwd}\r\n\r\n> `

  it('returns the printed dir when it exists on disk', () => {
    expect(detectClaudeBootCwd(banner(dir))).toBe(dir)
  })

  it('null without a banner, and null when no printed line is a real directory', () => {
    expect(detectClaudeBootCwd('plain shell output, no claude here')).toBeNull()
    expect(detectClaudeBootCwd(banner('Z:\\does\\not\\exist'))).toBeNull()
  })

  it('strips ANSI and still finds the dir', () => {
    const wrapped = banner(dir).replace(dir, `\x1b[2m${dir}\x1b[22m`)
    expect(detectClaudeBootCwd(wrapped)).toBe(dir)
  })

  it('uses the LAST banner in the ring — the current boot, not a scrollback ghost', () => {
    const ghost = banner('Z:\\gone')
    expect(detectClaudeBootCwd(ghost + '\r\nexit\r\n' + banner(dir))).toBe(dir)
  })

  it('ignores non-absolute lines (the tagline never parses as a path)', () => {
    // The model/plan tagline sits between the version and the cwd — must be skipped.
    expect(detectClaudeBootCwd(banner(dir))).toBe(dir)
  })

  it('review [critical]: refuses filesystem/drive roots — `/`, `C:\\`, `C:/` never resolve', () => {
    // statSync('/')/('C:\\') is a real directory, but a root is never a claude project dir —
    // a stray root-only output line must not become a hook-install target.
    for (const root of ['/', 'C:\\', 'C:/']) {
      expect(detectClaudeBootCwd(banner(root))).toBeNull()
    }
    // A real dir printed AFTER a root line still wins (root skipped, scan continues).
    expect(detectClaudeBootCwd(banner(`C:\\\r\n${dir}`))).toBe(dir)
  })
})

describe('maybeEnsureClaudeHook — the data-plane probe', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-hook-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    setRecapHookSyncProvider(undefined)
  })

  it('fires the recap-hook seam with the detected cwd when the chunk carries the banner', () => {
    const seen: { id: string; cwd: string }[] = []
    setRecapHookSyncProvider((o) => seen.push(o))
    const ring = `Claude Code v2.1.201\r\nplan line\r\n${dir}\r\n`
    maybeEnsureClaudeHook('…Claude Code v2.1.201…', () => ring, 'b1')
    expect(seen).toEqual([{ id: 'b1', cwd: dir }])
  })

  it('does not even read the ring for a chunk without the banner marker', () => {
    const ringText = vi.fn(() => '')
    maybeEnsureClaudeHook('ordinary output', ringText, 'b1')
    expect(ringText).not.toHaveBeenCalled()
  })

  it('skips the home dir (Claude Code USER scope — matches the spawn-time policy)', () => {
    const seen: unknown[] = []
    setRecapHookSyncProvider((o) => seen.push(o))
    const ring = `Claude Code v2.1.201\r\n${homedir()}\r\n`
    maybeEnsureClaudeHook('Claude Code v', () => ring, 'b1')
    expect(seen).toEqual([])
  })

  it('a throwing provider never breaks the data plane', () => {
    setRecapHookSyncProvider(() => {
      throw new Error('EACCES')
    })
    const ring = `Claude Code v2.1.201\r\n${dir}\r\n`
    expect(() => maybeEnsureClaudeHook('Claude Code v', () => ring, 'b1')).not.toThrow()
  })

  it('review [critical] dedupe: a dir already ensured for a board never re-fires the install', () => {
    // The banner marker can recur for the session's whole life (`claude --version`, help
    // text, docs quoting it) — repeats must cost a parse at most, never another install.
    const seen: unknown[] = []
    setRecapHookSyncProvider((o) => seen.push(o))
    const ring = `Claude Code v2.1.201\r\n${dir}\r\n`
    maybeEnsureClaudeHook('Claude Code v', () => ring, 'b-dedupe')
    maybeEnsureClaudeHook('Claude Code v', () => ring, 'b-dedupe')
    maybeEnsureClaudeHook('Claude Code v', () => ring, 'b-dedupe')
    expect(seen).toHaveLength(1)
    // A DIFFERENT board ensuring the same dir still fires (dedupe is per board).
    maybeEnsureClaudeHook('Claude Code v', () => ring, 'b-other')
    expect(seen).toHaveLength(2)
  })
})
