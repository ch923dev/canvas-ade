import { describe, expect, it } from 'vitest'
import { createDaemonRing, daemonRingReplay, daemonRingWrapped, pushDaemonRing } from './ring'
import { createRing, pushRing, readRing, readRingReplay, ringWrapped } from '../ptyOutput'

/**
 * Wrap-semantics PARITY between the two PTY output rings: the daemon's (`ptyHost/ring.ts`, replayed
 * on a backgrounded terminal's reattach) and the in-proc one (`ptyOutput.ts`, replayed on adopt /
 * switch-back). They evict differently — the daemon drops WHOLE head chunks, the in-proc ring trims
 * to exactly `cap` — so their retained bytes legitimately differ once saturated. What must NOT differ
 * is the verdict that drives the replay guard: "has anything been evicted?". The in-proc ring fixed
 * its exact-cap off-by-one in PR #369 (`written > cap`); the daemon kept `len >= cap` and dropped an
 * intact first line on every exact-cap reattach. This table holds both to one rule so the next
 * change to either cannot drift them apart again.
 */

interface Case {
  name: string
  cap: number
  pushes: string[]
}

const CASES: Case[] = [
  { name: 'empty', cap: 8, pushes: [] },
  { name: 'well under cap', cap: 16, pushes: ['ab\n', 'cd'] },
  { name: 'EXACTLY cap, one chunk', cap: 6, pushes: ['abcdef'] },
  { name: 'EXACTLY cap, multi-line, multi-chunk', cap: 12, pushes: ['first\n', 'second'] },
  { name: 'one char past cap', cap: 12, pushes: ['first\n', 'second!'] },
  {
    name: 'single chunk far past cap',
    cap: 40,
    pushes: ['A'.repeat(30) + '\nB\n' + 'C'.repeat(20)]
  },
  {
    name: 'whole-chunk eviction leaves daemon below cap',
    cap: 32,
    pushes: ['x'.repeat(20), 'torn\nCLEAN'.padEnd(20, '.')]
  },
  { name: 'one giant newline-free line', cap: 4, pushes: ['abcdefgh'] },
  {
    name: 'many small chunks crossing cap',
    cap: 10,
    pushes: ['a\n', 'bb\n', 'ccc\n', 'dddd\n', 'e']
  }
]

function runDaemon(c: Case): { wrapped: boolean; replay: string; retained: string } {
  const r = createDaemonRing()
  for (const p of c.pushes) pushDaemonRing(r, p, c.cap)
  return {
    wrapped: daemonRingWrapped(r, c.cap),
    replay: daemonRingReplay(r, c.cap),
    retained: r.chunks.join('')
  }
}

function runInProc(c: Case): { wrapped: boolean; replay: string; retained: string } {
  const ring = createRing(c.cap)
  for (const p of c.pushes) pushRing(ring, p)
  return { wrapped: ringWrapped(ring), replay: readRingReplay(ring), retained: readRing(ring) }
}

describe('daemon ring ⇄ in-proc ring: wrap-semantics parity', () => {
  it.each(CASES)('$name', (c) => {
    const full = c.pushes.join('')
    const daemon = runDaemon(c)
    const inProc = runInProc(c)

    // (1) ONE verdict, and it is exactly "more was ever written than the ring may hold".
    expect(daemon.wrapped).toBe(full.length > c.cap)
    expect(inProc.wrapped).toBe(daemon.wrapped)

    for (const ring of [daemon, inProc]) {
      // (2) A replay is always a true suffix of what the PTY produced — never fabricated bytes.
      expect(full.endsWith(ring.replay)).toBe(true)
      if (!ring.wrapped) {
        // (3) Unwrapped ⇒ nothing was dropped ⇒ the replay is the whole stream, verbatim. This is
        //     the exact-cap case the daemon used to get wrong.
        expect(ring.replay).toBe(full)
        continue
      }
      // (4) Wrapped ⇒ the head may be torn, so the replay must START ON A LINE BOUNDARY of the full
      //     stream — unless the retained bytes hold no usable newline, in which case it replays as-is
      //     (losing the only line would be worse).
      const nl = ring.retained.indexOf('\n')
      if (nl >= 0 && nl < ring.retained.length - 1) {
        expect(full[full.length - ring.replay.length - 1]).toBe('\n')
      } else {
        expect(ring.replay).toBe(ring.retained)
      }
    }
  })
})
