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

  it('pause (edit focus) cancels the hold; mid-edit finals DEFER (never mutate the edited text under the caret) and fold in on resume', () => {
    const onSend = vi.fn()
    const changes: string[] = []
    const hold = createUtteranceHold({ onSend, onChange: (p) => changes.push(p) })
    hold.pushFinal('start of prompt', 'auto', 1000)
    hold.pause() // user clicked into the composing editor
    vi.advanceTimersByTime(5000)
    expect(onSend).not.toHaveBeenCalled()
    hold.pushFinal('spoken while editing', 'auto', 1000)
    // Review W2: the controlled textarea's value must NOT change mid-edit — the final
    // parks in the deferred buffer instead.
    expect(hold.pending()).toBe('start of prompt')
    expect(changes).toEqual(['start of prompt'])
    vi.advanceTimersByTime(5000)
    expect(onSend).not.toHaveBeenCalled()
    hold.resume('auto', 1000) // blur — deferred folds in, the window re-arms over it all
    expect(hold.pending()).toBe('start of prompt spoken while editing')
    vi.advanceTimersByTime(1000)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('start of prompt spoken while editing')
  })

  it('flush during an edit session (Enter in the textarea) sends edited + deferred text and unsticks paused', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('draft text', 'manual', 1000)
    hold.pause()
    hold.setText('edited draft') // the user's edit
    hold.pushFinal('and a spoken tail', 'manual', 1000) // defers
    hold.flush() // Enter — no blur/resume ever comes (the textarea unmounts)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('edited draft and a spoken tail')
    // paused unstuck: the NEXT final buffers visibly again (no invisible deferred limbo).
    hold.pushFinal('next utterance', 'manual', 1000)
    expect(hold.pending()).toBe('next utterance')
  })

  it('an UNRELATED config push (same mode+holdMs) never disturbs an armed countdown (review W3)', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('steady prompt', 'auto', 1000)
    vi.advanceTimersByTime(900)
    // e.g. the speaking-rate slider mid-drag: a flood of jarvis:config pushes with the
    // listen fields UNCHANGED — the countdown must keep its original schedule.
    hold.modeChanged('auto', 1000)
    hold.modeChanged('auto', 1000)
    vi.advanceTimersByTime(100)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('steady prompt') // fired at the ORIGINAL 1000
  })

  it('a real holdMs change re-times the countdown to the new window', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('patient prompt', 'auto', 1000)
    vi.advanceTimersByTime(900)
    hold.modeChanged('auto', 5000) // the user dragged Patience up mid-countdown
    vi.advanceTimersByTime(4900)
    expect(onSend).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('patient prompt')
  })

  it('a LIVE mode flip auto→manual cancels the counting-down send; manual→auto arms over the buffer (review W1)', () => {
    const onSend = vi.fn()
    const hold = createUtteranceHold({ onSend })
    hold.pushFinal('almost sent', 'auto', 1000)
    vi.advanceTimersByTime(900)
    hold.modeChanged('manual', 1000) // Settings flip mid-countdown
    vi.advanceTimersByTime(60_000)
    expect(onSend).not.toHaveBeenCalled() // manual NEVER auto-sends — flip honored
    hold.modeChanged('auto', 1000) // flip back with the buffer still pending
    vi.advanceTimersByTime(1000)
    expect(onSend).toHaveBeenCalledExactlyOnceWith('almost sent') // doesn't sit forever
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
