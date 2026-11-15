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
  attachLineDecoder,
  encodeLine,
  verifyHello,
  type ClientMsg,
  type DaemonMsg
} from './protocol'
import { createDaemonSessions } from './daemonSessions'

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

let idleTimer: ReturnType<typeof setTimeout> | null = null

function send(sock: net.Socket, msg: DaemonMsg): void {
  if (!sock.destroyed) sock.write(encodeLine(msg))
}

function armIdleExit(delay = IDLE_EXIT_MS): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (sessions.size() === 0) {
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

// The session table + every op handler live in daemonSessions.ts (pure, unit-tested); this file
// binds them to the real pty, the real tree-kill and this process's lifetime.
const sessions = createDaemonSessions({
  spawnPty: (msg) =>
    loadPty().spawn(msg.shell, msg.args, {
      name: 'xterm-256color',
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      env: msg.env,
      useConpty: true
    }),
  killTree,
  log,
  onActive: () => {
    if (idleTimer) clearTimeout(idleTimer)
  },
  onSessionEnded: () => armIdleExit(),
  onShutdownComplete: () => {
    try {
      server.close()
    } catch {
      /* already closing */
    }
    process.exit(0)
  },
  ringCap: RING_CAP
})

function handleMessage(sock: net.Socket, msg: ClientMsg): void {
  if (msg.op === 'hello') {
    // Re-hello on an authed socket is harmless; answer again.
    send(sock, { ev: 'hello', version: PROTOCOL_VERSION, pid: process.pid })
    return
  }
  sessions.handle(sock, msg)
}

const server = net.createServer((sock) => {
  let authed = false
  attachLineDecoder<ClientMsg>(
    sock,
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
        // R7: capability negotiation by ADDITIVE hello field, not a PROTOCOL_VERSION bump — a bump
        // would orphan the sessions surviving an app update, which is the whole point of the
        // daemon (protocol.ts: MAIN drains-and-respawns on mismatch). An old daemon ignores the
        // unknown field; this new daemon leaves accounting off for a client that never sent it.
        if ((msg as { flowControl?: unknown }).flowControl === true) sessions.markFlowCapable(sock)
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
  sock.on('close', () => {
    sessions.disconnect(sock)
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
