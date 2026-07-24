/**
 * Lead-terminal IPC (orchestration Phase 1, precondition X) — the consent-gated grant path for the
 * wire-facing `lead` role. Three frame-guarded handlers back the Settings › Agent orchestration
 * pane's "Lead terminal" section:
 *
 *   - `orchestration:getLeadStatus` → `{ boardId | null }` (null when no MCP server is mounted)
 *   - `orchestration:grantLead(boardId)` → typed result. THE consent gate: only an explicit human
 *     action in Settings reaches this, the project must already hold orchestration consent, and
 *     the target must be a live terminal board. Granting DESIGNATES only — the lead token itself
 *     is minted by the existing spawn-time provisioning seam when the designated terminal's agent
 *     next (re)starts, so no bearer ever appears without a spawn the human can see.
 *   - `orchestration:revokeLead` → `{ ok: true }` (idempotent).
 *
 * 🔒 The token NEVER crosses to the renderer and is NEVER logged (PLAN §6). Single-active-lead
 * (Q2) is enforced in `leadAuthority.ts` — a grant while a different board holds the role returns
 * `already-active` + the holder id, and the UI offers revoke-then-grant. MAIN-only.
 */
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { isOrchestrationEnabled } from './orchestration/seam'
import type { RunningMcp } from './mcp'

/** Renderer-facing grant outcome (mirrored in preload — process boundary, no shared import). */
export type LeadGrantIpcResult =
  | { ok: true }
  | { ok: false; reason: 'forbidden' | 'no-project' | 'consent' | 'no-server' | 'not-found' }
  | { ok: false; reason: 'already-active'; holder: string }

export function registerOrchestrationLeadHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: {
    getCurrentDir: () => string | null
    /** The lazily-started MCP server (memoized) — grant starts it so the designation lands. */
    ensureMcp: () => Promise<RunningMcp | null>
    /** The currently-running server (or null) — status/revoke never force a server start. */
    getMcp: () => RunningMcp | null
  }
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('orchestration:getLeadStatus', (e): { boardId: string | null } => {
    if (guard(e)) return { boardId: null }
    return { boardId: deps.getMcp()?.getLeadBoardId() ?? null }
  })

  ipcMain.handle(
    'orchestration:grantLead',
    async (e, rawBoardId: unknown): Promise<LeadGrantIpcResult> => {
      if (guard(e)) return { ok: false, reason: 'forbidden' }
      if (typeof rawBoardId !== 'string' || rawBoardId.trim() === '') {
        return { ok: false, reason: 'not-found' }
      }
      const projectDir = deps.getCurrentDir()
      if (!projectDir) return { ok: false, reason: 'no-project' }
      // Mirror the provisioner-IPC discipline: never designate (and thus never later mint) for a
      // project that has not granted orchestration consent, regardless of renderer sequencing.
      if (!isOrchestrationEnabled(projectDir)) return { ok: false, reason: 'consent' }
      let mcp: RunningMcp | null
      try {
        mcp = await deps.ensureMcp()
      } catch {
        mcp = null
      }
      if (!mcp) return { ok: false, reason: 'no-server' }
      return mcp.grantLead(rawBoardId)
    }
  )

  ipcMain.handle('orchestration:revokeLead', (e): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    deps.getMcp()?.revokeLead()
    return { ok: true }
  })
}
