import { describe, it, expect } from 'vitest'
import { classifyExit, looksLikePrompt, isIdleAtPrompt } from './ptyLifecycle'

describe('classifyExit', () => {
  it('maps a clean exit (code 0) to done', () => {
    expect(classifyExit(0)).toBe('done')
  })
  it('maps any non-zero code to error', () => {
    expect(classifyExit(1)).toBe('error')
    expect(classifyExit(130)).toBe('error') // SIGINT
    expect(classifyExit(-1)).toBe('error')
  })
})

describe('looksLikePrompt', () => {
  it('matches a direct question', () => {
    expect(looksLikePrompt('Do you want to continue?')).toBe(true)
    expect(looksLikePrompt('Overwrite existing file? ')).toBe(true)
  })
  it('matches a yes/no affordance', () => {
    expect(looksLikePrompt('Proceed [y/n]')).toBe(true)
    expect(looksLikePrompt('Delete this branch? (Y/n) ')).toBe(true)
    expect(looksLikePrompt('Are you sure {yes/no}')).toBe(true)
  })
  it('matches press-to-continue / arrow-key menu affordances', () => {
    expect(looksLikePrompt('Press Enter to continue')).toBe(true)
    expect(looksLikePrompt('Select an option (Use arrow keys)')).toBe(true)
  })
  it('matches a credential / value prompt ending in a colon', () => {
    expect(looksLikePrompt('Password:')).toBe(true)
    expect(looksLikePrompt('Verification code: ')).toBe(true)
  })
  it('does NOT match a bare shell prompt (the key false-positive guard)', () => {
    expect(looksLikePrompt('user@host:~/proj$ ')).toBe(false)
    expect(looksLikePrompt('PS C:\\Users\\me> ')).toBe(false)
    expect(looksLikePrompt('❯ ')).toBe(false)
    expect(looksLikePrompt('% ')).toBe(false)
    expect(looksLikePrompt('bash-5.2# ')).toBe(false)
  })
  it('does NOT match plain output or an empty tail', () => {
    expect(looksLikePrompt('Building project...\nDone in 4.2s')).toBe(false)
    expect(looksLikePrompt('')).toBe(false)
    expect(looksLikePrompt('   \n\n')).toBe(false)
  })
  it('reads the LAST non-blank line and ignores trailing blank lines', () => {
    expect(looksLikePrompt('some log line\nContinue? \n\n  \n')).toBe(true)
    // A question earlier in the buffer that is NOT the last line must not match.
    expect(looksLikePrompt('Continue?\nBuild finished, 0 errors')).toBe(false)
  })
  it('strips ANSI before matching', () => {
    expect(looksLikePrompt('\x1b[1;32mProceed? \x1b[0m')).toBe(true)
    expect(looksLikePrompt('\x1b[32muser@host\x1b[0m:~$ ')).toBe(false)
  })
})

describe('isIdleAtPrompt', () => {
  const base = {
    running: true,
    monitored: true,
    alreadyAwaiting: false,
    staleMs: 20_000,
    idleMs: 10_000,
    tail: 'Continue? '
  }
  it('fires when live + monitored + idle + at a soliciting prompt', () => {
    expect(isIdleAtPrompt(base)).toBe(true)
  })
  it('does not fire when the session is not running', () => {
    expect(isIdleAtPrompt({ ...base, running: false })).toBe(false)
  })
  it('does not fire for a monitorActivity:false board (opt-out)', () => {
    expect(isIdleAtPrompt({ ...base, monitored: false })).toBe(false)
  })
  it('does not fire twice in one idle period (already flagged)', () => {
    expect(isIdleAtPrompt({ ...base, alreadyAwaiting: true })).toBe(false)
  })
  it('does not fire before the idle dwell elapses', () => {
    expect(isIdleAtPrompt({ ...base, staleMs: 4_000 })).toBe(false)
  })
  it('does not fire when the tail is not a soliciting prompt', () => {
    expect(isIdleAtPrompt({ ...base, tail: 'user@host:~$ ' })).toBe(false)
  })
})
