import { beforeEach, describe, expect, it } from 'vitest'
import { joinFinal, useVoiceStore, SILENCE_RMS } from './voiceStore'

const initial = {
  capturing: false,
  level: 0,
  micSilent: false,
  framesSent: 0,
  activeBoardId: null,
  draft: '',
  partial: '',
  flyoutOpen: false,
  micStatus: 'unknown',
  modelStatus: 'unknown' as const,
  lastVoiceAt: 0,
  captureStartedAt: 0
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

  it('partialReceived replaces the tail and opens the flyout on first text', () => {
    useVoiceStore.getState().partialReceived('hel')
    expect(useVoiceStore.getState().partial).toBe('hel')
    expect(useVoiceStore.getState().flyoutOpen).toBe(true)
    useVoiceStore.getState().partialReceived('hello wor')
    expect(useVoiceStore.getState().partial).toBe('hello wor') // wholesale replace, no append
  })

  it('an empty partial does not open the flyout', () => {
    useVoiceStore.getState().partialReceived('')
    expect(useVoiceStore.getState().flyoutOpen).toBe(false)
  })

  it('finalReceived folds ONLY the tail into the draft (solid text never reflows)', () => {
    useVoiceStore.setState({ draft: 'first sentence.' })
    useVoiceStore.getState().partialReceived('second sen')
    useVoiceStore.getState().finalReceived('second sentence.')
    const s = useVoiceStore.getState()
    expect(s.draft).toBe('first sentence. second sentence.') // one joining space
    expect(s.partial).toBe('')
  })

  it('joinFinal respects existing trailing whitespace and empty sides', () => {
    expect(joinFinal('', 'abc')).toBe('abc')
    expect(joinFinal('abc', '')).toBe('abc')
    expect(joinFinal('line one\n', 'two')).toBe('line one\ntwo')
    expect(joinFinal('one', 'two')).toBe('one two')
  })

  it('joinFinal edge-trims incoming segments (sherpa leads finals with a space)', () => {
    expect(joinFinal('', ' After early nightfall')).toBe('After early nightfall')
    expect(joinFinal('first.', ' second.')).toBe('first. second.')
    expect(joinFinal('kept', '   ')).toBe('kept')
  })

  it('captureStopped solidifies a still-provisional tail into the draft', () => {
    useVoiceStore.getState().captureStarted()
    useVoiceStore.getState().partialReceived('trailing tail')
    useVoiceStore.getState().captureStopped()
    const s = useVoiceStore.getState()
    expect(s.draft).toBe('trailing tail')
    expect(s.partial).toBe('')
  })

  it('clearTranscript drops draft AND tail in one update (Send/Insert consumed them)', () => {
    useVoiceStore.setState({ draft: 'kept', partial: 'tail' })
    useVoiceStore.getState().clearTranscript()
    expect(useVoiceStore.getState().draft).toBe('')
    expect(useVoiceStore.getState().partial).toBe('')
  })

  it('frameSent advances the silence clock only above the RMS floor', () => {
    useVoiceStore.getState().captureStarted()
    const armed = useVoiceStore.getState().lastVoiceAt
    expect(armed).toBeGreaterThan(0)
    useVoiceStore.setState({ lastVoiceAt: 123 })
    useVoiceStore.getState().frameSent(SILENCE_RMS / 2) // silence — clock frozen
    expect(useVoiceStore.getState().lastVoiceAt).toBe(123)
    useVoiceStore.getState().frameSent(SILENCE_RMS * 4) // voice — clock advances
    expect(useVoiceStore.getState().lastVoiceAt).toBeGreaterThan(123)
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
