import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_PAGE, pageOutput, stripAnsi } from './ptyOutput'

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
