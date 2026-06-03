import { describe, it, expect } from 'vitest'
import { isForeignSender } from './llmIpc'

// Unit tier: the pure frame-guard helper. The registered `llm:*` handlers (which wire this
// guard in) are integration-tested in llmIpc.integration.test.ts.
describe('isForeignSender', () => {
  const frame = {} as never
  it('allows a synthetic call (no senderFrame)', () => {
    expect(isForeignSender({ senderFrame: null } as never, () => frame)).toBe(false)
  })
  it('denies a real sender when the window is unresolved', () => {
    expect(isForeignSender({ senderFrame: frame } as never, () => null)).toBe(true)
  })
  it('allows the main frame and denies a different frame', () => {
    expect(isForeignSender({ senderFrame: frame } as never, () => frame)).toBe(false)
    expect(isForeignSender({ senderFrame: {} as never } as never, () => frame)).toBe(true)
  })
})
