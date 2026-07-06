import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * 🔒 Human-confirm gate (T4.2). The reusable "are you sure?" used by every dangerous
 * MCP action — M4 dispatch (handoff/assign), M6 merge, M7 permission answers. MAIN
 * OWNS THE DECISION: a tool calls {@link requestConfirm}, which posts a request to the
 * renderer, shows a modal, and BLOCKS the tool until the human approves or denies. The
 * decision authority is the human via our own trusted UI — NOT an MCP client
 * elicitation (which an agent's client could auto-answer), and never the
 * worker-originated content that prompted the action.
 *
 * Fail-closed in EVERY degenerate case — a gone/destroyed window, a send failure, a
 * malformed reply, a foreign-frame reply, or a safety-timeout all resolve to
 * `{ approved: false }`. The only way to get `approved: true` is a genuine main-frame
 * reply carrying `approved: true`. There is no path where ambiguity approves a write
 * into another agent's shell.
 */

/** One selectable option in a confirm CHOOSER (P5). `id` is the bounded value the host acts on. */
export interface ConfirmChoiceOption {
  id: string
  label: string
}

/**
 * 🔒 An optional CHOOSER attached to a confirm request (P5 — the upgraded `visualize_plan` gate). When
 * present, the modal renders the options and the human's pick rides back on the decision's `choice`.
 * The option ids are a BOUNDED, host-defined set — the requesting gate re-validates `decision.choice`
 * against `options` and falls back to `default` for anything off-set, so a garbage/forged choice can
 * never widen the action (the decision authority + the value space both stay MAIN's).
 */
export interface ConfirmChoices {
  /** Segment label above the options (e.g. "Visualization"). */
  label?: string
  /** The selectable options (bounded, host-defined). */
  options: ConfirmChoiceOption[]
  /** The pre-selected option id (one of `options[].id`) — the agent's suggestion. */
  default: string
}

export interface ConfirmRequest {
  /** Short modal title (e.g. "Dispatch to terminal"). */
  title: string
  /** Body text — what exactly will happen if approved (resolved target + the prompt). */
  body: string
  /** Optional button labels (default Approve / Deny). */
  confirmLabel?: string
  denyLabel?: string
  /** 🔒 P5: an optional layout chooser — when set, the modal renders the options + returns `choice`. */
  choices?: ConfirmChoices
}

export interface ConfirmDecision {
  approved: boolean
  /** 🔒 P5: the option id the human picked when the request carried `choices`; absent otherwise. */
  choice?: string
}

/** One row in a BATCH confirm (relay_prompts) — a short label + the EXACT (sanitized) command shown. */
export interface ConfirmBatchItem {
  /** Row heading (e.g. the resolved `source → target` route). */
  label: string
  /** The exact sanitized command the human is authorizing for this row. */
  body: string
}

/**
 * 🔒 A BATCH confirm request (relay_prompts) — several {@link ConfirmBatchItem} rows shown in ONE
 * modal so the human approves per row in a single gesture. The decision authority stays MAIN's
 * trusted UI; every row is still an independent dispatch gated separately behind this one modal.
 */
export interface ConfirmBatchRequest {
  /** Short modal title (e.g. "Relay 3 prompts"). */
  title: string
  /** The rows to review (bounded by the caller). */
  items: ConfirmBatchItem[]
}

/**
 * 🔒 The per-row batch decision — `decisions` is POSITIONALLY 1:1 with the request items. Fail-closed:
 * any row not explicitly approved (a missing/garbage/short reply) reads `{ approved: false }`, so a
 * malformed reply can never approve a write.
 */
export interface ConfirmBatchDecision {
  decisions: Array<{ approved: boolean }>
}

/**
 * Backstop wall-clock timeout for a confirm decision (BUG-010). A human is allowed to
 * take time, but a FROZEN renderer (UI deadlock, hung event loop, modal that never
 * registered its reply handler) fires neither `destroyed` nor `render-process-gone`, so
 * without a finite default the awaiting MCP tool call — and the SSE connection behind it
 * — would hang forever. 10 minutes is generous enough for a real human yet bounded so a
 * stuck modal can never permanently hold the connection. On expiry the request fails
 * closed (`{ approved: false }`) and tears down the pending listeners via `finish`.
 * Callers may still pass an explicit `timeoutMs` (including `Infinity` to opt out).
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const DENIED: ConfirmDecision = { approved: false }

/**
 * Post a confirm request to the renderer and resolve the human's decision. Mirrors
 * `sendMcpCommand`'s injected-bus, frame-guarded, never-throws shape — but the only
 * "ok" outcome is an explicit `approved: true`; everything else fails closed.
 *
 * `bus` is injected (not imported) so the module stays free of electron value imports
 * and is unit-testable without the runtime.
 */
export function requestConfirm(
  bus: Pick<IpcMain, 'on' | 'removeListener'>,
  getWin: () => BrowserWindow | null,
  request: ConfirmRequest,
  opts: { timeoutMs?: number } = {}
): Promise<ConfirmDecision> {
  const win = getWin()
  const wc = win?.webContents
  if (!win || win.isDestroyed() || !wc || wc.isDestroyed()) {
    return Promise.resolve(DENIED) // no UI to confirm against → deny
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<ConfirmDecision>((resolve) => {
    // 🔒 Cryptographically-strong, unguessable per-request reply channel (BUG-022). The
    // channel name is posted to the renderer; a CSPRNG UUID (not Date.now()+Math.random,
    // both predictable) means it can't be guessed/precomputed to forge an early
    // `{approved:true}` on this request's channel.
    const replyChannel = `mcp:confirm:reply:${randomUUID()}`
    let done = false
    const finish = (decision: ConfirmDecision): void => {
      if (done) return
      done = true
      bus.removeListener(replyChannel, onReply)
      // Fail-closed teardown: a window torn down WHILE the modal is open (no human can
      // reply) must deny, not hang the awaiting tool forever — remove these on resolve.
      wc.removeListener('destroyed', onGone)
      wc.removeListener('render-process-gone', onGone)
      if (timer) clearTimeout(timer)
      resolve(decision)
    }
    const onGone = (): void => finish(DENIED)
    const onReply = (e: IpcMainEvent, decision: unknown): void => {
      if (isForeignSender(e, getWin)) return // a foreign frame can't decide — ignore
      // Fail-closed: ONLY an explicit `approved === true` approves; anything else denies.
      const d =
        decision !== null && typeof decision === 'object' ? (decision as ConfirmDecision) : null
      const approved = d?.approved === true
      // 🔒 P5: carry the chooser pick through as an OPAQUE string when present. It is meaningful only
      // on an approve, and the requesting gate re-validates it against the offered option set (falling
      // back to `default`), so a forged/garbage value here can never widen the action.
      const choice = typeof d?.choice === 'string' ? d.choice : undefined
      finish(choice !== undefined ? { approved, choice } : { approved })
    }
    // Backstop safety timeout (deny on expiry). Defaults to DEFAULT_TIMEOUT_MS so a frozen
    // renderer can't hang the awaiting tool forever (BUG-010). Arm only for a finite
    // positive bound — `Infinity` / `<= 0` is an explicit opt-out (no timer) for callers
    // that truly want to wait indefinitely.
    const timer =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => finish(DENIED), timeoutMs)
        : null
    // 🔒 Use bus.on (not bus.once) so a foreign-frame event on the reply channel does NOT
    // consume the listener before the genuine human reply arrives (BUG-030). finish() calls
    // bus.removeListener on every resolution path, so the listener is torn down exactly once.
    bus.on(replyChannel, onReply)
    // If the window/render-process dies after the modal is shown but before a reply,
    // the on-listener never fires — deny so the awaiting MCP tool call can't hang forever.
    wc.once('destroyed', onGone)
    wc.once('render-process-gone', onGone)
    try {
      wc.send('mcp:confirm', { request, replyChannel })
    } catch {
      finish(DENIED) // couldn't even show the modal → deny
    }
  })
}

/** Fail-closed default for a batch of N rows: every row denied (used on every degenerate path). */
function allDenied(n: number): ConfirmBatchDecision {
  return { decisions: Array.from({ length: n }, () => ({ approved: false })) }
}

/**
 * 🔒 Normalize a renderer batch reply to EXACTLY `n` positional decisions, fail-closed: a row is
 * approved ONLY when the reply carries an explicit `approved === true` at that index. A missing,
 * short, over-long, or non-array reply collapses to all-denied for the affected rows — a malformed
 * reply can never approve a dispatch.
 */
function normalizeBatch(decision: unknown, n: number): ConfirmBatchDecision {
  const arr =
    decision !== null &&
    typeof decision === 'object' &&
    Array.isArray((decision as { decisions?: unknown }).decisions)
      ? (decision as { decisions: unknown[] }).decisions
      : []
  return {
    decisions: Array.from({ length: n }, (_, i) => ({
      approved: (arr[i] as { approved?: unknown } | undefined)?.approved === true
    }))
  }
}

/**
 * 🔒 BATCH sibling of {@link requestConfirm} (relay_prompts): post ONE request carrying N rows,
 * show ONE per-row modal, and resolve the human's per-row decisions. Same injected-bus,
 * frame-guarded, never-throws shape — and the SAME fail-closed discipline: a gone/destroyed
 * window, a send failure, a foreign-frame reply, a malformed reply, or the safety timeout all
 * resolve to ALL rows denied. The only path to `approved: true` for a row is a genuine main-frame
 * reply carrying an explicit `approved === true` at that row's index.
 */
export function requestConfirmBatch(
  bus: Pick<IpcMain, 'on' | 'removeListener'>,
  getWin: () => BrowserWindow | null,
  request: ConfirmBatchRequest,
  opts: { timeoutMs?: number } = {}
): Promise<ConfirmBatchDecision> {
  const n = request.items.length
  const win = getWin()
  const wc = win?.webContents
  if (!win || win.isDestroyed() || !wc || wc.isDestroyed()) {
    return Promise.resolve(allDenied(n)) // no UI to confirm against → deny every row
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<ConfirmBatchDecision>((resolve) => {
    const replyChannel = `mcp:confirm:batch:reply:${randomUUID()}`
    let done = false
    const finish = (decision: ConfirmBatchDecision): void => {
      if (done) return
      done = true
      bus.removeListener(replyChannel, onReply)
      wc.removeListener('destroyed', onGone)
      wc.removeListener('render-process-gone', onGone)
      if (timer) clearTimeout(timer)
      resolve(decision)
    }
    const onGone = (): void => finish(allDenied(n))
    const onReply = (e: IpcMainEvent, decision: unknown): void => {
      if (isForeignSender(e, getWin)) return // a foreign frame can't decide — ignore
      finish(normalizeBatch(decision, n))
    }
    const timer =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => finish(allDenied(n)), timeoutMs)
        : null
    bus.on(replyChannel, onReply)
    wc.once('destroyed', onGone)
    wc.once('render-process-gone', onGone)
    try {
      wc.send('mcp:confirm:batch', { request, replyChannel })
    } catch {
      finish(allDenied(n)) // couldn't even show the modal → deny every row
    }
  })
}
