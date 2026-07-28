/**
 * E2E-ONLY: the harness-owned-capture pin for `osrNetworkStore`.
 *
 * A Data-Flow spec seeds a Browser board's capture through `__canvasE2E` and then asserts on the
 * derived graph — but that board ALSO carries a live MAIN subscription, and every message MAIN sends
 * can destroy the seed:
 *   • `replay`  — replaces `records` wholesale, and the ring buffer is EMPTY at subscribe time
 *                 (`previewOsrNetwork.ts` arms capture on the same line it replays)
 *   • `cleared` — emitted at the OSR page's nav boundary (`applyNavBoundary`), preserve off
 *   • `delta`   — upserts real rows into a set the spec expects to own
 * and separately `clearBoard` (the FIND-011 unmount cleanup) deletes the board's whole entry when a
 * zoom-out crosses `LOD_ZOOM` — the LOD swap is a hard mount/unmount for non-terminal boards.
 *
 * A pinned board ignores ALL FOUR. The pin deliberately lives HERE, in module scope, and NOT as a
 * field on `BoardNet`: PR #396 put the flag inside `byBoard[id]`, which is the very object
 * `clearBoard` deletes, so a single LOD unmount dropped the guard and the next replay wiped the seed
 * permanently. State that protects an entry cannot live inside it.
 *
 * The seeders are unaffected — the guard sits on the MAIN subscription seam (`useSharedOsrNet`), not
 * on `apply`, so the harness can re-seed a pinned board at any time.
 *
 * **Production is untouched**: `pinOsrNet` is reachable only through `__canvasE2E`, which installs
 * behind `isE2E()` (`Canvas.tsx`). Outside the harness the set is always empty and both guards fall
 * out on the `size === 0` fast path.
 */

/** What a pinned board dropped: the three MAIN message kinds + the unmount cleanup. */
export type OsrNetDropKind = 'replay' | 'delta' | 'cleared' | 'clearBoard'

const pinned = new Set<string>()
const drops = new Map<string, Record<OsrNetDropKind, number>>()

const zeroDrops = (): Record<OsrNetDropKind, number> => ({
  replay: 0,
  delta: 0,
  cleared: 0,
  clearBoard: 0
})

/** Make a board's capture harness-owned: MAIN can no longer replace, clear, extend or drop it. */
export function pinOsrNet(id: string): void {
  pinned.add(id)
  if (!drops.has(id)) drops.set(id, zeroDrops())
}

/**
 * Whether `id` is pinned, RECORDING the drop when it is. The single call both guards use, so the
 * per-kind tally is exactly what was suppressed — the evidence channel for a bug class where a green
 * Windows leg proves nothing (see `docs/e2e-reliability-kickoff.md`).
 */
export function dropOsrNetMessage(id: string, kind: OsrNetDropKind): boolean {
  if (pinned.size === 0) return false // production / unpinned run: no map lookup at all
  if (!pinned.has(id)) return false
  const tally = drops.get(id) ?? zeroDrops()
  tally[kind] += 1
  drops.set(id, tally)
  return true
}

/** Per-kind drop tally for a pinned board (null if it was never pinned). Diagnostics only. */
export function osrNetPinStats(id: string): Record<OsrNetDropKind, number> | null {
  const tally = drops.get(id)
  return tally ? { ...tally } : null
}

/**
 * Release every pin and forget the tallies; returns the ids that were pinned. `reset()` deletes
 * exactly those `byBoard` entries: a pinned board skips the unmount cleanup by design, so nothing
 * else would ever collect them.
 */
export function clearOsrNetPins(): string[] {
  const ids = [...pinned]
  pinned.clear()
  drops.clear()
  return ids
}
