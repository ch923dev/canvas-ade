/**
 * Listen-hold aggregator units — the "Jarvis cuts me off" fix. Timing runs on fake
 * timers; the aggregator is pure renderer logic (no store, no IPC).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createUtteranceHold, matchSendSpeech } from './utteranceHold'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('matchSendSpeech', () => {
  it('exact send words only (punctuation/case-insensitive)', () => {
    expect(matchSendSpeech('Send it.')).toBe(true)
    expect(matchSendSpeech('go ahead')).toBe(true)
    expect(matchSendSpeech("that's it")).toBe(true)
    expect(matchSendSpeech('send')).toBe(true)
    // Content that CONTAINS a trigger stays content.
    expect(matchSendSpeech('send it to the planning board')).toBe(false)
    expect(matchSendSpeech('go ahead and refactor the cap')).toBe(false)
  })
})

describe('createUtteranceHold (auto mode)', () => {
  it('buffers fragmented finals across pauses and sends ONE joined utterance after the hold', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('refactor the preview cap', 'auto', 2500)
    vi.advanceTimersByTime(2000) // the user pauses ~2 s — under the hold, nothing sends
    expect(onSend).not.toHaveBeenCalled()
    hold.pushFinal('and bump the version', 'auto', 2500) // …then keeps talking
    vi.advanceTimersByTime(2400)
    expect(onSend).not.toHaveBeenCalled() // the second final re-armed the window
    vi.advanceTimersByTime(200)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('refactor the preview cap and bump the version')
    expect(hold.pending()).toBe('')
  })

  it('a live partial cancels the armed hold; the next final re-arms it', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('first fragment', 'auto', 1000)
    vi.advanceTimersByTime(900)
    hold.touchPartial(true) // speech resumed just before the window fired
    vi.advanceTimersByTime(5000)
    expect(onSend).not.toHaveBeenCalled() // no timer left — the final owns the re-arm
    hold.pushFinal('second fragment', 'auto', 1000)
    vi.advanceTimersByTime(1000)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('first fragment second fragment')
  })

  it('an empty partial (tail cleared after a buffered final) never cancels the hold', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('the whole prompt', 'auto', 1000)
    hold.touchPartial(false)
    vi.advanceTimersByTime(1000)
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('mirrors the pending text through onChange (the panel composing row)', () => {
    const changes: string[] = []
    const hold = createUtteranceHold({ onSend: vi.fn(), onChange: (p) => changes.push(p) })
    hold.pushFinal('part one', 'auto', 1000)
    hold.pushFinal('part two', 'auto', 1000)
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual(['part one', 'part one part two', ''])
  })
})

describe('createUtteranceHold (manual mode + flush/clear)', () => {
  it('manual mode NEVER auto-sends; flush ships the buffer', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('a long prompt', 'manual', 1000)
    hold.pushFinal('with more detail', 'manual', 1000)
    vi.advanceTimersByTime(60_000)
    expect(onSend).not.toHaveBeenCalled()
    hold.flush() // send word / panel Send
    expect(onSend).toHaveBeenCalledExactlyOnceWith('a long prompt with more detail')
  })

  it('flush on an empty buffer is a no-op', () => {
    const onSend = vi.fn()
    createUtteranceHold({ onSend }).flush()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('flush mid-hold sends immediately and disarms the pending timer (no double send)', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('ship it now', 'auto', 2500)
    hold.flush()
    expect(onSend).toHaveBeenCalledExactlyOnceWith('ship it now')
    vi.advanceTimersByTime(10_000)
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('pause (edit focus) cancels the hold AND blocks arming from mid-edit finals; resume re-arms', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('start of prompt', 'auto', 1000)
    hold.pause() // user clicked into the composing editor
    vi.advanceTimersByTime(5000)
    expect(onSend).not.toHaveBeenCalled()
    hold.pushFinal('spoken while editing', 'auto', 1000) // a mid-edit final must not arm
    vi.advanceTimersByTime(5000)
    expect(onSend).not.toHaveBeenCalled()
    hold.resume('auto', 1000) // blur — the window re-arms over the whole buffer
    vi.advanceTimersByTime(1000)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('start of prompt spoken while editing')
  })

  it('resume in manual mode never arms (blur just ends the edit session)', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('a manual prompt', 'manual', 1000)
    hold.pause()
    hold.resume('manual', 1000)
    vi.advanceTimersByTime(60_000)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('setText replaces the buffer (user edit); the NEXT final joins the edited text', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('recognized txet', 'manual', 1000)
    hold.setText('recognized text') // the user fixed the transcription
    expect(hold.pending()).toBe('recognized text')
    hold.pushFinal('and more speech', 'manual', 1000)
    hold.flush()
    expect(onSend).toHaveBeenCalledExactlyOnceWith('recognized text and more speech')
  })

  it('setText never arms a timer, even in auto mode (edits are not speech)', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.setText('typed from scratch')
    vi.advanceTimersByTime(60_000)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('clear discards the buffer and the armed timer (converse teardown)', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('doomed text', 'auto', 1000)
    hold.clear()
    expect(hold.pending()).toBe('')
    vi.advanceTimersByTime(5000)
    expect(onSend).not.toHaveBeenCalled()
  })
})
