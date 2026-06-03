/**
 * Coarse, agent-facing board status buckets (T1.1) — the single source of truth the
 * MCP `canvas://boards` / `canvas://board/{id}/status` resources expose AND the
 * on-canvas status pill (T1.6) reads. Derived in the renderer from the live runtime
 * stores (`terminalRuntimeStore` running-by-id + `previewStore` load state), then
 * pushed to MAIN over the board mirror — so the human-visible pill and the agent's
 * view can never disagree.
 *
 * Coverage v1 is intentionally coarse: terminals distinguish running vs idle only
 * (the runtime store tracks a single `running` boolean), browsers map their preview
 * load state, planning is static. The richer terminal states (`awaiting-review`,
 * `blocked`) are reserved here but only START being emitted in T1.3 (attention) and
 * M8 (permission detection), when MAIN gains the signals to detect them.
 */
import type { PreviewStatus } from './previewStore'

/** The coarse status buckets an agent (and the canvas chrome) sees per board. */
export type BoardStatusBucket =
  | 'idle'
  | 'running'
  | 'awaiting-review'
  | 'blocked'
  | 'failed'
  | 'static'

/** Live runtime signals a board's bucket is derived from (all optional → resting). */
export interface BoardStatusSignals {
  /** From `terminalRuntimeStore.running[id]` — a terminal's PTY is live. */
  terminalRunning?: boolean
  /** From `previewStore.byId[id].status` — a browser's load lifecycle. */
  preview?: PreviewStatus
}

/**
 * Map a board `type` + its live signals to a coarse bucket. An unrecognized
 * (forward) board type is treated as `static` — it has no known liveness signal.
 */
export function boardStatusBucket(type: string, signals: BoardStatusSignals): BoardStatusBucket {
  switch (type) {
    case 'terminal':
      return signals.terminalRunning ? 'running' : 'idle'
    case 'browser':
      switch (signals.preview) {
        case 'connecting':
          return 'running'
        case 'load-failed':
          return 'failed'
        case 'connected':
        case 'idle':
        default:
          return 'idle'
      }
    case 'planning':
      return 'static'
    default:
      return 'static'
  }
}

/** Per-board runtime the snapshot builder reads (the slices the mirror needs). */
export interface BoardStatusRuntime {
  running: Record<string, boolean>
  preview: Record<string, { status: PreviewStatus }>
}

/** A board's metadata projection the mirror carries (control plane; no content). */
export interface BoardMirrorEntry {
  id: string
  type: string
  title: string
}

/**
 * Build the renderer→MAIN board snapshot: each board's `{id,type,title}` plus its
 * derived `status` bucket. Pure — no store/React access — so it is unit-testable and
 * the publish hook is a thin wiring layer over it.
 */
export function buildBoardSnapshot(
  boards: ReadonlyArray<BoardMirrorEntry>,
  runtime: BoardStatusRuntime
): Array<BoardMirrorEntry & { status: BoardStatusBucket }> {
  return boards.map((b) => ({
    id: b.id,
    type: b.type,
    title: b.title,
    status: boardStatusBucket(b.type, {
      terminalRunning: runtime.running[b.id],
      preview: runtime.preview[b.id]?.status
    })
  }))
}
