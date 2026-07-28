/**
 * Findings publishing — the app wiring (orchestration P4).
 *
 * ONE composer, TWO triggers:
 *   · the human presses “Publish findings →” on the Command board  (this file's IPC)
 *   · an orchestrator calls the `publish_findings` MCP tool         (mcpBoot's registry delegate)
 * Both land in the same {@link publishFindings}, so they cannot drift: the same batch, the same
 * confirm modal, the same single `patchKanban`. The agent trigger is a thin layer over the human
 * one — it names the destination and nothing else.
 *
 * 🔒 The renderer supplies only a board ID. Card CONTENT is derived MAIN-side from `boardResults`,
 * never sent over the wire — the same rule on both triggers, for the same reason.
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import { listBoardResults } from './boardResults'
import { listBoardMirror } from './boardRegistry'
import { requestConfirmBatch } from './mcpConfirm'
import { sendMcpCommand } from './mcpCommand'
import { publishFindings, type FindingsPublishResult } from './findingsPublish'
import type { WorkerReport } from './findingsBatch'

/**
 * Build the publish dependencies from the app singletons. Exported so the MCP tool delegate and the
 * IPC handler share ONE construction — a second, subtly different dep set is exactly how two
 * triggers start behaving differently.
 */
export function findingsPublishDeps(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): Parameters<typeof publishFindings>[0] {
  return {
    collectReports: (): WorkerReport[] => {
      // Join results to the LIVE board mirror: a result whose board has left the canvas is dropped,
      // because a card assigned to a board the human can no longer open is a dead reference. The
      // mirror is also where the role and the title come from — MAIN never invents either.
      const boards = new Map(listBoardMirror().map((b) => [b.id, b]))
      const out: WorkerReport[] = []
      for (const { boardId, result, synthesized } of listBoardResults()) {
        const board = boards.get(boardId)
        if (!board) continue
        out.push({
          boardId,
          ...(board.agentKind ? { role: board.agentKind } : {}),
          ...(typeof result.status === 'string' ? { status: result.status } : {}),
          ...(typeof result.summary === 'string' ? { summary: result.summary } : {}),
          ...(Array.isArray(result.refs) ? { refs: result.refs } : {}),
          ...(synthesized ? { synthesized: true } : {})
        })
      }
      return out
    },
    lookupBoard: (id) => {
      const b = listBoardMirror().find((x) => x.id === id)
      return b ? { type: b.type, title: b.title } : undefined
    },
    lanesOf: (boardId) => {
      const b = listBoardMirror().find((x) => x.id === boardId)
      return b?.kanban?.columns?.map((c) => c.id) ?? []
    },
    confirmBatch: (req) => requestConfirmBatch(ipcMain, getWin, req),
    send: (command) => sendMcpCommand(ipcMain, getWin, command),
    // 🔒 CSPRNG card ids — the BUG-031 hardening rule (Date.now()+Math.random() is ~48 predictable bits).
    newCardId: () => `card-${randomUUID()}`
  }
}

/**
 * Register the human-trigger IPC. Frame-guarded like every control-plane handler: a foreign sender
 * gets a refusal, never a publish.
 */
export function registerFindingsHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.handle(
    'findings:publish',
    async (e: IpcMainInvokeEvent, payload: unknown): Promise<FindingsPublishResult> => {
      if (isForeignSender(e, getWin)) {
        return { ok: false, published: 0, summary: 'forbidden' }
      }
      const boardId =
        payload !== null && typeof payload === 'object'
          ? (payload as { boardId?: unknown }).boardId
          : undefined
      if (typeof boardId !== 'string' || boardId.length === 0) {
        return { ok: false, published: 0, summary: 'publish needs a kanban boardId' }
      }
      return publishFindings(findingsPublishDeps(ipcMain, getWin), boardId)
    }
  )
}
