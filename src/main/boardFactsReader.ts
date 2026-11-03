/**
 * One board's Claude recap facts, read from its TRUSTED transcript tail — local disk only, no egress,
 * no consent gate. Shared by the result synthesizer (PR-4: a settled agent's derived result) and the
 * workspace status writer (WS-8: the Agents lines). Extracted from index.ts so both read the same way.
 *
 * Returns null when there is no transcript yet, it is untrusted/missing, or it can't be read.
 */
import { existsSync } from 'node:fs'
import { isTrustedTranscriptPath, readTranscriptTail } from './agentTranscript'
import { computeRecapFacts, type RecapFacts } from './recapFacts'
import type { TerminalRuntime } from './summaryLoop'

export function makeBoardFactsReader(deps: {
  /** The board's live transcript path (resolved through the A4 resolver), if any. */
  resolvePath: (boardId: string) => string | undefined
  getRuntime: (boardId: string) => TerminalRuntime | undefined
}): (boardId: string) => RecapFacts | null {
  return (boardId) => {
    const path = deps.resolvePath(boardId)
    if (!path || !isTrustedTranscriptPath(path) || !existsSync(path)) return null
    let runtime: TerminalRuntime | undefined
    try {
      runtime = deps.getRuntime(boardId)
    } catch {
      runtime = undefined
    }
    let tail = ''
    try {
      tail = readTranscriptTail(path)
    } catch {
      return null // unreadable/vanished transcript — no verdict
    }
    if (!tail) return null
    return computeRecapFacts(tail, runtime, Date.now())
  }
}
