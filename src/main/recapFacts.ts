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
import { IDLE_AFTER_MS, type TerminalRuntime } from './summaryLoop'

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
}

export interface RecapCommandFact {
  label: string
  count: number
}

export interface RecapFacts {
  v: 1
  status: RecapStatus
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
  generatedAt: number
}

/** Cap the lastAsk anchor (a glance anchor, not a transcript). */
export const LAST_ASK_MAX_CHARS = 200
/** Cap the files/commands chip lists (recency-ordered; the face shows a handful). */
export const FACT_LIST_MAX = 12
/** How far back in an assistant turn's tail a `?` still reads as an open question. */
const QUESTION_TAIL_CHARS = 200
/** Fallback command-label length when a Bash tool_use carries no `description`. */
const COMMAND_LABEL_MAX = 60

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
    { path: string; op: 'edit' | 'write'; count: number; seq: number }
  >()
  const commands = new Map<string, { label: string; count: number; seq: number }>()
  let seq = 0

  for (const raw of jsonlTail.split('\n')) {
    const s = raw.trim()
    if (!s) continue
    let rec: {
      type?: unknown
      timestamp?: unknown
      aiTitle?: unknown
      lastPrompt?: unknown
      message?: { role?: unknown; content?: unknown }
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
    if (rec.type === 'ai-title') {
      const t = str(rec.aiTitle).trim()
      if (t) title = t
      continue
    }
    if (rec.type === 'last-prompt') {
      const p = str(rec.lastPrompt).trim()
      if (p) lastPrompt = p
      continue
    }
    const role = rec.message?.role
    if (role === 'user') {
      const text = textFromContent(rec.message?.content).trim()
      if (!text) continue // tool_result-only user records are plumbing, not a user event
      userTurns++
      lastUserText = text
      askPending = false // the user replied past any pending question
      lastEvent = 'user'
      continue
    }
    if (role !== 'assistant') continue
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
            str(input.description) || str(input.command).slice(0, COMMAND_LABEL_MAX)
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

  const lastAskRaw = lastPrompt ?? lastUserText
  return {
    v: 1,
    status,
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
      .map(({ path, op, count }) => ({ path, op, count })),
    commands: [...commands.values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, FACT_LIST_MAX)
      .map(({ label, count }) => ({ label, count })),
    generatedAt: now
  }
}
