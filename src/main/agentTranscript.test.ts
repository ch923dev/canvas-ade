import { describe, it, expect } from 'vitest'
import { detectAgentCli, claudeProjectSlug, extractMilestones } from './agentTranscript'

describe('detectAgentCli', () => {
  it('detects claude across common launch shapes', () => {
    for (const cmd of ['claude', 'claude --resume x', '  claude  ', 'npx claude', 'pwsh -c claude'])
      expect(detectAgentCli(cmd)).toBe('claude')
  })
  it('returns unknown for non-claude / empty', () => {
    for (const cmd of ['aider', 'codex', '', undefined as unknown as string])
      expect(detectAgentCli(cmd)).toBe('unknown')
  })
})

describe('claudeProjectSlug', () => {
  it('replaces every non-alphanumeric with a dash', () => {
    expect(claudeProjectSlug('Z:\\Canvas ADE')).toBe('Z--Canvas-ADE')
  })
  it('handles posix paths + trailing slash', () => {
    expect(claudeProjectSlug('/home/u/proj/')).toBe('-home-u-proj-')
  })
})

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
