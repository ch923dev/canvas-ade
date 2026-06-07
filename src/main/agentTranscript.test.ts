import { describe, it, expect } from 'vitest'
import { detectAgentCli, claudeProjectSlug } from './agentTranscript'

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
  it('replaces every non-alphanumeric with a dash (verified shape)', () => {
    expect(claudeProjectSlug('Z:\\Canvas ADE')).toBe('Z--Canvas-ADE')
  })
  it('handles posix paths + trailing slash', () => {
    expect(claudeProjectSlug('/home/u/proj/')).toBe('-home-u-proj-')
  })
})
