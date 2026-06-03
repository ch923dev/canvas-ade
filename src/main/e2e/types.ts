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

/**
 * A probe inside a fixture group. Unlike the legacy E2EProbe it receives the
 * group's TYPED fixture instead of reading the shared ctx.ids bag.
 */
export interface GroupProbe<F> {
  /** Playlist label (the part name(s) on the returned E2EPart). */
  readonly name: string
  run(ctx: E2ECtx, fixture: F): Promise<E2EPart | E2EPart[]>
}

/**
 * A themed group: seed a typed fixture once, run the group's probes against it
 * (each self-restoring; the runner guards the board-count invariant between
 * probes), then tear down to an empty canvas so groups cannot leak into one
 * another.
 */
export interface E2EGroup<F = unknown> {
  readonly name: string
  setup(ctx: E2ECtx): Promise<F>
  readonly probes: GroupProbe<F>[]
  teardown(ctx: E2ECtx, fixture: F): Promise<void>
}
