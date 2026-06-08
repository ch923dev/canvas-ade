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
import { type Milestone } from './agentTranscript'

/** Cap the board-content text fed to the model (canvas.json has no live scrollback). */
export const MAX_INPUT_CHARS = 4000

/**
 * BUG-016: cap the model's OUTPUT before it lands on disk. MAX_INPUT_CHARS bounds the prompt, not
 * the response - a `local`/`openrouter` endpoint with no server-side max_tokens (e.g. Ollama
 * num_predict=-1) can return a multi-megabyte completion that gets written verbatim into
 * board-<id>.md. ~8k chars is roughly 4x the 1024-token summary budget - generous for a 1-2
 * sentence summary, tight enough to stop a disk-fill / injection blob.
 */
export const MAX_OUTPUT_CHARS = 8000

const SYSTEM =
  'Summarize what this board is for in 1-2 sentences. Be concise and factual; do not invent details.'

/**
 * BUG-016: sanitize an untrusted LLM completion before it is written into a Markdown memory
 * file. The summary is passive context (shown + MCP-read, never action-triggering), but a
 * misbehaving or malicious provider can return control chars, NUL bytes, or a giant blob. We:
 *  - normalize CRLF / lone CR to LF,
 *  - drop C0/C1 control chars except newline + tab (NUL/BEL/ESC corrupt the file + readers),
 *  - neutralize a forged leading-`#` Markdown heading on each line (escape to `\\#`) so the
 *    model can't break the `# <title>` framing of the file or inject a new top-level heading,
 *  - hard-cap the length to MAX_OUTPUT_CHARS.
 * Pure + total: never throws; a non-string yields ''.
 */
export function sanitizeSummary(text: unknown): string {
  if (typeof text !== 'string') return ''
  return (
    text
      .replace(/\r\n?/g, '\n') // CRLF / lone CR -> LF
      // strip C0/C1 control chars except \n (\u000a) and \t (\u0009)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
      // BUG-041: strip Unicode bidi override and isolate characters (Trojan Source class):
      // U+200B-U+200F (zero-width/LRM/RLM), U+202A-U+202E (LRE/RLE/PDF/LRO/RLO), U+2066-U+2069
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      // BUG-018: preserve leading whitespace when escaping a forged Markdown heading at line start
      .replace(/^([ \t]*)#/gm, '$1\\#')
      .slice(0, MAX_OUTPUT_CHARS)
  )
}

/**
 * BUG-017: sanitize a board title before interpolation into the `# <title>` heading of a
 * Markdown memory file or into a list-item in MEMORY.md. A title with embedded newlines would
 * terminate the ATX heading early and inject additional Markdown structure. Collapses any
 * newline sequences to a space, trims, and escapes a leading `#`.
 * Pure + total: never throws.
 */
export function sanitizeTitle(t: string): string {
  return t
    .replace(/[\r\n]+/g, ' ') // collapse any newlines to a single space
    .replace(/^[ \t]*#/, '\\#') // escape a leading # that would open a new heading context
    .trim()
}

/**
 * SECURITY (terminal recap): scrub common secret shapes out of agent-transcript milestone text
 * BEFORE it becomes egress input. The consent modal promises "only a secret-scrubbed slice leaves;
 * secrets/file-contents never sent", so buildRecapInput runs every milestone through this. Pure +
 * total: never throws; a non-string yields ''. Best-effort, NOT a guarantee — it targets the most
 * common provider-token shapes plus long opaque hex/base64 blobs. Each match → `[redacted]`.
 * Order matters: specific provider prefixes first, the generic high-entropy blob last so it does
 * not chew up the surrounding prose around an already-handled token.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return ''
  return (
    text
      // OpenAI-style: sk-..., sk-proj-..., sk-ant-... (>= 16 trailing key chars)
      .replace(/\bsk-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
      // GitHub tokens: ghp_ (PAT), gho_ (OAuth), ghs_ (server), ghu_ (user), ghr_ (refresh)
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]')
      // AWS access key id: AKIA / ASIA + 16 uppercase alnum
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]')
      // Slack bot/user tokens: xoxb-/xoxp-/xoxa-/xoxr-...
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]')
      // Generic `Bearer <token>` (Authorization headers) — keep the word, redact the token
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer [redacted]')
      // Long opaque hex blob (>= 40 hex chars: SHA-1+, raw key material). Threshold stays at 40 on
      // purpose: a 20-byte (40-hex) token/hash MUST be redacted before egress, and over-redacting a
      // 40-char git SHA in a milestone to [redacted] is an accepted cosmetic loss. Do NOT raise it
      // to 64 to "keep commit hashes" — that re-exposes 20-byte secrets, and the base64 rule below
      // already redacts any hex SHA containing a digit regardless, so it wouldn't even help.
      .replace(/\b[0-9a-fA-F]{40,}\b/g, '[redacted]')
      // Long base64/base64url blob (>= 40 chars) that looks like key material — require a digit so
      // ordinary all-letter prose words never trip it.
      .replace(/\b(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[redacted]')
  )
}

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

// ── Task 9: terminal/agent-CLI session RECAP ────────────────────────────────────────────
//
// ADDITIVE path: taken ONLY for a terminal board whose launchCommand is `claude` AND when the
// injected getAgentMilestones returns >= 1 distilled milestone. Otherwise the loop falls back to
// the existing buildSummarizeInput (config+runtime) path, unchanged. The model returns a small
// JSON payload {now, notes[]}; CODE then assembles the markdown with the REAL milestone timestamps
// (the model is told NOT to emit timestamps) so the timeline is trustworthy even if the prose
// drifts. Egress is secret-scrubbed (redactSecrets) per the consent contract.

/**
 * The recap system prompt. The model receives NUMBERED milestones and returns JSON-only
 * {now, notes:[{i,text}]}, where `i` is the milestone number a note summarizes — the app (not the
 * model) stamps the real time from that milestone. CURATION is the point: a recap is a glance, not a
 * log, so the model keeps only the few resume-relevant beats and drops routine churn.
 */
export const RECAP_SYSTEM =
  'You summarize an AI coding agent session for a developer who wants to resume it. You are given ' +
  'NUMBERED milestones (the user and agent turns). Return ONLY JSON: ' +
  '{"now": "<ONE sentence: what the agent is doing right now + where to resume>", ' +
  '"notes": [{"i": <the milestone number this note summarizes>, "text": "<short, resume-relevant>"}]}. ' +
  'Keep ONLY the 3-5 MOST resume-relevant moments — merge granular steps into one, and SKIP routine ' +
  'chatter, self-corrections, mode/setup lines, and internal status. Prefer concrete decisions, ' +
  'scope, and findings. Be factual; never invent. Do NOT write timestamps — the app adds them from `i`.'

/** Cap how many distilled milestones go into one recap (matches agentTranscript's default). */
export const MAX_MILESTONES = 12

/** Hard ceiling on rendered timeline lines (a recap is a glance, not a log). */
export const MAX_RECAP_NOTES = 5

/** One curated recap note: `i` (1-based milestone number, for the timestamp) + the short text. */
export interface RecapNote {
  i?: number
  text: string
}
/** Parsed recap payload: the NOW headline + curated, milestone-referencing notes. */
export interface RecapPayload {
  now: string
  notes: RecapNote[]
}

/** Coerce one model-supplied note into a RecapNote (tolerates a bare string for back-compat). */
function normalizeNote(n: unknown): RecapNote | null {
  if (typeof n === 'string') return { text: n }
  if (n && typeof n === 'object') {
    const o = n as { i?: unknown; text?: unknown }
    if (typeof o.text === 'string') {
      const i = typeof o.i === 'number' && Number.isFinite(o.i) ? o.i : undefined
      return { i, text: o.text }
    }
  }
  return null
}

/**
 * Pure: parse the model's recap completion. A well-formed `{now, notes}` object → that shape; any
 * non-JSON / malformed payload degrades gracefully to NOW-only (the whole text as `now`, no notes).
 * Never throws.
 *
 * Robust to the common LLM habit of wrapping JSON in a markdown ```json fence (or prefacing it with
 * prose) despite "return ONLY JSON": we slice from the first `{` to the last `}` before parsing, so
 * a fenced/prefixed object still parses into a real NOW + timeline instead of dumping the raw blob.
 */
export function parseRecapPayload(text: string): RecapPayload {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text
  try {
    const o = JSON.parse(candidate) as { now?: unknown; notes?: unknown }
    if (typeof o?.now === 'string') {
      const notes = Array.isArray(o.notes)
        ? o.notes.map(normalizeNote).filter((n): n is RecapNote => n !== null)
        : []
      return { now: o.now, notes }
    }
  } catch {
    /* fall through to NOW-only */
  }
  return { now: text.trim(), notes: [] }
}

/** Pure: a milestone epoch-ms → local "HH:MM" (or "--:--" for a missing/zero timestamp). */
function hhmm(ts: number): string {
  if (!ts) return '--:--'
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * CODE assembles the recap markdown — real timestamps from the milestones, the NOW + curated notes
 * from the (sanitized) model payload. Each note's timestamp comes from the milestone it references
 * (`note.i`, 1-based); if the model omitted/over-ranged `i` we fall back to the note's positional
 * milestone, so a stale index never mis-times or drops a line. Capped at MAX_RECAP_NOTES (a recap is
 * a glance). Both the NOW line and each note run through sanitizeSummary (untrusted LLM → md file).
 */
export function buildRecapMarkdown(
  title: string,
  payload: RecapPayload,
  milestones: Milestone[]
): string {
  const head = `# ${sanitizeTitle(title) || 'Recap'}\n\n**Now:** ${sanitizeSummary(payload.now).trim()}\n`
  const notes = payload.notes.slice(0, MAX_RECAP_NOTES)
  if (notes.length === 0) return head + '\n'
  const lines: string[] = ['']
  notes.forEach((note, idx) => {
    const ref =
      note.i && note.i >= 1 && note.i <= milestones.length
        ? milestones[note.i - 1]
        : milestones[idx]
    const text = sanitizeSummary(note.text).replace(/\n/g, ' ').trim()
    lines.push(`- ${hhmm(ref ? ref.ts : 0)} — ${text}`)
  })
  return head + lines.join('\n') + '\n'
}

/**
 * Build the numbered-milestone summarize input for a terminal recap. SECURITY: each milestone's
 * text is run through redactSecrets BEFORE it becomes egress input (the consent contract). Capped
 * to MAX_INPUT_CHARS like the config path.
 */
export function buildRecapInput(milestones: Milestone[]): SummarizeInput {
  const numbered = milestones
    .map((m, i) => `${i + 1}. [${m.role === 'user' ? 'you' : 'agent'}] ${redactSecrets(m.text)}`)
    .join('\n')
    .slice(0, MAX_INPUT_CHARS)
  return { system: RECAP_SYSTEM, text: numbered || 'No activity yet.' }
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
      // BUG-017: sanitize the title to prevent newlines from breaking the list-item structure
      `- ${sanitizeTitle(str(b.title)) || '(untitled)'} (${str(b.type) || 'unknown'}) — board-${id}.md${mark}`
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
  /**
   * Terminal recap (this feature): MAIN-internal accessor for a board's distilled transcript
   * milestones. Optional + defensive (mirrors getTerminalRuntime): absent/throwing/empty → the
   * loop falls back to the config+runtime summary. NEVER an action surface — read-only.
   */
  getAgentMilestones?: (boardId: string, board: unknown) => Milestone[] | undefined
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
  // BUG-015: key the in-flight guard on (project,board), NOT boardId alone. A board id that
  // collides across projects (deterministic fixture ids; theoretically nanoid) would otherwise
  // let a stale in-flight call from project A block — or, worse, silently drop — a legitimately
  // different board's intent in project B after a rapid switch. `pending` remembers an intent
  // dropped by the guard so the in-flight call's `finally` re-fires it: a content change that
  // raced an in-flight summarize is no longer lost when the first call fails.
  const inFlight = new Set<string>()
  const pending = new Set<string>()
  const fetchImpl = deps.fetch ?? defaultDeps().fetch
  const env = deps.env ?? process.env
  const now = deps.now ?? ((): Date => new Date())

  async function doIntent({ boardId }: SummarizeIntent): Promise<void> {
    {
      const dir = deps.getCurrentDir()
      if (!dir) return
      const key = `${dir}\u0000${boardId}` // NUL can't appear in a real path → unambiguous join
      if (inFlight.has(key)) {
        pending.add(key) // a slow call for this (project,board) is running — remember to retry
        return
      }
      inFlight.add(key)
      try {
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

        // Task 9 (terminal recap): ADDITIVE branch. Taken for ANY terminal board once the injected
        // getAgentMilestones returns >= 1 milestone. We do NOT gate on launchCommand==='claude' here:
        // a transcript is only ever learned (via the SessionStart hook) for a real claude session, so
        // the presence of milestones IS the claude signal — and gating on launchCommand wrongly
        // excluded shell boards where the user typed `claude` by hand. Defensive (mirrors
        // getTerminalRuntime): a throwing/absent getter, a non-terminal board, or an empty milestone
        // list → milestones stays undefined → the existing config+runtime path runs unchanged.
        let milestones: Milestone[] | undefined
        try {
          if ((board as RawBoard)?.type === 'terminal') {
            milestones = deps.getAgentMilestones?.(boardId, board)
          }
        } catch {
          milestones = undefined
        }
        const useRecap = !!milestones && milestones.length > 0

        const config = readLlmConfig(deps.llmDataDir)
        const result = await runSummarize(
          config,
          useRecap
            ? buildRecapInput(milestones!)
            : buildSummarizeInput(board, runtime, now().getTime()),
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
        // BUG-017: ensure the .canvas/ scaffold (incl. the default-private .gitignore) exists before
        // writing memory files. scaffoldProjectMemory at project-open swallows ALL errors, so a
        // transient ENOSPC/EACCES there could leave .gitignore absent — then these writes would
        // create un-ignored board-*.md, breaking the default-private contract. ensureScaffold is
        // idempotent (existsSync-guarded) and best-effort: a failure must not abort the summarize.
        try {
          mem.ensureScaffold()
        } catch (err) {
          console.warn('[summaryLoop] ensureScaffold failed (non-fatal)', err)
        }
        // BUG-016: sanitize + bound the untrusted LLM output before it lands on disk. The input
        // was capped (MAX_INPUT_CHARS) but the response was not - a local/openrouter endpoint with
        // no server-side token cap could return a giant or control-char-laced blob written verbatim.
        // Task 9: the recap path assembles a NOW + code-timestamped timeline from the model's JSON
        // payload + the REAL milestone timestamps; the non-recap path is byte-identical to before.
        // BUG-017: sanitize the title to prevent newlines from breaking the # heading (both paths).
        const title = sanitizeTitle(str((board as RawBoard).title)) || boardId
        const md =
          useRecap && milestones
            ? buildRecapMarkdown(title, parseRecapPayload(result.text), milestones)
            : `# ${title}

${sanitizeSummary(result.text)}
`
        mem.writeBoard(boardId, md)
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
        inFlight.delete(key)
        // BUG-015: a content change that raced this in-flight call was parked in `pending` (and
        // its fingerprint already advanced in memoryEngine, so no future observe() would re-arm
        // it). Re-fire it now that the slot is free — whether this call succeeded OR failed — so a
        // warranted re-summarize is not silently lost on a slow first-call failure.
        //
        // BUG-007: but ONLY if the project hasn't switched out from under the parked intent. The
        // re-fire carries the bare boardId, so a fresh doIntent would re-snapshot getCurrentDir()
        // — if the user opened project B while this projA intent was parked, the retry would
        // summarize + write B's same-id board OUTSIDE the debounce/fingerprint flow (an
        // uninstructed spend; pending is keyed on the OLD projA dir and reset() never clears it).
        // `dir` is this invocation's captured project dir, so skip the re-fire when the live dir
        // no longer matches — the parked intent was for a now-closed project.
        if (pending.delete(key) && deps.getCurrentDir() === dir) void loop.onIntent({ boardId })
      }
    }
  }

  const loop: SummaryLoop = {
    onIntent: doIntent
  }
  return loop
}
