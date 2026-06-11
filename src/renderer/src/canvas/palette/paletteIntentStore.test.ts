import { beforeEach, describe, expect, it } from 'vitest'
import { sendPaletteIntent, usePaletteIntentStore } from './paletteIntentStore'

describe('paletteIntentStore', () => {
  beforeEach(() => usePaletteIntentStore.setState({ intent: null }))

  it('send publishes a one-shot intent with a fresh nonce each time', () => {
    sendPaletteIntent('b1', 'rename')
    const first = usePaletteIntentStore.getState().intent!
    expect(first).toMatchObject({ boardId: 'b1', kind: 'rename' })
    sendPaletteIntent('b1', 'rename')
    const second = usePaletteIntentStore.getState().intent!
    expect(second.nonce).toBeGreaterThan(first.nonce) // identical intent still re-fires
  })

  it('consume clears only the matching nonce (a newer intent survives a stale consume)', () => {
    sendPaletteIntent('b1', 'restart-new')
    const stale = usePaletteIntentStore.getState().intent!
    sendPaletteIntent('b2', 'restart-resume')
    usePaletteIntentStore.getState().consume(stale.nonce)
    expect(usePaletteIntentStore.getState().intent?.boardId).toBe('b2')
    usePaletteIntentStore.getState().consume(usePaletteIntentStore.getState().intent!.nonce)
    expect(usePaletteIntentStore.getState().intent).toBeNull()
  })
})
