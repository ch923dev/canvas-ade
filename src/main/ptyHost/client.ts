/**
 * MAIN-side PTY-host client (DESIGN.md). Owns the daemon lifecycle (stage → spawn detached →
 * hello) and exposes daemon sessions as **IPty-shaped proxies** (D4) so pty.ts's session
 * bookkeeping — park/adopt, lifecycle heuristics, killTree — runs unchanged on top of them.
 *
 * One named-pipe connection multiplexes every session. Loss of the daemon while sessions are
 * live is surfaced honestly: each proxy emits an exit and the injected notifier fires once —
 * never a silent fallback (D2).
 */
import { app } from 'electron'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn as spawnChild } from 'node:child_process'
import type { IPty, IDisposable } from 'node-pty'
import {
  PROTOCOL_VERSION,
  createLineDecoder,
  encodeLine,
  type ClientMsg,
  type DaemonMsg,
  type SessionInfo,
  type SessionMeta
} from './protocol'
import { ensureStaged, sweepOldStages, type StageSources } from './runtimeStage'
// Pure discovery-state helpers (pipe-name derivation, state-file repair) live in ./state so the
// unit suite imports them without dragging this module's electron dependency in.
import { pipeNameFor, repairState, type PtyHostState } from './state'

/* ── connection state ───────────────────────────────────────────────────────────────────────── */

interface SessionHandlers {
  onData: Set<(d: string) => void>
  onExit: Set<(e: { exitCode: number; signal?: number }) => void>
  onPid?: (pid: number) => void
}

interface Pending {
  spawned: Map<string, { resolve: (pid: number) => void; reject: (err: Error) => void }>
  replay: Map<
    string,
    {
      resolve: (r: {
        data: string
        cols: number
        rows: number
        pid: number
        meta: SessionMeta
      }) => void
      reject: (err: Error) => void
    }
  >
  killed: Map<string, () => void>
  lists: Array<(l: SessionInfo[]) => void>
}

let sock: net.Socket | null = null
let ready: Promise<void> | null = null
let keepOnQuit = false
let failedReason: string | null = null
const handlers = new Map<string, SessionHandlers>()
const pending: Pending = { spawned: new Map(), replay: new Map(), killed: new Map(), lists: [] }

/** Surfaced failure sink (index.ts wires a toast). Fires at most once per failure reason. */
let notifier: ((message: string) => void) | null = null
export function setPtyHostNotifier(fn: ((message: string) => void) | null): void {
  notifier = fn
}
function notifyOnce(message: string): void {
  if (failedReason === message) return
  failedReason = message
  console.error(`[ptyhost] ${message}`)
  notifier?.(message)
}

/** pty.ts's fallback path surfaces its reason through the same once-per-reason sink. */
export function reportPtyHostFailure(message: string): void {
  notifyOnce(message)
}

function stateFile(): string {
  return path.join(app.getPath('userData'), 'ptyhost-state.json')
}

function sendMsg(msg: ClientMsg): void {
  if (sock && !sock.destroyed) sock.write(encodeLine(msg))
}

function routeMsg(msg: DaemonMsg): void {
  switch (msg.ev) {
    case 'output':
      handlers.get(msg.id)?.onData.forEach((fn) => fn(msg.data))
      break
    case 'exit': {
      const h = handlers.get(msg.id)
      handlers.delete(msg.id)
      h?.onExit.forEach((fn) => fn({ exitCode: msg.code }))
      break
    }
    case 'pid':
      handlers.get(msg.id)?.onPid?.(msg.pid)
      break
    case 'spawned':
      pending.spawned.get(msg.id)?.resolve(msg.pid)
      pending.spawned.delete(msg.id)
      break
    case 'spawn-failed':
      pending.spawned.get(msg.id)?.reject(new Error(msg.error))
      pending.spawned.delete(msg.id)
      break
    case 'replay':
      pending.replay
        .get(msg.id)
        ?.resolve({ data: msg.data, cols: msg.cols, rows: msg.rows, pid: msg.pid, meta: msg.meta })
      pending.replay.delete(msg.id)
      break
    case 'killed':
      pending.killed.get(msg.id)?.()
      pending.killed.delete(msg.id)
      break
    case 'sessions':
      pending.lists.shift()?.(msg.list)
      break
    case 'error':
      if (msg.id) {
        // A per-session error settles that session's pending request, if any.
        pending.spawned.get(msg.id)?.reject(new Error(msg.message))
        pending.spawned.delete(msg.id)
        pending.replay.get(msg.id)?.reject(new Error(msg.message))
        pending.replay.delete(msg.id)
      }
      break
    case 'hello':
      break
  }
}

/** The daemon vanished mid-flight: fail every pending request, exit every live proxy, and
 *  surface ONE notification. Sessions may in fact still run (a pipe hiccup), but a lost data
 *  plane is a dead terminal either way — honest exit beats a silently frozen board. */
function onConnectionLost(): void {
  sock = null
  ready = null
  const err = new Error('PTY host connection lost')
  for (const p of pending.spawned.values()) p.reject(err)
  pending.spawned.clear()
  for (const p of pending.replay.values()) p.reject(err)
  pending.replay.clear()
  for (const fn of pending.killed.values()) fn()
  pending.killed.clear()
  pending.lists.length = 0
  if (handlers.size > 0) {
    notifyOnce('Terminal host disconnected — running sessions were interrupted.')
    const all = [...handlers.values()]
    handlers.clear()
    for (const h of all) h.onExit.forEach((fn) => fn({ exitCode: -1 }))
  }
}

function connectTo(pipe: string, token: string, retries: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryOnce = (): void => {
      const s = net.connect(pipe)
      let settled = false
      const feed = createLineDecoder<DaemonMsg>((msg) => {
        if (!settled && msg.ev === 'hello') {
          settled = true
          if (msg.version !== PROTOCOL_VERSION) {
            s.destroy()
            reject(new Error(`protocol mismatch: daemon v${msg.version}, app v${PROTOCOL_VERSION}`))
            return
          }
          resolve(s)
          return
        }
        if (!settled && msg.ev === 'error') {
          settled = true
          s.destroy()
          reject(new Error(msg.message))
          return
        }
        routeMsg(msg)
      })
      s.on('data', (c) => feed(c.toString('utf8')))
      s.once('connect', () =>
        s.write(encodeLine({ op: 'hello', token, version: PROTOCOL_VERSION }))
      )
      s.once('error', (err) => {
        if (settled) return
        if (++attempt >= retries) {
          settled = true
          reject(err)
        } else setTimeout(tryOnce, 250)
      })
      s.once('close', () => {
        if (settled && sock === s) onConnectionLost()
      })
    }
    tryOnce()
  })
}

/** Resolve stage sources for this build flavor (dev = checkout paths, packaged = install dir). */
function resolveSources(): { src: StageSources; stageInPlace: boolean } {
  if (app.isPackaged) {
    return {
      src: {
        runtimeDir: path.dirname(process.execPath),
        exeName: path.basename(process.execPath),
        daemonJs: path.join(__dirname, 'ptyHostDaemon.js'),
        nodePtyDir: path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          'node-pty'
        )
      },
      stageInPlace: false
    }
  }
  // Dev: the checkout's electron dist + out/main. No install dir exists to lock, so the daemon
  // runs IN PLACE (no 245 MB copy per dev iteration); e2e opts back into staging via env to
  // exercise the packaged path.
  const checkout = path.resolve(__dirname, '..', '..')
  return {
    src: {
      runtimeDir: path.join(checkout, 'node_modules', 'electron', 'dist'),
      exeName: 'electron.exe',
      daemonJs: path.join(__dirname, 'ptyHostDaemon.js'),
      nodePtyDir: path.join(checkout, 'node_modules', 'node-pty')
    },
    stageInPlace: process.env.CANVAS_PTYHOST_STAGE !== '1'
  }
}

function spawnDaemon(): PtyHostState {
  const { src, stageInPlace } = resolveSources()
  let exe: string
  let script: string
  if (stageInPlace) {
    exe = path.join(src.runtimeDir, src.exeName)
    script = src.daemonJs
  } else {
    const stageRoot = path.join(app.getPath('appData'), '..', 'Local', 'expanse-ptyhost')
    const versionDir = app.getVersion()
    const staged = ensureStaged(src, path.join(stageRoot, versionDir))
    sweepOldStages(stageRoot, versionDir)
    exe = staged.exe
    script = staged.script
  }
  const suffix = crypto.randomBytes(6).toString('hex')
  const state: PtyHostState = {
    pipe: pipeNameFor(app.getPath('userData'), suffix),
    token: crypto.randomBytes(32).toString('hex'),
    daemonPid: 0,
    protocolVersion: PROTOCOL_VERSION
  }
  const child = spawnChild(exe, [script], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PTYHOST_PIPE: state.pipe,
      PTYHOST_TOKEN: state.token,
      PTYHOST_LOG: path.join(app.getPath('userData'), 'ptyhost.log')
    }
  })
  child.unref()
  state.daemonPid = child.pid ?? 0
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  return state
}

/** Connect to the existing daemon or spawn a fresh one. Single-flight. */
export function ensurePtyHost(): Promise<void> {
  if (ready) return ready
  ready = (async () => {
    // 1. A daemon from a previous app run? (update restart / crash — the reattach case.)
    let existing: PtyHostState | null = null
    try {
      existing = repairState(JSON.parse(fs.readFileSync(stateFile(), 'utf8')))
    } catch {
      /* no/torn state file — fresh spawn below */
    }
    if (existing) {
      try {
        sock = await connectTo(existing.pipe, existing.token, 2)
        failedReason = null
        return
      } catch {
        /* daemon gone or incompatible — fresh spawn below */
      }
    }
    // 2. Fresh daemon.
    const state = spawnDaemon()
    sock = await connectTo(state.pipe, state.token, 40)
    failedReason = null
  })()
  ready.catch(() => {
    ready = null
    sock = null
  })
  return ready
}

/* ── IPty-shaped proxy (D4) ─────────────────────────────────────────────────────────────────── */

/** Brand test: is this IPty a daemon-backed proxy (vs a real in-proc node-pty)? The quit-path
 *  drain partitions on this (review #337 — a mixed fleet must kill its in-proc members). */
export function isDaemonProxy(proc: unknown): boolean {
  return proc instanceof DaemonPty
}

class DaemonPty implements IPty {
  pid: number
  cols: number
  rows: number
  readonly process: string
  handleFlowControl = false
  private readonly h: SessionHandlers

  constructor(
    readonly id: string,
    pid: number,
    cols: number,
    rows: number,
    procTitle: string
  ) {
    this.pid = pid
    this.cols = cols
    this.rows = rows
    this.process = procTitle
    this.h = { onData: new Set(), onExit: new Set(), onPid: (p) => (this.pid = p) }
    handlers.set(id, this.h)
  }

  readonly onData = (listener: (e: string) => void): IDisposable => {
    this.h.onData.add(listener)
    return { dispose: () => this.h.onData.delete(listener) }
  }

  readonly onExit = (listener: (e: { exitCode: number; signal?: number }) => void): IDisposable => {
    this.h.onExit.add(listener)
    return { dispose: () => this.h.onExit.delete(listener) }
  }

  write(data: string): void {
    sendMsg({ op: 'input', id: this.id, data })
  }

  resize(columns: number, rows: number): void {
    this.cols = columns
    this.rows = rows
    sendMsg({ op: 'resize', id: this.id, cols: columns, rows })
  }

  kill(): void {
    // killTree (pty.ts) taskkills the real pid from MAIN and calls this for the ConPTY
    // dispose — the daemon-side kill op is the authoritative tree reap either way.
    sendMsg({ op: 'kill', id: this.id })
  }

  clear(): void {
    /* ConPTY buffer clear is daemon-internal; not needed by any MAIN path */
  }
  pause(): void {
    /* flow control unused (matches in-proc usage — pty.ts never pauses) */
  }
  resume(): void {
    /* see pause */
  }
}

/* ── session operations consumed by pty.ts ──────────────────────────────────────────────────── */

export interface DaemonSpawnOpts {
  id: string
  shell: string
  args: string[]
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
  meta: SessionMeta
}

/** Spawn a session in the daemon; resolves to an IPty-shaped proxy. Rejects → caller falls
 *  back to in-proc and surfaces the failure (never silent). */
export async function spawnViaDaemon(opts: DaemonSpawnOpts): Promise<IPty> {
  await ensurePtyHost()
  const pid = await new Promise<number>((resolve, reject) => {
    pending.spawned.set(opts.id, { resolve, reject })
    sendMsg({
      op: 'spawn',
      id: opts.id,
      shell: opts.shell,
      args: opts.args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env,
      meta: opts.meta
    })
    setTimeout(() => {
      if (pending.spawned.delete(opts.id)) {
        // Review #337 [warning]: a LATE `spawned` ack (slow ConPTY under load) would otherwise
        // leave a session registered in the daemon that MAIN never tracks — an orphan until the
        // next app restart. Tell the daemon to reap the id regardless of which side of the race
        // the ack lands on; a kill for a not-(yet-)existing id is acked harmlessly.
        sendMsg({ op: 'kill', id: opts.id })
        reject(new Error('daemon spawn timed out'))
      }
    }, 10_000).unref()
  })
  return new DaemonPty(opts.id, pid, opts.cols, opts.rows, path.basename(opts.shell))
}

/**
 * Live daemon sessions, failure-HONEST (PR-2 review #340 [critical]): `null` means the call
 * FAILED (daemon unreachable / response timeout) — callers that act on "zero sessions" (the
 * tray's last-exit-quits poll) must not confuse a transient IPC hiccup with a confirmed-empty
 * daemon, or a single flaky poll ends residency and quits with sessions still alive.
 */
export async function listDaemonSessionsStrict(): Promise<SessionInfo[] | null> {
  try {
    await ensurePtyHost()
  } catch {
    return null
  }
  return new Promise<SessionInfo[] | null>((resolve) => {
    const settle = (l: SessionInfo[]): void => resolve(l)
    pending.lists.push(settle)
    sendMsg({ op: 'list' })
    setTimeout(() => {
      const i = pending.lists.indexOf(settle)
      if (i >= 0) {
        pending.lists.splice(i, 1)
        resolve(null) // timed out — a failure, NOT an empty daemon
      }
    }, 5_000).unref()
  })
}

/** Live daemon sessions (boot reattach list). Empty on any failure — reattach is best-effort;
 *  the board then takes its normal spawn path. */
export async function listDaemonSessions(): Promise<SessionInfo[]> {
  return (await listDaemonSessionsStrict()) ?? []
}

/** Attach to a surviving daemon session: proxy + ring replay + persisted meta. */
export async function attachDaemonSession(
  id: string
): Promise<{ proxy: IPty; replay: string; meta: SessionMeta; pid: number }> {
  await ensurePtyHost()
  const r = await new Promise<{
    data: string
    cols: number
    rows: number
    pid: number
    meta: SessionMeta
  }>((resolve, reject) => {
    pending.replay.set(id, { resolve, reject })
    sendMsg({ op: 'attach', id })
    setTimeout(() => {
      if (pending.replay.delete(id)) reject(new Error('daemon attach timed out'))
    }, 5_000).unref()
  })
  const proxy = new DaemonPty(id, r.pid, r.cols, r.rows, path.basename(r.meta.shell))
  return { proxy, replay: r.data, meta: r.meta, pid: r.pid }
}

/** Kill a daemon session that has no MAIN proxy (e.g. an id collision at spawn). */
export function killDaemonSession(id: string): Promise<void> {
  return new Promise((resolve) => {
    pending.killed.set(id, resolve)
    sendMsg({ op: 'kill', id })
    setTimeout(() => {
      if (pending.killed.delete(id)) resolve()
    }, 5_000).unref()
  })
}

/* ── quit-path control (D5) ─────────────────────────────────────────────────────────────────── */

/** Set by the auto-update install path just before quitAndInstall: this quit KEEPS sessions. */
export function setKeepSessionsOnQuit(v: boolean): void {
  keepOnQuit = v
}
export function shouldKeepSessionsOnQuit(): boolean {
  return keepOnQuit && sock !== null && handlers.size > 0
}

/** Detach without killing: close the pipe; the daemon keeps every session for the relaunch. */
export function disconnectPtyHost(): void {
  const s = sock
  sock = null // clear FIRST so the close handler skips onConnectionLost's exit fan-out
  ready = null
  handlers.clear()
  try {
    s?.destroy()
  } catch {
    /* already gone */
  }
}

/** Ask the daemon to tree-kill everything and exit (e2e teardown sweep / explicit stop-all). */
export async function shutdownPtyHostDaemon(): Promise<void> {
  if (!sock) {
    try {
      await ensurePtyHost()
    } catch {
      return // nothing to shut down
    }
  }
  sendMsg({ op: 'shutdown' })
  disconnectPtyHost()
  try {
    fs.rmSync(stateFile(), { force: true })
  } catch {
    /* best-effort */
  }
}
