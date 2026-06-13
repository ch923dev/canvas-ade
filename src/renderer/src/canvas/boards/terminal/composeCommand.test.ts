import { describe, it, expect } from 'vitest'
import { composeCommand } from './composeCommand'
import { presetById } from './agentPresets'

const claude = presetById('claude')!
const shell = presetById('shell')!

describe('composeCommand', () => {
  it('shell with no values composes to empty (plain shell)', () => {
    expect(composeCommand(shell, {})).toBe('')
  })

  it('claude with no values is just the bin', () => {
    expect(composeCommand(claude, {})).toBe('claude')
  })

  it('composes selects + toggles in registry order', () => {
    expect(composeCommand(claude, { model: 'opus', effort: 'high', continue: true })).toBe(
      'claude --model opus --effort high -c'
    )
  })

  it('omits empty / false / whitespace-only values', () => {
    expect(composeCommand(claude, { model: '', continue: false, resume: '   ' })).toBe('claude')
  })

  it('emits flag + value for a text option', () => {
    expect(composeCommand(claude, { resume: 'abc123' })).toBe('claude --resume abc123')
  })

  it('quotes a value containing whitespace (path with spaces stays one arg)', () => {
    expect(composeCommand(claude, { 'add-dir': 'C:/My Project' })).toBe(
      'claude --add-dir "C:/My Project"'
    )
  })
})
