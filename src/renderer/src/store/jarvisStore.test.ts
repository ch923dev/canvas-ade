/**
 * Jarvis P1-B — the display transcript is BOUNDED: `turns` caps at MAX_DISPLAY_ROWS on
 * append (oldest rows drop first), so one long conversation no longer grows store memory
 * and the panel DOM without limit (JarvisPanel maps the whole array every render). MAIN's
 * canonical history (jarvisHistoryStore / MAX_HISTORY_TURNS) is bounded separately.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_DISPLAY_ROWS, useJarvisStore } from './jarvisStore'

describe('jarvisStore transcript cap (P1-B)', () => {
  beforeEach(() => {
    useJarvisStore.setState({
      turns: [],
      acts: [],
      activeTurnId: null,
      awaitingReply: false,
      streamText: '',
      lastUserText: '',
      pendingConfirm: null
    })
  })

  it('caps on append: length clamps at MAX_DISPLAY_ROWS and the OLDEST rows drop first', () => {
    const s = useJarvisStore.getState()
    // Each settled turn folds 2 rows (user + assistant; no acts) — run well past the cap.
    const total = Math.ceil(MAX_DISPLAY_ROWS / 2) + 10
    for (let i = 0; i < total; i++) {
      s.turnStarted(i + 1, `question ${i}`)
      s.turnDone(`answer ${i}`, false)
    }
    const { turns } = useJarvisStore.getState()
    expect(turns.length).toBe(MAX_DISPLAY_ROWS)
    // The earliest turns fell off the FRONT…
    expect(turns[0].text).not.toBe('question 0')
    expect(turns.some((t) => t.text === 'question 0')).toBe(false)
    // …and the newest turn survives intact at the tail.
    expect(turns[turns.length - 2]).toMatchObject({ role: 'user', text: `question ${total - 1}` })
    expect(turns[turns.length - 1]).toMatchObject({
      role: 'assistant',
      text: `answer ${total - 1}`
    })
  })

  it('act-row folding survives the slice: user + act + assistant stay adjacent, in order', () => {
    const s = useJarvisStore.getState()
    // Fill to exactly the cap so the next append genuinely slices…
    for (let i = 0; i < MAX_DISPLAY_ROWS / 2; i++) {
      s.turnStarted(i + 1, `q${i}`)
      s.turnDone(`a${i}`, false)
    }
    expect(useJarvisStore.getState().turns.length).toBe(MAX_DISPLAY_ROWS)
    // …then settle a turn WITH a resolved act row.
    s.turnStarted(9001, 'do the thing')
    s.actEvent({ actId: 1, name: 'add_card', summary: 'add_card · "x"', phase: 'ok', gated: true })
    s.turnDone('did it', false)
    const { turns } = useJarvisStore.getState()
    expect(turns.length).toBe(MAX_DISPLAY_ROWS)
    const tail = turns.slice(-3)
    expect(tail.map((t) => t.role)).toEqual(['user', 'act', 'assistant'])
    expect(tail[0].text).toBe('do the thing')
    expect(tail[1].act).toMatchObject({ actId: 1, name: 'add_card', phase: 'ok' })
    expect(tail[2].text).toBe('did it')
  })

  it('a confirm still parked at turn settle is denied + cleared (P1-A dead-gate hygiene)', () => {
    const s = useJarvisStore.getState()
    // Cancel path: the turn settles while the gate is parked (MAIN already settled it
    // denied via the abort wiring) — the renderer slot must not leak into the next turn.
    const doneReply: Array<{ approved: boolean }> = []
    s.turnStarted(1, 'do the thing')
    s.confirmRequested({ title: 'T', body: 'B' }, (d) => doneReply.push(d))
    s.turnDone('', true)
    expect(doneReply).toEqual([{ approved: false }])
    expect(useJarvisStore.getState().pendingConfirm).toBeNull()
    // Error path: same hygiene.
    const failReply: Array<{ approved: boolean }> = []
    s.turnStarted(2, 'again')
    s.confirmRequested({ title: 'T', body: 'B' }, (d) => failReply.push(d))
    s.turnFailed('turn-failed')
    expect(failReply).toEqual([{ approved: false }])
    expect(useJarvisStore.getState().pendingConfirm).toBeNull()
  })

  it('hydrateTurns clamps an over-long hydrate to the NEWEST rows (belt+braces)', () => {
    const rows = Array.from({ length: MAX_DISPLAY_ROWS + 50 }, (_, i) => ({
      role: 'assistant' as const,
      text: `r${i}`,
      at: i + 1
    }))
    useJarvisStore.getState().hydrateTurns(rows)
    const { turns } = useJarvisStore.getState()
    expect(turns.length).toBe(MAX_DISPLAY_ROWS)
    expect(turns[0].text).toBe('r50')
    expect(turns[turns.length - 1].text).toBe(`r${MAX_DISPLAY_ROWS + 49}`)
  })
})
