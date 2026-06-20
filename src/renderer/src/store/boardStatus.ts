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
import type { BoardStatus } from '../canvas/BoardFrame'

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
        case 'crashed': // D2-C: a dead preview renderer is a failure the agent should see
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

/**
 * Map a coarse bucket to the on-canvas status pill (T1.6 — colour-token dot + a short
 * mono label). The SAME `boardStatusBucket` value drives both this pill AND the MCP
 * `canvas://boards` / `board-states` resources, so the human-visible dot and the
 * agent's view can never disagree (the one-source-of-truth rule). `static` boards
 * (planning / forward types) have no liveness → no pill. `running` uses `--ok` so the
 * BoardFrame pulse lights; attention buckets use `--warn`/`--err`.
 */
const BUCKET_PILL: Record<BoardStatusBucket, BoardStatus | null> = {
  running: { dot: 'var(--ok)', label: 'running' },
  idle: { dot: 'var(--text-3)', label: 'idle' },
  'awaiting-review': { dot: 'var(--warn)', label: 'awaiting review' },
  blocked: { dot: 'var(--warn)', label: 'blocked' },
  failed: { dot: 'var(--err)', label: 'failed' },
  static: null
}

/** The on-canvas status pill for a bucket (null = no pill, e.g. static boards). */
export function bucketToPill(bucket: BoardStatusBucket): BoardStatus | null {
  return BUCKET_PILL[bucket]
}

/** Per-board runtime the snapshot builder reads (the slices the mirror needs). */
export interface BoardStatusRuntime {
  running: Record<string, boolean>
  preview: Record<string, { status: PreviewStatus }>
}

/**
 * A single agent-readable file reference (file-tree S5). A file board's `path` and each Planning
 * `fileref` element project to this shape on the board mirror so the MCP `canvas://boards` view can
 * point an agent at the files the human has surfaced. `path` is the project-relative POSIX path (the
 * `openFileBoard`/`file:*` contract); never file CONTENT.
 */
export interface FileRefSummary {
  path: string
  label: string
}

/** A board's metadata projection the mirror carries (control plane; no content). */
export interface BoardMirrorEntry {
  id: string
  type: string
  title: string
  /**
   * Terminal agent-preset id (schema v10 `agentKind`) — forwarded to the MCP
   * `canvas://boards` view so an orchestrator can route by capability. Absent on
   * non-terminal boards. The full `Board` objects passed in already carry it.
   */
  agentKind?: string
  /**
   * Terminal activity-monitoring opt-out (schema v10). Absent ⇒ monitored; `false`
   * keeps a plain shell out of the agent-facing attention queue (Phase B).
   */
  monitorActivity?: boolean
  /**
   * File board's project-relative path (file-tree S5; `type:'file'` only) — forwarded to
   * `canvas://boards` so an agent knows WHICH file an open File board points at. Absent on
   * non-file boards and on an unbound (placeholder) File board.
   */
  path?: string
  /**
   * Planning board's referenced files (file-tree S5; `type:'planning'` only) — the project-
   * relative path + display label of each `fileref` element, so an agent can see the files a human
   * pinned to a plan. Absent (not `[]`) when a planning board has no fileref elements, keeping
   * non-fileref snapshots byte-identical to before.
   */
  fileRefs?: FileRefSummary[]
}

/**
 * The minimal board shape {@link buildBoardSnapshot} READS. A superset of the mirror's inputs: a
 * `'file'` board's `path` and a `'planning'` board's `elements` (the latter read only to derive
 * `fileRefs`, NEVER emitted onto the mirror). The live `Board` union satisfies this structurally;
 * tests pass plain objects.
 */
export interface BoardSnapshotInput {
  id: string
  type: string
  title: string
  agentKind?: string
  monitorActivity?: boolean
  /** Present on a `'file'` board (FileBoard.path). */
  path?: string
  /** Present on a `'planning'` board (PlanningBoard.elements); read to derive `fileRefs`. */
  elements?: ReadonlyArray<{ kind: string; path?: string; label?: string }>
}

/**
 * Derive a planning board's agent-readable file references from its elements (S5). Keeps only
 * well-formed `fileref` elements with a non-empty string `path`; `label` falls back to the path's
 * basename, then the path itself, so a missing label never blanks the reference. Returns `undefined`
 * (not `[]`) when there are none, so the conditional spread in {@link buildBoardSnapshot} omits the
 * field for fileref-free planning boards.
 */
function deriveFileRefs(
  elements: ReadonlyArray<{ kind: string; path?: string; label?: string }> | undefined
): FileRefSummary[] | undefined {
  if (!elements) return undefined
  const refs: FileRefSummary[] = []
  for (const el of elements) {
    if (el.kind !== 'fileref') continue
    const path = el.path
    if (typeof path !== 'string' || path.length === 0) continue
    const label =
      typeof el.label === 'string' && el.label.length > 0
        ? el.label
        : (path.split('/').pop() ?? '') || path
    refs.push({ path, label })
  }
  return refs.length > 0 ? refs : undefined
}

/**
 * Build the renderer→MAIN board snapshot: each board's `{id,type,title}` plus its
 * derived `status` bucket. Pure — no store/React access — so it is unit-testable and
 * the publish hook is a thin wiring layer over it. The v10 agent-identity fields and the
 * S5 file-context fields (`path` / `fileRefs`) ride through only when present, so a board
 * without them snapshots byte-identical to before.
 */
export function buildBoardSnapshot(
  boards: ReadonlyArray<BoardSnapshotInput>,
  runtime: BoardStatusRuntime
): Array<BoardMirrorEntry & { status: BoardStatusBucket }> {
  return boards.map((b) => {
    // File-context projection (S5): a file board forwards its bound path; a planning board forwards
    // its fileref elements as path+label summaries. Both omitted (not empty) when absent.
    const path = b.type === 'file' && typeof b.path === 'string' ? b.path : undefined
    const fileRefs = b.type === 'planning' ? deriveFileRefs(b.elements) : undefined
    return {
      id: b.id,
      type: b.type,
      title: b.title,
      status: boardStatusBucket(b.type, {
        terminalRunning: runtime.running[b.id],
        preview: runtime.preview[b.id]?.status
      }),
      ...(b.agentKind !== undefined ? { agentKind: b.agentKind } : {}),
      ...(b.monitorActivity !== undefined ? { monitorActivity: b.monitorActivity } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(fileRefs !== undefined ? { fileRefs } : {})
    }
  })
}
