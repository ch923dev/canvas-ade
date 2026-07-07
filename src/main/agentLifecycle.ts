/**
 * Agent-lifecycle desktop notifications — Phase 1 (Claude path).
 *
 * The recap hook (recordSession.js) now also registers for Stop / SubagentStop / Notification
 * (see RECAP_HOOK_EVENTS in agentRecapMap.ts) and appends one JSONL line per fired event to the
 * app-owned session map. This module watches that file for NEW lifecycle lines and emits a
 * normalized event, so MAIN can raise a desktop notification when an agent finishes or needs input.
 *
 * It reads the RAW appended lines — NOT readRecapMap's collapsed last-write-wins map — because
 * every event matters (readRecapMap keeps one entry per board, for resume). A (boardId, event)
 * burst (Stop + SubagentStop fire together) is deduped into one emit. History already in the file
 * at init is skipped: only lines appended during this app run notify, never a replay on boot.
 */
import { existsSync, readFileSync, mkdirSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'

export type LifecycleEvent = 'done' | 'needs-input' | 'error'

/** Claude hook event name → normalized lifecycle event (null = not a lifecycle event). */
export function classifyHookEvent(hookEvent: string): LifecycleEvent | null {
  switch (hookEvent) {
    case 'Stop':
    case 'SubagentStop':
      return 'done'
    case 'Notification':
      return 'needs-input'
    default:
      return null
  }
}

export interface LifecycleSignal {
  boardId: string
  event: LifecycleEvent
  /** The agent's working dir at fire time (from the hook line) — notification context. */
  cwd: string
}

/** Parse ONE raw map line into a lifecycle signal, or null (non-lifecycle / malformed / no board). */
export function parseLifecycleLine(raw: string): LifecycleSignal | null {
  const s = raw.trim()
  if (!s) return null
  let d: { boardId?: unknown; hookEvent?: unknown; cwd?: unknown }
  try {
    d = JSON.parse(s) as typeof d
  } catch {
    return null
  }
  if (typeof d.boardId !== 'string' || !d.boardId) return null
  if (typeof d.hookEvent !== 'string') return null
  const event = classifyHookEvent(d.hookEvent)
  if (!event) return null
  return { boardId: d.boardId, event, cwd: typeof d.cwd === 'string' ? d.cwd : '' }
}

/**
 * Notification title copy for a lifecycle event, folding in the agent name when known (SPEC Phase 4
 * › Copy). `done` reads "Task done — claude"; `needs-input`/`error` read as the agent doing the
 * thing ("claude needs your input"). An unknown agent (generic-PTY board with no `agentKind`)
 * falls back to the literal word "agent".
 */
export function lifecycleTitle(event: LifecycleEvent, agent?: string): string {
  const a = agent && agent.trim() ? agent.trim() : 'agent'
  switch (event) {
    case 'done':
      return `Task done — ${a}`
    case 'needs-input':
      return `${a} needs your input`
    case 'error':
      return `${a} hit an error`
  }
}

/**
 * Notification body copy — `<board title> · <detail>` (SPEC Phase 4 › Copy). Either part may be
 * absent (a board missing from the mirror, or the generic-PTY path with no resolved cwd); the
 * present parts join on " · ", and an empty result falls back to a click hint so the notification is
 * never bodyless.
 */
export function lifecycleBody(boardTitle?: string, detail?: string): string {
  const parts = [boardTitle, detail].map((s) => (s ?? '').trim()).filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Click to open the board'
}

/** Number of complete (newline-terminated or final) JSONL rows in the text. */
function countLines(text: string): number {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

function readMap(path: string): string {
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export interface LifecycleScanner {
  /** Emit the NEW, deduped lifecycle signals present in `text` since the last scan/prime. */
  scan: (text: string, nowMs: number) => LifecycleSignal[]
}

/**
 * The stateful line-tracking + dedupe logic, pure over its inputs (no fs) so it is unit-testable.
 * The first `scan` call BASELINES to the file's current line count — pre-existing history never
 * emits (no boot replay). A shrink (the consent-decline prune rewrites the file smaller)
 * re-baselines rather than replaying. A (boardId, event) pair repeating within `dedupeMs` of its
 * last emit is collapsed (Stop + SubagentStop fire together).
 */
export function createLifecycleScanner(dedupeMs = 2000): LifecycleScanner {
  let seen: number | null = null // null until the first scan primes the baseline
  const lastFire = new Map<string, number>()
  return {
    scan(text, nowMs) {
      const total = countLines(text)
      if (seen === null) {
        seen = total // baseline: skip everything already present at startup
        return []
      }
      if (total < seen) {
        seen = total // file shrank (prune) — re-baseline, don't replay
        return []
      }
      const rows = text.split('\n')
      const out: LifecycleSignal[] = []
      for (let i = seen; i < total; i++) {
        const sig = parseLifecycleLine(rows[i])
        if (!sig) continue
        const key = `${sig.boardId}:${sig.event}`
        const prev = lastFire.get(key)
        if (prev !== undefined && nowMs - prev < dedupeMs) continue
        lastFire.set(key, nowMs)
        out.push(sig)
      }
      seen = total
      return out
    }
  }
}

export interface LifecycleNotifierDeps {
  /** Absolute path to the app-owned session-map JSONL (same file the recap hook appends to). */
  mapPath: string
  /** Fired once per NEW lifecycle line appended after init (deduped). */
  onEvent: (sig: LifecycleSignal) => void
  /** Collapse a (boardId, event) burst within this window into one emit (ms). Default 2000. */
  dedupeMs?: number
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number
}

/**
 * Watch the session-map file and emit NEW lifecycle lines (deduped, via {@link createLifecycleScanner}).
 * Returns a disposer. Watches the parent DIRECTORY (the file is created lazily by the hook's first
 * append; fs.watch on a missing file throws) and filters by filename, mirroring watchRecapMap.
 * Best-effort: an unwatchable dir simply yields no lifecycle notifications and never throws.
 */
export function createLifecycleNotifier(deps: LifecycleNotifierDeps): () => void {
  const now = deps.now ?? Date.now
  const scanner = createLifecycleScanner(deps.dedupeMs)
  scanner.scan(readMap(deps.mapPath), now()) // prime the baseline — skip pre-existing history

  const runScan = (): void => {
    for (const sig of scanner.scan(readMap(deps.mapPath), now())) deps.onEvent(sig)
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(runScan, 120)
  }

  let w: ReturnType<typeof watch> | null = null
  try {
    const dir = dirname(deps.mapPath)
    const fname = basename(deps.mapPath)
    mkdirSync(dir, { recursive: true })
    w = watch(dir, { persistent: false }, (_event, filename) => {
      if (filename === null || filename === fname) fire()
    })
  } catch {
    /* dir unwatchable (rare) — best-effort: no lifecycle notifications */
  }

  return () => {
    if (timer) clearTimeout(timer)
    try {
      w?.close()
    } catch {
      /* already closed */
    }
  }
}
