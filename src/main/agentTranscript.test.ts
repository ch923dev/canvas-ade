import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractMilestones,
  isTrustedTranscriptPath,
  readTranscriptTail,
  resolveLiveTranscriptPath,
  TRANSCRIPT_TAIL_BYTES
} from './agentTranscript'

const line = (o: unknown): string => JSON.stringify(o)
const T = '2026-06-07T14:32:00.000Z'

describe('extractMilestones', () => {
  it('keeps user + assistant TEXT turns, drops tool records, with real timestamps', () => {
    const jsonl = [
      line({
        type: 'user',
        timestamp: T,
        message: { role: 'user', content: 'review the auth service' }
      }),
      line({
        type: 'assistant',
        timestamp: T,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 issues.' }] }
      }),
      line({
        type: 'assistant',
        timestamp: T,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] }
      }),
      line({ type: 'tool_result', timestamp: T, message: { content: 'file body...' } }),
      'not json'
    ].join('\n')
    const ms = extractMilestones(jsonl, { maxMilestones: 12, maxTextChars: 200 })
    expect(ms.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(ms[0]).toMatchObject({ role: 'user', text: 'review the auth service' })
    expect(ms[1]).toMatchObject({ role: 'agent', text: 'Found 3 issues.' })
    expect(typeof ms[0].ts).toBe('number')
  })
  it('caps to the last N and truncates long text', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      line({ type: 'user', timestamp: T, message: { role: 'user', content: 'x'.repeat(500) + i } })
    ).join('\n')
    const ms = extractMilestones(many, { maxMilestones: 12, maxTextChars: 50 })
    expect(ms).toHaveLength(12)
    expect(ms[0].text.length).toBeLessThanOrEqual(50)
  })

  // BUG-011: a secret that straddles the maxTextChars (cap) offset must be redacted at FULL length
  // BEFORE the slice. redactSecrets' patterns are length-gated (hex >= 40 chars), so if redaction ran
  // only later (buildRecapInput) AFTER truncation, the secret's sub-threshold PREFIX (here 20 hex
  // chars) would survive the slice and egress unredacted.
  it('BUG-011: redacts a secret straddling the cap so no sub-threshold prefix survives the slice', () => {
    const cap = 600
    // Non-hex padding ending in a space (so the secret is matched as its own token via the word
    // boundary, not absorbed into the padding). 'word ' x 116 = 580 chars, so the 64-hex secret
    // occupies offsets [580, 644) and straddles the cap at 600. A redaction that ran only AFTER the
    // slice would see just the first 20 hex chars (offsets 580-599), below the 40-char threshold →
    // the prefix would leak. Full-length redaction before the cap closes that gap.
    const pad = 'word '.repeat(116) // ends with a space → word boundary right before the secret
    const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' // 64 hex chars
    const prefix = secret.slice(0, cap - pad.length) // the 20 hex chars that would survive a raw slice
    expect(pad.length).toBe(580)
    expect(prefix.length).toBe(20)
    const jsonl = line({
      type: 'assistant',
      timestamp: T,
      message: { role: 'assistant', content: [{ type: 'text', text: pad + secret }] }
    })
    const ms = extractMilestones(jsonl, { maxMilestones: 12, maxTextChars: cap })
    expect(ms).toHaveLength(1)
    // The token was collapsed to [redacted] at full length BEFORE the cap, so its prefix never leaks.
    expect(ms[0].text).not.toContain(prefix)
    expect(ms[0].text).not.toContain(secret)
    expect(ms[0].text).toContain('[redacted]')
    expect(ms[0].text.length).toBeLessThanOrEqual(cap)
  })
})

describe('readTranscriptTail', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
  const tmpFile = (content: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'tail-'))
    dirs.push(d)
    const f = join(d, 'session.jsonl')
    writeFileSync(f, content)
    return f
  }

  it('returns the whole file when it is smaller than the window', () => {
    const f = tmpFile('line-a\nline-b\n')
    expect(readTranscriptTail(f, 1024)).toBe('line-a\nline-b\n')
  })

  it('returns only the last maxBytes of a larger file (a tail, not the head)', () => {
    const big = 'H'.repeat(2000) + 'TAIL_MARKER'
    const f = tmpFile(big)
    const out = readTranscriptTail(f, 64)
    expect(out.length).toBe(64)
    expect(out.endsWith('TAIL_MARKER')).toBe(true)
    expect(out.includes('H'.repeat(64))).toBe(false) // the head was not read
  })

  it('a tail that starts mid-line still yields valid milestones (partial line dropped)', () => {
    const full = line({
      type: 'user',
      timestamp: T,
      message: { role: 'user', content: 'A'.repeat(400) }
    })
    const tailGood = line({
      type: 'assistant',
      timestamp: T,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    })
    const f = tmpFile(full + '\n' + tailGood + '\n')
    // Window small enough to bisect the first line → its remnant is malformed JSON.
    const ms = extractMilestones(readTranscriptTail(f, tailGood.length + 5))
    expect(ms.map((m) => m.text)).toContain('done')
    expect(ms.every((m) => m.text !== 'A'.repeat(400))).toBe(true)
  })

  it('defaults to a 64 KB window', () => {
    expect(TRANSCRIPT_TAIL_BYTES).toBe(64 * 1024)
  })

  // BUG-034 regression: readTranscriptTail must use the bytesRead return value of readSync
  // (not decode the full allocUnsafe buffer). When fstat reports a size that a concurrent
  // truncation makes stale, readSync returns fewer bytes; decoding the full buffer would include
  // uninitialized heap content. We test the normal path to confirm length alignment.
  it('BUG-034: returned string length equals the file byte size (no heap overread)', () => {
    const content = 'A'.repeat(200)
    const f = tmpFile(content)
    const result = readTranscriptTail(f, 1024)
    expect(result.length).toBe(200)
    expect(result).toBe(content)
  })
})

describe('isTrustedTranscriptPath', () => {
  // A real temp dir as the config root → the test is portable across Win/Linux (no literal
  // platform paths, which resolve() treats differently per OS).
  const roots: string[] = []
  afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
  const makeEnv = (): { root: string; env: NodeJS.ProcessEnv } => {
    const root = mkdtempSync(join(tmpdir(), 'claude-root-'))
    roots.push(root)
    return { root, env: { CLAUDE_CONFIG_DIR: root } as NodeJS.ProcessEnv }
  }

  it('accepts a .jsonl under the Claude config root', () => {
    const { root, env } = makeEnv()
    expect(isTrustedTranscriptPath(join(root, 'projects', 'p', 's.jsonl'), env)).toBe(true)
  })
  it('rejects a non-.jsonl file even under the root', () => {
    const { root, env } = makeEnv()
    expect(isTrustedTranscriptPath(join(root, 'projects', 'secrets.env'), env)).toBe(false)
  })
  it('rejects a path outside the root', () => {
    const { env } = makeEnv()
    expect(isTrustedTranscriptPath(join(tmpdir(), 'elsewhere', 'passwd.jsonl'), env)).toBe(false)
  })
  it('rejects traversal that escapes the root after normalization', () => {
    const { root, env } = makeEnv()
    expect(isTrustedTranscriptPath(join(root, '..', '..', 'evil.jsonl'), env)).toBe(false)
  })
  it('rejects a non-string', () => {
    const { env } = makeEnv()
    expect(isTrustedTranscriptPath(undefined as unknown as string, env)).toBe(false)
  })
})

describe('resolveLiveTranscriptPath', () => {
  const roots: string[] = []
  afterEach(() => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
  // A claude config root with a project dir holding .jsonl files at explicit mtimes (epoch s).
  const makeProject = (
    files: { name: string; mtime: number }[]
  ): { dir: string; env: NodeJS.ProcessEnv } => {
    const root = mkdtempSync(join(tmpdir(), 'claude-root-'))
    roots.push(root)
    const dir = join(root, 'projects', 'Z--proj')
    mkdirSync(dir, { recursive: true })
    for (const f of files) {
      const p = join(dir, f.name)
      writeFileSync(p, '{}\n')
      utimesSync(p, f.mtime, f.mtime)
    }
    return { dir, env: { CLAUDE_CONFIG_DIR: root } as NodeJS.ProcessEnv }
  }

  it('resolves to the NEWEST .jsonl in the dir — self-heals a rotated/vanished recorded session', () => {
    const { dir, env } = makeProject([
      { name: 'old.jsonl', mtime: 1000 },
      { name: 'live.jsonl', mtime: 5000 },
      { name: 'mid.jsonl', mtime: 3000 }
    ])
    expect(resolveLiveTranscriptPath(join(dir, 'old.jsonl'), env)).toBe(join(dir, 'live.jsonl'))
    // the dunly-dunning case: recorded session file is gone, but its dir holds the live one
    expect(resolveLiveTranscriptPath(join(dir, 'gone.jsonl'), env)).toBe(join(dir, 'live.jsonl'))
  })

  it('only considers .jsonl files (a newer non-transcript file is ignored)', () => {
    const { dir, env } = makeProject([
      { name: 'a.jsonl', mtime: 1000 },
      { name: 'notes.txt', mtime: 9000 }
    ])
    expect(resolveLiveTranscriptPath(join(dir, 'a.jsonl'), env)).toBe(join(dir, 'a.jsonl'))
  })

  it('passes an untrusted / empty recorded path through unchanged (never scans)', () => {
    const { env } = makeProject([])
    const outside = join(tmpdir(), 'elsewhere', 'x.jsonl')
    expect(resolveLiveTranscriptPath(outside, env)).toBe(outside)
    expect(resolveLiveTranscriptPath(undefined, env)).toBeUndefined()
  })

  it('falls back to the recorded path when the dir holds no .jsonl', () => {
    const { dir, env } = makeProject([{ name: 'readme.md', mtime: 1000 }])
    const recorded = join(dir, 'session.jsonl')
    expect(resolveLiveTranscriptPath(recorded, env)).toBe(recorded)
  })
})
