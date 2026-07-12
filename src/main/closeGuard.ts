/**
 * Close guard (PR-2 background sessions): intercepts a user-initiated window close while
 * daemon-backed sessions are alive and routes it per Settings › Terminal — ask (the close
 * modal), always-keep (silent tray residency), or always-stop (today's kill-everything
 * close). Interception happens on the WINDOW 'close' event, i.e. BEFORE index.ts's
 * `quitting` latch — once the quit path owns a close (update install, tray quit, crash
 * sinks) the guard stands down (locked: an update restart NEVER prompts).
 *
 * The modal round trip mirrors mcpConfirm.ts (unguessable per-request reply channel,
 * frame-guarded reply, bounded wait) with one deliberate inversion: every degenerate path
 * resolves to CANCEL, not deny — a garbage reply must neither kill sessions nor silently
 * background the app; it changes nothing and the window stays open.
 */
import { randomUUID } from 'node:crypto'
import { app, ipcMain, type BrowserWindow, type IpcMain, type IpcMainEvent } from 'electron'
import type { CloseGuardAnswer, CloseSessionRow } from '../shared/closeGuardTypes'
import { listBoardMirror } from './boardRegistry'
import { isForeignSender } from './ipcGuard'
import { isPtyHostActive, listKeepableSessions } from './ptyHost/bridge'
import { decideOnClose, normalizeCloseAnswer } from './ptyHost/closeGuardCore'
import { readPtyHostConfig, writePtyHostConfig, type PtyHostConfig } from './ptyHost/config'
import { enterTrayResidency, isTrayResident } from './trayResidency'

/** Bounded wait for the modal answer (the mcpConfirm BUG-010 rationale) — expiry cancels. */
const ANSWER_TIMEOUT_MS = 10 * 60 * 1000

export interface CloseGuardDeps {
  /** userData dir (config reads/writes — never a project folder). */
  userData: string
}

/** A guard-approved "stop" is re-driving win.close() — the guard lets exactly that through. */
let bypassClose = false
/** One modal at a time; further close clicks while it is up are swallowed. */
let modalOpen = false
/** Boot-time context (wireBackgroundSessionsUx). Unset = the guard stands down (fail-open). */
let ctx: CloseGuardDeps | null = null
/** Mirrors index.ts's `quitting` latch via the SAME before-quit event: once the quit path owns
 *  the teardown (update install, tray quit, crash-adjacent quits), the guard never re-prompts. */
let quitLatched = false

/** One-time context wiring so `attachCloseGuard(win)` stays a one-liner in index.ts's
 *  createWindow (which is at its max-lines ratchet). */
export function configureCloseGuard(deps: CloseGuardDeps): void {
  ctx = deps
  app.once('before-quit', () => {
    quitLatched = true
  })
}

/**
 * The Playwright/smoke harnesses close the app programmatically with real terminal boards
 * live — an intercepted close would hang every spec's teardown. Under a harness the guard
 * stands down unless the spec explicitly opts in (the closeModalKeep e2e sets the flag on
 * its own app instance). Dev + packaged runs are unaffected (neither env var is set).
 */
function harnessBypassed(env: NodeJS.ProcessEnv): boolean {
  if (env.CANVAS_E2E_CLOSEGUARD === '1') return false
  return Boolean(env.CANVAS_E2E || env.CANVAS_SMOKE)
}

/** Board-title lookup for the session rows (active project's MAIN mirror; absent id → null). */
function titleLookup(): (id: string) => string | undefined {
  const byId = new Map(listBoardMirror().map((b) => [b.id, b.title]))
  return (id) => byId.get(id)
}

/** Attach the guard to a (re)created main window — index.ts createWindow calls this. */
export function attachCloseGuard(win: BrowserWindow): void {
  win.on('close', (e) => {
    const deps = ctx
    if (!deps) return // never configured — behave exactly like today's close
    let rows: CloseSessionRow[] = []
    let decision: ReturnType<typeof decideOnClose> = 'proceed'
    try {
      rows =
        !harnessBypassed(process.env) && isPtyHostActive()
          ? listKeepableSessions(titleLookup())
          : []
      decision = decideOnClose({
        quitting: quitLatched,
        bypass: bypassClose,
        resident: isTrayResident(),
        keepableCount: rows.length,
        mode: readPtyHostConfig(deps.userData).onCloseWithSessions
      })
    } catch {
      decision = 'proceed' // fail-open: a broken guard must never brick the close button
    }
    if (decision === 'proceed') return
    e.preventDefault()
    if (decision === 'keep') {
      void enterTrayResidency(rows)
      return
    }
    if (modalOpen) return
    modalOpen = true
    void askAndRoute(win, deps, rows).finally(() => {
      modalOpen = false
    })
  })
}

async function askAndRoute(
  win: BrowserWindow,
  deps: CloseGuardDeps,
  rows: CloseSessionRow[]
): Promise<void> {
  const answer = await queryRenderer(ipcMain, win, rows)
  if (answer.remember && answer.action !== 'cancel') {
    try {
      const cfg = readPtyHostConfig(deps.userData)
      const next: PtyHostConfig = { ...cfg, onCloseWithSessions: answer.action }
      writePtyHostConfig(deps.userData, next)
    } catch {
      /* the chosen ACTION still applies this once; only the persistence failed */
    }
  }
  if (answer.action === 'keep') {
    await enterTrayResidency(rows)
  } else if (answer.action === 'stop') {
    // Re-drive the close with the guard bypassed: the default flow (window-all-closed →
    // app.quit → guarded before-quit → kill-everything drain) is exactly "stop all & close".
    bypassClose = true
    if (!win.isDestroyed()) win.close()
  }
  // 'cancel' → nothing: the preventDefault already ate the close.
}

/** Post the session list to the renderer's modal and resolve the (normalized) answer. */
function queryRenderer(
  bus: Pick<IpcMain, 'on' | 'removeListener'>,
  win: BrowserWindow,
  sessions: CloseSessionRow[]
): Promise<CloseGuardAnswer> {
  const CANCELLED: CloseGuardAnswer = { action: 'cancel', remember: false }
  const wc = win.webContents
  if (win.isDestroyed() || wc.isDestroyed()) return Promise.resolve(CANCELLED)
  return new Promise((resolve) => {
    const replyChannel = `closeGuard:reply:${randomUUID()}`
    let done = false
    const finish = (a: CloseGuardAnswer): void => {
      if (done) return
      done = true
      bus.removeListener(replyChannel, onReply)
      wc.removeListener('destroyed', onGone)
      wc.removeListener('render-process-gone', onGone)
      clearTimeout(timer)
      resolve(a)
    }
    // Window torn down mid-modal: cancel — there is nothing left to close or keep from here;
    // if a quit is what killed it, the quit path already owns the sessions' fate.
    const onGone = (): void => finish(CANCELLED)
    const onReply = (e: IpcMainEvent, reply: unknown): void => {
      if (isForeignSender(e, () => win)) return
      finish(normalizeCloseAnswer(reply))
    }
    const timer = setTimeout(() => finish(CANCELLED), ANSWER_TIMEOUT_MS)
    timer.unref()
    bus.on(replyChannel, onReply)
    wc.once('destroyed', onGone)
    wc.once('render-process-gone', onGone)
    try {
      wc.send('closeGuard:query', { sessions, replyChannel })
    } catch {
      finish(CANCELLED)
    }
  })
}

/**
 * Settings › Terminal IPC for the PR-2 rows (+ the surviveRestart toggle PR-1 deferred here).
 * Frame-guarded like every settings surface; `set` merges onto the repaired current config so
 * a partial write can't drop sibling fields.
 */
export function registerPtyHostConfigIpc(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  userData: string
): void {
  ipc.handle('ptyhost:config:get', (e) => {
    if (isForeignSender(e, getWin)) return null
    return readPtyHostConfig(userData)
  })
  ipc.handle('ptyhost:config:set', (e, patch: unknown) => {
    if (isForeignSender(e, getWin)) return { ok: false }
    try {
      const cur = readPtyHostConfig(userData)
      const p = typeof patch === 'object' && patch !== null ? (patch as Partial<PtyHostConfig>) : {}
      const next: PtyHostConfig = {
        surviveRestart:
          typeof p.surviveRestart === 'boolean' ? p.surviveRestart : cur.surviveRestart,
        onCloseWithSessions:
          p.onCloseWithSessions === 'ask' ||
          p.onCloseWithSessions === 'keep' ||
          p.onCloseWithSessions === 'stop'
            ? p.onCloseWithSessions
            : cur.onCloseWithSessions,
        notifyBackgroundExit:
          typeof p.notifyBackgroundExit === 'boolean'
            ? p.notifyBackgroundExit
            : cur.notifyBackgroundExit
      }
      writePtyHostConfig(userData, next)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })
}
