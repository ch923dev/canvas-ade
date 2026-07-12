/**
 * pty.ts ⇄ PTY-host glue (extracted for the max-lines ratchet, the ptyDataBatch/ptyExitResidue
 * pattern): the daemon gate, the boot-time survivor list, daemon-first process acquisition, and
 * the reattach-as-synthetic-park. pty.ts injects its private session state (parked map, data
 * pump, reaper) via `configurePtyHostBridge` at module load; everything else imports directly.
 */
import { app, Notification } from 'electron'
import * as pty from 'node-pty'
import { getCurrentDir } from '../projectStore'
import { createRing, pushRing, type OutputRing } from '../ptyOutput'
import type { SpawnOpts } from '../pty'
import {
  attachDaemonSession,
  disconnectPtyHost,
  isDaemonProxy,
  killDaemonSession,
  listDaemonSessions,
  reportPtyHostFailure,
  setPtyHostNotifier,
  shouldKeepSessionsOnQuit,
  spawnViaDaemon
} from './client'
import { ptyHostEnabled, readPtyHostConfig } from './config'
import type { SessionInfo, SessionMeta } from './protocol'

/** The slice of pty.ts's ParkedLike the synthetic reattach park needs to construct. */
interface ParkedEntryLike {
  proc: pty.IPty
  buf: OutputRing
  timer?: ReturnType<typeof setTimeout>
  kind?: 'undo' | 'background'
  owningDir?: string | null
  watermark?: number
  flushData?: () => void
}

/** The slice of pty.ts's SessionLike the quit-path detach needs. */
interface SessionEntryLike {
  proc: pty.IPty
  port: { close(): void }
  flushData?: () => void
}

interface BridgeDeps {
  /** pty.ts's private live-session map — the quit-path detach target. */
  sessions: Map<string, SessionEntryLike>
  /** pty.ts's private parked map — the reattach target. */
  parked: Map<string, ParkedEntryLike>
  /** pty.ts's private per-board cwd map (gitDiff contract). */
  boardCwds: Map<string, string>
  /** The shared data-plane pump (ring record + forward + exit lifecycle); returns flushData. */
  bindProcPump: (id: string, proc: pty.IPty, buf: OutputRing) => () => void
  /** Reap one parked entry (TTL expiry) — pty.ts's reapParked. */
  reapParked: (id: string) => Promise<void>
  /** PARK_TTL_MS — the synthetic park's never-adopted safety net. */
  parkTtlMs: number
  /** pty.ts's disposeAllPtys — the normal-quit kill-everything drain. */
  disposeAllPtys: () => Promise<void>
  /** pty.ts's killTree — reaps the IN-PROC members of a mixed fleet on the detach path. */
  killTree: (proc: pty.IPty) => Promise<void>
}

let deps: BridgeDeps | null = null
export function configurePtyHostBridge(d: BridgeDeps): void {
  deps = d
}

/**
 * Boot wiring (index.ts, one call): surface daemon failures as an OS notification (D2 — the
 * in-proc fallback must never be silent; muted under headless e2e/smoke like the lifecycle
 * notifier), then warm the reattach survivor list.
 */
export function bootPtyHost(opts: { muted: boolean }): void {
  setPtyHostNotifier((message) => {
    if (opts.muted) return
    try {
      new Notification({ title: 'Expanse — terminals', body: message }).show()
    } catch {
      /* notification support missing — the client's console.error already logged it */
    }
  })
  void warmPtyHostReattach()
}

/**
 * Quit-path drain (index.ts shutdown, DESIGN.md D5): an UPDATE-INSTALL quit detaches — renderer
 * ports closed, procs left alive in the daemon for the relaunch's reattach; every other quit
 * (window close, explicit quit, crash sinks) keeps the kill-everything drain. NEVER the detach
 * path on a normal close — that behavior change waits for the PR-2 close modal.
 */
export function quitPtyDrain(): Promise<void> {
  if (!deps) return Promise.resolve()
  if (!shouldKeepSessionsOnQuit()) return deps.disposeAllPtys()
  // Review #337 [warning]: the fleet can be MIXED — daemon-backed proxies plus in-proc
  // sessions from the surfaced fallback (D2). Only daemon-backed sessions survive an app
  // quit by construction; the in-proc members must still be tree-killed here or they leak
  // as unreattachable orphans. Partition on the proxy brand.
  const kills: Promise<void>[] = []
  for (const s of deps.sessions.values()) {
    try {
      s.flushData?.()
    } catch {
      /* already torn down */
    }
    try {
      s.port.close()
    } catch {
      /* already closed */
    }
    if (!isDaemonProxy(s.proc)) kills.push(deps.killTree(s.proc))
  }
  deps.sessions.clear()
  for (const p of deps.parked.values()) {
    if (p.timer) clearTimeout(p.timer)
    if (!isDaemonProxy(p.proc)) kills.push(deps.killTree(p.proc))
  }
  deps.parked.clear()
  deps.boardCwds.clear()
  disconnectPtyHost()
  return Promise.all(kills).then(() => undefined)
}

/** Sessions found alive in the daemon at boot (a previous app run kept them): id → info. */
const daemonSurvivors = new Map<string, SessionInfo>()
/** The boot-time survivor list fetch; reattach awaits it so early board mounts can't race it. */
let survivorsReady: Promise<void> = Promise.resolve()
/** Effective daemon gate, resolved lazily once per run (config + platform + env, D2). */
let ptyHostGate: boolean | null = null

export function isPtyHostActive(): boolean {
  if (ptyHostGate === null) {
    try {
      ptyHostGate = ptyHostEnabled(
        readPtyHostConfig(app.getPath('userData')),
        process.platform,
        process.env
      )
    } catch {
      ptyHostGate = false
    }
  }
  return ptyHostGate
}

/**
 * Boot-time reattach warm-up (index.ts, right after handler registration): list the daemon's
 * surviving sessions so the adopt-first terminal mount can reattach instead of respawning.
 * Best-effort — an unreachable daemon yields an empty list and boards spawn fresh.
 */
export function warmPtyHostReattach(): Promise<void> {
  if (!isPtyHostActive()) return Promise.resolve()
  survivorsReady = listDaemonSessions()
    .then((list) => {
      for (const info of list) daemonSurvivors.set(info.id, info)
    })
    .catch(() => undefined)
  return survivorsReady
}

/**
 * Acquire the session process (DESIGN.md D2/D4): through the daemon when the gate is ON — an
 * id already live in the daemon from a previous run is killed first (the board chose a fresh
 * spawn over adopt) — falling back to in-proc node-pty on ANY daemon failure with the reason
 * surfaced once, never silent. The returned object is IPty-shaped either way.
 */
export async function acquireProc(
  opts: SpawnOpts,
  shell: string,
  args: string[],
  cols: number,
  rows: number,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<pty.IPty> {
  if (isPtyHostActive()) {
    try {
      if (daemonSurvivors.has(opts.id)) {
        daemonSurvivors.delete(opts.id)
        await killDaemonSession(opts.id)
      }
      const cleanEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(env)) if (typeof v === 'string') cleanEnv[k] = v
      const meta: SessionMeta = {
        projectDir: getCurrentDir(),
        cwd,
        shell,
        monitored: opts.monitorActivity !== false
      }
      return await spawnViaDaemon({
        id: opts.id,
        shell,
        args,
        cwd,
        cols,
        rows,
        env: cleanEnv,
        meta
      })
    } catch (err) {
      reportPtyHostFailure(
        `Terminal host unavailable — sessions will not survive restarts (${
          err instanceof Error ? err.message : String(err)
        })`
      )
    }
  }
  return pty.spawn(shell, args, { name: 'xterm-256color', cols, rows, cwd, env })
}

/**
 * Reattach one daemon-surviving session (a previous app run kept it alive — update restart or
 * crash) as a synthetic UNDO-park, so the adopt path right after this call rebinds it with the
 * exact port/replay/owner semantics of a live park. Owner-scoped like every cross-session read:
 * a survivor owned by a DIFFERENT project stays untouched in the daemon (its owner reattaches
 * it on switch-back). kind 'undo' (not 'background') is deliberate — the adopt handler must NOT
 * prepend the sidecar snapshot, because the daemon ring already spans the pre-quit tail and a
 * preface would duplicate the overlap. Returns false → the caller falls through to the
 * snapshot-restore/spawn path.
 */
export async function tryDaemonReattach(id: string): Promise<boolean> {
  if (!deps) return false
  await survivorsReady
  const info = daemonSurvivors.get(id)
  if (!info) return false
  if ((info.meta.projectDir ?? null) !== getCurrentDir()) return false
  daemonSurvivors.delete(id)
  let att: Awaited<ReturnType<typeof attachDaemonSession>>
  try {
    att = await attachDaemonSession(id)
  } catch {
    return false // session exited between list and attach — spawn fresh
  }
  const buf = createRing(256 * 1024)
  if (att.replay) pushRing(buf, att.replay)
  const flushData = deps.bindProcPump(id, att.proxy, buf)
  const reap = deps.reapParked
  deps.parked.set(id, {
    proc: att.proxy,
    buf,
    kind: 'undo',
    owningDir: att.meta.projectDir ?? null,
    // Safety net: if the adopt right after this never lands (renderer died mid-mount), the
    // synthetic park is reaped like any undo park instead of dangling forever.
    timer: setTimeout(() => void reap(id), deps.parkTtlMs),
    flushData
  })
  deps.boardCwds.set(id, att.meta.cwd)
  return true
}
