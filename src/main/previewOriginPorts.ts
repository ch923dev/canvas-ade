/**
 * D10 — the loopback origin-port observer (spatial-awareness C9 producer, lane L11).
 *
 * Answers "which local servers does this Browser board's page talk to?" so the role model can link
 * a preview to the terminal SERVING a port it calls (the S3 "api :3000" link, ROLE-LAYOUT §2:
 * preview→server = `callsPorts ∩ ports`). One observer per Browser board, on its OSR session
 * (partition `preview-osr-${id}`, `previewOsr.ensureOsr`).
 *
 * 🔒 Privacy / safety posture (SPEC D10, decided 2026-10-16 — always on):
 *  - OBSERVE-ONLY: `session.webRequest.onCompleted` never blocks, delays or rewrites a request. No
 *    `onBeforeRequest` / `onBeforeSendHeaders` / `onHeadersReceived` — nothing blocking.
 *  - LOOPBACK-ONLY: the listener's `urls` filter names only `localhost` / `127.0.0.1` / `[::1]`, so
 *    Chromium never hands it a non-loopback request. The host is re-checked here anyway.
 *  - PORT-ONLY: each URL is parsed for its port (explicit, else 80/443 by scheme) and dropped on
 *    the spot. No URL, host, path, query, header or body is stored, logged or emitted.
 *  - EPHEMERAL: ≤ {@link MAX_ORIGIN_PORTS} ports per board (most recent wins), in memory only,
 *    disposed with the preview (`previewOsr.disposeOsr`). Independent of the Data-Flow capture
 *    opt-in, which rides CDP `Network.*` in `previewOsrNetwork.ts`, not `webRequest`.
 *  - CHANGE-ONLY emission: the renderer hears `{ boardId, ports }` only when the port SET changes,
 *    coalesced over {@link ORIGIN_PORTS_EMIT_MS} so a page load's request burst is one message.
 *
 * ⚠️ OWNERSHIP: Electron keeps ONE listener per `webRequest` event per session — registering a
 * second `onCompleted` silently replaces the first. This module OWNS `webRequest.onCompleted` on
 * preview sessions; any future consumer must multiplex through it, never register its own.
 *
 * No Electron import: the session is a structural slice, so the module unit-tests with a fake.
 */
import { MAX_CONTEXT_PORTS } from '../shared/spatialTypes'

/**
 * Chromium match patterns for loopback requests, every scheme `*` covers and any port. A pattern
 * without a port already matches every port (verified on Electron 42.3.3, together with the
 * `[::1]` literal and non-loopback exclusion: `127.0.0.2` never reached the listener); the
 * explicit `:*` forms keep the intent readable. Nothing outside these hosts may ever be listed.
 */
export const LOOPBACK_URL_PATTERNS: readonly string[] = Object.freeze([
  '*://localhost/*',
  '*://localhost:*/*',
  '*://127.0.0.1/*',
  '*://127.0.0.1:*/*',
  '*://[::1]/*',
  '*://[::1]:*/*'
])

/** At most this many ports per board — the C1 mirror bound (`MAX_CONTEXT_PORTS`). */
export const MAX_ORIGIN_PORTS = MAX_CONTEXT_PORTS
/** Trailing coalesce window for an emission (ms). */
export const ORIGIN_PORTS_EMIT_MS = 500

/** Host names (WHATWG-normalized `URL.hostname`) that count as loopback. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Default port per scheme when the URL names none. */
const DEFAULT_PORT: ReadonlyMap<string, number> = new Map([
  ['http:', 80],
  ['ws:', 80],
  ['https:', 443],
  ['wss:', 443]
])

/**
 * The port of a loopback request URL — explicit, else the scheme default — or null for anything
 * else (non-loopback host, unparseable URL, unknown scheme). Reads the URL once and keeps nothing.
 */
export function loopbackPort(url: string): number | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null
  if (parsed.port === '') return DEFAULT_PORT.get(parsed.protocol) ?? null
  const port = Number(parsed.port)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/** The `webRequest` slice the observer uses — a real Electron `Session` satisfies it. */
export interface OriginPortsSession {
  webRequest: {
    onCompleted(
      filter: { urls: string[] },
      listener: ((details: { url: string }) => void) | null
    ): void
    onCompleted(listener: null): void
  }
}

/** One board's observer handle (held on the preview's `OsrEntry`). */
export interface OriginPortsObserver {
  /** The current port set, ascending — for a re-emit when a backgrounded board remounts. */
  ports(): number[]
  /** Remove the listener (only if this observer still owns it), cancel a pending emit, drop state. */
  dispose(): void
}

/** Session → the observer that currently owns its `onCompleted` (the stale-dispose guard). */
const owners = new WeakMap<object, OriginPortsObserver>()

const ascending = (ports: readonly number[]): number[] => [...ports].sort((a, b) => a - b)
const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((p, i) => b[i] === p)

/**
 * Start observing `session`'s completed loopback requests. `emit` receives the ascending port set
 * whenever it differs from the last one emitted (after the coalesce window). If Electron rejects
 * the filter, the observer is inert — a preview never fails to open over this signal; the role
 * model then falls back to Named Group > same cwd > sibling folder (D10).
 */
export function observeOriginPorts(
  session: OriginPortsSession,
  emit: (ports: number[]) => void,
  opts: { emitDelayMs?: number } = {}
): OriginPortsObserver {
  const delay = opts.emitDelayMs ?? ORIGIN_PORTS_EMIT_MS
  let recent: number[] = [] // most recent first, ≤ MAX_ORIGIN_PORTS
  let lastEmitted: number[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    timer = null
    if (disposed) return
    const next = ascending(recent)
    if (sameSet(next, lastEmitted)) return
    lastEmitted = next
    emit([...next])
  }

  const onCompleted = (details: { url: string }): void => {
    if (disposed) return
    const port = loopbackPort(details.url) // the URL is never kept past this line
    if (port === null) return
    const at = recent.indexOf(port)
    if (at >= 0) {
      // Already in the set: refresh its recency (eviction order) — membership is unchanged.
      recent.splice(at, 1)
      recent.unshift(port)
      return
    }
    recent.unshift(port)
    if (recent.length > MAX_ORIGIN_PORTS) recent.length = MAX_ORIGIN_PORTS
    if (timer === null) {
      timer = setTimeout(flush, delay)
      timer.unref?.() // never keep MAIN alive for a pending emit
    }
  }

  const observer: OriginPortsObserver = {
    ports: () => (disposed ? [] : ascending(recent)),
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      recent = []
      lastEmitted = []
      if (owners.get(session) !== observer) return // a newer observer owns the listener now
      owners.delete(session)
      try {
        session.webRequest.onCompleted(null)
      } catch {
        /* session already torn down */
      }
    }
  }

  try {
    // OWNS onCompleted on this preview session (see the header) — never register a second one.
    session.webRequest.onCompleted({ urls: [...LOOPBACK_URL_PATTERNS] }, onCompleted)
  } catch {
    disposed = true // filter rejected / session gone: an inert observer, the preview still opens
    return observer
  }
  owners.set(session, observer)
  return observer
}
