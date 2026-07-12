/**
 * PTY-host daemon wire protocol (PR 1, DESIGN.md D3): newline-delimited JSON over a
 * Windows named pipe. One JSON object per line; PTY output travels as JSON-escaped
 * strings (binary framing filed as a perf follow-up). Shared by the daemon process
 * (daemonMain.ts) and the MAIN-side client (client.ts) so the two can never drift.
 *
 * Security posture (PLAN §10): the pipe name carries a per-profile hash + random
 * suffix, and EVERY connection must open with a `hello` carrying the 32-byte token
 * minted by MAIN at daemon spawn — an un-helloed socket gets one error line and is
 * destroyed. Trusted-user-only surface; never a TCP port.
 */

/** Bump when a message shape changes. MAIN drains-and-respawns on mismatch (D-handshake). */
export const PROTOCOL_VERSION = 1

/** Opaque per-session metadata MAIN round-trips through the daemon (survives app restarts). */
export interface SessionMeta {
  /** Owning project dir at spawn (SessionLike.projectDir contract — adopt scoping). */
  projectDir: string | null
  /** Resolved spawn cwd (boardCwds / gitDiff contract). */
  cwd: string
  /** Shell binary the session was spawned with (board identity pill on reattach). */
  shell: string
  /** monitorActivity opt-out captured at spawn (lifecycle notifications). */
  monitored: boolean
}

/** client → daemon */
export type ClientMsg =
  | { op: 'hello'; token: string; version: number }
  | {
      op: 'spawn'
      id: string
      shell: string
      args: string[]
      cwd: string
      cols: number
      rows: number
      env: Record<string, string>
      meta: SessionMeta
    }
  | { op: 'attach'; id: string }
  | { op: 'input'; id: string; data: string }
  | { op: 'resize'; id: string; cols: number; rows: number }
  | { op: 'kill'; id: string }
  | { op: 'list' }
  | { op: 'shutdown' }

/** daemon → client */
export type DaemonMsg =
  | { ev: 'hello'; version: number; pid: number }
  | { ev: 'spawned'; id: string; pid: number }
  | { ev: 'spawn-failed'; id: string; error: string }
  | {
      ev: 'replay'
      id: string
      data: string
      cols: number
      rows: number
      pid: number
      meta: SessionMeta
    }
  | { ev: 'output'; id: string; data: string }
  | { ev: 'exit'; id: string; code: number }
  | { ev: 'killed'; id: string }
  | { ev: 'pid'; id: string; pid: number }
  | { ev: 'sessions'; list: SessionInfo[] }
  | { ev: 'error'; id?: string; message: string }

export interface SessionInfo {
  id: string
  pid: number
  cols: number
  rows: number
  meta: SessionMeta
}

/** Encode one message as an NDJSON line (the trailing \n IS the frame delimiter). */
export function encodeLine(msg: ClientMsg | DaemonMsg): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Incremental NDJSON line decoder. Feed raw socket chunks; emits each complete,
 * parseable JSON object. A malformed line is surfaced to `onBadLine` (the daemon
 * answers with an error; the client treats it as protocol corruption) instead of
 * throwing through the socket's data handler.
 */
export function createLineDecoder<T>(
  onMsg: (msg: T) => void,
  onBadLine?: (line: string) => void
): (chunk: string) => void {
  let buf = ''
  return (chunk: string): void => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        onMsg(JSON.parse(line) as T)
      } catch {
        onBadLine?.(line)
      }
    }
  }
}

/**
 * The daemon-side handshake gate, pure for unit tests: first line must be a `hello`
 * with the exact token and a compatible protocol version.
 */
export type HelloVerdict = 'ok' | 'bad-token' | 'version-mismatch' | 'not-hello'

export function verifyHello(msg: unknown, expectedToken: string): HelloVerdict {
  if (typeof msg !== 'object' || msg === null) return 'not-hello'
  const m = msg as { op?: unknown; token?: unknown; version?: unknown }
  if (m.op !== 'hello') return 'not-hello'
  if (typeof m.token !== 'string' || m.token !== expectedToken) return 'bad-token'
  if (m.version !== PROTOCOL_VERSION) return 'version-mismatch'
  return 'ok'
}
