/**
 * Recap redesign S0: Layer-0 LOCAL session facts for a terminal board's recap face.
 * Computed entirely from the transcript JSONL tail (+ the board's live runtime) - no
 * LLM, no egress, no consent gate (nothing leaves the machine), no budget. Pure +
 * total: malformed/partial input degrades to a sparse facts object, never a throw.
 *
 * Status heuristic (spec 4.1, precedence top-down): spawn-failed / spawning / exited
 * come straight from the runtime; "waiting-on-you" is transcript-derived - the last
 * meaningful event is an assistant message whose text tail reads as a question, or an
 * AskUserQuestion tool_use with no later user turn; then running vs idle splits on
 * IDLE_AFTER_MS (the same threshold the narrative path uses). An ABSENT runtime
 * (getter not wired / unknown) is treated as alive-unknown: the transcript-derived
 * states still apply, so the facts face stays useful instead of pinning "idle".
 */
import { textFromContent } from './agentTranscript'
import { IDLE_AFTER_MS, redactSecrets, type TerminalRuntime } from './summaryLoop'

export type RecapStatus =
  | 'spawning'
  | 'running'
  | 'waiting-on-you'
  | 'idle'
  | 'exited'
  | 'spawn-failed'

export interface RecapFileFact {
  path: string
  /** 'write' = created/overwritten (sticky once seen); 'edit' = modified in place. */
  op: 'edit' | 'write'
  count: number
  /**
   * Lines added/removed, summed from the file's Edit/Write tool_result `structuredPatch`
   * hunks (recap enrichment P1). Present together only when at least one patch was seen in
   * the tail; a tool_use whose result fell outside the tail window simply lacks them.
   */
  adds?: number
  dels?: number
}

export interface RecapCommandFact {
  label: string
  count: number
}

/** Plan progress from the LAST TodoWrite tool_use in the tail — later entries win (P0). */
export interface RecapTodoFact {
  done: number
  total: number
  /** The in-progress item's label (activeForm preferred over content), when one is marked. */
  active?: string
}

/** Tool failures: tool_results with `is_error`; `last` = scrubbed excerpt of the newest (P0). */
export interface RecapErrorFact {
  count: number
  last?: string
}

/** Sub-agent (Task tool) activity: spawn count + up to AGENT_LABELS_MAX recent labels (P2). */
export interface RecapAgentFact {
  count: number
  labels: string[]
}

export interface RecapFacts {
  v: 1
  status: RecapStatus
  /**
   * Whether the AGENTIC CLI is currently active — scope is the AGENT, not the PTY/shell. The
   * recap's Resume control is offered only when this is false (resuming a live agent would kill
   * + respawn it). Derived from the agent's transcript ACTIVITY (status `running`/`spawning`),
   * NOT the shell lifecycle — so a live shell whose agent has EXITED still offers Resume (the
   * bug this guards against). INTERIM signal (this is the single seam we migrate to an MCP-backed
   * per-board agent-liveness signal): node-pty's `proc.process` can't see the foreground child
   * under Windows ConPTY (verified — it returns the terminal name), so transcript activity is the
   * best local proxy; a just-exited agent reads `running` until activity ages past IDLE_AFTER_MS,
   * so Resume can stay hidden for up to ~60s after it actually exits.
   */
  live: boolean
  /** Present only when `status === 'exited'` and the runtime knew the code. */
  exitCode?: number
  /** Claude's own session title (last `ai-title` record), when present. */
  title?: string
  /** First / latest transcript activity (epoch ms); latest folds in the PTY clock. */
  sessionStart?: number
  lastActivity?: number
  turns: { user: number; agent: number }
  /** The user's last ask (last `last-prompt` record, else last user text turn), capped. */
  lastAsk?: string
  /** Files touched via Edit/MultiEdit/Write/NotebookEdit - deduped, recency-first. */
  files: RecapFileFact[]
  /** Bash commands run - labeled by their `description`, deduped, recency-first. */
  commands: RecapCommandFact[]
  // ── Recap enrichment (2026-07-03): OPTIONAL, feature-detected by the renderer. The facts
  // bundle is computed per recap:get and never persisted, so these are additive with NO
  // schema bump — older transcripts / truncated tails simply lack them.
  /** Plan progress from the last TodoWrite tool_use (P0; later entries win). */
  todos?: RecapTodoFact
  /** Tool errors seen in the tail (P0). */
  errors?: RecapErrorFact
  /** Model id from the LATEST assistant message metadata (P0). */
  model?: string
  /** Git branch read off the transcript records (P0) — never derived by running git. */
  gitBranch?: string
  /**
   * The LAST assistant `usage` (input + cache-read tokens): a POINT metric for "how full is
   * the context", honest under tail truncation. Deliberately NOT a summed cost (P1).
   */
  contextTokens?: number
  /** Sub-agent (Task tool) activity (P2). */
  agents?: RecapAgentFact
  generatedAt: number
}

/** Cap the title anchor (a glance anchor, not a transcript). */
export const TITLE_MAX_CHARS = 200
/** Cap the lastAsk anchor (a glance anchor, not a transcript). */
export const LAST_ASK_MAX_CHARS = 200
/** Cap the files/commands chip lists (recency-ordered; the face shows a handful). */
export const FACT_LIST_MAX = 12
/** How far back in an assistant turn's tail a `?` still reads as an open question. */
const QUESTION_TAIL_CHARS = 200
/** Max length for a Bash command label (from `description`, or the raw command as fallback). */
export const COMMAND_LABEL_MAX = 60
/** Cap the last-error excerpt (a glance line, not a log; scrubbed BEFORE capping). */
export const ERROR_EXCERPT_MAX = 120
/** Cap the active-todo label on the Plan row. */
export const TODO_ACTIVE_MAX = 120
/** Cap the sub-agent label list (the face shows a hint, not a roster). */
export const AGENT_LABELS_MAX = 3
/** Cap the model / gitBranch meta strings (transcripts are untrusted input). */
export const META_FIELD_MAX = 120

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Pure: (transcript tail, runtime, now) -> the facts object the recap face renders.
 * `jsonlTail` is a readTranscriptTail slice, so the first line may be a partial record -
 * the per-line try/catch drops it, same as extractMilestones.
 */
export function computeRecapFacts(
  jsonlTail: string,
  runtime: TerminalRuntime | undefined,
  now: number = Date.now()
): RecapFacts {
  let title: string | undefined
  let lastPrompt: string | undefined
  let lastUserText: string | undefined
  let firstTs = 0
  let lastTs = 0
  let userTurns = 0
  let agentTurns = 0
  // True while an AskUserQuestion tool_use has no LATER user text turn answering it.
  let askPending = false
  let lastEvent: 'user' | 'agent-text' | 'agent-tool' | undefined
  let lastAgentText = ''
  const files = new Map<
    string,
    { path: string; op: 'edit' | 'write'; count: number; seq: number; adds?: number; dels?: number }
  >()
  const commands = new Map<string, { label: string; count: number; seq: number }>()
  let seq = 0
  // Recap enrichment accumulators (all optional outputs; later records win where noted).
  let todos: RecapTodoFact | undefined
  let errorCount = 0
  let lastError: string | undefined
  let model: string | undefined
  let gitBranch: string | undefined
  let contextTokens: number | undefined
  let agentCount = 0
  let agentLabels: string[] = []

  for (const raw of jsonlTail.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    let rec: {
      type?: unknown
      timestamp?: unknown
      aiTitle?: unknown
      lastPrompt?: unknown
      gitBranch?: unknown
      toolUseResult?: unknown
      message?: { role?: unknown; content?: unknown; model?: unknown; usage?: unknown }
    }
    try {
      rec = JSON.parse(s)
    } catch {
      continue // malformed line (incl. the partial first line of a tail read)
    }
    const ts = Date.parse(str(rec.timestamp)) || 0
    if (ts) {
      if (!firstTs) firstTs = ts
      if (ts > lastTs) lastTs = ts
    }
    // Claude Code stamps the checkout's branch on every record — tail-safe (unlike the
    // gitStatus context block, which lives at the transcript HEAD and truncates away).
    const branch = str(rec.gitBranch).trim()
    if (branch) gitBranch = branch.slice(0, META_FIELD_MAX)
    if (rec.type === 'ai-title') {
      const t = str(rec.aiTitle).trim()
      if (t) title = t.slice(0, TITLE_MAX_CHARS)
      continue
    }
    if (rec.type === 'last-prompt') {
      const p = str(rec.lastPrompt).trim()
      if (p) lastPrompt = p
      continue
    }
    const role = rec.message?.role
    if (role === 'user') {
      // ANY user record answers a pending question — in real transcripts the answer to an
      // AskUserQuestion arrives as a tool_result-only user record (no text block), so clear
      // askPending BEFORE the plumbing guard or status pins at 'waiting-on-you' (and live=false,
      // showing Resume) while the agent is actively working on the answer.
      askPending = false
      const userContent = rec.message?.content
      if (Array.isArray(userContent)) {
        // Tool failures ride user records as tool_result blocks with is_error (P0). The
        // excerpt is scrubbed (redactSecrets) BEFORE the cap so a secret straddling the cap
        // can't survive it; an empty-content error still counts but keeps the previous `last`.
        for (const b of userContent) {
          const blk = b as { type?: unknown; is_error?: unknown; content?: unknown }
          if (blk.type !== 'tool_result' || blk.is_error !== true) continue
          errorCount++
          const excerpt = textFromContent(blk.content).replace(/\s+/g, ' ').trim()
          if (excerpt) lastError = redactSecrets(excerpt).slice(0, ERROR_EXCERPT_MAX)
        }
      }
      // Per-file diff stats (P1): Claude Code stores the Edit/Write result detail on the
      // RECORD's top-level `toolUseResult` — `{filePath, structuredPatch: [{lines}]}` where
      // hunk lines carry '+'/'-'/' ' prefixes. Only ANNOTATES an entry the tool_use pass
      // already created (a result whose tool_use fell outside the tail is dropped, never
      // fabricated into a phantom file chip).
      const tur = rec.toolUseResult as { filePath?: unknown; structuredPatch?: unknown } | undefined
      if (tur && typeof tur === 'object' && Array.isArray(tur.structuredPatch)) {
        const cur = files.get(str(tur.filePath))
        if (cur) {
          for (const hunk of tur.structuredPatch) {
            const hunkLines = (hunk as { lines?: unknown })?.lines
            if (!Array.isArray(hunkLines)) continue
            for (const l of hunkLines) {
              if (typeof l !== 'string') continue
              if (l.startsWith('+')) cur.adds = (cur.adds ?? 0) + 1
              else if (l.startsWith('-')) cur.dels = (cur.dels ?? 0) + 1
            }
          }
        }
      }
      const text = textFromContent(userContent).trim()
      if (!text) continue // tool_result-only user records are plumbing, not a user event
      userTurns++
      lastUserText = text
      lastEvent = 'user'
      continue
    }
    if (role !== 'assistant') continue
    // Model id rides every assistant message's metadata; the latest wins (P0).
    const modelId = str(rec.message?.model).trim()
    if (modelId) model = modelId.slice(0, META_FIELD_MAX)
    // Context size = the LAST assistant usage (input + cache-read), a point metric (P1).
    const usage = rec.message?.usage as
      | { input_tokens?: unknown; cache_read_input_tokens?: unknown }
      | undefined
    if (usage && typeof usage === 'object') {
      const input = usage.input_tokens
      if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
        const cacheRead = usage.cache_read_input_tokens
        contextTokens = Math.round(
          input +
            (typeof cacheRead === 'number' && Number.isFinite(cacheRead) && cacheRead >= 0
              ? cacheRead
              : 0)
        )
      }
    }
    const content = rec.message?.content
    const text = textFromContent(content).trim()
    let usedTool = false
    if (Array.isArray(content)) {
      for (const b of content) {
        const blk = b as { type?: unknown; name?: unknown; input?: unknown }
        if (blk.type !== 'tool_use') continue
        usedTool = true
        const name = str(blk.name)
        const input = (blk.input ?? {}) as Record<string, unknown>
        if (FILE_TOOLS.has(name)) {
          const path = str(input.file_path) || str(input.notebook_path)
          if (path) {
            const cur = files.get(path)
            if (cur) {
              cur.count++
              cur.seq = seq++
              if (name === 'Write') cur.op = 'write' // created stays "new" over later edits
            } else {
              files.set(path, {
                path,
                op: name === 'Write' ? 'write' : 'edit',
                count: 1,
                seq: seq++
              })
            }
          }
        } else if (name === 'Bash') {
          const label = (
            str(input.description).slice(0, COMMAND_LABEL_MAX) ||
            str(input.command).slice(0, COMMAND_LABEL_MAX)
          ).trim()
          if (label) {
            const cur = commands.get(label)
            if (cur) {
              cur.count++
              cur.seq = seq++
            } else {
              commands.set(label, { label, count: 1, seq: seq++ })
            }
          }
        } else if (name === 'TodoWrite') {
          // Plan progress (P0): the LAST TodoWrite wins outright — an emptied list clears it.
          const items = input.todos
          if (Array.isArray(items)) {
            if (items.length === 0) {
              todos = undefined
            } else {
              let done = 0
              let active: string | undefined
              for (const t of items) {
                const item = t as { status?: unknown; content?: unknown; activeForm?: unknown }
                if (item?.status === 'completed') done++
                if (!active && item?.status === 'in_progress') {
                  const label = (str(item.activeForm) || str(item.content)).trim()
                  if (label) active = label.slice(0, TODO_ACTIVE_MAX)
                }
              }
              todos = { done, total: items.length, ...(active ? { active } : {}) }
            }
          }
        } else if (name === 'Task') {
          // Sub-agent activity (P2): count every spawn; labels deduped, recency-first, capped.
          agentCount++
          const label = str(input.description).trim().slice(0, COMMAND_LABEL_MAX)
          if (label) {
            agentLabels = [label, ...agentLabels.filter((l) => l !== label)].slice(
              0,
              AGENT_LABELS_MAX
            )
          }
        } else if (name === 'AskUserQuestion') {
          askPending = true
        }
      }
    }
    if (text || usedTool) {
      agentTurns++
      if (text) {
        lastEvent = 'agent-text'
        lastAgentText = text
      } else {
        lastEvent = 'agent-tool'
      }
    }
  }

  const lastActivity = Math.max(lastTs, runtime?.lastActivityAt ?? 0) || undefined

  let status: RecapStatus
  if (runtime?.state === 'spawn-failed') {
    status = 'spawn-failed'
  } else if (runtime?.state === 'spawning') {
    status = 'spawning'
  } else if (runtime?.state === 'exited') {
    status = 'exited'
  } else {
    // runtime 'running' or absent (alive-unknown): transcript-derived states apply
    const waiting =
      askPending ||
      (lastEvent === 'agent-text' && lastAgentText.slice(-QUESTION_TAIL_CHARS).includes('?'))
    if (waiting) status = 'waiting-on-you'
    else if (lastActivity !== undefined && now - lastActivity < IDLE_AFTER_MS) status = 'running'
    else status = 'idle'
  }

  // Agent liveness for Resume-gating = the agentic CLI is actively producing (status `running`)
  // or the board is starting (`spawning`) — derived from the AGENT's transcript activity, not the
  // shell/PTY lifecycle. A quiet (idle), waiting, or exited board reads NOT live, so a live shell
  // whose agent has exited still offers Resume. (proc.process is blind to the foreground child on
  // Windows ConPTY; this is the interim proxy that migrates to an MCP per-board liveness signal.)
  const live = status === 'running' || status === 'spawning'

  const lastAskRaw = lastPrompt ?? lastUserText
  return {
    v: 1,
    status,
    live,
    ...(status === 'exited' && typeof runtime?.exitCode === 'number'
      ? { exitCode: runtime.exitCode }
      : {}),
    ...(title ? { title } : {}),
    ...(firstTs ? { sessionStart: firstTs } : {}),
    ...(lastActivity !== undefined ? { lastActivity } : {}),
    turns: { user: userTurns, agent: agentTurns },
    ...(lastAskRaw ? { lastAsk: lastAskRaw.slice(0, LAST_ASK_MAX_CHARS) } : {}),
    files: [...files.values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, FACT_LIST_MAX)
      .map(({ path, op, count, adds, dels }) => ({
        path,
        op,
        count,
        // Both present together once ANY patch was seen for the file (a 0 is honest data;
        // the renderer shows only the non-zero halves).
        ...(adds !== undefined || dels !== undefined ? { adds: adds ?? 0, dels: dels ?? 0 } : {})
      })),
    commands: [...commands.values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, FACT_LIST_MAX)
      .map(({ label, count }) => ({ label, count })),
    ...(todos ? { todos } : {}),
    ...(errorCount > 0
      ? { errors: { count: errorCount, ...(lastError ? { last: lastError } : {}) } }
      : {}),
    ...(model ? { model } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(agentCount > 0 ? { agents: { count: agentCount, labels: agentLabels } } : {}),
    generatedAt: now
  }
}
