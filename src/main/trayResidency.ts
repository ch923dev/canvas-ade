/**
 * Tray residency (PR-2 background sessions, Option B — locked): after a "keep running in
 * background" close, the window + renderer die and MAIN shrinks to a system-tray icon. The
 * icon exists ONLY in this state (zero footprint otherwise); the daemon underneath never
 * depends on it (survival is the daemon's job — this is pure visibility UX).
 *
 * While resident, a poll loop lists the daemon's sessions (~4s): sessions that vanish exited
 * on their own → an OS toast rides the #314 lifecycle-notifications delivery (gated by the
 * Settings "notify when a background agent finishes" toggle); the LAST exit removes the tray
 * and fully quits the app — no permanent resident. Polling (not attach) is deliberate:
 * attaching would stream every session's output through MAIN just to hear exits, and any
 * protocol change would bump PROTOCOL_VERSION, which orphans surviving sessions across an
 * app update (the drain-and-respawn handshake).
 *
 * Reopen (tray click / "Open Expanse" / a second app launch) tears the tray down, re-warms
 * the PR-1 survivor list, and recreates the window — boards reattach through the exact
 * adopt-first machinery an update-restart uses.
 */
import { app, Menu, Tray, nativeImage } from 'electron'
import type { CloseSessionRow } from '../shared/closeGuardTypes'
import { quitPtyDrain, warmPtyHostReattach } from './ptyHost/bridge'
import {
  listDaemonSessionsStrict,
  setKeepSessionsOnQuit,
  shutdownPtyHostDaemon
} from './ptyHost/client'
import { readPtyHostConfig } from './ptyHost/config'
import type { SessionInfo } from './ptyHost/protocol'
import {
  buildTrayMenuModel,
  decidePollOutcome,
  seedModelFromRows,
  type TrayMenuModel
} from './ptyHost/trayResidencyCore'

const POLL_MS = 4_000

export interface TrayResidencyDeps {
  /** Recreate the app window (index.ts createWindow) — boards reattach via PR-1 adopt. */
  createWindow: () => void
  /** Flush the renderer autosave before the window dies (the guarded-quit flush, bounded). */
  flushRenderer: () => Promise<void>
  /** Persist background parks' ring tails (mirrors shutdown()'s pre-drain persist). */
  persistRingTails: () => void
  /** Destroy the current window without re-entering the close guard (win.destroy()). */
  destroyWindow: () => void
  /** The ONE lifecycle delivery site (#314) — background-exit toasts go through it. */
  deliver: (sig: { boardId: string; event: 'done'; cwd?: string }) => void
  /** userData dir for the fresh config read at toast time (never a project folder). */
  userData: string
}

let deps: TrayResidencyDeps | null = null
let resident = false
let tray: Tray | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
/** Sessions seen by the previous poll — the exit-diff baseline. */
let lastSeen: SessionInfo[] = []
/** Consecutive failed polls (review #340 [critical] — see decidePollOutcome). */
let pollFailures = 0

/** window-all-closed consults this: while resident (or entering residency) the app must NOT quit. */
export function isTrayResident(): boolean {
  return resident
}

/**
 * One-time wiring (index.ts whenReady). Also handles a second app launch while resident:
 * the single-instance lock forwards it here and the resident main reopens the window
 * (deepLinkBoot's own second-instance handler no-ops on a null window).
 */
export function wireTrayResidency(d: TrayResidencyDeps): void {
  deps = d
  app.on('second-instance', () => {
    if (resident) void reopenFromTray()
  })
}

/**
 * Enter residency: flush + persist while the renderer is still alive, detach the session
 * fleet into the daemon (the D5 keep drain — quitDrainCore keep=true: ports closed, daemon
 * procs kept, in-proc members reaped), destroy the window, then raise the tray.
 */
export async function enterTrayResidency(rows: CloseSessionRow[]): Promise<void> {
  if (!deps || resident) return
  resident = true // set BEFORE the window dies so window-all-closed skips app.quit()
  try {
    await deps.flushRenderer()
  } catch {
    /* a wedged renderer must not block residency — canvas.json autosave already ran ~1s ago */
  }
  try {
    deps.persistRingTails()
  } catch {
    /* best-effort, mirrors shutdown() */
  }
  setKeepSessionsOnQuit(true)
  try {
    await quitPtyDrain()
  } finally {
    // Reset so a LATER real quit from the tray (or the OS) takes the honest kill drain.
    setKeepSessionsOnQuit(false)
  }
  deps.destroyWindow()
  await raiseTray(seedModelFromRows(rows, Date.now()))
  lastSeen = []
  pollFailures = 0
  pollTimer = setInterval(() => void poll(), POLL_MS)
  void poll() // immediate first poll seeds lastSeen from the daemon's truth
}

/** Reopen the window (tray click / menu / second instance): tray down, PR-1 reattach up. */
export async function reopenFromTray(): Promise<void> {
  if (!resident || !deps) return
  stopResidency()
  await warmPtyHostReattach() // re-list survivors so the adopt-first mount reattaches
  deps.createWindow()
}

/** "Stop all sessions" / "Quit — stop all sessions": tree-kill everything, then a clean quit. */
async function stopAllAndQuit(): Promise<void> {
  stopResidency()
  try {
    await shutdownPtyHostDaemon()
  } catch {
    /* daemon already gone — the quit below is still correct */
  }
  app.quit()
}

/** Leave the residency state machine (shared by reopen / stop-all / last-exit). */
function stopResidency(): void {
  resident = false
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  tray?.destroy()
  tray = null
  lastSeen = []
  pollFailures = 0
}

async function raiseTray(model: TrayMenuModel): Promise<void> {
  // The packaged exe carries the brand icon — derive the tray image from it (build/ assets
  // are not shipped inside the asar). Dev shows the stock Electron icon, which is fine.
  let icon = nativeImage.createEmpty()
  try {
    icon = await app.getFileIcon(process.execPath, { size: 'small' })
  } catch {
    /* empty image still yields a functional (if invisible) tray — menu keeps working */
  }
  tray = new Tray(icon)
  tray.setToolTip(model.header)
  tray.on('click', () => void reopenFromTray())
  applyMenu(model)
}

function applyMenu(model: TrayMenuModel): void {
  if (!tray) return
  tray.setToolTip(model.header)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: model.header, enabled: false },
      ...model.rows.map((r) => ({ label: r.label, enabled: false })),
      { type: 'separator' as const },
      { label: 'Open Expanse', click: () => void reopenFromTray() },
      { label: 'Stop all sessions', click: () => void stopAllAndQuit() },
      { type: 'separator' as const },
      // Locked: the quit item always states its consequence.
      { label: 'Quit — stop all sessions', click: () => void stopAllAndQuit() }
    ])
  )
}

/**
 * One poll tick: refresh the menu, toast exits, and quit when the last session is gone. The
 * decision math is pure (decidePollOutcome — review #340 [critical]): a FAILED daemon call is
 * a retry, never "zero sessions"; only a run of MAX_POLL_FAILURES declares the daemon (and
 * therefore its ConPTY children) gone, and that path skips the 'done' toasts — an agent whose
 * host crashed did not "finish".
 */
async function poll(): Promise<void> {
  if (!resident || !deps) return
  const list = await listDaemonSessionsStrict() // null = call FAILED (≠ empty daemon)
  if (!resident) return // stop-all / reopen raced the await — this tick no longer owns state
  const outcome = decidePollOutcome(
    lastSeen.map((s) => s.id),
    list,
    pollFailures
  )
  pollFailures = outcome.failures
  switch (outcome.action) {
    case 'skip':
      return // transient hiccup: keep the tray + last menu, retry next tick
    case 'quit-daemon-lost':
      stopResidency()
      app.quit()
      return
    case 'quit-empty':
      // Last session ended on its own: toast it, tray removed, app fully quits.
      if (outcome.exited.length > 0) notifyExits(outcome.exited)
      stopResidency()
      app.quit()
      return
    case 'refresh':
      if (outcome.exited.length > 0) notifyExits(outcome.exited)
      lastSeen = list ?? []
      applyMenu(buildTrayMenuModel(lastSeen, Date.now()))
  }
}

/** Route background exits through the ONE #314 delivery site, gated by the Settings toggle. */
function notifyExits(ids: string[]): void {
  if (!deps) return
  let notify = true
  try {
    notify = readPtyHostConfig(deps.userData).notifyBackgroundExit
  } catch {
    /* unreadable config → default-notify (repair default) */
  }
  if (!notify) return
  for (const id of ids) {
    const seen = lastSeen.find((s) => s.id === id)
    deps.deliver({ boardId: id, event: 'done', cwd: seen?.meta.cwd })
  }
}
