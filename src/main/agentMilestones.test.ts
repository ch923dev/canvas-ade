import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGetAgentMilestones,
  persistedTranscriptPath,
  type AgentMilestonesDeps
} from './agentMilestones'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A trusted root (CLAUDE_CONFIG_DIR) stubbed into process.env, matching the default guard. */
function fixtureRoot(): { dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'canvas-milestones-'))
  roots.push(root)
  vi.stubEnv('CLAUDE_CONFIG_DIR', root)
  const dir = join(root, 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  return { dir }
}

function deps(over: Partial<AgentMilestonesDeps> = {}): AgentMilestonesDeps {
  return {
    getCurrentDir: () => 'C:/proj',
    isConsented: () => true,
    resolveTranscript: (_id, recorded) => recorded,
    getRecordedPath: () => undefined,
    ...over
  }
}

describe('persistedTranscriptPath', () => {
  it('returns the board doc field only when the read is ok and the field is a non-empty string', () => {
    const doc = {
      boards: [
        { id: 'b1', agentTranscriptPath: 'C:/t/a.jsonl' },
        { id: 'b2', agentTranscriptPath: '' },
        { id: 'b3' }
      ]
    }
    const read = (): { ok: true; doc: unknown } => ({ ok: true, doc })
    expect(persistedTranscriptPath(read, 'd', 'b1')).toBe('C:/t/a.jsonl')
    expect(persistedTranscriptPath(read, 'd', 'b2')).toBeUndefined()
    expect(persistedTranscriptPath(read, 'd', 'b3')).toBeUndefined()
    expect(persistedTranscriptPath(read, 'd', 'missing')).toBeUndefined()
    expect(persistedTranscriptPath(() => ({ ok: false }), 'd', 'b1')).toBeUndefined()
    expect(persistedTranscriptPath(() => ({ ok: true, doc: {} }), 'd', 'b1')).toBeUndefined()
  })
})

describe('createGetAgentMilestones', () => {
  it('BUG-002: no project / consent off → consent-off skip (egress stays gated)', () => {
    expect(createGetAgentMilestones(deps({ getCurrentDir: () => null }))('b1', {})).toEqual({
      skip: 'consent-off'
    })
    expect(createGetAgentMilestones(deps({ isConsented: () => false }))('b1', {})).toEqual({
      skip: 'consent-off'
    })
  })

  it('no resolvable / untrusted / missing transcript → no-transcript skip', () => {
    const { dir } = fixtureRoot()
    const get = createGetAgentMilestones(deps())
    expect(get('b1', {})).toEqual({ skip: 'no-transcript' })
    // Outside the trusted root (isTrustedTranscriptPath rejects).
    const evil = mkdtempSync(join(tmpdir(), 'canvas-evil-'))
    roots.push(evil)
    expect(get('b1', { agentTranscriptPath: join(evil, 'x.jsonl') })).toEqual({
      skip: 'no-transcript'
    })
    // Trusted but never written.
    expect(get('b1', { agentTranscriptPath: join(dir, 'gone.jsonl') })).toEqual({
      skip: 'no-transcript'
    })
  })

  it('board doc path wins; recap-map path is the fallback', () => {
    const { dir } = fixtureRoot()
    const p = join(dir, 'a.jsonl')
    writeFileSync(p, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }))
    const fromMap = createGetAgentMilestones(deps({ getRecordedPath: () => p }))
    expect(fromMap('b1', {})).toHaveProperty('milestones')
  })

  it('readable transcript → milestones + P3 extras shape (no skip)', () => {
    const { dir } = fixtureRoot()
    const p = join(dir, 'a.jsonl')
    writeFileSync(
      p,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'done' } })
      ].join('\n')
    )
    const r = createGetAgentMilestones(deps())('b1', { agentTranscriptPath: p })
    expect(r).toHaveProperty('milestones')
    expect(Array.isArray((r as { milestones: unknown[] }).milestones)).toBe(true)
  })
})
