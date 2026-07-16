import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * The preload `mcp` namespace — the MCP board mirror + human-confirm gates + the renderer → MAIN
 * orchestrator drive — factored out of preload/index.ts to stay under the max-lines ratchet (the
 * recapApi.ts / mcpServersApi.ts precedent). Control plane only: metadata + coarse status cross the
 * bridge, never board content, and the renderer never holds a token.
 *
 * Shapes MIRROR the main-process types across the process boundary (tsconfig.preload ⊥
 * tsconfig.node → no shared import; keep them in lockstep).
 */

/** A human-confirm request surfaced to the modal (mirrors main `ConfirmRequest`, T4.2). */
export interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  denyLabel?: string
  /** P5: layout chooser (mirrors main `ConfirmChoices`); when set the modal renders it and the reply carries the picked `choice`. */
  choices?: { label?: string; options: Array<{ id: string; label: string }>; default: string }
  /** J4: MAIN-stamped Jarvis-tool origin — routes the confirm to the panel act card
   *  (presentation only; the reply protocol and fail-closed paths are identical). */
  origin?: 'jarvis'
}

/** The modal's reply to a confirm request; P5 adds the optional chooser `choice`. */
type ConfirmDecisionMsg = { approved: boolean; choice?: string }

/** A per-row BATCH confirm request surfaced to the modal (mirrors main `ConfirmBatchRequest`). */
export interface ConfirmBatchRequest {
  title: string
  items: Array<{ label: string; body: string }>
}

/** The batch modal's reply — per-row decisions, positionally 1:1 with `request.items`. */
type ConfirmBatchDecisionMsg = { decisions: Array<{ approved: boolean }> }

/** One MCP dispatch audit entry surfaced to the viewer (mirrors main `AuditEntry`, T4.1). */
export interface AuditEntry {
  seq: number
  ts: number
  type: string
  targetId: string
  prompt: string
  nonce: string
  status: string
  outputs?: string
  detail?: string
}

// ── MCP board mirror (control plane; metadata only — id/type/title + coarse status
//    bucket, never content) ──
export const mcpApi = {
  publishBoards: (payload: {
    boards: Array<{ id: string; type: string; title: string; status: string }>
    connectors: Array<{ id: string; sourceId: string; targetId: string; kind: string }>
    // PR-5: Named Board Groups (feature zones) — feeds the app-model's live canvas.groups.
    groups?: Array<{ id: string; name: string; boardIds: string[] }>
  }): void => ipcRenderer.send('mcp:boards', payload),

  // MAIN → renderer command channel (the inverse of publishBoards). The handler
  // gets the command + a reply fn that acks on MAIN's unique reply channel.
  // Returns an unsubscribe fn. Control-plane only.
  onCommand: (
    handler: (command: { type: string }, reply: (ack: unknown) => void) => void
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      msg: { command: { type: string }; replyChannel: string }
    ): void => {
      handler(msg.command, (ack) => ipcRenderer.send(msg.replyChannel, ack))
    }
    ipcRenderer.on('mcp:command', listener)
    return () => ipcRenderer.removeListener('mcp:command', listener)
  },

  // Read-only view of the MCP dispatch audit trail (T4.1). Most-recent-first,
  // capped MAIN-side. There is intentionally NO write side — entries are recorded
  // only by the MAIN dispatch path, so the renderer can neither forge nor erase one.
  readAudit: (opts?: { limit?: number }): Promise<AuditEntry[]> =>
    ipcRenderer.invoke('audit:read', opts),

  // 🔒 Human-confirm gate (T4.2): MAIN posts a confirm request; the renderer shows a
  // modal and replies the human's decision on MAIN's unique reply channel. Returns an
  // unsubscribe fn. MAIN owns the decision (it blocks the tool on this reply).
  //
  // 🔒 BUG-029: at most ONE subscriber may ever be wired to the underlying 'mcp:confirm'
  // IPC event. A second call while a listener is already registered is a no-op (returns a
  // no-op unsubscribe) — otherwise a second in-frame listener would fire on every request
  // alongside the legitimate ConfirmModal and could win the race to reply first, auto-
  // approving a dangerous action before a human ever sees the modal. (isForeignSender only
  // guards the sender FRAME, not which in-frame subscriber replied.)
  onConfirm: (
    handler: (request: ConfirmRequest, reply: (decision: ConfirmDecisionMsg) => void) => void
  ): (() => void) => {
    if (ipcRenderer.listenerCount('mcp:confirm') > 0) return () => {}
    const listener = (
      _e: IpcRendererEvent,
      msg: { request: ConfirmRequest; replyChannel: string }
    ): void => {
      handler(msg.request, (decision) => ipcRenderer.send(msg.replyChannel, decision))
    }
    ipcRenderer.on('mcp:confirm', listener)
    return () => ipcRenderer.removeListener('mcp:confirm', listener)
  },

  // 🔒 Per-row BATCH human-confirm gate (relay_prompts): MAIN posts ONE request carrying N rows;
  // the renderer shows ONE modal and replies the human's per-row decisions on MAIN's unique reply
  // channel. Same BUG-029 single-subscriber gate as onConfirm — at most one listener may ever be
  // wired to 'mcp:confirm:batch', so no second in-frame script can race the real BatchConfirmModal
  // to auto-approve. Returns an unsubscribe fn; MAIN owns the decision (it blocks the tool on it).
  onConfirmBatch: (
    handler: (
      request: ConfirmBatchRequest,
      reply: (decision: ConfirmBatchDecisionMsg) => void
    ) => void
  ): (() => void) => {
    if (ipcRenderer.listenerCount('mcp:confirm:batch') > 0) return () => {}
    const listener = (
      _e: IpcRendererEvent,
      msg: { request: ConfirmBatchRequest; replyChannel: string }
    ): void => {
      handler(msg.request, (decision) => ipcRenderer.send(msg.replyChannel, decision))
    }
    ipcRenderer.on('mcp:confirm:batch', listener)
    return () => ipcRenderer.removeListener('mcp:confirm:batch', listener)
  },

  // ── Phase C / C1 · renderer → MAIN orchestrator drive (the Command board's face) ──
  // The renderer holds NO token; it only requests actions MAIN's orchestrator executes.
  // `spawnGroup` is content-less (cap-checked); `dispatchPrompt`/`interrupt` carry content,
  // so MAIN's runGatedWrite pops the confirm modal (via onConfirm above) before the write —
  // the invoke stays pending until the human answers, then resolves/rejects.
  spawnGroup: (input: {
    name: string
    planning?: boolean
    browser?: boolean
    // Agentic CLI the worker terminal boots (e.g. 'claude'); MAIN sanitizes it to a single line.
    launchCommand?: string
  }): Promise<{ groupId: string; terminalId: string; planningId?: string; browserId?: string }> =>
    ipcRenderer.invoke('mcp:spawnGroup', input),
  dispatchPrompt: (boardId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('mcp:dispatchPrompt', { boardId, text }),
  // Dispatch AND await the worker's settle, resolving with its result (the kanban's done signal).
  handoffPrompt: (
    boardId: string,
    text: string
  ): Promise<{ present?: boolean; status?: string; summary?: string; refs?: string[] }> =>
    ipcRenderer.invoke('mcp:handoffPrompt', { boardId, text }),
  // C2e: await a worker's task settle (output silence / own result / backstop) WITHOUT a write —
  // the verdict for a dispatch whose prompt was delivered as a launch arg. Read-only (no gate).
  awaitSettled: (
    boardId: string
  ): Promise<{ present?: boolean; status?: string; summary?: string; refs?: string[] }> =>
    ipcRenderer.invoke('mcp:awaitSettled', boardId),
  interrupt: (boardId: string): Promise<void> => ipcRenderer.invoke('mcp:interrupt', boardId),
  // Phase D: read-only working-tree diff for a board (result-zone diffstat + view-diff). The
  // orchestrator does the terminal-check + 100 KB clamp in MAIN; returns the raw unified diff
  // ('' when the board has no known cwd or its cwd is not a repo).
  gitDiff: (boardId: string): Promise<string> => ipcRenderer.invoke('mcp:gitDiff', boardId),

  // MAIN → renderer: per-board coarse status stream that drives the kanban (status only,
  // never content). Returns an unsubscribe fn.
  onTaskStatus: (
    cb: (change: { id: string; status: string; monitorActivity?: boolean }) => void
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      change: { id: string; status: string; monitorActivity?: boolean }
    ): void => cb(change)
    ipcRenderer.on('mcp:status', listener)
    return () => ipcRenderer.removeListener('mcp:status', listener)
  }
}
