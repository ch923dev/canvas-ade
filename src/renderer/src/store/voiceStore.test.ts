import { beforeEach, describe, expect, it } from 'vitest'
import { useVoiceStore } from './voiceStore'

const initial = {
  capturing: false,
  level: 0,
  micSilent: false,
  framesSent: 0,
  activeBoardId: null
}

beforeEach(() => useVoiceStore.setState(initial))

describe('voiceStore', () => {
  it('starts idle', () => {
    const s = useVoiceStore.getState()
    expect(s.capturing).toBe(false)
    expect(s.level).toBe(0)
    expect(s.micSilent).toBe(false)
    expect(s.framesSent).toBe(0)
    expect(s.activeBoardId).toBeNull()
  })

  it('captureStarted arms the session and resets the per-session counters', () => {
    useVoiceStore.setState({ level: 0.4, micSilent: true, framesSent: 99 })
    useVoiceStore.getState().captureStarted()
    const s = useVoiceStore.getState()
    expect(s.capturing).toBe(true)
    expect(s.level).toBe(0)
    expect(s.micSilent).toBe(false)
    expect(s.framesSent).toBe(0)
  })

  it('frameSent tracks the last level and counts frames', () => {
    useVoiceStore.getState().captureStarted()
    useVoiceStore.getState().frameSent(0.25)
    useVoiceStore.getState().frameSent(0.5)
    const s = useVoiceStore.getState()
    expect(s.level).toBe(0.5)
    expect(s.framesSent).toBe(2)
  })

  it('captureStopped clears the live flags but keeps framesSent readable', () => {
    useVoiceStore.getState().captureStarted()
    useVoiceStore.getState().frameSent(0.3)
    useVoiceStore.getState().setMicSilent(true)
    useVoiceStore.getState().captureStopped()
    const s = useVoiceStore.getState()
    expect(s.capturing).toBe(false)
    expect(s.level).toBe(0)
    expect(s.micSilent).toBe(false)
    expect(s.framesSent).toBe(1) // session total survives the stop (e2e/devtools post-mortem)
  })

  it('setMicSilent and setActiveBoard are identity no-ops when unchanged', () => {
    const before = useVoiceStore.getState()
    useVoiceStore.getState().setMicSilent(false)
    useVoiceStore.getState().setActiveBoard(null)
    expect(useVoiceStore.getState()).toBe(before) // no new state object → no re-render churn
    useVoiceStore.getState().setMicSilent(true)
    useVoiceStore.getState().setActiveBoard('b1')
    expect(useVoiceStore.getState().micSilent).toBe(true)
    expect(useVoiceStore.getState().activeBoardId).toBe('b1')
  })
})
