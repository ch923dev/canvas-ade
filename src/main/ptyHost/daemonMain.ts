/**
 * PTY-host daemon entry (PR 1 — DESIGN.md). A detached, headless process that OWNS the
 * node-pty (ConPTY) sessions so they survive the app's lifecycle: update installs, crashes,
 * plain restarts. Spawned by MAIN (client.ts) from the STAGED runtime copy — never from the
 * install dir (a running exe blocks the NSIS update; measured, DESIGN.md D1).
 *
 * Runs under ELECTRON_RUN_AS_NODE: plain Node semantics, NO electron imports here. Bundled
 * as its own electron-vite main entry → out/main/ptyHostDaemon.js (voiceEngineHost precedent),
 * then copied into the stage dir beside a node_modules/node-pty subset (runtimeStage.ts).
 *
 * Contract (spike b42a6b36, productionized):
 * - named pipe (net.createServer), NDJSON protocol (protocol.ts), token-gated hello line
 * - per-session bounded output ring, replay trimmed to a line boundary on attach
 * - taskkill /PID <pid> /T /F tree-kill (src/main/pty.ts killTreeCommand pattern)
 * - lazy pid (ConPTY pid is 0 at spawn — pushed via an `ev:pid` update once real)
 * - idle-exit: zero sessions → grace → process exit (no permanent resident)
 */
import net from 'node:net'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  PROTOCOL_VERSION,
  createLineDecoder,
  encodeLine,
  verifyHello,
  type ClientMsg,
  type DaemonMsg,
  type SessionInfo,
  type SessionMeta
} from './protocol'
import { daemonRingReplay, pushDaemonRing, type DaemonRing } from './ring'

// node-pty resolves relative to the daemon's own on-disk location: the stage dir carries a
// node_modules/node-pty subset beside ptyHostDaemon.js; in dev the walk-up finds the checkout's
// node_modules. Both are the same Electron-ABI build (D1: no recompile). Loaded LAZILY at the
// first spawn: a top-level require ran before the log sink existed, so a broken stage killed
// the process with zero trace — lazy, the failure surfaces as a logged `spawn-failed` reply.
const requireFromHere = createRequire(__filename)
let ptyMod: typeof import('node-pty') | null = null
function loadPty(): typeof import('node-pty') {
  if (!ptyMod) ptyMod = requireFromHere('node-pty') as typeof import('node-pty')
  return ptyMod
}

const PIPE = process.env.PTYHOST_PIPE
const TOKEN = process.env.PTYHOST_TOKEN
const LOG = process.env.PTYHOST_LOG
if (!PIPE || !TOKEN) {
  process.stderr.write('ptyHost daemon: PTYHOST_PIPE and PTYHOST_TOKEN are required\n')
  process.exit(2)
}

/** Ring cap mirrors MAIN's RING_CAP_BYTES (pty.ts) so a reattach replay covers the same window. */
const RING_CAP = 256 * 1024
/** Zero sessions this long → exit. Also armed at boot (an orphaned daemon self-cleans). */
const IDLE_EXIT_MS = 5_000
const BOOT_GRACE_MS = 30_000

function log(msg: string): void {
  if (!LOG) return
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [ptyhost ${process.pid}] ${msg}\n`)
  } catch {
    /* logging must never take the daemon down */
  }
}

interface Session {
  proc: import('node-pty').IPty
  ring: DaemonRing
  cols: number
  rows: number
  meta: SessionMeta
  subscribers: Set<net.Socket>
  lastPidSent: number
}

const sessions = new Map<string, Session>()
let idleTimer: ReturnType<typeof setTimeout> | null = null

function send(sock: net.Socket, msg: DaemonMsg): void {
  if (!sock.destroyed) sock.write(encodeLine(msg))
}

function armIdleExit(delay = IDLE_EXIT_MS): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (sessions.size === 0) {
      log('idle (zero sessions) — exiting')
      try {
        server.close()
      } catch {
        /* already closing */
      }
      process.exit(0)
    }
  }, delay)
}

/** taskkill /T /F on win32; negative-pgid SIGKILL elsewhere (killTreeCommand pattern). */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      let settled = false
      const finish = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => finish())
      setTimeout(finish, 2000).unref()
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* group already gone */
      }
      resolve()
    }
  })
}

/** Push a late-arriving real pid (ConPTY reports 0 at spawn) to every subscriber once. */
function maybePushPid(id: string, s: Session): void {
  const pid = s.proc.pid
  if (pid && pid !== s.lastPidSent) {
    s.lastPidSent = pid
    for (const sub of s.subscribers) send(sub, { ev: 'pid', id, pid })
  }
}

function listSessions(): SessionInfo[] {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    pid: s.proc.pid,
    cols: s.cols,
    rows: s.rows,
    meta: s.meta
  }))
}

function handleMessage(sock: net.Socket, msg: ClientMsg): void {
  switch (msg.op) {
    case 'hello':
      // Re-hello on an authed socket is harmless; answer again.
      send(sock, { ev: 'hello', version: PROTOCOL_VERSION, pid: process.pid })
      break
    case 'spawn': {
      if (sessions.has(msg.id)) {
        send(sock, { ev: 'error', id: msg.id, message: `session ${msg.id} already exists` })
        return
      }
      let proc: import('node-pty').IPty
      try {
        proc = loadPty().spawn(msg.shell, msg.args, {
          name: 'xterm-256color',
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.cwd,
          env: msg.env,
          useConpty: true
        })
      } catch (err) {
        send(sock, {
          ev: 'spawn-failed',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err)
        })
        return
      }
      const s: Session = {
        proc,
        ring: { chunks: [], len: 0 },
        cols: msg.cols,
        rows: msg.rows,
        meta: msg.meta,
        subscribers: new Set([sock]),
        lastPidSent: 0
      }
      sessions.set(msg.id, s)
      if (idleTimer) clearTimeout(idleTimer)
      proc.onData((d) => {
        pushDaemonRing(s.ring, d, RING_CAP)
        maybePushPid(msg.id, s)
        for (const sub of s.subscribers) send(sub, { ev: 'output', id: msg.id, data: d })
      })
      proc.onExit(({ exitCode }) => {
        log(`session ${msg.id} exited code=${exitCode}`)
        for (const sub of s.subscribers) send(sub, { ev: 'exit', id: msg.id, code: exitCode })
        sessions.delete(msg.id)
        armIdleExit()
      })
      log(`spawned ${msg.id}: ${msg.shell} ${msg.cols}x${msg.rows}`)
      send(sock, { ev: 'spawned', id: msg.id, pid: proc.pid })
      break
    }
    case 'attach': {
      const s = sessions.get(msg.id)
      if (!s) {
        send(sock, { ev: 'error', id: msg.id, message: `no session ${msg.id}` })
        return
      }
      s.subscribers.add(sock)
      log(`attach ${msg.id} (ring ${s.ring.len})`)
      send(sock, {
        ev: 'replay',
        id: msg.id,
        data: daemonRingReplay(s.ring, RING_CAP),
        cols: s.cols,
        rows: s.rows,
        pid: s.proc.pid,
        meta: s.meta
      })
      break
    }
    case 'input': {
      const s = sessions.get(msg.id)
      if (!s) return
      try {
        s.proc.write(msg.data)
      } catch {
        /* pty already exited — exit event is on its way */
      }
      break
    }
    case 'resize': {
      const s = sessions.get(msg.id)
      if (!s) return
      try {
        s.proc.resize(msg.cols, msg.rows)
        s.cols = msg.cols
        s.rows = msg.rows
      } catch {
        /* pty already exited */
      }
      break
    }
    case 'kill': {
      const s = sessions.get(msg.id)
      if (!s) {
        // Already gone — ack anyway so the client's kill promise settles.
        send(sock, { ev: 'killed', id: msg.id })
        return
      }
      const pid = s.proc.pid
      sessions.delete(msg.id)
      void killTree(pid).then(() => {
        try {
          s.proc.kill() // dispose ConPTY handle + conout worker (pty.ts killTree pattern)
        } catch {
          /* already disposed */
        }
        send(sock, { ev: 'killed', id: msg.id })
        armIdleExit()
      })
      break
    }
    case 'list':
      send(sock, { ev: 'sessions', list: listSessions() })
      break
    case 'shutdown': {
      log('shutdown requested — killing all sessions')
      const kills = [...sessions.entries()].map(([id, s]) => {
        sessions.delete(id)
        return killTree(s.proc.pid).then(() => {
          try {
            s.proc.kill()
          } catch {
            /* already disposed */
          }
        })
      })
      void Promise.all(kills).then(() => {
        try {
          server.close()
        } catch {
          /* already closing */
        }
        process.exit(0)
      })
      break
    }
  }
}

const server = net.createServer((sock) => {
  let authed = false
  const feed = createLineDecoder<ClientMsg>(
    (msg) => {
      if (!authed) {
        const verdict = verifyHello(msg, TOKEN)
        if (verdict !== 'ok') {
          log(`rejected connection: ${verdict}`)
          send(sock, { ev: 'error', message: `handshake failed: ${verdict}` })
          sock.destroy()
          return
        }
        authed = true
        send(sock, { ev: 'hello', version: PROTOCOL_VERSION, pid: process.pid })
        return
      }
      try {
        handleMessage(sock, msg)
      } catch (err) {
        log(`handler error: ${err instanceof Error ? err.stack : String(err)}`)
        send(sock, { ev: 'error', message: String(err) })
      }
    },
    () => {
      send(sock, { ev: 'error', message: 'bad json line' })
      if (!authed) sock.destroy()
    }
  )
  sock.on('data', (chunk) => feed(chunk.toString('utf8')))
  sock.on('close', () => {
    for (const s of sessions.values()) s.subscribers.delete(sock)
    log('client disconnected (sessions keep running)')
  })
  sock.on('error', () => {
    /* client vanished — close handler does the detach */
  })
})

server.listen(PIPE, () => {
  log(`listening on ${PIPE} (protocol v${PROTOCOL_VERSION})`)
  // A daemon that never receives a session self-cleans (MAIN may have died mid-boot).
  armIdleExit(BOOT_GRACE_MS)
})
process.on('uncaughtException', (err) => log(`UNCAUGHT: ${err.stack ?? String(err)}`))
