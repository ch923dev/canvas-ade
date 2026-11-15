/**
 * The PTY-host daemon's session table + op handlers, pure of process state (the quitDrain /
 * closeGuardCore pattern: daemonMain.ts owns the pipe, the env, node-pty and `process.exit`, so it
 * cannot be unit-imported — everything that decides WHICH session an op or a pty event belongs to
 * lives here, where the suite drives it with a fake pty and fake connections).
 *
 * INSTANCE IDENTITY (the pty.ts `isStaleExit` discipline, daemon side). The table is keyed by
 * board id, and an id is REUSED: Restart kills a session and respawns under the same id straight
 * away, while the killed pty keeps draining output and only reports its exit once its tree is dead
 * — about a second later, long after the replacement is registered. So a pty callback must never
 * act on "the session called <id>": it acts only while ITS OWN session object is still the one
 * registered (`owns`). Without that, the old pty's late exit told the client the fresh session
 * had exited and deleted it from the table, leaving its process running with no way to address it.
 * A session leaves the table by its own exit, by `kill`, or by `shutdown`; after the last two
 * the `killed` ack (or the daemon's exit) is its final word and its pty is silent from then on.
 */
import { encodeLine, type ClientMsg, type DaemonMsg, type SessionInfo } from './protocol'
import { createDaemonRing, daemonRingReplay, pushDaemonRing, type DaemonRing } from './ring'
import { createSessionFlow, type SessionFlow } from './flowControl'

/** The slice of node-pty's IPty the daemon drives (the real IPty satisfies it structurally). */
export interface DaemonPtyLike {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (e: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
}

/** The slice of net.Socket a client connection needs (subscriber identity + line writes). */
export interface DaemonConnLike {
  readonly destroyed: boolean
  write(data: string): unknown
}

export type SpawnMsg = Extract<ClientMsg, { op: 'spawn' }>

export interface DaemonSessionsDeps {
  /** Start the pty for a `spawn` op. A throw is reported to the client as `spawn-failed`. */
  spawnPty: (msg: SpawnMsg) => DaemonPtyLike
  /** Reap a process tree (taskkill /T /F on win32); resolves once reaped or timed out. */
  killTree: (pid: number) => Promise<void>
  log: (msg: string) => void
  /** A session was registered — the daemon is not idle. */
  onActive: () => void
  /** A session ended (own exit, or a kill finished) — time to re-check idleness. */
  onSessionEnded: () => void
  /** `shutdown` tree-killed everything — close the server and exit. */
  onShutdownComplete: () => void
  /** Per-session replay ring cap, in chars. */
  ringCap: number
}

interface Session {
  proc: DaemonPtyLike
  ring: DaemonRing
  cols: number
  rows: number
  meta: SpawnMsg['meta']
  subscribers: Set<DaemonConnLike>
  lastPidSent: number
  /** R7: the watermark/coalescing state machine for this session's output (flowControl.ts). */
  flow: SessionFlow
}

export interface DaemonSessions {
  /** Handle one authed client op (`hello` is the pipe owner's — it is ignored here). */
  handle(conn: DaemonConnLike, msg: ClientMsg): void
  /** R7: this connection's `hello` declared flow-control support. */
  markFlowCapable(conn: DaemonConnLike): void
  /** A connection closed: unsubscribe it everywhere (its sessions keep running). */
  disconnect(conn: DaemonConnLike): void
  /** Registered sessions (the idle-exit check). */
  size(): number
}

export function createDaemonSessions(deps: DaemonSessionsDeps): DaemonSessions {
  const sessions = new Map<string, Session>()
  /**
   * R7: connections whose `hello` declared flow-control support. A session only accounts (and can
   * only pause) while a capable client is subscribed — an OLD app reattaching to a NEW daemon after
   * an update never acks, and pausing for it would freeze a live agent with no way back.
   */
  const flowCapable = new Set<DaemonConnLike>()

  const send = (conn: DaemonConnLike, msg: DaemonMsg): void => {
    if (!conn.destroyed) conn.write(encodeLine(msg))
  }

  /** Is `s` still the instance registered under `id`? False once it was killed (or shut down),
   *  whether or not a replacement has taken the id since. */
  const owns = (id: string, s: Session): boolean => sessions.get(id) === s

  /** R7: recompute a session's accounting state from its CURRENT subscribers. */
  const syncFlowState = (s: Session): void => {
    s.flow.setEnabled([...s.subscribers].some((sub) => flowCapable.has(sub)))
    s.flow.setSubscribers(s.subscribers.size)
  }

  /** Push a late-arriving real pid (ConPTY reports 0 at spawn) to every subscriber once. */
  const maybePushPid = (id: string, s: Session): void => {
    const pid = s.proc.pid
    if (pid && pid !== s.lastPidSent) {
      s.lastPidSent = pid
      for (const sub of s.subscribers) send(sub, { ev: 'pid', id, pid })
    }
  }

  const listSessions = (): SessionInfo[] =>
    [...sessions.entries()].map(([id, s]) => ({
      id,
      pid: s.proc.pid,
      cols: s.cols,
      rows: s.rows,
      meta: s.meta
    }))

  const spawn = (conn: DaemonConnLike, msg: SpawnMsg): void => {
    if (sessions.has(msg.id)) {
      send(conn, { ev: 'error', id: msg.id, message: `session ${msg.id} already exists` })
      return
    }
    let proc: DaemonPtyLike
    try {
      proc = deps.spawnPty(msg)
    } catch (err) {
      send(conn, {
        ev: 'spawn-failed',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }
    const s: Session = {
      proc,
      ring: createDaemonRing(),
      cols: msg.cols,
      rows: msg.rows,
      meta: msg.meta,
      subscribers: new Set([conn]),
      lastPidSent: 0,
      // R7: one coalesced `ev:output` per tick, and the pause/resume watermarks on top of it.
      // pause/resume are guarded — a node-pty build without them must degrade to today's
      // unthrottled behavior, never take the daemon down.
      flow: createSessionFlow({
        send: (data) => {
          for (const sub of s.subscribers) send(sub, { ev: 'output', id: msg.id, data })
        },
        pause: () => {
          try {
            proc.pause()
          } catch {
            /* pty already gone / pause unsupported — degrade to unthrottled */
          }
        },
        resume: () => {
          try {
            proc.resume()
          } catch {
            /* see pause */
          }
        }
      })
    }
    sessions.set(msg.id, s)
    syncFlowState(s)
    deps.onActive()
    proc.onData((d) => {
      // A killed pty drains for up to ~1 s. Those bytes belong to no one: sent as `output` for
      // the id they would paint into the replacement's terminal (and charge its ack debt).
      if (!owns(msg.id, s)) return
      pushDaemonRing(s.ring, d, deps.ringCap)
      maybePushPid(msg.id, s)
      s.flow.push(d)
    })
    proc.onExit(({ exitCode }) => {
      // Already unregistered by kill/shutdown (flushed + disposed there): this is the dead
      // instance's exit arriving late. Reporting it, or deleting by id, would hit the replacement.
      if (!owns(msg.id, s)) {
        deps.log(`session ${msg.id}: killed instance's pty closed (code=${exitCode})`)
        return
      }
      deps.log(`session ${msg.id} exited code=${exitCode}`)
      // The last output must reach subscribers BEFORE the exit that explains it — a coalesced
      // chunk still sitting in this tick's buffer would otherwise arrive after the exit, or be
      // dropped with the session (mirrors MAIN's drainBatch discipline in ptyDataBatch.ts).
      s.flow.flush()
      s.flow.dispose()
      for (const sub of s.subscribers) send(sub, { ev: 'exit', id: msg.id, code: exitCode })
      sessions.delete(msg.id)
      deps.onSessionEnded()
    })
    deps.log(`spawned ${msg.id}: ${msg.shell} ${msg.cols}x${msg.rows}`)
    send(conn, { ev: 'spawned', id: msg.id, pid: proc.pid })
  }

  const handle = (conn: DaemonConnLike, msg: ClientMsg): void => {
    switch (msg.op) {
      case 'hello':
        break // answered by the pipe owner (it knows the protocol version + daemon pid)
      case 'spawn':
        spawn(conn, msg)
        break
      case 'attach': {
        const s = sessions.get(msg.id)
        if (!s) {
          send(conn, { ev: 'error', id: msg.id, message: `no session ${msg.id}` })
          return
        }
        // R7: flush BEFORE the replay is built, or this tick's buffered chunk — already in the
        // ring, so already inside the replay — would be re-sent to the new subscriber as fresh
        // output and land twice on its terminal.
        s.flow.flush()
        s.subscribers.add(conn)
        syncFlowState(s)
        deps.log(`attach ${msg.id} (ring ${s.ring.len})`)
        send(conn, {
          ev: 'replay',
          id: msg.id,
          data: daemonRingReplay(s.ring, deps.ringCap),
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
      case 'ack': {
        // R7: the consumer processed `chars` characters — retire that much debt, and un-pause the
        // pty once the backlog is back under the low watermark.
        sessions.get(msg.id)?.flow.ack(msg.chars)
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
          send(conn, { ev: 'killed', id: msg.id })
          return
        }
        const pid = s.proc.pid
        s.flow.flush() // last words before the tree dies (see the onExit note)
        s.flow.dispose()
        sessions.delete(msg.id)
        void deps.killTree(pid).then(() => {
          try {
            s.proc.kill() // dispose ConPTY handle + conout worker (pty.ts killTree pattern)
          } catch {
            /* already disposed */
          }
          send(conn, { ev: 'killed', id: msg.id })
          deps.onSessionEnded()
        })
        break
      }
      case 'list':
        send(conn, { ev: 'sessions', list: listSessions() })
        break
      case 'shutdown': {
        deps.log('shutdown requested — killing all sessions')
        const kills = [...sessions.entries()].map(([id, s]) => {
          s.flow.flush()
          s.flow.dispose()
          sessions.delete(id)
          return deps.killTree(s.proc.pid).then(() => {
            try {
              s.proc.kill()
            } catch {
              /* already disposed */
            }
          })
        })
        void Promise.all(kills).then(() => deps.onShutdownComplete())
        break
      }
    }
  }

  return {
    handle,
    markFlowCapable: (conn) => {
      flowCapable.add(conn)
    },
    disconnect: (conn) => {
      flowCapable.delete(conn)
      for (const s of sessions.values()) {
        // R7: a session that just lost its LAST subscriber has its debt cleared and is resumed by
        // syncFlowState. Sessions outlive the app on purpose, and an unattached one receives no
        // acks — left accounting, it would pause at the high watermark and stay frozen until the
        // app returned.
        if (s.subscribers.delete(conn)) syncFlowState(s)
      }
    },
    size: () => sessions.size
  }
}
