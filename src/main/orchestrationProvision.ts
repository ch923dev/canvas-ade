/**
 * Agent Orchestration Onboarding — provisioner IPC (the Sync modal's data plane).
 *
 * The onboarding lane (P1+P2) wires WT-provision's (P3) async provisioner surface to the
 * renderer's presentational `<OrchestrationSyncModal/>`: two frame-guarded handlers backed by
 * `cliProvisioners` (P3) + the connected-tier minter (P0 seam).
 *
 *   - `orchestration:getProvisionStatus` → { endpoint (port + MASKED token), per-CLI detect rows }
 *   - `orchestration:syncProvisioners(ids)` → per-CLI `SyncResult[]`
 *
 * The manual Sync is a project-level PRE-WARM: it mints a connected-tier token under a stable
 * pseudo-board id (`SYNC_PSEUDO_BOARD`). That token is security-equivalent to a real board token —
 * a pseudo-board has no cables, so relay is rejected by `canRelay`, and spawn/configure/plan-write
 * stay ConfirmModal-gated — and it is OVERWRITTEN by the board-bound token the spawn-time hook
 * writes when a real terminal of that CLI starts (`makeOrchestrationSyncProvider`).
 *
 * 🔒 The raw token NEVER crosses to the renderer (the status endpoint carries only a masked
 * placeholder; sync results carry only paths/messages) and is NEVER logged (PLAN §6). MAIN-only.
 */
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { isOrchestrationEnabled, mintTerminalToken } from './orchestration/seam'
import {
  getProvisionStatus,
  runProvisionerSync,
  CLI_IDS,
  type CliId,
  type ProvisionStatus,
  type SyncResult
} from './cliProvisioners'

/**
 * Stable pseudo-board id for the project-level manual Sync (see module header). Not a real board:
 * it has no cables (relay rejected) and every connected-tier action stays ConfirmModal-gated.
 */
const SYNC_PSEUDO_BOARD = 'orchestration-sync'

/**
 * Register the Sync modal's data-plane IPC (frame-guarded). `getCurrentDir` returns the open
 * project dir (or null when none); both handlers no-op safely (null / []) when no project is open
 * or the MCP server isn't mounted, so the modal degrades to its loading / per-row error state
 * rather than throwing across the bridge.
 */
export function registerOrchestrationProvisionHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  getCurrentDir: () => string | null
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('orchestration:getProvisionStatus', async (e): Promise<ProvisionStatus | null> => {
    if (guard(e)) return null
    const projectDir = getCurrentDir()
    if (!projectDir || !isOrchestrationEnabled(projectDir)) return null
    let port: number
    try {
      // Mint only to read the LIVE loopback port; the token itself is discarded (the status
      // shows a masked placeholder, never a real token). A discarded connected token is inert —
      // never written anywhere — and the in-memory store resets each app run.
      port = mintTerminalToken(SYNC_PSEUDO_BOARD).port
    } catch {
      return null // MCP server not mounted → modal stays in its "detecting endpoint" state
    }
    return getProvisionStatus({ projectDir, port })
  })

  ipcMain.handle(
    'orchestration:syncProvisioners',
    async (e, ids: unknown): Promise<SyncResult[]> => {
      if (guard(e)) return []
      const projectDir = getCurrentDir()
      if (!projectDir) return []
      const wanted = Array.isArray(ids)
        ? ids.filter((x): x is CliId => (CLI_IDS as readonly string[]).includes(x as string))
        : []
      if (wanted.length === 0) return []
      // Mirror the spawn-time hook's gate (cliProvisioners/index.ts's
      // `makeOrchestrationSyncProvider`) at the IPC trust boundary: never mint/persist a live
      // bearer token for a project that hasn't granted orchestration consent, regardless of what
      // renderer-side UI sequencing (palette visibility / modal ordering) currently guarantees.
      if (!isOrchestrationEnabled(projectDir)) {
        return wanted.map((id) => ({
          id,
          status: 'error' as const,
          detail: 'Agent orchestration is not enabled for this project.'
        }))
      }
      let token
      try {
        token = mintTerminalToken(SYNC_PSEUDO_BOARD)
      } catch {
        return wanted.map((id) => ({
          id,
          status: 'error' as const,
          detail: 'Orchestration server is not running — open a terminal first, then try again.'
        }))
      }
      return runProvisionerSync({ projectDir, ids: wanted, token })
    }
  )
}
