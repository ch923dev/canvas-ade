import { describe, it, expect, beforeEach } from 'vitest'
import { makePortDetectNote } from './terminalPreview'
import { useToastStore } from '../../store/toastStore'

beforeEach(() => {
  useToastStore.getState().clearToasts()
})

describe('makePortDetectNote — routes the port-detect note to the toast channel (D1-A)', () => {
  it('a message shows a board-keyed info toast', () => {
    makePortDetectNote('b1')('No dev server detected yet — start it, then try again.')
    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].id).toBe('port-detect-b1')
    expect(toasts[0].kind).toBe('info')
    expect(toasts[0].message).toContain('No dev server detected')
  })

  it('a repeat message replaces the keyed toast instead of stacking', () => {
    const note = makePortDetectNote('b1')
    note('first')
    note('second')
    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('second')
  })

  it('null clears ONLY this board’s note (the runDetectPorts leading clear)', () => {
    makePortDetectNote('b1')('one')
    makePortDetectNote('b2')('two')
    makePortDetectNote('b1')(null)
    const { toasts } = useToastStore.getState()
    expect(toasts.map((t) => t.id)).toEqual(['port-detect-b2'])
  })
})
