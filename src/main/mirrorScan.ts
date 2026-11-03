/**
 * The scan bound every `mcp:boards` sanitizer shares, factored out of boardRegistry (max-lines
 * ratchet at the v24 workspaces bump) so `workspaceMirror.ts` uses the SAME bound without an import
 * cycle back into boardRegistry.
 */

/** How many raw entries a sanitizer may SCAN per output slot it can keep (malformed entries are
 *  skipped, so a cap-sized window alone could starve a payload with a few bad rows). */
const SCAN_FACTOR = 4

/**
 * Bound a sanitizer's scan BEFORE it iterates (I2 P3). `for…of` walks every index of a sparse
 * array — holes included — so a forged `mcp:boards` array with `length` 2^32-1 and no elements
 * never fills `out` and spins MAIN for minutes. Every loop over IPC data scans at most
 * `cap × SCAN_FACTOR` entries; `slice` copies only that window. A legit payload is never longer.
 */
export function scanOf(input: readonly unknown[], cap: number): readonly unknown[] {
  const limit = cap * SCAN_FACTOR
  return input.length > limit ? input.slice(0, limit) : input
}
