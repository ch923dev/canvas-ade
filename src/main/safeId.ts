/**
 * MCP-07: the ONE id-safety contract for memory file paths.
 *
 * `canvasMemory` (writer) and `boardMemory` (MCP reader) both derive an on-disk filename from a
 * board/canvas id (`board-<id>.md`, the recap sidecar, …). The id can be agent-controlled (it
 * arrives over the `canvas://board/{id}/summary` MCP URI), so it MUST be a bounded, path-safe token
 * — `[A-Za-z0-9_-]` only (no `.`/`/`/`\` → no traversal), non-empty, and length-capped so a
 * megabyte-long-but-valid-charset id can't reach `join()` + a wasted ENAMETOOLONG syscall (BUG-019).
 *
 * Both modules previously carried their own `SAFE_ID` regex + `MAX_ID_LEN` copy; a drift between
 * them would open a traversal/availability gap on one side only. Keep this the single source.
 */

/** Real board ids are uuid/nanoid-sized; 64 is generous and bounds the path length. */
export const MAX_ID_LEN = 64

/** Path-safe id charset: letters, digits, `_`, `-` only (the `+` requires ≥1 char → empty fails). */
export const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** True when `id` is a non-empty, length-capped, path-safe token usable in a memory filename. */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN && SAFE_ID.test(id)
}
