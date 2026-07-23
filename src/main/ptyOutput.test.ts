import { describe, expect, it } from 'vitest'
import {
  MAX_OUTPUT_PAGE,
  pageOutput,
  stripAnsi,
  createRing,
  pushRing,
  readRing,
  readRingSince,
  readRingReplay,
  readRingSinceReplay,
  trimWrappedReplayHead,
  ringWrapped,
  resolveFlushWatermark
} from './ptyOutput'

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

// Bg sessions Phase 5: the `written` watermark + post-watermark reads that make the
// snapshot+tail splice possible (park records `written`; adopt replays only what followed).
describe('readRingSince (Phase 5 watermark splice)', () => {
  it('tracks cumulative written across pushes (never decremented by eviction)', () => {
    const ring = createRing(4)
    pushRing(ring, 'abcd')
    pushRing(ring, 'efgh')
    expect(ring.written).toBe(8)
    expect(readRing(ring)).toBe('efgh') // capped retained tail
  })

  it('returns only the bytes pushed after the watermark', () => {
    const ring = createRing(1024)
    pushRing(ring, 'before-park')
    const watermark = ring.written
    pushRing(ring, 'AFTER')
    expect(readRingSince(ring, watermark)).toBe('AFTER')
  })

  it('returns empty when nothing followed the watermark', () => {
    const ring = createRing(1024)
    pushRing(ring, 'x')
    expect(readRingSince(ring, ring.written)).toBe('')
  })

  it('degrades to the whole retained tail when eviction ate part of the fresh bytes', () => {
    const ring = createRing(4)
    pushRing(ring, 'old')
    const watermark = ring.written
    pushRing(ring, 'abcdefgh') // 8 fresh chars, only 4 retained
    expect(readRingSince(ring, watermark)).toBe('efgh')
  })

  it('a watermark of 0 (legacy park) reads as the full retained ring', () => {
    const ring = createRing(1024)
    pushRing(ring, 'everything')
    expect(readRingSince(ring, 0)).toBe('everything')
  })
})

// T2·D1: line-boundary replay guard — mirrors the daemon ring's daemonRingReplay (ptyHost/ring.ts).
// A wrapped (saturated) ring can open a replay mid-CSI; guard the FULL replay + the degraded
// post-watermark tail, while leaving the exact splice boundary untrimmed.
describe('trimWrappedReplayHead (T2·D1)', () => {
  it('is verbatim when not wrapped (nothing was dropped, head is intact)', () => {
    expect(trimWrappedReplayHead('\x1b[31mred\nmore', false)).toBe('\x1b[31mred\nmore')
  })
  it('drops the torn first line when wrapped', () => {
    expect(trimWrappedReplayHead('rn-esc\x1b[3\nCLEAN\nrest', true)).toBe('CLEAN\nrest')
  })
  it('replays a single newline-free line as-is when wrapped (losing it is worse)', () => {
    expect(trimWrappedReplayHead('x'.repeat(40), true)).toBe('x'.repeat(40))
  })
  it('replays as-is when the only newline is the final char (no clean line follows)', () => {
    expect(trimWrappedReplayHead('torn-head\n', true)).toBe('torn-head\n')
  })
})

describe('ringWrapped (T2·D1)', () => {
  it('is false under the cap, true once saturated', () => {
    const r = createRing(6)
    pushRing(r, 'abcd')
    expect(ringWrapped(r)).toBe(false)
    pushRing(r, 'efgh') // now over cap → head trimmed, saturated
    expect(ringWrapped(r)).toBe(true)
  })
  it('is FALSE at exactly cap with nothing evicted (off-by-one: pushRing trims only on strict overflow)', () => {
    const r = createRing(6)
    pushRing(r, 'abcdef') // total === cap, written === cap, head intact (no trim happened)
    expect(r.total).toBe(6)
    expect(r.written).toBe(6)
    expect(ringWrapped(r)).toBe(false) // a `total >= cap` check would wrongly report wrapped here
    // …and a full-ring replay must therefore NOT drop the (complete) first line.
    const r2 = createRing(12)
    pushRing(r2, 'first\nsecond') // 12 chars === cap exactly, untouched
    expect(readRingReplay(r2)).toBe('first\nsecond')
  })
})

describe('readRingReplay (T2·D1 full-ring replay guard)', () => {
  it('replays verbatim while under the cap', () => {
    const r = createRing(1024)
    pushRing(r, 'first\nsecond')
    expect(readRingReplay(r)).toBe('first\nsecond')
  })
  it('starts a wrapped replay after the first newline (no mid-escape head)', () => {
    const r = createRing(16)
    // Force saturation so the head chunk is trimmed to a torn line, then a clean line follows.
    pushRing(r, 'AAAAAAAAAAAA') // 12
    pushRing(r, 'B\nCLEAN-TAIL') // over cap 16 → oldest head trimmed to 'AAAA', ring wrapped
    expect(ringWrapped(r)).toBe(true)
    expect(readRing(r)).toBe('AAAAB\nCLEAN-TAIL') // torn head is 'AAAAB' (mid-line)
    // The torn head is dropped at the first newline boundary → the replay starts clean.
    expect(readRingReplay(r)).toBe('CLEAN-TAIL')
  })
  it('replays a wrapped single giant line as-is (no newline to trim to)', () => {
    const r = createRing(4)
    pushRing(r, 'abcdefgh') // saturated, single line, no newline
    expect(ringWrapped(r)).toBe(true)
    expect(readRingReplay(r)).toBe('efgh')
  })
})

describe('resolveFlushWatermark (T2·D2 exact splice boundary)', () => {
  it('uses the renderer-reported boundary, clamped to the live ring', () => {
    expect(resolveFlushWatermark(120, 500)).toBe(120)
  })
  it('clamps a renderer count that (impossibly) exceeds the ring to the ring written', () => {
    expect(resolveFlushWatermark(9999, 500)).toBe(500)
  })
  it('clamps a negative renderer count to 0', () => {
    expect(resolveFlushWatermark(-5, 500)).toBe(0)
  })
  it('falls back to the ring count for a legacy caller (no renderer watermark)', () => {
    expect(resolveFlushWatermark(undefined, 500)).toBe(500)
  })
  it('falls back to the ring count when the renderer watermark is non-finite', () => {
    expect(resolveFlushWatermark(Number.NaN, 500)).toBe(500)
  })
  it('is null when there is no live session to splice (null ring written)', () => {
    expect(resolveFlushWatermark(120, null)).toBeNull()
    expect(resolveFlushWatermark(undefined, null)).toBeNull()
  })
})

describe('readRingSinceReplay (T2·D1 post-watermark replay guard)', () => {
  it('returns empty when nothing followed the watermark', () => {
    const r = createRing(1024)
    pushRing(r, 'x')
    expect(readRingSinceReplay(r, r.written)).toBe('')
  })
  it('does NOT trim the exact splice boundary (preserves the preface join)', () => {
    const r = createRing(1024)
    pushRing(r, 'PREFACE-END') // rendered into the snapshot preface
    const watermark = r.written
    pushRing(r, 'no-newline-tail-continues-the-line')
    // Even though there is no newline, the exact in-ring slice is returned untrimmed so the
    // snapshot's trailing partial line keeps its raw continuation.
    expect(readRingSinceReplay(r, watermark)).toBe('no-newline-tail-continues-the-line')
  })
  it('trims the torn head only in the degraded (eviction ate the boundary) case', () => {
    const r = createRing(10)
    pushRing(r, 'aaaaaaaaaa') // fills the ring
    const watermark = r.written // 10
    // Push past the watermark region so eviction eats it: written(21) - watermark(10) = 11 fresh,
    // but only 10 retained → degraded whole-tail path with a torn 'b…' head.
    pushRing(r, 'bb\nCCCCCCCC')
    expect(ringWrapped(r)).toBe(true)
    expect(readRing(r)).toBe('b\nCCCCCCCC') // torn head 'b', then a clean line
    expect(readRingSinceReplay(r, watermark)).toBe('CCCCCCCC') // wrap-guard drops the torn head
  })
})
