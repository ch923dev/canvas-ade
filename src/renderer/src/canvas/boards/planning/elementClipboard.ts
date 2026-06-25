/**
 * In-app element clipboard for cross-board element transfer (Phase 3 — spec §3.B).
 *
 * A tiny EPHEMERAL module-level singleton holding the origin-normalized payload produced by
 * `extractForTransfer` (planning/elements.ts). Ctrl+C / Ctrl+X write it; Ctrl+V reads it and
 * materializes fresh-id copies via `insertTransferred` into the focused board.
 *
 * Scene/session split (CLAUDE.md): this is SESSION state — it is NEVER serialized, never the
 * OS clipboard, never routed into a board's `elements[]` or `PATCHABLE_KEYS`. It lives only in
 * memory for the app session and persists until overwritten or the app closes. A module
 * singleton is deliberate: the keyboard handler reads/writes it imperatively at key time, and
 * it is shared across every Planning board so a copy on board A pastes onto board B
 * (cross-board) or back onto board A (within-board duplicate) alike.
 *
 * Stored-payload contract: the payload is exactly what the engine already deep-cloned +
 * normalized (the selection's union-bbox top-left at the origin), so `insertTransferred` —
 * which deep-clones again per insert — is paste-twice safe even though every paste shares this
 * one reference.
 */
import type { PlanningElement } from '../../../lib/boardSchema'

// The single in-memory slot. `null` = nothing copied yet this session.
let payload: PlanningElement[] | null = null

/** Replace the clipboard with a freshly-extracted (non-empty) payload. */
export function setClipboard(next: PlanningElement[]): void {
  payload = next
}

/** The current payload, or `null` when the clipboard is empty. */
export function getClipboard(): PlanningElement[] | null {
  return payload
}

/** Empty the clipboard. (Not wired to any destructive path in v1 — provided for completeness.) */
export function clearClipboard(): void {
  payload = null
}

/** True when there is a non-empty payload to paste (also false for a defensively-empty slot). */
export function hasClipboard(): boolean {
  return payload !== null && payload.length > 0
}
