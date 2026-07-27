import type { BoardResult } from '@expanse-ade/mcp'

/**
 * `await_settled` (C2e) — extracted from `mcpOrchestrator.ts` under the max-lines doctrine (the
 * `./dispatchGate` · `./mcpKanbanGate` · `./mcpPlanningEditGate` · `./mcpRelayBatch` pattern), so
 * the orchestrator keeps only the assembly and the settle POLICY lives in one readable place.
 *
 * It is the verdict half of a dispatch whose prompt was delivered as a LAUNCH ARG
 * (`claude "<prompt>"`), so there is no handoff write to gate. READ-ONLY: no nonce, no confirm, no
 * PTY write.
 *
 * A live agent shell never flips its derived status off `running`, so the settle signal is OUTPUT
 * SILENCE — the PTY quiet for {@link SETTLE_QUIET_MS} AFTER first showing activity. Three other
 * ways out: the worker recording its OWN result (`write_result`, the real task-done marker and the
 * fast path), the board leaving the canvas, and a one-shot backstop that bounds the wait.
 */
export interface AwaitSettledDeps {
  listBoards(): Array<{ id: string; type: string }>
  readResult(boardId: string): BoardResult
  /** Ms since the board last produced PTY output; `undefined` for a board with no live session. */
  boardActivityStaleMs?(id: string): number | undefined
  /** Resolve when the board records its own result (`write_result`). Returns an unsubscribe. */
  onResultSettled(boardId: string, fn: () => void): () => void
  /** One-shot timer that bounds the wait. Returns a cancel. */
  startBackstop(ms: number, onExpire: () => void): () => void
  handoffTimeoutMs: number
}

/** PTY silence that reads as "the worker finished its task". */
const SETTLE_QUIET_MS = 6000
const SETTLE_POLL_MS = 1000

export function createAwaitSettledMethod(deps: AwaitSettledDeps): {
  awaitSettled(boardId: string): Promise<BoardResult>
} {
  return {
    async awaitSettled(boardId: string): Promise<BoardResult> {
      const board = deps.listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`await_settled: board not found: ${boardId}`)
      if (board.type !== 'terminal') {
        throw new Error(`await_settled: target is not a terminal (${board.type})`)
      }
      await new Promise<void>((resolve) => {
        let done = false
        let sawActivity = false
        let poll: ReturnType<typeof setInterval> | null = null
        let unsubResult = (): void => {}
        let cancelBackstop = (): void => {}
        const finish = (): void => {
          if (done) return
          done = true
          if (poll) clearInterval(poll)
          unsubResult()
          cancelBackstop()
          resolve()
        }
        // write_result fast-path: a worker recording its own result is the real task-done marker.
        unsubResult = deps.onResultSettled(boardId, finish)
        // Output-silence poll: settle once the worker — having shown activity — has been quiet for
        // SETTLE_QUIET_MS, or the board left the canvas. `sawActivity` guards against settling on
        // the INITIAL quiet before the agent has produced any output (still booting).
        poll = setInterval(() => {
          if (!deps.listBoards().some((b) => b.id === boardId)) return finish()
          const stale = deps.boardActivityStaleMs?.(boardId)
          if (typeof stale !== 'number') return
          if (stale < SETTLE_QUIET_MS) sawActivity = true
          else if (sawActivity) finish()
        }, SETTLE_POLL_MS)
        // One-shot backstop — bound the wait if the worker never goes quiet / never reports.
        cancelBackstop = deps.startBackstop(deps.handoffTimeoutMs, finish)
      })
      return deps.readResult(boardId)
    }
  }
}
