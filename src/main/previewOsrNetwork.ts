import type { IpcMain, BrowserWindow, WebContents } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * Per-board DevTools NETWORK + WebSocket capture for the OSR preview engine (MAIN-only).
 *
 * Mirrors `previewOsrWidgets.ts`: it rides the SAME per-board `wc.debugger` attachment (no second
 * client — verified 2026-06-21) and adds its own `'message'` listener. CDP `Network` on the root
 * session captures the main document + ALL frames (incl. cross-origin iframes); `Target.setAutoAttach`
 * flat-mode brings in WORKER targets, whose events arrive on the same client tagged by `sessionId`
 * (the probe's root/child split — see docs/research/2026-06-21-board-devtools-network/SPEC.md §3).
 *
 * Trust boundary: every captured string is page-controlled, so it is CAPPED here in MAIN before it is
 * ever buffered (URL/header/WS payload). Bodies are NOT buffered — they are fetched lazily + capped on
 * user request (S5). Capture is always-on for a live board into a bounded ring buffer; deltas only
 * cross to the renderer while a panel is subscribed (set in S2) — closed inspector ⇒ zero IPC.
 */

/* ── Caps (the trust boundary) + ring sizes ──────────────────────────────────────────────────── */
export const URL_CAP = 2048
export const HEADER_VALUE_CAP = 4096
export const HEADER_COUNT_CAP = 100
export const WS_PAYLOAD_CAP = 16 * 1024
export const BODY_CAP = 5 * 1024 * 1024 // lazy body fetch ceiling (CDP buffer caps do NOT bound one body — fact #4)
export const MAX_RECORDS = 1000 // per board (drop-oldest)
export const MAX_WS_FRAMES = 500 // per socket
export const MAX_SOCKETS = 32 // per board
export const FLUSH_MS = 100 // coalesce deltas while subscribed

/* ── Data model (MAIN ring buffer + the renderer mirror) ─────────────────────────────────────── */
export interface NetHeader {
  name: string
  value: string
}
export interface NetFailed {
  errorText: string
  blockedReason?: string
  canceled?: boolean
}
export interface NetRecord {
  requestId: string
  url: string
  method: string
  type: string // resourceType: document|fetch|xhr|script|stylesheet|websocket|…
  status?: number
  statusText?: string
  mimeType?: string
  fromCache?: boolean
  reqHeaders?: NetHeader[]
  resHeaders?: NetHeader[]
  startTs: number
  endTs?: number
  encodedDataLength?: number
  failed?: NetFailed
  // sub-target provenance (the flat-mode `sessionId`; absent ⇒ main target / root session)
  sessionId?: string
  frameId?: string
  crossOrigin?: boolean // → origin badge in the row (worker targets, for now)
}
export interface WsFrame {
  dir: 'sent' | 'recv'
  opcode: number
  ts: number
  payload: string // capped WS_PAYLOAD_CAP
  truncated: boolean
}
export interface WsRecord {
  requestId: string
  url: string
  createdTs: number
  closedTs?: number
  frames: WsFrame[] // per-socket ring (MAX_WS_FRAMES)
}

/** What MAIN ferries to a subscribed renderer panel (id-dispatched in preload, like `preview:osrFrame`). */
export interface OsrNetMsg {
  kind: 'replay' | 'delta' | 'cleared'
  records?: NetRecord[]
  ws?: WsRecord[]
  dropped?: number
}

/** Per-board MAIN state. Lives on the `OsrEntry` (`e.net`); cheap, bounded, ephemeral. */
export interface OsrNetState {
  records: NetRecord[] // insertion-ordered ring
  byId: Map<string, NetRecord> // requestId → record (response/finish merge + body session)
  ws: Map<string, WsRecord> // requestId → socket
  wsOrder: string[] // socket ring (MAX_SOCKETS)
  dropped: number // ring-eviction counter (shown as "N dropped")
  subscribed: boolean // a renderer panel is listening → emit deltas
  preserve: boolean // keep log across main-frame navigation
  dirtyRecords: Set<string> // requestIds changed since last flush
  dirtyWs: Set<string>
  flushTimer: ReturnType<typeof setTimeout> | null
  childSessions: Set<string> // attached worker sessionIds (flat mode)
}

export function createNetState(): OsrNetState {
  return {
    records: [],
    byId: new Map(),
    ws: new Map(),
    wsOrder: [],
    dropped: 0,
    subscribed: false,
    preserve: false,
    dirtyRecords: new Set(),
    dirtyWs: new Set(),
    flushTimer: null,
    childSessions: new Set()
  }
}

/* ── Pure helpers (unit-tested) ──────────────────────────────────────────────────────────────── */

/** Cap an untrusted page string at the trust boundary. Non-strings collapse to ''. */
export function capText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

/** Normalize + cap a CDP header map (`{name: value}`) to a bounded, escaped-later array. */
export function capHeaders(raw: unknown): NetHeader[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: NetHeader[] = []
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length >= HEADER_COUNT_CAP) break
    out.push({ name: capText(name, 256), value: capText(String(value ?? ''), HEADER_VALUE_CAP) })
  }
  return out
}

/** A best-effort epoch-ms timestamp from a CDP event (`wallTime` is epoch seconds; else now). */
export function eventTs(params: Record<string, unknown>, now: number): number {
  const wall = params.wallTime
  return typeof wall === 'number' && wall > 0 ? Math.round(wall * 1000) : now
}

/** Build a fresh NetRecord from `Network.requestWillBeSent` (+ the flat-mode sessionId). */
export function recordFromRequest(
  params: Record<string, unknown>,
  sessionId: string | undefined,
  now: number
): NetRecord {
  const req = (params.request ?? {}) as Record<string, unknown>
  return {
    requestId: capText(params.requestId, 256),
    url: capText(req.url, URL_CAP),
    method: capText(req.method, 16) || 'GET',
    type: capText(params.type, 32) || 'other',
    reqHeaders: capHeaders(req.headers),
    startTs: eventTs(params, now),
    frameId: typeof params.frameId === 'string' ? params.frameId : undefined,
    sessionId: sessionId || undefined,
    crossOrigin: sessionId ? true : undefined // worker target; iframe cross-origin tagging is S6 (needs main-frame id)
  }
}

/**
 * A redirect on `Network.requestWillBeSent` reuses the requestId — refresh url + method, keep the row.
 * A 303 (and some 301/302) rewrites POST→GET, so the final method must follow or the row would lie.
 */
export function applyRedirect(rec: NetRecord, params: Record<string, unknown>): void {
  const req = (params.request ?? {}) as Record<string, unknown>
  rec.url = capText(req.url, URL_CAP) || rec.url
  rec.method = capText(req.method, 16) || rec.method
}

/** Merge `Network.responseReceived` onto an existing record. */
export function applyResponse(rec: NetRecord, params: Record<string, unknown>): void {
  const res = (params.response ?? {}) as Record<string, unknown>
  if (typeof res.status === 'number') rec.status = res.status
  rec.statusText = capText(res.statusText, 256) || rec.statusText
  rec.mimeType = capText(res.mimeType, 128) || rec.mimeType
  if (typeof res.fromDiskCache === 'boolean' || typeof res.fromServiceWorker === 'boolean') {
    rec.fromCache = res.fromDiskCache === true || res.fromServiceWorker === true
  }
  const h = capHeaders(res.headers)
  if (h) rec.resHeaders = h
}

/** Merge `Network.loadingFinished`. */
export function applyFinished(rec: NetRecord, params: Record<string, unknown>, now: number): void {
  rec.endTs = eventTs(params, now)
  if (typeof params.encodedDataLength === 'number') rec.encodedDataLength = params.encodedDataLength
}

/** Merge `Network.loadingFailed`. */
export function applyFailed(rec: NetRecord, params: Record<string, unknown>, now: number): void {
  rec.endTs = eventTs(params, now)
  rec.failed = {
    errorText: capText(params.errorText, 256) || 'failed',
    blockedReason: typeof params.blockedReason === 'string' ? params.blockedReason : undefined,
    canceled: params.canceled === true
  }
}

/** Build a capped WsFrame from a `Network.webSocketFrame{Sent,Received}` response. */
export function wsFrameFrom(
  params: Record<string, unknown>,
  dir: 'sent' | 'recv',
  now: number
): WsFrame {
  const resp = (params.response ?? {}) as Record<string, unknown>
  const raw = typeof resp.payloadData === 'string' ? resp.payloadData : ''
  return {
    dir,
    opcode: typeof resp.opcode === 'number' ? resp.opcode : 0,
    ts: now,
    payload: raw.slice(0, WS_PAYLOAD_CAP),
    truncated: raw.length > WS_PAYLOAD_CAP
  }
}

/** Push a record into the ring (drop-oldest beyond MAX_RECORDS, evicting its index entries). */
export function ringPushRecord(state: OsrNetState, rec: NetRecord): void {
  state.records.push(rec)
  state.byId.set(rec.requestId, rec)
  while (state.records.length > MAX_RECORDS) {
    const evicted = state.records.shift()
    if (evicted) {
      state.byId.delete(evicted.requestId)
      state.dirtyRecords.delete(evicted.requestId)
      state.dropped++
    }
  }
}

/** Get-or-create the per-socket WsRecord (socket ring capped at MAX_SOCKETS). */
export function ensureWs(
  state: OsrNetState,
  requestId: string,
  url: string,
  now: number
): WsRecord {
  let rec = state.ws.get(requestId)
  if (rec) return rec
  rec = { requestId, url: capText(url, URL_CAP), createdTs: now, frames: [] }
  state.ws.set(requestId, rec)
  state.wsOrder.push(requestId)
  while (state.wsOrder.length > MAX_SOCKETS) {
    const old = state.wsOrder.shift()
    if (old) {
      state.ws.delete(old)
      state.dirtyWs.delete(old)
    }
  }
  return rec
}

/** Append a frame to a socket's per-frame ring (drop-oldest beyond MAX_WS_FRAMES). */
export function pushWsFrame(rec: WsRecord, frame: WsFrame): void {
  rec.frames.push(frame)
  if (rec.frames.length > MAX_WS_FRAMES) rec.frames.shift()
}

/** Reset all captured data (clear button / clear-on-nav). Keeps subscription + preserve flags. */
export function clearNet(state: OsrNetState): void {
  state.records = []
  state.byId.clear()
  state.ws.clear()
  state.wsOrder = []
  state.dropped = 0
  state.dirtyRecords.clear()
  state.dirtyWs.clear()
}

/** A full snapshot for the subscribe-replay (S2). */
export function snapshotNet(state: OsrNetState): OsrNetMsg {
  return {
    kind: 'replay',
    records: [...state.records],
    ws: [...state.ws.values()],
    dropped: state.dropped
  }
}

/* ── CDP wiring (fire-and-forget; never await an enable — cold-start latency, fact #6) ──────────── */

function netCdp(
  wc: WebContents,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string
): void {
  try {
    void Promise.resolve(wc.debugger.sendCommand(method, params ?? {}, sessionId)).catch(() => {
      /* domain unsupported / target gone */
    })
  } catch {
    /* debugger detached */
  }
}

/**
 * (Re)enable Network capture on the root session + arm flat-mode auto-attach for workers. Idempotent
 * and cheap — called on attach AND on every crash-ready (defensive; the debugger survives a crash so
 * a re-enable is belt-and-suspenders, not required — fact #2).
 */
export function armOsrNetwork(wc: WebContents): void {
  if (!wc.debugger.isAttached()) return
  // Generous CDP-side buffer caps; our own BODY_CAP on the lazy fetch is the real bound (fact #4).
  netCdp(wc, 'Network.enable', {
    maxTotalBufferSize: 10_000_000,
    maxResourceBufferSize: 5_000_000,
    maxPostDataSize: 65_536
  })
  // Flat mode: worker/service-worker targets surface as Target.attachedToTarget on THIS client,
  // sessionId-routed (no nested sockets). Iframes already ride the root session (probe 2026-06-21).
  netCdp(wc, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  })
}

export interface OsrNetworkDeps {
  state: OsrNetState
  /** Ferry a coalesced batch to the renderer (ensureOsr injects the board id + channel). */
  emit: (msg: OsrNetMsg) => void
}

/**
 * Attach NETWORK capture to a board's offscreen webContents. Adds ONE `'message'` listener on the
 * already-attached debugger (an EventEmitter — composes with the widget listener) and arms capture.
 * Call once from ensureOsr after `attachOsrWidgets`.
 */
export function attachOsrNetwork(wc: WebContents, deps: OsrNetworkDeps): void {
  if (!wc.debugger.isAttached()) return
  const { state, emit } = deps

  wc.debugger.on('message', (_e, method, params: Record<string, unknown>, sessionId?: string) => {
    handleNetMessage(wc, state, emit, method, params ?? {}, sessionId)
  })

  armOsrNetwork(wc)
}

/**
 * One-call per-board wiring for ensureOsr (keeps previewOsr.ts lean): attach capture + clear-on-
 * main-frame-navigation (DevTools parity; honors "Preserve log"). `send` is previewOsr's generic
 * channel emitter; the board `id` is injected here so the payload is renderer-dispatchable.
 */
export function wireOsrNetwork(
  wc: WebContents,
  state: OsrNetState,
  send: (channel: string, payload: object) => void,
  id: string
): void {
  const emit = (msg: OsrNetMsg): void => send('preview:osrNet', { id, ...msg })
  attachOsrNetwork(wc, { state, emit })
  // A same-document nav (fragment / pushState, isInPlace) keeps the log; only emit when subscribed
  // (preserve the zero-IPC-when-closed invariant).
  wc.on('did-start-navigation', (_ev, _navUrl, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace || state.preserve) return
    clearNet(state)
    if (state.subscribed) emit({ kind: 'cleared' })
  })
}

/** Route one CDP message into the ring buffer + schedule a coalesced delta. */
function handleNetMessage(
  wc: WebContents,
  state: OsrNetState,
  emit: (msg: OsrNetMsg) => void,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined
): void {
  const now = Date.now()
  const reqId = typeof params.requestId === 'string' ? params.requestId : ''
  switch (method) {
    case 'Network.requestWillBeSent': {
      const existing = state.byId.get(reqId)
      if (existing) {
        applyRedirect(existing, params) // a redirect chain reuses the requestId
      } else {
        ringPushRecord(state, recordFromRequest(params, sessionId, now))
      }
      markRecord(state, emit, reqId)
      break
    }
    case 'Network.responseReceived': {
      const rec = state.byId.get(reqId)
      if (rec) {
        applyResponse(rec, params)
        markRecord(state, emit, reqId)
      }
      break
    }
    case 'Network.loadingFinished': {
      const rec = state.byId.get(reqId)
      if (rec) {
        applyFinished(rec, params, now)
        markRecord(state, emit, reqId)
      }
      break
    }
    case 'Network.loadingFailed': {
      const rec = state.byId.get(reqId)
      if (rec) {
        applyFailed(rec, params, now)
        markRecord(state, emit, reqId)
      }
      break
    }
    case 'Network.webSocketCreated': {
      // Surface the socket both as a request row (type websocket) and a frame log.
      if (!state.byId.get(reqId)) {
        ringPushRecord(state, {
          requestId: reqId,
          url: capText(params.url, URL_CAP),
          method: 'GET',
          type: 'websocket',
          startTs: now,
          sessionId: sessionId || undefined,
          crossOrigin: sessionId ? true : undefined
        })
      }
      ensureWs(state, reqId, capText(params.url, URL_CAP), now)
      markRecord(state, emit, reqId)
      markWs(state, emit, reqId)
      break
    }
    case 'Network.webSocketHandshakeResponseReceived': {
      const rec = state.byId.get(reqId)
      if (rec) {
        const res = (params.response ?? {}) as Record<string, unknown>
        if (typeof res.status === 'number') rec.status = res.status
        markRecord(state, emit, reqId)
      }
      break
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const rec = state.ws.get(reqId)
      if (rec) {
        const dir = method === 'Network.webSocketFrameSent' ? 'sent' : 'recv'
        pushWsFrame(rec, wsFrameFrom(params, dir, now))
        markWs(state, emit, reqId)
      }
      break
    }
    case 'Network.webSocketClosed': {
      const rec = state.ws.get(reqId)
      if (rec) {
        rec.closedTs = now
        markWs(state, emit, reqId)
      }
      break
    }
    case 'Target.attachedToTarget': {
      // A worker target attached (flat mode). Enable Network on its session; tag future events.
      const childSid = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (childSid) {
        state.childSessions.add(childSid)
        netCdp(wc, 'Network.enable', { maxTotalBufferSize: 10_000_000 }, childSid)
      }
      break
    }
    case 'Target.detachedFromTarget': {
      const childSid = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (childSid) state.childSessions.delete(childSid)
      break
    }
    default:
      break
  }
}

/** Mark a record dirty + schedule a coalesced flush (only matters while subscribed). */
function markRecord(state: OsrNetState, emit: (msg: OsrNetMsg) => void, requestId: string): void {
  if (!requestId) return
  state.dirtyRecords.add(requestId)
  scheduleFlush(state, emit)
}
function markWs(state: OsrNetState, emit: (msg: OsrNetMsg) => void, requestId: string): void {
  if (!requestId) return
  state.dirtyWs.add(requestId)
  scheduleFlush(state, emit)
}

function scheduleFlush(state: OsrNetState, emit: (msg: OsrNetMsg) => void): void {
  if (!state.subscribed || state.flushTimer) return
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null
    flushNet(state, emit)
  }, FLUSH_MS)
}

/** Emit the changed records + sockets since the last flush (a coalesced delta). */
export function flushNet(state: OsrNetState, emit: (msg: OsrNetMsg) => void): void {
  if (!state.subscribed) return
  if (state.dirtyRecords.size === 0 && state.dirtyWs.size === 0) return
  const records: NetRecord[] = []
  for (const id of state.dirtyRecords) {
    const r = state.byId.get(id)
    if (r) records.push(r)
  }
  const ws: WsRecord[] = []
  for (const id of state.dirtyWs) {
    const r = state.ws.get(id)
    if (r) ws.push(r)
  }
  state.dirtyRecords.clear()
  state.dirtyWs.clear()
  emit({ kind: 'delta', records, ws, dropped: state.dropped })
}

/** Stop a pending flush (unsubscribe / dispose). */
export function stopNetFlush(state: OsrNetState): void {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer)
    state.flushTimer = null
  }
}

/* ── IPC (renderer ⇄ MAIN) — every handler isForeignSender-guarded; args re-validated in MAIN ──── */

/** A lazily-fetched body, capped at BODY_CAP (the real bound — CDP buffer caps don't limit one body). */
export interface NetBody {
  body: string
  base64: boolean
  truncated: boolean
}
export function capBody(body: unknown, base64: boolean, max = BODY_CAP): NetBody {
  if (typeof body !== 'string') return { body: '', base64, truncated: false }
  if (body.length <= max) return { body, base64, truncated: false }
  return { body: body.slice(0, max), base64, truncated: true }
}

/** Structural OSR entry the network IPC reads (the live `OsrEntry` satisfies it). */
export interface OsrNetEntry {
  osrWin: { webContents: WebContents }
  net: OsrNetState
}
export interface OsrNetBodyArgs {
  id: string
  requestId: string
  kind?: 'response' | 'request'
}

/**
 * Register the 5 renderer→MAIN Network handlers (subscribe · unsubscribe · clear · setPreserve ·
 * getBody). All `isForeignSender` frame-guarded; renderer args re-validated against live MAIN state
 * (an unknown id / requestId is a no-op). `emit` is previewOsr's id-injecting `preview:osrNet` sender.
 */
export function registerOsrNetworkIpc(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  getEntry: (id: string) => OsrNetEntry | undefined,
  emit: (id: string, msg: OsrNetMsg) => void
): void {
  ipcMain.handle('preview:osrNetSubscribe', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = getEntry(id)
    if (!e) return false
    e.net.subscribed = true
    emit(id, snapshotNet(e.net)) // replay the current ring buffer once
    return true
  })
  ipcMain.handle('preview:osrNetUnsubscribe', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = getEntry(id)
    if (!e) return false
    e.net.subscribed = false
    stopNetFlush(e.net) // panel closed → zero further IPC
    return true
  })
  ipcMain.handle('preview:osrNetClear', (ev, id: string) => {
    if (isForeignSender(ev, getWin)) return false
    const e = getEntry(id)
    if (!e) return false
    clearNet(e.net)
    if (e.net.subscribed) emit(id, { kind: 'cleared' })
    return true
  })
  ipcMain.handle('preview:osrNetSetPreserve', (ev, args: { id: string; preserve: boolean }) => {
    if (isForeignSender(ev, getWin)) return false
    const e = getEntry(args.id)
    if (!e) return false
    e.net.preserve = args.preserve === true
    return true
  })
  // Lazy, capped, user-initiated body fetch (the approved exfil surface). The requestId MUST match a
  // live record for this board (re-validation); the fetch rides the record's own sessionId so a
  // worker sub-target body resolves on its child session.
  ipcMain.handle('preview:osrNetGetBody', async (ev, args: OsrNetBodyArgs) => {
    if (isForeignSender(ev, getWin)) return { error: 'forbidden' }
    const e = getEntry(args?.id)
    if (!e) return { error: 'no board' }
    const rec = e.net.byId.get(String(args?.requestId))
    if (!rec) return { error: 'unknown request' }
    const method =
      args.kind === 'request' ? 'Network.getRequestPostData' : 'Network.getResponseBody'
    try {
      const res = (await e.osrWin.webContents.debugger.sendCommand(
        method,
        { requestId: rec.requestId },
        rec.sessionId
      )) as Record<string, unknown>
      const raw = typeof res.postData === 'string' ? res.postData : res.body
      return capBody(raw, res.base64Encoded === true)
    } catch (err) {
      return { error: capText((err as Error)?.message, 200) || 'body unavailable' }
    }
  })
}
