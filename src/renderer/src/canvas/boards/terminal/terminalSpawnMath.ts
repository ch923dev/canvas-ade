/**
 * Pure decision helpers for the terminal spawn lifecycle, extracted from useTerminalSpawn
 * (max-lines doctrine, resize-storm fix slice). No React, no xterm — every function here is
 * a decidable seam unit-tested in useTerminalSpawn.test.ts (imports stay on that module via
 * its re-export, the pty.ts › ptyResize.ts precedent).
 */
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'

/** The full-view modal's inset (mirrors FullViewModal's 5vh/5vw → ~90% of the viewport). */
const FULL_VIEW_INSET = 0.9

/** Min ConPTY build for xterm to keep reflow ON under the `windowsPty` hint (its `_isReflowEnabled`
 *  gate). Below this, setting `windowsPty` would DISABLE reflow → widen-loses-data; so we skip it. */
const CONPTY_REFLOW_MIN_BUILD = 21376

/**
 * A-Win: xterm's `windowsPty` constructor hint (terminal-scrollback fix § A-Win). On a Windows 11
 * ConPTY build (≥ 21376) it tells xterm the ConPTY context so its resize/scrollback handling defers
 * to ConPTY's own screen reprint instead of double-laying-out the screen — cutting the row
 * duplication/garble seen on a drag-resize. Returns `undefined` (no hint) off Windows (`winBuild`
 * null) or on older builds, where enabling it would instead DISABLE reflow and lose data on widen.
 * Pure for unit-testing the build gate.
 */
export function conptyHint(
  winBuild: number | null
): { backend: 'conpty'; buildNumber: number } | undefined {
  if (winBuild == null || winBuild < CONPTY_REFLOW_MIN_BUILD) return undefined
  return { backend: 'conpty', buildNumber: winBuild }
}

/**
 * Full-view font scale (Pure A1, docs/research/2026-06-23-terminal-scrollback-reflow; grid
 * unfrozen in S3). Full view portals the board OUTSIDE React Flow at native scale (no camera).
 * counterScale is the factor that fits the IN-CANVAS grid into the modal — the font seam renders
 * at pinned × cs (natively crisp, no bitmap upscale), so full view reads bigger. Since S3 the
 * grid is no longer frozen at that size: `fitWhole` refits cols/rows to the modal at the scaled
 * font THROUGH the lossless S2 backstop, so the axis this min-fit letterboxes is filled with real
 * columns/rows instead of dead space (cs keeps only its font-magnification role). We divide the
 * modal by the OUTER board box (board.w/board.h) — deliberately an over-estimate of the grid's
 * content box (it includes the fixed title bar + 12px well padding), which keeps the scale-up
 * CONSERVATIVE (never clips; min of the width/height fits for the same reason). The no-clip rAF
 * loop in useTerminalReraster is the sub-cell safety net for any residual overflow. Window dims
 * are tracked LIVE while full view is open (fvWinSize state in useTerminalSpawn — the stale-scale
 * fix): an OS fullscreen/maximize toggle mid-full-view recomputes the factor.
 */
export function fullViewScale(
  boardW: number,
  boardH: number,
  innerW: number,
  innerH: number
): number {
  if (!(boardW > 0) || !(boardH > 0) || !(innerW > 0) || !(innerH > 0)) return 1
  const k = Math.min((innerW * FULL_VIEW_INSET) / boardW, (innerH * FULL_VIEW_INSET) / boardH)
  // Clamp to a sane, finite, positive range: full view should never SHRINK below ~half (a huge
  // board still reads), and a tiny board scaled to a giant monitor caps at 8× (avoids absurd fonts).
  return Number.isFinite(k) && k > 0 ? Math.min(Math.max(k, 0.5), 8) : 1
}

/**
 * Resolve the PTY spawn descriptor's cwd + launchCommand. Pure, so the cwd fallback
 * chain and the one-shot launch-override precedence are unit-testable in isolation.
 *  - cwd: the board's explicit cwd, else the open project dir, else undefined (MAIN
 *    spawns in os.homedir()).
 *  - launchCommand: a one-shot `override` (e.g. `claude --resume <id>` from the Restart
 *    menu) wins over the board's persisted command. `??` (not `||`) so a deliberate
 *    empty override stays empty rather than reverting to the board command.
 */
export function resolveSpawnArgs(
  board: Pick<TerminalBoardData, 'cwd' | 'launchCommand'>,
  projectDir: string | null | undefined,
  override?: string
): { cwd: string | undefined; launchCommand: string | undefined } {
  return {
    cwd: board.cwd ?? projectDir ?? undefined,
    launchCommand: override ?? board.launchCommand
  }
}

/**
 * The adopt → idle → spawn fork, decided once after `adoptTerminal` resolves. Pure.
 *  - adopted (undo-of-delete reattach) → 'running' (the reposted port replays the buffer).
 *  - else idle-on-mount (disk-restored / duplicated) → 'idle' (explicit Start, no auto-spawn).
 *  - else → 'spawn' a fresh shell.
 */
export function nextStateAfterAdopt(
  adopted: boolean,
  idleOnMount: boolean
): 'running' | 'idle' | 'spawn' {
  if (adopted) return 'running'
  if (idleOnMount) return 'idle'
  return 'spawn'
}

/**
 * True only when FitAddon's proposal reflects a REAL layout — finite cols AND rows. An
 * unfitted well (below-LOD `display:none`, mount before first layout) proposes undefined
 * or non-finite dims; every consumer of a proposal must gate on this, or it acts on the
 * constructor-default 80×24 grid. Pure — shared by the deferred spawn (#34), the deferred
 * respawn (#23), the backstop's propose, and the fit-gate release (switch-back replay fix).
 */
export function finiteDims(
  d: { cols: number; rows: number } | undefined
): d is { cols: number; rows: number } {
  return d !== undefined && Number.isFinite(d.cols) && Number.isFinite(d.rows)
}

/**
 * T2·D3 — the write-coalescer's fit-hold gate. PTY bytes render only when the board is live
 * (on-screen ∧ ≥ LOD), no resize-backstop snapshot is mid-flight, AND the grid has been fitted to
 * a real finite layout (`gridFitted`). Until `gridFitted`, incoming bytes are HELD so an adopt's
 * replayed scrollback / a fresh respawn's first output never renders at the constructor-default
 * 80×24 and get reflow-mangled by the first real fit. Mirrors useTerminalSpawn's coalescer `isLive`.
 */
export function fitHoldReleased(
  live: boolean,
  backstopInFlight: boolean,
  gridFitted: boolean
): boolean {
  return live && !backstopInFlight && gridFitted
}

/**
 * T2·D3 — whether THIS fit should release the fit-hold: only when the hold is still ARMED
 * (`gridFitted` false) AND the proposal is finite (a real layout, not the not-laid-out 80×24).
 * Re-arming `gridFitted` (set false) on respawn is what lets a fresh finite fit re-make this
 * decision at the CURRENT cols — without the re-arm a stale `gridFitted === true` carried over from
 * a prior term incarnation keeps the gate open, so a finite-but-wrong transient proposal could have
 * released the hold at the wrong column count.
 */
export function shouldReleaseFitHold(
  gridFitted: boolean,
  proposal: { cols: number; rows: number } | undefined
): boolean {
  return !gridFitted && finiteDims(proposal)
}

/**
 * T2·D2 — the EXACT snapshot/tail splice boundary on the PTY ring's `written` byte axis. A
 * background switch-away serializes the RENDERED xterm buffer (the snapshot preface) and MAIN
 * replays the raw ring tail AFTER it on switch-back; the boundary between them must be exact or the
 * gap duplicates (overlap) / loses (gap) bytes. It is exactly the count of bytes RENDERED into the
 * snapshot = bytes the renderer RECEIVED on the port (`received`, ring-axis, seeded by MAIN's adopt
 * `sync`) minus the bytes the coalescer still HOLDS unrendered (`held` — a hidden board's queued
 * tail belongs to the post-snapshot replay, not the preface). Clamped ≥ 0. Reported to MAIN, which
 * splices `readRingSince(watermark)` after the preface — replacing the old approximate
 * handler-entry ring count.
 */
export function snapshotWatermark(received: number, held: number): number {
  return Math.max(0, received - held)
}

/**
 * T2·D2 — advance the received-byte counter for one port message on the ring's `written` axis.
 * A live `t:'data'` adds its length; MAIN's `t:'sync'` (after an adopt replay) OVERWRITES the
 * counter to the ring's absolute `written` so it re-aligns past the replayed bytes; anything else
 * is inert. Pure so the counting reducer is unit-tested without the port.
 */
export function nextReceived(prev: number, m: { t: string; d?: string; written?: number }): number {
  if (m.t === 'data' && typeof m.d === 'string') return prev + m.d.length
  if (m.t === 'sync' && typeof m.written === 'number') return m.written
  return prev
}

/**
 * T2·D2 — build the persisted snapshot (serialized text + exact splice boundary) from the live
 * serialize result and the current received/held counts, or null when there is nothing to persist
 * (no serializer / non-string). The boundary is `snapshotWatermark(received, held)`. Pure so the
 * snapshot assembly is unit-tested without xterm.
 */
export function buildSnapshot(
  text: string | undefined,
  received: number,
  held: number
): { text: string; watermark: number } | null {
  if (typeof text !== 'string') return null
  return { text, watermark: snapshotWatermark(received, held) }
}
