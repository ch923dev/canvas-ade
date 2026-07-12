/**
 * The daemon's bounded output ring — a chunk deque trimmed from the head (the pty.ts
 * OutputRing shape, kept dependency-free here so daemonMain.ts — which must never import
 * electron-adjacent modules — and the unit suite share ONE implementation).
 */
export interface DaemonRing {
  chunks: string[]
  len: number
}

export function pushDaemonRing(r: DaemonRing, data: string, cap: number): void {
  r.chunks.push(data)
  r.len += data.length
  while (r.len > cap && r.chunks.length > 1) {
    r.len -= r.chunks[0].length
    r.chunks.shift()
  }
  if (r.len > cap) {
    const only = r.chunks[0]
    r.chunks[0] = only.slice(only.length - cap)
    r.len = cap
  }
}

/**
 * Replay = ring joined, head-trimmed to the first line boundary when the ring has wrapped
 * (DESIGN.md D3 / spike lesson: a byte-capped ring can open mid-escape-sequence; starting at
 * a fresh line keeps xterm clean). A single line longer than the ring replays as-is — losing
 * it entirely would be worse.
 */
export function daemonRingReplay(r: DaemonRing, cap: number): string {
  const joined = r.chunks.join('')
  if (r.len < cap) return joined
  const nl = joined.indexOf('\n')
  return nl >= 0 && nl < joined.length - 1 ? joined.slice(nl + 1) : joined
}
