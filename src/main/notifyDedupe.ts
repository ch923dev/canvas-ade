/**
 * Delivery-level dedupe for lifecycle notifications (audit P2-2). SPEC.md promises "gating, dedupe,
 * and copy live in exactly one place" — the dedupe half was never built, so the same board state
 * could notify twice from independent detectors (the known case: a Claude permission prompt fires
 * `needs-input` from the hook path immediately AND from the generic idle monitor ~10s later).
 *
 * Pure module (no electron): `createLifecycleDeliver` calls `admit(dedupeKey(sig))` AFTER the gate
 * passes — dedupe suppresses repeat DELIVERIES, not repeat attempts, so a fully-silenced event never
 * poisons the window for the next real one.
 *
 * The key is the full signal identity (`boardId|event|attention|detail`), NOT just (board, event):
 * a re-block with a NEW reason (`silent 11m` → `failing check`) is a distinct key and fires, while
 * the identical swarm re-emit collapses. Not user-configurable by design — this is a delivery
 * invariant, not a preference (the workerAttention no-new-config-key rationale).
 */

interface Sig {
  boardId: string
  event: string
  attention?: string
  detail?: string
}

/** The dedupe identity of a deliverable signal. `|` never appears in the closed event/attention
 *  vocabularies, and a `detail` collision across fields is harmless (worst case: one collapsed
 *  duplicate). */
export function dedupeKey(sig: Sig): string {
  return `${sig.boardId}|${sig.event}|${sig.attention ?? ''}|${sig.detail ?? ''}`
}

/**
 * 10s: must SPAN the idle monitor's dwell (`IDLE_PROMPT_MS = 10_000` in ptyLifecycleMonitor) or the
 * hook-vs-idle double `needs-input` slips through; short enough that a genuine second completion on
 * the same board still surfaces. The cost of a rare over-collapse is one missing toast while the
 * on-canvas ring already shows the same state.
 */
export const DELIVER_DEDUPE_MS = 10_000

/** Prune trigger — pure memory hygiene, far above any realistic concurrent-board count. */
const PRUNE_ABOVE = 200

export interface DeliverDedupe {
  /** True ⇒ first sighting inside the window ⇒ deliver. False ⇒ suppress. Records the sighting. */
  admit: (key: string) => boolean
  /** Forget everything (the e2e seam's clean-slate reset). */
  reset: () => void
}

export function createDeliverDedupe(opts?: {
  windowMs?: number
  now?: () => number
}): DeliverDedupe {
  const windowMs = opts?.windowMs ?? DELIVER_DEDUPE_MS
  const now = opts?.now ?? Date.now
  const lastAt = new Map<string, number>()
  return {
    admit: (key: string): boolean => {
      const t = now()
      const prev = lastAt.get(key)
      if (prev !== undefined && t - prev < windowMs) return false
      if (lastAt.size > PRUNE_ABOVE) {
        for (const [k, at] of lastAt) if (t - at >= windowMs) lastAt.delete(k)
      }
      lastAt.set(key, t)
      return true
    },
    reset: (): void => {
      lastAt.clear()
    }
  }
}
