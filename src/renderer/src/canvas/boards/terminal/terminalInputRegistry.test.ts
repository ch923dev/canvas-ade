import { describe, expect, it, vi } from 'vitest'
import {
  getTerminalInput,
  registerTerminalInput,
  unregisterTerminalInput
} from './terminalInputRegistry'

describe('terminalInputRegistry', () => {
  it('register → get → unregister lifecycle', () => {
    const entry = { paste: vi.fn(), submit: vi.fn() }
    expect(getTerminalInput('t1')).toBeUndefined()
    registerTerminalInput('t1', entry)
    expect(getTerminalInput('t1')).toBe(entry)
    unregisterTerminalInput('t1')
    expect(getTerminalInput('t1')).toBeUndefined()
  })

  it('re-register overwrites (config respawn registers the fresh term)', () => {
    const old = { paste: vi.fn(), submit: vi.fn() }
    const fresh = { paste: vi.fn(), submit: vi.fn() }
    registerTerminalInput('t2', old)
    registerTerminalInput('t2', fresh)
    expect(getTerminalInput('t2')).toBe(fresh)
    unregisterTerminalInput('t2')
  })

  it('unregister of an unknown id is a no-op', () => {
    expect(() => unregisterTerminalInput('never-registered')).not.toThrow()
  })
})
