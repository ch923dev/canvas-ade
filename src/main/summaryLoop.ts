/**
 * T-M3: the Tier-2 autonomous summary loop. A {boardId} change-intent (from the T-M2
 * detector) → re-read the board from disk → summarize its CONTENT via the budgeted
 * runSummarize → cache the prose into <project>/.canvas/memory/board-<id>.md + refresh
 * MEMORY.md/project.md. The FIRST autonomous-spend path in the app.
 *
 * 🔒 Opt-in (no key → no-provider → no spend / no write), capped (goes through the
 * budgeted runSummarize — no second egress), passive output (the summary is untrusted
 * passive context: written + later shown/MCP-read, it NEVER triggers an action). The key
 * never leaves MAIN / never lands in .canvas/.
 *
 * PROCESS-BOUNDARY NOTE: MAIN cannot import the renderer's boardSchema/digest.ts
 * (tsconfig.node = src/main/**), so the board content is picked here defensively from the
 * `unknown` doc, mirroring the fields digest.ts/memoryEngine.ts surface (terminal
 * launchCommand/cwd/port; browser url/viewport; planning checklist titles+items + note
 * text).
 */
import { runSummarize, defaultDeps, type FetchLike, type SummarizeInput } from './llmService'
import { readLlmConfig } from './llmConfig'
import { createKeyStore, type Encryptor } from './llmKeyStore'
import { createBudgetStore } from './llmBudget'
import { createCanvasMemory } from './canvasMemory'
import { projectName, type ProjectResult } from './projectStore'
import type { SummarizeIntent } from './memoryEngine'

/** Cap the board-content text fed to the model (canvas.json has no live scrollback). */
export const MAX_INPUT_CHARS = 4000

const SYSTEM =
  'Summarize what this board is for in 1-2 sentences. Be concise and factual; do not invent details.'

type RawBoard = { id?: unknown; type?: unknown; title?: unknown; [k: string]: unknown }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

/**
 * The meaningful, human-readable content slice of one board (mirrors digest.ts fields).
 *
 * F-C / T-F2: the board TITLE is intentionally EXCLUDED from this prompt so it agrees with
 * `memoryEngine.boardFingerprint` (which also omits title). If title were summarized but not
 * fingerprinted, a title-only rename would never re-summarize yet the stale prose could keep
 * naming the OLD title; if it were both, every rename would burn a budgeted summarize for an
 * identical body. We pick neither: the panel card already shows the LIVE title, and the
 * Tier-2 prose describes what the board IS, not what it's called. Keep this field set and
 * boardFingerprint's in lockstep.
 */
function boardContent(b: RawBoard): string {
  switch (b.type) {
    case 'terminal':
      return [
        'Terminal board.',
        str(b.launchCommand) && `Runs: ${str(b.launchCommand)}`,
        str(b.cwd) && `cwd: ${str(b.cwd)}`,
        num(b.port) && `Dev server port: ${num(b.port)}`
      ]
        .filter(Boolean)
        .join('\n')
    case 'browser':
      return [
        'Browser preview board.',
        str(b.url) && `URL: ${str(b.url)}`,
        str(b.viewport) && `Viewport: ${str(b.viewport)}`
      ]
        .filter(Boolean)
        .join('\n')
    case 'planning': {
      const els = Array.isArray(b.elements) ? (b.elements as RawBoard[]) : []
      const lines: string[] = ['Planning board.']
      for (const e of els) {
        if (e.kind === 'checklist') {
          const items = Array.isArray(e.items) ? (e.items as RawBoard[]) : []
          lines.push(`Checklist "${str(e.title)}":`)
          for (const i of items) lines.push(`- [${i.done === true ? 'x' : ' '}] ${str(i.label)}`)
        } else if (e.kind === 'note') {
          lines.push(`Note: ${str(e.text)}`)
        }
      }
      return lines.join('\n')
    }
    default:
      return `Board (${str(b.type) || 'unknown'}).`
  }
}

// ── T-F1: terminal RUNTIME status (running/idle/exited) folded into the summary ──────
//
// Runtime state lives in MAIN (pty.ts), NOT on disk — Tier-1 (disk-only) and the detector
// (canvas.json only) can't see it, so the Tier-2 loop is the one place that can surface it.
// The loop reads it via an injected MAIN-internal getter (see SummaryLoopDeps.getTerminalRuntime)
// and folds a single status line into the terminal board's summarize input. This mirrors the
// renderer's `PtyState` union without importing pty.ts (process-boundary; preload mirrors it the
// same way). The getter is optional + defensive: undefined → omit the line, never throw, never block.

/** A terminal session's runtime, sourced from MAIN (mirrors pty.ts `PtyState` + activity clock). */
export interface TerminalRuntime {
  state: 'spawning' | 'running' | 'exited' | 'spawn-failed'
  /** Epoch ms of the last PTY data/exit, when known. */
  lastActivityAt?: number
  /** Exit code when `state === 'exited'`. */
  exitCode?: number
}

/** A running session with no activity for this long reads as "idle" rather than "running". */
export const IDLE_AFTER_MS = 60_000

/** Pure: a coarse relative-time phrase for a non-negative ms delta ("just now" / "3m ago"). */
function relTime(deltaMs: number): string {
  const s = Math.max(0, Math.round(deltaMs / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}

/**
 * Pure: one human runtime line for a terminal board, or null when unknown. "running" with stale
 * activity (older than IDLE_AFTER_MS) degrades to "idle" so the prose distinguishes an active agent
 * from a parked shell. `now` is injected for deterministic tests.
 */
export function terminalRuntimeLine(rt: TerminalRuntime | undefined, now: number): string | null {
  if (!rt) return null
  switch (rt.state) {
    case 'spawning':
      return 'Status: starting up'
    case 'running': {
      const age = typeof rt.lastActivityAt === 'number' ? now - rt.lastActivityAt : undefined
      const when = age !== undefined ? `, last active ${relTime(age)}` : ''
      const label = age !== undefined && age >= IDLE_AFTER_MS ? 'idle' : 'running'
      return `Status: ${label}${when}`
    }
    case 'exited':
      return `Status: exited${typeof rt.exitCode === 'number' ? ` (code ${rt.exitCode})` : ''}`
    case 'spawn-failed':
      return 'Status: failed to start'
  }
}

/**
 * Pure: a board → a capped SummarizeInput. Never throws on malformed input. For a terminal board
 * an optional `runtime` (from MAIN's getTerminalRuntime) folds in a live status line; `now` (default
 * Date.now()) only affects that relative phrase. Non-terminal boards ignore both extra args.
 */
export function buildSummarizeInput(
  board: unknown,
  runtime?: TerminalRuntime,
  now: number = Date.now()
): SummarizeInput {
  const b = (board ?? {}) as RawBoard
  const lines = [boardContent(b)]
  if (b.type === 'terminal') {
    const status = terminalRuntimeLine(runtime, now)
    if (status) lines.push(status)
  }
  const text = lines.join('\n').slice(0, MAX_INPUT_CHARS)
  return { system: SYSTEM, text: text.length > 0 ? text : 'Empty board.' }
}

function boardsOf(doc: unknown): RawBoard[] {
  const boards = (doc as { boards?: unknown })?.boards
  return Array.isArray(boards) ? (boards as RawBoard[]) : []
}

/** Pure: rebuild MEMORY.md — one line per board, ` ✓` when a cached summary exists. */
export function buildMemoryIndex(doc: unknown, hasSummary: (id: string) => boolean): string {
  const lines = ['# Memory', '']
  for (const b of boardsOf(doc)) {
    const id = str(b.id)
    if (!id) continue
    const mark = hasSummary(id) ? ' ✓' : ''
    lines.push(
      `- ${str(b.title) || '(untitled)'} (${str(b.type) || 'unknown'}) — board-${id}.md${mark}`
    )
  }
  return lines.join('\n') + '\n'
}

/** Pure: a small project-level roll-up (header + board counts). */
export function buildProjectRollup(name: string, doc: unknown): string {
  const boards = boardsOf(doc)
  const by = (t: string): number => boards.filter((b) => b.type === t).length
  const n = boards.length
  return (
    `# ${name}\n\n` +
    `${n} board${n === 1 ? '' : 's'}: ` +
    `${by('terminal')} terminal, ${by('browser')} browser, ${by('planning')} planning\n`
  )
}

export interface SummaryLoopDeps {
  /** Where the file-backed key/budget stores live (userData; e2e temp dir). */
  llmDataDir: string
  /** safeStorage encryptor (real in prod; a fake in unit tests — unused on the mock path). */
  encryptor: Encryptor
  /** The current open project dir, or null. */
  getCurrentDir: () => string | null
  /** Read a project's doc from disk (post-save). */
  readProject: (dir: string) => ProjectResult
  /**
   * T-F1: MAIN-internal accessor for a terminal board's live runtime (running/idle/exited).
   * Optional + defensive — when absent (e.g. not yet wired to pty.ts) or it returns undefined,
   * the summary simply omits the status line. NEVER an action surface: the loop only READS it.
   */
  getTerminalRuntime?: (boardId: string) => TerminalRuntime | undefined
  /** Clock for the per-day budget (default new Date()). */
  now?: () => Date
  /** Transport (default global fetch); the mock seam short-circuits it under e2e. */
  fetch?: FetchLike
  /** Env override (default process.env); tests pass CANVAS_LLM_MOCK to force the mock. */
  env?: Record<string, string | undefined>
}

export interface SummaryLoop {
  /** Handle one detector intent: read → summarize → write. Best-effort; never throws. */
  onIntent(intent: SummarizeIntent): Promise<void>
}

export function createSummaryLoop(deps: SummaryLoopDeps): SummaryLoop {
  const inFlight = new Set<string>()
  const fetchImpl = deps.fetch ?? defaultDeps().fetch
  const env = deps.env ?? process.env
  const now = deps.now ?? ((): Date => new Date())

  return {
    async onIntent({ boardId }) {
      if (inFlight.has(boardId)) return // a slow call for this board is already running
      inFlight.add(boardId)
      try {
        const dir = deps.getCurrentDir()
        if (!dir) return
        const r = deps.readProject(dir)
        if (!r.ok) return
        const boards = (r.doc as { boards?: unknown })?.boards
        const board = Array.isArray(boards)
          ? (boards as { id?: unknown }[]).find((b) => b.id === boardId)
          : undefined
        if (!board) return // deleted between the debounce and the fire

        // T-F1: fold the terminal's live runtime (if the getter is wired + returns one) into the
        // input. Defensive: a throwing/absent getter must never fail the summarize or block a save.
        let runtime: TerminalRuntime | undefined
        try {
          runtime = deps.getTerminalRuntime?.(boardId)
        } catch {
          runtime = undefined
        }
        const config = readLlmConfig(deps.llmDataDir)
        const result = await runSummarize(
          config,
          buildSummarizeInput(board, runtime, now().getTime()),
          {
            fetch: fetchImpl,
            env,
            keyStore: createKeyStore(deps.llmDataDir, deps.encryptor),
            budget: createBudgetStore(deps.llmDataDir, now)
          }
        )
        if (!result.ok) return // no-provider / budget-exceeded / provider-error → Tier-1 stays

        // BUG-006: TOCTOU guard. `dir` was snapshotted before the (up to 30 s) await; the user can
        // close project A and open project B while the LLM call is in flight. memoryEngine.reset()
        // cancels pending debounces but has no handle to this already-running promise, so without
        // this re-check we'd write board-<id>.md / MEMORY.md / project.md into the OLD project's
        // .canvas/ — stale prose for a board that may not even exist in the now-open project.
        if (deps.getCurrentDir() !== dir) return // project switched mid-summarize → drop the write

        const mem = createCanvasMemory(dir)
        mem.writeBoard(
          boardId,
          `# ${str((board as RawBoard).title) || boardId}\n\n${result.text}\n`
        )
        // BUG-014: the index + rollup enumerate the WHOLE board list, so they must reflect any
        // boards added/removed during the (up to 30 s) await — not the `r.doc` snapshot taken
        // before it. With another board's intent racing concurrently, the stale snapshot would
        // make the last writer silently overwrite MEMORY.md with an out-of-date board list. The
        // dir is already re-confirmed by the TOCTOU guard above, so this re-read is the SAME
        // project; fall back to the snapshot only if the fresh read fails.
        const fresh = deps.readProject(dir)
        const doc = fresh.ok ? fresh.doc : r.doc
        mem.writeIndex(buildMemoryIndex(doc, (id) => mem.readBoard(id) !== undefined))
        mem.writeProject(buildProjectRollup(projectName(dir), doc))
      } catch (err) {
        console.warn('[summaryLoop] onIntent failed (non-fatal)', err)
      } finally {
        inFlight.delete(boardId)
      }
    }
  }
}
