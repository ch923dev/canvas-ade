import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getTerminalInput = vi.fn()
const getState = vi.fn()
vi.mock('../terminal/terminalInputRegistry', () => ({ getTerminalInput: () => getTerminalInput() }))
vi.mock('../../../store/terminalRuntimeStore', () => ({
  useTerminalRuntimeStore: { getState: () => getState() }
}))

import { composeNodeComment, sendNodeComment } from './diagramCommentRelay'

describe('composeNodeComment (pure)', () => {
  it('includes node id + label + detail and trims the comment', () => {
    expect(
      composeNodeComment(
        { id: 'deploy', label: 'deploy', detail: 'infra/deploy.ts' },
        '  why blocked? '
      )
    ).toBe('Regarding diagram node "deploy" — infra/deploy.ts (id: deploy): why blocked?')
  })
  it('omits the detail clause when the node has none', () => {
    expect(composeNodeComment({ id: 'build', label: 'build' }, 'status?')).toBe(
      'Regarding diagram node "build" (id: build): status?'
    )
  })
})

describe('sendNodeComment (gated relay)', () => {
  let entry: { paste: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    vi.useFakeTimers()
    entry = { paste: vi.fn(), submit: vi.fn() }
    getTerminalInput.mockReturnValue(entry)
  })
  afterEach(() => {
    vi.useRealTimers()
    getTerminalInput.mockReset()
    getState.mockReset()
  })

  it('no-ops (no paste) when the target is not running', async () => {
    getState.mockReturnValue({ running: { t1: false } })
    expect(await sendNodeComment('t1', 'hi')).toBe(false)
    expect(entry.paste).not.toHaveBeenCalled()
  })

  it('no-ops when the terminal is not mounted (no registry entry)', async () => {
    getState.mockReturnValue({ running: { t1: true } })
    getTerminalInput.mockReturnValue(undefined)
    expect(await sendNodeComment('t1', 'hi')).toBe(false)
  })

  it('pastes then submits after the settle when the target stays live', async () => {
    getState.mockReturnValue({ running: { t1: true } })
    const p = sendNodeComment('t1', 'the text')
    expect(entry.paste).toHaveBeenCalledWith('the text')
    expect(entry.submit).not.toHaveBeenCalled() // submit is a separate, later write
    await vi.advanceTimersByTimeAsync(200)
    expect(entry.submit).toHaveBeenCalledTimes(1)
    expect(await p).toBe(true)
  })

  it('pastes but does NOT submit if the target exits during the settle', async () => {
    let live = true
    getState.mockImplementation(() => ({ running: { t1: live } }))
    const p = sendNodeComment('t1', 'x')
    expect(entry.paste).toHaveBeenCalledOnce()
    live = false // terminal exits mid-settle
    await vi.advanceTimersByTimeAsync(200)
    expect(entry.submit).not.toHaveBeenCalled()
    expect(await p).toBe(false)
  })
})
