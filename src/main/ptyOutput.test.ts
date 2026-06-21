import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_PAGE, pageOutput, stripAnsi, createRing, pushRing, readRing } from './ptyOutput'

describe('OutputRing (PERF-06 chunk deque)', () => {
  it('concatenates chunks under the cap (read joins them)', () => {
    const r = createRing(10)
    pushRing(r, 'ab')
    pushRing(r, 'cd')
    expect(readRing(r)).toBe('abcd')
  })
  it('keeps exactly the input at the cap boundary', () => {
    const r = createRing(6)
    pushRing(r, 'abcd')
    pushRing(r, 'ef')
    expect(readRing(r)).toBe('abcdef')
    expect(r.total).toBe(6)
  })
  it('drops the oldest chars when over the cap (keeps the last `cap`)', () => {
    const r = createRing(6)
    pushRing(r, 'abcd')
    pushRing(r, 'efgh')
    expect(readRing(r)).toBe('cdefgh')
  })
  it('keeps only the last `cap` chars when a single chunk exceeds the cap', () => {
    const r = createRing(4)
    pushRing(r, 'abcdefgh')
    expect(readRing(r)).toBe('efgh')
    expect(r.total).toBe(4)
  })
  it('is a no-op for an empty chunk', () => {
    const r = createRing(10)
    pushRing(r, 'abc')
    pushRing(r, '')
    expect(readRing(r)).toBe('abc')
  })
  it('bounds the deque under a steady stream of many small chunks (drops whole head chunks)', () => {
    const r = createRing(4)
    for (const c of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) pushRing(r, c)
    expect(readRing(r)).toBe('defg')
    expect(r.total).toBe(4)
  })
  it('readRing collapses the deque to one chunk (repeated reads are stable)', () => {
    const r = createRing(10)
    pushRing(r, 'ab')
    pushRing(r, 'cd')
    expect(readRing(r)).toBe('abcd')
    expect(r.chunks.length).toBe(1) // collapsed
    pushRing(r, 'ef')
    expect(readRing(r)).toBe('abcdef')
  })
  it('an empty ring reads as the empty string', () => {
    expect(readRing(createRing(8))).toBe('')
  })
})

describe('stripAnsi', () => {
  it('removes SGR color codes, keeping the text', () => {
    expect(stripAnsi('\x1b[31mRED\x1b[0m text')).toBe('RED text')
  })

  it('removes cursor-movement / erase CSI sequences', () => {
    expect(stripAnsi('a\x1b[2Jb\x1b[1;1Hc')).toBe('abc')
  })

  it('removes OSC sequences (window title) terminated by BEL or ST', () => {
    expect(stripAnsi('\x1b]0;my title\x07done')).toBe('done')
    expect(stripAnsi('\x1b]0;my title\x1b\\done')).toBe('done')
  })

  it('removes lone/2-byte escape sequences but keeps newlines and tabs', () => {
    expect(stripAnsi('x\x1b(By\tz\nw')).toBe('xy\tz\nw')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain $ npm run dev\n> ready')).toBe('plain $ npm run dev\n> ready')
  })

  // BUG-025: 8-bit C1 escape codes must be stripped, not passed through.
  // On POSIX (non-ConPTY), programs can emit raw 8-bit C1 bytes (U+0080-U+009F);
  // node-pty UTF-8-decodes 0xC2 0x9B -> U+009B etc., so these reach the ring
  // as Unicode code points and must be caught by the strip regex.
  it('BUG-025: removes 8-bit C1 CSI sequences (0x9B = ESC [ equivalent)', () => {
    // U+009B is the 8-bit CSI introducer. The sequence \x9b31m sets red; \x9b0m resets.
    // Both are stripped; the plain text RED and " hi" remain.
    expect(stripAnsi('\x9b31mRED\x9b0m hi')).toBe('RED hi')
    // A sequence with no surrounding plain text produces an empty string.
    expect(stripAnsi('\x9b2J')).toBe('')
  })

  it('BUG-025: removes 8-bit C1 OSC sequences terminated by BEL', () => {
    // U+009D is the 8-bit OSC introducer.
    expect(stripAnsi('\x9d0;title\x07done')).toBe('done')
  })

  it('BUG-025: removes 8-bit C1 OSC sequences terminated by ST (0x9C)', () => {
    expect(stripAnsi('\x9d0;title\x9cdone')).toBe('done')
  })

  it('BUG-025: removes 8-bit C1 OSC sequences terminated by 7-bit ST (ESC \\)', () => {
    expect(stripAnsi('\x9d0;title\x1b\\done')).toBe('done')
  })

  it('BUG-025: removes 8-bit C1 DCS sequences terminated by ST (0x9C)', () => {
    // U+0090 is the 8-bit DCS introducer; payload should be stripped.
    expect(stripAnsi('\x90q#0;2;0;0;0SIXEL\x9cdone')).toBe('done')
  })

  it('BUG-025: removes 8-bit C1 DCS sequences terminated by 7-bit ST (ESC \\)', () => {
    expect(stripAnsi('\x90q#0SIXEL\x1b\\done')).toBe('done')
  })

  it('BUG-025: removes 7-bit DCS sequences including their full payload (not just the introducer)', () => {
    // Without the fix, ESC P ... ESC \\ stripped only ESC P (2-byte intro) and
    // ESC \\ (2-byte ST), leaving the payload "q#0;2;0;0;0SIXELDATA" in the text.
    expect(stripAnsi('\x1bPq#0;2;0;0;0SIXELDATA\x1b\\done')).toBe('done')
  })
})

describe('pageOutput', () => {
  it('returns an empty page for empty input', () => {
    expect(pageOutput('', {})).toEqual({
      text: '',
      total: 0,
      returned: 0,
      nextCursor: undefined,
      droppedOlder: false
    })
  })

  it('returns the whole buffer when it is under one page', () => {
    const p = pageOutput('hello', {})
    expect(p.text).toBe('hello')
    expect(p.total).toBe(5)
    expect(p.returned).toBe(5)
    expect(p.nextCursor).toBeUndefined()
    expect(p.droppedOlder).toBe(false)
  })

  it('caps the tail page at MAX_OUTPUT_PAGE and points nextCursor at older content', () => {
    const clean = 'A'.repeat(MAX_OUTPUT_PAGE) + 'B'.repeat(MAX_OUTPUT_PAGE)
    const p = pageOutput(clean, {})
    expect(p.returned).toBe(MAX_OUTPUT_PAGE)
    expect(p.text).toBe('B'.repeat(MAX_OUTPUT_PAGE)) // tail = newest
    expect(p.nextCursor).toBe(MAX_OUTPUT_PAGE)
    expect(p.droppedOlder).toBe(false)
  })

  it('pages older content via cursor and reassembles in order', () => {
    const clean = 'A'.repeat(MAX_OUTPUT_PAGE) + 'B'.repeat(MAX_OUTPUT_PAGE)
    const p1 = pageOutput(clean, {})
    const p2 = pageOutput(clean, { cursor: p1.nextCursor })
    expect(p2.text).toBe('A'.repeat(MAX_OUTPUT_PAGE))
    expect(p2.nextCursor).toBeUndefined()
    expect(p2.text + p1.text).toBe(clean)
  })

  it('honours a smaller explicit limit but never exceeds MAX_OUTPUT_PAGE', () => {
    const clean = 'x'.repeat(100)
    expect(pageOutput(clean, { limit: 10 }).returned).toBe(10)
    const huge = 'y'.repeat(MAX_OUTPUT_PAGE + 1000)
    expect(pageOutput(huge, { limit: MAX_OUTPUT_PAGE + 9999 }).returned).toBe(MAX_OUTPUT_PAGE)
  })

  it('reports droppedOlder=true only at the oldest page when the ring was saturated', () => {
    const clean = 'A'.repeat(MAX_OUTPUT_PAGE + 50)
    const tail = pageOutput(clean, { truncatedHead: true })
    expect(tail.droppedOlder).toBe(false) // not yet at the front
    const oldest = pageOutput(clean, { cursor: tail.nextCursor, truncatedHead: true })
    expect(oldest.nextCursor).toBeUndefined()
    expect(oldest.droppedOlder).toBe(true) // front reached + ring had discarded older bytes
  })

  it('returns an empty page when the cursor is past the buffer', () => {
    const p = pageOutput('abc', { cursor: 999 })
    expect(p.text).toBe('')
    expect(p.returned).toBe(0)
    expect(p.nextCursor).toBeUndefined()
  })
})
