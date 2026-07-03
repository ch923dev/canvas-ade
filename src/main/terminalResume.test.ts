import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractSessionIdFromTail,
  resolveResume,
  resumeLaunchLine,
  sanitizeSessionId,
  type ResumeDeps,
  type ResumeResolution
} from './terminalResume'
import type { RecapMapEntry } from './agentRecapMap'

const line = (o: unknown): string => JSON.stringify(o)
/** A minimal transcript body whose every line carries `sessionId` (as Claude's do). */
const transcript = (...sessionIds: string[]): string =>
  sessionIds
    .map((sid, i) =>
      line({ sessionId: sid, type: 'user', message: { role: 'user', content: `turn ${i}` } })
    )
    .join('\n') + '\n'

const SID = 'aaaabbbb-1111-2222-3333-444455556666'
const OTHER = 'ffffeeee-9999-8888-7777-666655554444'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A trusted fixture root (CLAUDE_CONFIG_DIR) with one project dir for transcripts. */
function fixtureRoot(): { root: string; dir: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'canvas-resume-'))
  roots.push(root)
  const dir = join(root, 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  return { root, dir, env: { CLAUDE_CONFIG_DIR: root } }
}

function deps(
  env: NodeJS.ProcessEnv,
  entries: Record<string, RecapMapEntry> = {},
  resolveTranscript?: ResumeDeps['resolveTranscript']
): ResumeDeps {
  return {
    getWin: () => null,
    resolveTranscript: resolveTranscript ?? ((_id, recorded) => recorded),
    getMapEntries: () => new Map(Object.entries(entries)),
    env
  }
}

describe('sanitizeSessionId', () => {
  it('keeps the UUID charset, strips shell metacharacters and whitespace', () => {
    expect(sanitizeSessionId(SID)).toBe(SID)
    expect(sanitizeSessionId('x; curl evil.com')).toBe('xcurlevilcom')
    expect(sanitizeSessionId('a`b$(c)&d|e f\n')).toBe('abcdef')
  })
  it('non-strings become empty', () => {
    expect(sanitizeSessionId(undefined)).toBe('')
    expect(sanitizeSessionId(42)).toBe('')
    expect(sanitizeSessionId({})).toBe('')
  })
})

describe('extractSessionIdFromTail', () => {
  it('returns the NEWEST parseable line’s sessionId', () => {
    expect(extractSessionIdFromTail(transcript(SID, SID, OTHER))).toBe(OTHER)
  })
  it('skips malformed / partial trailing lines (tail reads can cut mid-line)', () => {
    const body = transcript(SID) + '{"sessionId":"trunc'
    expect(extractSessionIdFromTail(body)).toBe(SID)
  })
  it('undefined when no line carries a sessionId', () => {
    expect(extractSessionIdFromTail(line({ type: 'summary' }))).toBeUndefined()
    expect(extractSessionIdFromTail('')).toBeUndefined()
  })
})

describe('resolveResume', () => {
  it('no/garbage/short stored id → fresh no-session (nothing to even validate)', () => {
    const { env } = fixtureRoot()
    const d = deps(env)
    expect(resolveResume(d, 'b1', {})).toMatchObject({ kind: 'fresh', reason: 'no-session' })
    expect(resolveResume(d, 'b1', { sessionId: '; ;' })).toMatchObject({ reason: 'no-session' })
    // Post-sanitize < 8 chars: too weak a lineage anchor to trust an `includes` match on.
    expect(resolveResume(d, 'b1', { sessionId: 'ab1' })).toMatchObject({ reason: 'no-session' })
  })

  it('RC-1 (eager capture): id stored but the transcript never existed → fresh no-transcript', () => {
    const { dir, env } = fixtureRoot()
    const r = resolveResume(deps(env), 'b1', {
      sessionId: SID,
      transcriptPath: join(dir, `${SID}.jsonl`) // recorded at SessionStart, never written
    })
    expect(r).toEqual({ kind: 'fresh', reason: 'no-transcript' })
  })

  it('untrusted transcript path (outside the Claude config root) → fresh no-transcript', () => {
    const { env } = fixtureRoot()
    const evil = mkdtempSync(join(tmpdir(), 'canvas-evil-'))
    roots.push(evil)
    const p = join(evil, 'x.jsonl')
    writeFileSync(p, transcript(SID))
    expect(resolveResume(deps(env), 'b1', { sessionId: SID, transcriptPath: p })).toEqual({
      kind: 'fresh',
      reason: 'no-transcript'
    })
  })

  it('existing but empty transcript → fresh empty-transcript', () => {
    const { dir, env } = fixtureRoot()
    const p = join(dir, `${SID}.jsonl`)
    writeFileSync(p, '  \n')
    expect(resolveResume(deps(env), 'b1', { sessionId: SID, transcriptPath: p })).toEqual({
      kind: 'fresh',
      reason: 'empty-transcript'
    })
  })

  it('lineage-proven transcript → resume the recorded id', () => {
    const { dir, env } = fixtureRoot()
    const p = join(dir, `${SID}.jsonl`)
    writeFileSync(p, transcript(SID, SID))
    expect(resolveResume(deps(env), 'b1', { sessionId: SID, transcriptPath: p })).toEqual({
      kind: 'resume',
      sessionId: SID,
      source: 'recorded'
    })
  })

  it('RC-2 (rotation): successor transcript carries our id in history → resume its ACTUAL id', () => {
    const { dir, env } = fixtureRoot()
    // The recorded file is gone; the resolver (A4) adopted the successor, whose copied
    // history still references SID but whose newest turns belong to OTHER.
    const successor = join(dir, `${OTHER}.jsonl`)
    writeFileSync(successor, transcript(SID, OTHER))
    const d = deps(env, {}, () => successor)
    expect(
      resolveResume(d, 'b1', { sessionId: SID, transcriptPath: join(dir, 'gone.jsonl') })
    ).toEqual({
      kind: 'resume',
      sessionId: OTHER,
      source: 'adopted'
    })
  })

  it('foreign transcript claimed by ANOTHER board → fresh (never sibling-reattribute)', () => {
    const { dir, env } = fixtureRoot()
    const p = join(dir, `${OTHER}.jsonl`)
    writeFileSync(p, transcript(OTHER))
    const d = deps(env, { b2: { sessionId: OTHER, transcriptPath: p } }, () => p)
    expect(
      resolveResume(d, 'b1', { sessionId: SID, transcriptPath: join(dir, 'gone.jsonl') })
    ).toEqual({ kind: 'fresh', reason: 'foreign-transcript' })
  })

  it('foreign but UNCLAIMED transcript → continue (best-effort recovery)', () => {
    const { dir, env } = fixtureRoot()
    const p = join(dir, `${OTHER}.jsonl`)
    writeFileSync(p, transcript(OTHER))
    const d = deps(env, {}, () => p)
    expect(
      resolveResume(d, 'b1', { sessionId: SID, transcriptPath: join(dir, 'gone.jsonl') })
    ).toEqual({ kind: 'continue' })
  })

  it('falls back to the recap-map entry path when the board doc carries none', () => {
    const { dir, env } = fixtureRoot()
    const p = join(dir, `${SID}.jsonl`)
    writeFileSync(p, transcript(SID))
    const d = deps(env, { b1: { sessionId: SID, transcriptPath: p } })
    expect(resolveResume(d, 'b1', { sessionId: SID })).toMatchObject({ kind: 'resume' })
  })

  it('injection-shaped stored id can never smuggle metacharacters into the launch line', () => {
    const { dir, env } = fixtureRoot()
    const raw = 'abc; curl evil.com'
    const sanitized = sanitizeSessionId(raw) // what an attacker would need in the transcript
    const p = join(dir, 'x.jsonl')
    writeFileSync(p, transcript(sanitized))
    const r = resolveResume(deps(env), 'b1', { sessionId: raw, transcriptPath: p })
    const launch = resumeLaunchLine(r)
    expect(launch.command).toBe(`claude --resume ${sanitized}`)
    expect(launch.command).not.toMatch(/[^a-zA-Z0-9_\- ]/)
  })
})

describe('resumeLaunchLine', () => {
  it('maps each resolution to its PTY line', () => {
    const resume: ResumeResolution = { kind: 'resume', sessionId: SID, source: 'recorded' }
    expect(resumeLaunchLine(resume)).toEqual({ mode: 'resume', command: `claude --resume ${SID}` })
    expect(resumeLaunchLine({ kind: 'continue' })).toEqual({
      mode: 'continue',
      command: 'claude --continue'
    })
    expect(resumeLaunchLine({ kind: 'fresh', reason: 'no-session' })).toEqual({ mode: 'fresh' })
  })
})
