/**
 * Probe contract for the in-process board harness (CANVAS_SMOKE=e2e). Each probe is a
 * self-contained block lifted from the former monolithic runE2ESmoke; the runner
 * (./index.ts) drives them in a FIXED order, threading a shared E2ECtx. Probes return
 * their E2EPart(s) instead of pushing to a shared array.
 */
import type { E2ECtx } from './context'
import type { E2EPart } from '../e2eReport'

export type { E2EPart }

export interface E2EProbe {
  /** Playlist label (the part name(s) a probe emits are on the returned E2EPart). */
  readonly name: string
  /** One part, or several when a block asserts multiple invariants in one pass. */
  run(ctx: E2ECtx): Promise<E2EPart | E2EPart[]>
}
