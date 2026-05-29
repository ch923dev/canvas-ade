import { describe, it, expect } from 'vitest'
import { summarizeE2E } from './e2eReport'

describe('summarizeE2E', () => {
  it('ok + exit 0 when every part passed', () => {
    const r = summarizeE2E([
      { name: 'terminal', ok: true },
      { name: 'browser', ok: true }
    ])
    expect(r.ok).toBe(true)
    expect(r.exitCode).toBe(0)
    expect(r.line.startsWith('E2E_DONE ')).toBe(true)
  })

  it('not ok + exit 1 when any part failed', () => {
    const r = summarizeE2E([
      { name: 'terminal', ok: true },
      { name: 'browser', ok: false, detail: 'capture empty' }
    ])
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
  })

  it('treats an empty list as failure (nothing actually ran)', () => {
    const r = summarizeE2E([])
    expect(r.ok).toBe(false)
    expect(r.exitCode).toBe(1)
  })

  it('serializes parts into the E2E_DONE line', () => {
    const r = summarizeE2E([{ name: 'planning', ok: true, detail: '1 checklist' }])
    expect(r.line).toContain('"planning"')
    expect(r.line).toContain('1 checklist')
  })
})
