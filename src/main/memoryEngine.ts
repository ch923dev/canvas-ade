/**
 * T-M2: the meaningful-change DETECTOR half of the Tier-2 memory loop. Watches the
 * `project:save` doc stream and, when a board's MEANINGFUL content changes (not a pure
 * move/resize/pan/select), emits a debounced `{ boardId }` "summarize" intent. It does
 * NOT call the brain or write `.canvas/` (that is T-M3) — it only decides WHEN a board is
 * worth re-summarizing and emits an id via an injected callback. Electron-free + fully
 * deterministic: the timer is injected (mirrors llmBudget.ts's injected clock) so the
 * debounce unit-tests without real time, and e2e can use a short real debounce.
 *
 * PROCESS-BOUNDARY NOTE: MAIN cannot import the renderer's boardSchema/digest.ts
 * (tsconfig.node only includes src/main/**), so the meaningful-field set is picked here
 * defensively from the `unknown` doc. The picked fields MIRROR the fields
 * src/renderer/src/lib/digest.ts surfaces per type — keep the two in sync (terminal:
 * launchCommand/cwd/port · browser: url/viewport · planning: per-checklist title + items
 * {label,done}, note text). Geometry/selection/canvas pan/zoom are excluded so a pure
 * move/resize/pan/select yields an identical fingerprint. browser previewSourceId is also
 * excluded — it never reaches the summary input, so it would churn spend without changing output.
 *
 * 🔒 Security: generated/observed memory is untrusted passive context. The detector only
 * READS the already-trusted persisted doc and EMITS an id; it never triggers an action
 * beyond the emit. No new egress.
 */

/** Cancel a scheduled debounce. */
export type Cancel = () => void
/** Inject a setTimeout-like seam so the debounce is deterministic in tests. */
export type Scheduler = (fn: () => void, ms: number) => Cancel

/** The one thing the detector emits: "board X is worth re-summarizing." */
export interface SummarizeIntent {
  boardId: string
}

/** Default per-board debounce window — content settles before we spend a summarize. */
export const DEFAULT_DEBOUNCE_MS = 45_000

// ── Meaningful-field extraction (mirrors digest.ts; excludes geometry/selection) ──

type RawBoard = { id?: unknown; type?: unknown; [k: string]: unknown }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The meaningful slice of one board, in a fixed key order, as a stable JSON string. */
export function boardFingerprint(board: unknown): string {
  const b = (board ?? {}) as RawBoard
  switch (b.type) {
    case 'terminal':
      return JSON.stringify({
        t: 'terminal',
        launchCommand: str(b.launchCommand),
        cwd: str(b.cwd),
        port: numOrNull(b.port)
      })
    case 'browser':
      // previewSourceId is intentionally EXCLUDED: the Tier-2 summary (summaryLoop.boardContent)
      // never includes the preview link, so a link-only change can't change the cached prose —
      // fingerprinting it would only burn a budgeted summarize call that produces identical output.
      // The fingerprint mirrors the SUMMARY INPUT, not digest.ts's richer Tier-1 line set.
      return JSON.stringify({
        t: 'browser',
        url: str(b.url),
        viewport: str(b.viewport)
      })
    case 'planning': {
      const elements = Array.isArray(b.elements) ? (b.elements as RawBoard[]) : []
      const checklists = elements
        .filter((e) => e.kind === 'checklist')
        .map((e) => ({
          title: str(e.title),
          items: (Array.isArray(e.items) ? (e.items as RawBoard[]) : []).map((i) => ({
            label: str(i.label),
            done: i.done === true
          }))
        }))
      const notes = elements.filter((e) => e.kind === 'note').map((e) => str(e.text))
      return JSON.stringify({ t: 'planning', checklists, notes })
    }
    default:
      // Unknown/missing type: a stable constant per id so it never churns intents.
      return JSON.stringify({ t: String(b.type ?? 'unknown'), id: str(b.id) })
  }
}

// ── createMemoryEngine — per-board debounced change detector ──────────────────

export interface MemoryEngineDeps {
  /** Called once per board after its debounce settles. The ONLY output of the detector. */
  onIntent: (intent: SummarizeIntent) => void
  /** Debounce window per board (ms). Default DEFAULT_DEBOUNCE_MS. e2e/tests override small. */
  debounceMs?: number
  /** Timer seam. Default wraps setTimeout/clearTimeout. Tests inject a manual fake. */
  schedule?: Scheduler
}

export interface MemoryEngine {
  /** Feed a saved doc (the `project:save` payload, typed `unknown`). Best-effort, pure-read. */
  observe(doc: unknown): void
  /** Drop all per-board state + cancel pending timers (call on project switch). */
  reset(): void
}

/** Default real timer: setTimeout/clearTimeout. */
const realScheduler: Scheduler = (fn, ms) => {
  const t = setTimeout(fn, ms)
  // unref so a pending debounce never keeps the MAIN process alive at quit.
  if (typeof t.unref === 'function') t.unref()
  return () => clearTimeout(t)
}

export function createMemoryEngine(deps: MemoryEngineDeps): MemoryEngine {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const schedule = deps.schedule ?? realScheduler
  const fingerprints = new Map<string, string>()
  const timers = new Map<string, Cancel>()
  let primed = false

  function cancelTimer(id: string): void {
    const cancel = timers.get(id)
    if (cancel) {
      cancel()
      timers.delete(id)
    }
  }

  function armDebounce(id: string): void {
    cancelTimer(id) // trailing-edge: a fresh meaningful change restarts the window
    const cancel = schedule(() => {
      // delete the entry BEFORE the callback so a re-entrant observe() from inside
      // onIntent doesn't find a stale cancel fn.
      timers.delete(id)
      deps.onIntent({ boardId: id })
    }, debounceMs)
    timers.set(id, cancel)
  }

  return {
    observe(doc) {
      const boards = (doc as { boards?: unknown })?.boards
      if (!Array.isArray(boards)) return // best-effort: a malformed doc is a no-op

      const seen = new Set<string>()
      for (const board of boards) {
        const id = str((board as RawBoard)?.id)
        if (!id) continue
        seen.add(id)
        const fp = boardFingerprint(board)
        const prev = fingerprints.get(id)
        fingerprints.set(id, fp)
        if (!primed) continue // first doc of a session: baseline only, never emit
        if (prev === undefined || prev !== fp) armDebounce(id) // new or changed board
      }

      // A board removed from the doc: drop its state + cancel any pending intent.
      for (const id of [...fingerprints.keys()]) {
        if (!seen.has(id)) {
          cancelTimer(id)
          fingerprints.delete(id)
        }
      }

      primed = true
    },
    reset() {
      for (const id of [...timers.keys()]) cancelTimer(id)
      fingerprints.clear()
      primed = false
    }
  }
}
