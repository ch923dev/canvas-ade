import { describe, it, expect } from 'vitest'
import {
  agentIdentity,
  brailleFrame,
  BRAILLE_FRAMES,
  formatTimer,
  isLive,
  isRunning,
  statusFor,
  type TerminalState
} from './terminalState'

describe('isRunning / isLive', () => {
  it('isRunning is true only for the running state', () => {
    expect(isRunning('running')).toBe(true)
    expect(isRunning('awaiting-input')).toBe(false)
    expect(isRunning('idle')).toBe(false)
    expect(isRunning('exited')).toBe(false)
  })

  it('isLive covers running + awaiting-input only', () => {
    expect(isLive('running')).toBe(true)
    expect(isLive('awaiting-input')).toBe(true)
    expect(isLive('spawning')).toBe(false)
    expect(isLive('exited')).toBe(false)
    expect(isLive('spawn-failed')).toBe(false)
  })
})

describe('statusFor', () => {
  it('maps each state to the §7.1 dot colour', () => {
    expect(statusFor('running', 'claude').dot).toBe('var(--ok)')
    expect(statusFor('spawning', 'claude').dot).toBe('var(--ok)')
    expect(statusFor('awaiting-input', 'claude').dot).toBe('var(--warn)')
    expect(statusFor('spawn-failed', 'claude').dot).toBe('var(--err)')
    expect(statusFor('exited', 'claude').dot).toBe('var(--text-3)')
    expect(statusFor('idle', 'claude').dot).toBe('var(--text-3)')
  })

  it('appends the timer only when running and a timer is supplied', () => {
    expect(statusFor('running', 'claude', '02:14').label).toBe('claude · 02:14')
    expect(statusFor('running', 'claude').label).toBe('claude')
    // Non-running states ignore the timer suffix.
    expect(statusFor('awaiting-input', 'claude', '02:14').label).toBe('claude · awaiting input')
  })

  it('embeds the agent name in every label', () => {
    const states: TerminalState[] = [
      'idle',
      'spawning',
      'running',
      'awaiting-input',
      'exited',
      'spawn-failed'
    ]
    for (const s of states) expect(statusFor(s, 'codex').label.startsWith('codex')).toBe(true)
  })
})

describe('agentIdentity', () => {
  it('prefers the launchCommand head, stripping args + path + extension', () => {
    expect(agentIdentity('claude --resume')).toBe('claude')
    expect(agentIdentity('npx codex')).toBe('npx')
    expect(agentIdentity('C:\\tools\\agent.exe run')).toBe('agent')
    expect(agentIdentity('/usr/local/bin/aider')).toBe('aider')
  })

  it('falls back to the shell basename when no launchCommand', () => {
    expect(agentIdentity(undefined, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh')
    expect(agentIdentity('', '/bin/bash')).toBe('bash')
    expect(agentIdentity('   ', 'zsh')).toBe('zsh')
  })

  it('defaults to "shell" with no inputs', () => {
    expect(agentIdentity()).toBe('shell')
    expect(agentIdentity('', '')).toBe('shell')
  })
})

describe('formatTimer', () => {
  it('formats seconds as zero-padded mm:ss', () => {
    expect(formatTimer(0)).toBe('00:00')
    expect(formatTimer(9)).toBe('00:09')
    expect(formatTimer(75)).toBe('01:15')
    expect(formatTimer(134)).toBe('02:14')
    expect(formatTimer(3599)).toBe('59:59')
  })

  it('clamps negatives and floors fractions', () => {
    expect(formatTimer(-5)).toBe('00:00')
    expect(formatTimer(61.9)).toBe('01:01')
  })
})

describe('brailleFrame', () => {
  it('wraps the index over the frame set', () => {
    expect(brailleFrame(0)).toBe(BRAILLE_FRAMES[0])
    expect(brailleFrame(BRAILLE_FRAMES.length)).toBe(BRAILLE_FRAMES[0])
    expect(brailleFrame(BRAILLE_FRAMES.length + 3)).toBe(BRAILLE_FRAMES[3])
  })

  it('handles negative indices', () => {
    expect(brailleFrame(-1)).toBe(BRAILLE_FRAMES[BRAILLE_FRAMES.length - 1])
  })
})
