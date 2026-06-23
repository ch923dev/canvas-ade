import type { IpcMain, BrowserWindow, WebContents } from 'electron'
import { isForeignSender } from './ipcGuard'
import { registerOsrNetInferenceIpc } from './previewOsrLineage'

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
/** Where a response came from, for the DevTools Size cell. */
export type NetCacheSource = 'disk' | 'memory' | 'sw' | 'prefetch'
/** CDP ResourceTiming subset: `requestTime` is monotonic seconds; the rest are ms RELATIVE to it
 *  (-1 = not applicable). Drives the Timing tab + Waterfall phase bars. */
export interface NetTiming {
  requestTime: number
  dnsStart: number
  dnsEnd: number
  connectStart: number
  connectEnd: number
  sslStart: number
  sslEnd: number
  sendStart: number
  sendEnd: number
  receiveHeadersEnd: number
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
  decodedLength?: number // resource (decoded) size, summed from Network.dataReceived
  cacheSource?: NetCacheSource // drives the Size cell's "(disk cache)"/"(ServiceWorker)"/… label
  remoteAddress?: string // "ip:port" of the server (DevTools General › Remote Address)
  referrerPolicy?: string // request's referrer policy (DevTools General › Referrer Policy)
  reqHeaders?: NetHeader[]
  resHeaders?: NetHeader[]
  startTs: number
  endTs?: number
  encodedDataLength?: number
  timing?: NetTiming // CDP ResourceTiming (Timing tab + waterfall)
  finishMono?: number // loadingFinished monotonic timestamp (seconds) — the Content Download end
  failed?: NetFailed
  initiator?: string // what triggered the request (DevTools "Initiator" column): a script url or a type word
  initiatorRequestId?: string // JD-4: the CDP initiator's triggering requestId (structured initiator → request→request edges). Body-free metadata.
  loaderId?: string // the navigation/document loader (requestId===loaderId ⇒ the main document)
  preserved?: boolean // carried across a navigation under "Preserve log" (Chrome's request.preserved)
  navBoundary?: boolean // the document request that began a new navigation (the light-blue divider row)
  // sub-target provenance (the flat-mode `sessionId`; absent ⇒ main target / root session)
  sessionId?: string
  frameId?: string
  crossOrigin?: boolean // → origin badge in the row (worker targets, for now)
}
export interface WsFrame {
  dir: 'sent' | 'recv'
  opcode: number
  ts: number
  length: number // frame data length in bytes (pre-cap)
  payload: string // capped WS_PAYLOAD_CAP
  truncated: boolean
}
export interface WsRecord {
  requestId: string
  url: string
  createdTs: number
  closedTs?: number
  reqHeaders?: NetHeader[] // upgrade request headers (Sec-WebSocket-Key, …)
  resHeaders?: NetHeader[] // handshake response headers (Sec-WebSocket-Accept, …)
  frames: WsFrame[] // per-socket ring (MAX_WS_FRAMES)
}

/** What MAIN ferries to a subscribed renderer panel (id-dispatched in preload, like `preview:osrFrame`). */
export interface OsrNetMsg {
  kind: 'replay' | 'delta' | 'cleared'
  records?: NetRecord[]
  ws?: WsRecord[]
  dropped?: number
  /** MAIN's preserve flag, sent on `replay` so the reopened panel's checkbox reflects the real state. */
  preserve?: boolean
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
  pendingNav: boolean // a main-frame nav started; the clear/boundary is deferred to its document request
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
    pendingNav: false,
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
    referrerPolicy:
      typeof req.referrerPolicy === 'string' ? capText(req.referrerPolicy, 48) : undefined,
    startTs: eventTs(params, now),
    initiator: initiatorOf(params.initiator),
    initiatorRequestId: initiatorRequestIdOf(params.initiator),
    loaderId: typeof params.loaderId === 'string' ? params.loaderId : undefined,
    frameId: typeof params.frameId === 'string' ? params.frameId : undefined,
    sessionId: sessionId || undefined,
    crossOrigin: sessionId ? true : undefined // worker target; iframe cross-origin tagging is S6 (needs main-frame id)
  }
}

/** The DevTools "Initiator" display: the initiating script url if known, else the CDP type word
 *  (parser / script / preload / other). Capped + page-controlled. */
export function initiatorOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const i = raw as Record<string, unknown>
  if (typeof i.url === 'string' && i.url) return capText(i.url, URL_CAP)
  return typeof i.type === 'string' ? capText(i.type, 32) : undefined
}

/** JD-4 structured-initiator capture (ADR 0010 amendment, §A): the CDP `Network.Initiator.requestId`
 *  — the triggering request, when the initiator chains off another request. Body-free metadata CDP
 *  already delivers on `requestWillBeSent`; capped like every page-controlled string. Enables true
 *  request→request edges that the flattened display `initiator` string discards (finding B1). */
export function initiatorRequestIdOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const i = raw as Record<string, unknown>
  return typeof i.requestId === 'string' && i.requestId ? capText(i.requestId, 256) : undefined
}

/**
 * A redirect on `Network.requestWillBeSent` reuses the requestId — refresh url + method, keep the row.
 * A 303 (and some 301/302) rewrites POST→GET, so the final method must follow or the row would lie.
 * (Only the fallback path now; the redirect-chain split uses applyRedirectResponse + reKeyRedirectHop.)
 */
export function applyRedirect(rec: NetRecord, params: Record<string, unknown>): void {
  const req = (params.request ?? {}) as Record<string, unknown>
  rec.url = capText(req.url, URL_CAP) || rec.url
  rec.method = capText(req.method, 16) || rec.method
}

/** Finalize a redirect hop from the `redirectResponse` of the NEXT requestWillBeSent (the prior
 *  hop's actual response — status/headers/size/timing — closing the row at `now`). */
export function applyRedirectResponse(
  rec: NetRecord,
  res: Record<string, unknown>,
  now: number
): void {
  if (typeof res.status === 'number') rec.status = res.status
  rec.statusText = capText(res.statusText, 256) || rec.statusText
  const h = capHeaders(res.headers)
  if (h) rec.resHeaders = h
  if (typeof res.encodedDataLength === 'number') rec.encodedDataLength = res.encodedDataLength
  const tm = extractTiming(res.timing)
  if (tm) rec.timing = tm
  rec.endTs = now
}

/** Re-key a finalized redirect hop to a unique synthetic id (`<reqId>#<n>`) so it survives as its
 *  own stacked row while the live requestId is reused for the next hop. Keeps the ring slot in place. */
export function reKeyRedirectHop(state: OsrNetState, rec: NetRecord): void {
  const base = rec.requestId
  let k = 1
  while (state.byId.has(`${base}#${k}`)) k++
  const id = `${base}#${k}`
  state.byId.delete(base)
  state.dirtyRecords.delete(base)
  rec.requestId = id
  state.byId.set(id, rec)
}

/** Pull the CDP ResourceTiming subset off a response (undefined if absent — cached/failed). */
export function extractTiming(raw: unknown): NetTiming | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as Record<string, unknown>
  if (typeof t.requestTime !== 'number') return undefined
  const n = (k: string): number => (typeof t[k] === 'number' ? (t[k] as number) : -1)
  return {
    requestTime: t.requestTime,
    dnsStart: n('dnsStart'),
    dnsEnd: n('dnsEnd'),
    connectStart: n('connectStart'),
    connectEnd: n('connectEnd'),
    sslStart: n('sslStart'),
    sslEnd: n('sslEnd'),
    sendStart: n('sendStart'),
    sendEnd: n('sendEnd'),
    receiveHeadersEnd: n('receiveHeadersEnd')
  }
}

/** Merge `Network.responseReceived` onto an existing record. */
export function applyResponse(rec: NetRecord, params: Record<string, unknown>): void {
  const res = (params.response ?? {}) as Record<string, unknown>
  if (typeof res.status === 'number') rec.status = res.status
  const tm = extractTiming(res.timing)
  if (tm) rec.timing = tm
  rec.statusText = capText(res.statusText, 256) || rec.statusText
  rec.mimeType = capText(res.mimeType, 128) || rec.mimeType
  // Cache / SW source (the Size cell label). Service-worker is its own kind (not "from cache");
  // memory-cache arrives separately on requestServedFromCache. Don't clobber an existing source.
  if (res.fromServiceWorker === true) {
    rec.cacheSource = 'sw'
  } else if (res.fromDiskCache === true) {
    rec.cacheSource = 'disk'
    rec.fromCache = true
  }
  if (typeof res.remoteIPAddress === 'string' && res.remoteIPAddress) {
    const port = typeof res.remotePort === 'number' ? `:${res.remotePort}` : ''
    rec.remoteAddress = capText(res.remoteIPAddress, 64) + port
  }
  const h = capHeaders(res.headers)
  if (h) rec.resHeaders = h
}

/** Accumulate the decoded (resource) size from a `Network.dataReceived` chunk. */
export function applyDataReceived(rec: NetRecord, params: Record<string, unknown>): void {
  if (typeof params.dataLength === 'number' && params.dataLength > 0) {
    rec.decodedLength = (rec.decodedLength ?? 0) + params.dataLength
  }
}

/** Merge `Network.loadingFinished`. */
export function applyFinished(rec: NetRecord, params: Record<string, unknown>, now: number): void {
  rec.endTs = eventTs(params, now)
  if (typeof params.encodedDataLength === 'number') rec.encodedDataLength = params.encodedDataLength
  if (typeof params.timestamp === 'number') rec.finishMono = params.timestamp // monotonic — Content Download end
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

/** The frame's data length in bytes (pre-cap): base64-decoded for binary, UTF-8 byte length for text. */
export function wsFrameByteLength(raw: string, opcode: number): number {
  if (opcode === 2) {
    const clean = raw.replace(/=+$/, '')
    return Math.floor((clean.length * 3) / 4)
  }
  return Buffer.byteLength(raw, 'utf8')
}

/** Build a capped WsFrame from a `Network.webSocketFrame{Sent,Received}` response. */
export function wsFrameFrom(
  params: Record<string, unknown>,
  dir: 'sent' | 'recv',
  now: number
): WsFrame {
  const resp = (params.response ?? {}) as Record<string, unknown>
  const raw = typeof resp.payloadData === 'string' ? resp.payloadData : ''
  const opcode = typeof resp.opcode === 'number' ? resp.opcode : 0
  return {
    dir,
    opcode,
    ts: now,
    length: wsFrameByteLength(raw, opcode),
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
  state.pendingNav = false // a manual Clear cancels any deferred nav boundary (no stale double-fire)
}

/**
 * Resolve a deferred main-frame navigation at its document request. Preserve OFF → wipe the log
 * (the new doc, added next, survives). Preserve ON → keep everything, stamp the survivors
 * `preserved` (in-flight ones render `(unknown)`), and return true so the new doc becomes the
 * light-blue nav-boundary row. Clears `pendingNav`. Returns whether the new doc is a boundary.
 */
export function applyNavBoundary(state: OsrNetState, emit: (msg: OsrNetMsg) => void): boolean {
  state.pendingNav = false
  if (!state.preserve) {
    clearNet(state)
    if (state.subscribed) emit({ kind: 'cleared' })
    return false
  }
  for (const r of state.records) {
    r.preserved = true
    state.dirtyRecords.add(r.requestId)
  }
  scheduleFlush(state, emit)
  return true
}

/** A full snapshot for the subscribe-replay (S2) — includes preserve so the panel can seed its UI. */
export function snapshotNet(state: OsrNetState): OsrNetMsg {
  return {
    kind: 'replay',
    records: [...state.records],
    ws: [...state.ws.values()],
    dropped: state.dropped,
    preserve: state.preserve
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
  // Electron passes a single navigation-details OBJECT ({isMainFrame, isSameDocument, …}) — NOT the
  // old positional args. A real main-frame navigation can swap the renderer PROCESS (e.g. localhost
  // → youtube.com) and drop the Network domain, so we must RE-ARM on every such nav or capture
  // silently stops after the first page; a same-document nav (fragment / pushState) is left alone.
  wc.on('did-start-navigation', (details: NavDetails) => {
    if (!isMainFramePageNav(details)) return
    armOsrNetwork(wc) // re-enable across the (possibly cross-process) navigation
    // Defer the clear/boundary to the new main-document request (loaderId-aware): the new doc + its
    // redirect chain survive, in-flight old requests drop (or are kept + marked under Preserve log),
    // and an activation (no document request) never wipes the log.
    state.pendingNav = true
  })
  // Belt-and-suspenders: re-arm once the new document has committed too (catches the post-load flood
  // of XHR/fetch on SPA-heavy sites where the document request itself raced the re-enable).
  wc.on('did-finish-load', () => armOsrNetwork(wc))
}

/** The Electron `did-start-navigation` details object (the fields we read). */
export interface NavDetails {
  isMainFrame?: boolean
  isSameDocument?: boolean
}
/** A real top-level page navigation (drives re-arm + clear-on-nav). Excludes sub-frames and
 *  same-document (fragment / pushState) navigations. Pure — unit-tested (the S1 signature bug was
 *  reading positional args, so `isMainFrame` was always undefined and clear-on-nav never fired). */
export function isMainFramePageNav(details: NavDetails | undefined): boolean {
  return !!details?.isMainFrame && !details.isSameDocument
}

/** The main-document request of a navigation: a root-session Document whose requestId === loaderId.
 *  This is the deferred-clear / nav-boundary trigger (an activation issues no such request, so the
 *  log is never wiped on a BFCache/prerender activation). */
export function isMainDocumentRequest(
  params: Record<string, unknown>,
  sessionId: string | undefined
): boolean {
  return (
    !sessionId &&
    params.type === 'Document' &&
    typeof params.loaderId === 'string' &&
    params.loaderId === params.requestId
  )
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
      if (existing && params.redirectResponse) {
        // The prior hop got a redirect response — finalize it as its own stacked row, then start a
        // fresh row for the new URL (DevTools shows every hop; the destination's Initiator = Redirect).
        applyRedirectResponse(existing, params.redirectResponse as Record<string, unknown>, now)
        reKeyRedirectHop(state, existing)
        markRecord(state, emit, existing.requestId) // the finalized hop (synthetic id)
        const next = recordFromRequest(params, sessionId, now)
        next.initiator = 'Redirect'
        ringPushRecord(state, next)
        markRecord(state, emit, reqId)
        break
      }
      if (existing) {
        applyRedirect(existing, params) // fallback: same-id re-send without a redirectResponse
        markRecord(state, emit, reqId)
        break
      }
      // A new request. If a main-frame nav is pending and THIS is its document request, resolve the
      // deferred clear/boundary now (so the new doc survives; old in-flight requests drop or persist).
      const isNavDoc = state.pendingNav && isMainDocumentRequest(params, sessionId)
      const markBoundary = isNavDoc ? applyNavBoundary(state, emit) : false
      const rec = recordFromRequest(params, sessionId, now)
      if (markBoundary) rec.navBoundary = true
      ringPushRecord(state, rec)
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
    case 'Network.dataReceived': {
      const rec = state.byId.get(reqId)
      if (rec) {
        applyDataReceived(rec, params)
        markRecord(state, emit, reqId)
      }
      break
    }
    case 'Network.requestServedFromCache': {
      const rec = state.byId.get(reqId)
      if (rec && !rec.cacheSource) {
        rec.cacheSource = 'memory'
        rec.fromCache = true
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
      const res = (params.response ?? {}) as Record<string, unknown>
      const rec = state.byId.get(reqId)
      if (rec) {
        if (typeof res.status === 'number') rec.status = res.status
        rec.statusText = capText(res.statusText, 256) || rec.statusText || 'Switching Protocols'
        markRecord(state, emit, reqId)
      }
      const wsRec = state.ws.get(reqId)
      if (wsRec) {
        const rh = capHeaders(res.headers)
        if (rh) wsRec.resHeaders = rh
        const qh = capHeaders(res.requestHeaders)
        if (qh) wsRec.reqHeaders = qh
        markWs(state, emit, reqId)
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
      // Finalize the request row's Time (the socket's total connection duration).
      const row = state.byId.get(reqId)
      if (row && row.endTs === undefined) {
        row.endTs = now
        markRecord(state, emit, reqId)
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
    const e = getEntry(args?.id) // defensive: a buggy renderer could pass null/undefined
    if (!e) return false
    e.net.preserve = args?.preserve === true
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
  // The two ADR-0010 body-reading inference channels (schema sampling + id-lineage) — opt-in-gated,
  // frame-guarded, re-validated against the live ring. Extracted to previewOsrLineage (file-size
  // doctrine); both still register here so the panel/board reach them on the same OsrNetEntry.
  registerOsrNetInferenceIpc(ipcMain, getWin, getEntry, capBody)
}
