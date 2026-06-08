import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractMilestones,
  isTrustedTranscriptPath,
  readTranscriptTail,
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
