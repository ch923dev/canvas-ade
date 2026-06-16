import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { BoardResult } from '@expanse-ade/mcp'
import { isForeignSender } from './ipcGuard'
import type { SpawnGroupInput, SpawnGroupResult } from './mcpLifecycle'

/**
 * Phase C / C1 — the renderer → MAIN orchestrator drive. The Command board (renderer) is the
 * orchestrator's *face*; it drives the MAIN-resident orchestrator over these frame-guarded
 * `handle()` channels. It is the inverse of `mcpCommand.ts`'s MAIN → renderer command bus.
 *
 * 🔒 Security (never weakened): the renderer holds **no token**. It only *requests* orchestrator
 * actions — MAIN owns the single orchestrator-tier identity (bound to `boardId:'app'`) and executes
 * them, and **every cross-board write still pays `runGatedWrite`** (sanitize → single-use nonce →
 * human confirm → audit). `spawnGroup` is content-less ⇒ cap-checked only; `dispatchPrompt` /
 * `interrupt` carry content ⇒ the gate fires (the confirm modal pops via the existing `mcp:confirm`
 * channel). Each handler is frame-guarded (`isForeignSender`) — the same trust boundary as every
 * other MCP/preview/pty IPC. No new write path; no sandbox/isolation change.
 *
 * Per the project's handler convention, dependencies are *injected* (`getWin`/`getMcp`/`subscribe`),
 * never imported, so this module is unit-testable without the electron runtime.
 */

/** The minimal orchestrator facet the renderer may drive (a structural subset of `RunningMcp`). */
export interface OrchestratorDrive {
  spawnGroup(input: SpawnGroupInput): Promise<SpawnGroupResult>
  dispatchPrompt(boardId: string, text: string): Promise<void>
  handoffPrompt(boardId: string, text: string): Promise<BoardResult>
  awaitSettled(boardId: string): Promise<BoardResult>
  interrupt(boardId: string): Promise<void>
}

/** Coarse per-board status change forwarded to the kanban (raw `subscribeBoardStatus` shape). */
export interface BoardStatusEvent {
  id: string
  status: string
  monitorActivity?: boolean
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Register the three renderer → MAIN orchestrator channels. `getMcp` returns null until the
 * loopback server is up (or if it failed to bind) — handlers then reject with a clean error
 * rather than dereferencing null, so the board surfaces a failed dispatch instead of crashing.
 */
export function registerOrchestratorIpc(
  ipc: Pick<IpcMain, 'handle'>,
  getWin: () => BrowserWindow | null,
  getMcp: () => OrchestratorDrive | null
): void {
  const resolve = (e: IpcMainInvokeEvent): OrchestratorDrive => {
    if (isForeignSender(e, getWin)) throw new Error('forbidden') // 🔒 foreign frame → deny
    const mcp = getMcp()
    if (!mcp) throw new Error('orchestrator-unavailable')
    return mcp
  }

  ipc.handle('mcp:spawnGroup', async (e, input: unknown): Promise<SpawnGroupResult> => {
    const mcp = resolve(e)
    const name = asString((input as { name?: unknown })?.name)
    if (name === null) throw new Error('mcp:spawnGroup requires a string name')
    const { planning, browser, launchCommand } = (input ?? {}) as {
      planning?: unknown
      browser?: unknown
      launchCommand?: unknown
    }
    // Booleans coerced defensively; the orchestrator validates/clamps the name, sanitizes the
    // launchCommand to a single PTY line, and caps the cluster.
    return mcp.spawnGroup({
      name,
      planning: planning === true,
      browser: browser === true,
      ...(typeof launchCommand === 'string' ? { launchCommand } : {})
    })
  })

  ipc.handle('mcp:dispatchPrompt', async (e, arg: unknown): Promise<void> => {
    const mcp = resolve(e)
    const boardId = asString((arg as { boardId?: unknown })?.boardId)
    const text = asString((arg as { text?: unknown })?.text)
    if (boardId === null || text === null) {
      throw new Error('mcp:dispatchPrompt requires { boardId, text }')
    }
    await mcp.dispatchPrompt(boardId, text) // gated: sanitize → nonce → confirm → write → audit
  })

  ipc.handle('mcp:handoffPrompt', async (e, arg: unknown): Promise<BoardResult> => {
    const mcp = resolve(e)
    const boardId = asString((arg as { boardId?: unknown })?.boardId)
    const text = asString((arg as { text?: unknown })?.text)
    if (boardId === null || text === null) {
      throw new Error('mcp:handoffPrompt requires { boardId, text }')
    }
    return mcp.handoffPrompt(boardId, text) // gated dispatch + await the worker's two-gate settle
  })

  ipc.handle('mcp:awaitSettled', async (e, boardId: unknown): Promise<BoardResult> => {
    const mcp = resolve(e)
    const id = asString(boardId)
    if (id === null) throw new Error('mcp:awaitSettled requires a string boardId')
    return mcp.awaitSettled(id) // read-only: await output-silence settle, return the board result
  })

  ipc.handle('mcp:interrupt', async (e, boardId: unknown): Promise<void> => {
    const mcp = resolve(e)
    const id = asString(boardId)
    if (id === null) throw new Error('mcp:interrupt requires a string boardId')
    await mcp.interrupt(id) // gated Ctrl-C (no sanitize, terminator = \x03)
  })
}

/**
 * Forward the per-board coarse status stream to the renderer's kanban (the push half of the
 * orchestrator drive). Read-only status only — never content. Returns the unsubscribe fn. The
 * send is guarded against a torn-down window so a late status change can never throw at shutdown.
 */
export function forwardBoardStatus(
  getWin: () => BrowserWindow | null,
  subscribe: (listener: (change: BoardStatusEvent) => void) => () => void
): () => void {
  return subscribe((change) => {
    const wc = getWin()?.webContents
    if (wc && !wc.isDestroyed()) wc.send('mcp:status', change)
  })
}
