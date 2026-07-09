/**
 * M1 — the session sidecar (`.canvas/session.json`) validator. Extracted from boardSchema.ts (which
 * sits at the max-lines cap); reuses boardSchema's own guards so the sidecar is validated EXACTLY
 * the way `fromObject` validates the inline copy.
 */
import {
  isValidViewport,
  reconcileBackground,
  type CanvasViewport,
  type CanvasBackground,
  type CanvasDoc
} from './boardSchema'

/** The session sidecar's validated shape — a subset of the doc (camera + backdrop). */
export interface CanvasSession {
  viewport?: CanvasViewport
  background?: CanvasBackground
}

/**
 * Validate a RAW session sidecar through the SAME guards `fromObject` uses, so a parseable-but-
 * semantically-invalid sidecar (e.g. `{viewport:{x:0,y:0,zoom:0}}`, or `{background:{kind:'file'}}`
 * with no assetId) can NEVER override the doc's inline value with junk. A field that fails validation
 * is dropped (undefined) → the caller falls back to the inline value (fitView / no backdrop).
 */
export function reconcileSession(raw: unknown): CanvasSession {
  if (typeof raw !== 'object' || raw === null) return {}
  const rec = raw as Record<string, unknown>
  const out: CanvasSession = {}
  if (isValidViewport(rec.viewport)) out.viewport = rec.viewport
  // reconcileBackground reads only `.background`; the sidecar carries it.
  const bg = reconcileBackground(raw as unknown as CanvasDoc)
  if (bg) out.background = bg
  return out
}
