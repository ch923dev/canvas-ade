import { existsSync } from 'node:fs'
import { extractMilestones, isTrustedTranscriptPath, readTranscriptTail } from './agentTranscript'
import { computeRecapFacts } from './recapFacts'
import type { MilestoneResult } from './summaryLoop'

/**
 * The summary loop's `getAgentMilestones` body — extracted from index.ts (max-lines ratchet;
 * behavior unchanged). Distils a terminal board's transcript into milestones for the recap.
 *
 * Security: the transcript path can originate in canvas.json, so a hand-crafted file could
 * otherwise aim it at an arbitrary file whose scrubbed contents would egress to the user's LLM.
 * isTrustedTranscriptPath restricts reads to .jsonl files under Claude's config root (where the
 * hook legitimately writes), honoring the consent modal's "nothing else leaves" promise.
 * BUG-002: the consent gate lives HERE (not only at PTY-spawn/hook-install) so revoking consent
 * stops ongoing summary-loop recap egress.
 * Perf: readTranscriptTail reads only the file's tail. Defensive + read-only: missing/untrusted
 * path / read error → a skip reason (never throws past this, no action surface).
 */
export interface AgentMilestonesDeps {
  getCurrentDir: () => string | null
  isConsented: (dir: string) => boolean
  /** The A4 resolver (resolveBoardTranscript in index.ts) — eager-grace + rotation adoption. */
  resolveTranscript: (boardId: string, recorded: string | undefined) => string | undefined
  /** The learned recap-map entry's path, used when the board doc carries none. */
  getRecordedPath: (boardId: string) => string | undefined
}

/**
 * The board doc's persisted `agentTranscriptPath`, when the project reads OK and the field is a
 * non-empty string (extracted from index.ts's recap getTranscriptPath under the same ratchet).
 */
export function persistedTranscriptPath(
  read: (dir: string) => { ok: true; doc: unknown } | { ok: false },
  dir: string,
  boardId: string
): string | undefined {
  const r = read(dir)
  if (!r.ok) return undefined
  const boards = (r.doc as { boards?: unknown }).boards
  const b = Array.isArray(boards)
    ? (boards as { id?: unknown }[]).find((x) => x.id === boardId)
    : undefined
  const p = (b as { agentTranscriptPath?: unknown })?.agentTranscriptPath
  return typeof p === 'string' && p ? p : undefined
}

export function createGetAgentMilestones(
  deps: AgentMilestonesDeps
): (boardId: string, board: unknown) => MilestoneResult {
  return (boardId, board) => {
    const dir = deps.getCurrentDir()
    if (!dir || !deps.isConsented(dir)) return { skip: 'consent-off' }
    const path = deps.resolveTranscript(
      boardId,
      (board as { agentTranscriptPath?: string })?.agentTranscriptPath ??
        deps.getRecordedPath(boardId)
    )
    if (!path || !isTrustedTranscriptPath(path) || !existsSync(path))
      return { skip: 'no-transcript' }
    try {
      // Recap enrichment P3: plan progress + last tool error ride the SAME tail read into the
      // narrative input (computeRecapFacts is pure + local; buildRecapInput re-redacts pre-egress).
      const tail = readTranscriptTail(path)
      const facts = computeRecapFacts(tail, undefined, Date.now())
      return {
        milestones: extractMilestones(tail, { maxMilestones: 12, maxTextChars: 600 }),
        extras: {
          ...(facts.todos ? { plan: facts.todos } : {}),
          ...(facts.errors?.last ? { lastError: facts.errors.last } : {})
        }
      }
    } catch {
      return { skip: 'no-transcript' }
    }
  }
}
