/**
 * id-lineage value-read (JD-4, ADR 0010 amendment) — MAIN-side, capped, value-stripped.
 *
 * The ONLY pass in the Data Flow subsystem that reads response/request *values*: an id VALUE returned
 * by response A reappearing in request B ⇒ a directed edge A ⊳ B. The value read happens entirely in
 * MAIN, behind the per-board opt-in + the `isForeignSender` guard (like `preview:osrNetSampleSchema`),
 * and is **bounded** (≤LINEAGE_SAMPLE_CAP producer bodies, ≤LINEAGE_VALUE_CAP distinct id values,
 * ≤LINEAGE_BYTES_CAP/pass). Only the **edge list** crosses IPC — `{ idName, from/toRequestId, location }`
 * — never the matched value. Every candidate value is `redactSecrets`-scrubbed first; a value that
 * scrubs to a secret/token is EXCLUDED (we never correlate on a bearer token). Split out of
 * `previewOsrNetwork.ts` (file-size doctrine), mirroring `previewOsrShape.ts`.
 *
 * Wire types are mirrored in preload + `lib/lineage.ts` (process boundary — no shared import).
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { redactSecrets } from './summaryLoop'
import { isForeignSender } from './ipcGuard'
import { sampleResponseShapes } from './previewOsrShape'

/** A request-keyed lineage edge (value-less). `idName` is the field/segment NAME the id rode under. */
export interface RequestLineageEdgeWire {
  idName: string
  fromRequestId: string
  toRequestId: string
  location: 'path' | 'query' | 'body'
  confidence: 'body-match'
}
export interface OsrNetLineageResult {
  edges: RequestLineageEdgeWire[]
  producersScanned: number // response bodies actually read
  consumersScanned: number // requests whose surface was searched
  valuesTracked: number // distinct id values held in the pass (≤ LINEAGE_VALUE_CAP)
}

export const LINEAGE_SAMPLE_CAP = 20 // producer response bodies read per pass
export const LINEAGE_VALUE_CAP = 200 // distinct id VALUES tracked per pass
export const LINEAGE_BYTES_CAP = 8 * 1024 * 1024 // total decoded body bytes read per pass
const LINEAGE_POSTDATA_CAP = 64 * 1024 // request post-data bytes scanned per consumer
const ID_MIN_LEN = 6 // ignore short tokens (page=2, status codes) — ids are long
const ID_MAX_LEN = 128 // ignore very long blobs (not a propagated id)
const SHAPE_MAX_DEPTH = 64 // page-controlled nesting clamp

const L_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const L_KEY_RE = /(^_?(id|uuid|guid)$)|(Id$)|(_id$)/i // key reads like an identifier
const L_NUM_RE = /^\d{8,}$/ // a long numeric id (8+ digits)
const L_OPAQUE_RE = /^(?=.*[0-9])(?=.*[a-zA-Z])[A-Za-z0-9_-]{16,}$/ // mixed alnum token (nanoid/jwt chunk)

/** Whether a STRING value reads like an id worth tracking (uuid / long-numeric / opaque token). */
function isIdValue(v: string): boolean {
  if (v.length < ID_MIN_LEN || v.length > ID_MAX_LEN) return false
  return L_UUID_RE.test(v) || L_NUM_RE.test(v) || L_OPAQUE_RE.test(v)
}

/**
 * Extract id-shaped string values from a parsed response body — a value is tracked when its KEY reads
 * like an identifier OR the value itself is id-shaped. Each value is scrubbed first; a value that
 * `redactSecrets` rewrites (a secret/token) is dropped. Pure + exported for unit tests. The returned
 * `value`s never leave MAIN (only the `name`s ride out, attached to edges).
 */
export function extractIdValues(body: string): { name: string; value: string }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const out: { name: string; value: string }[] = []
  const seen = new Set<string>()
  const walk = (v: unknown, key: string, depth: number): void => {
    if (depth > SHAPE_MAX_DEPTH || out.length >= LINEAGE_VALUE_CAP) return
    if (typeof v === 'string') {
      const keyLike = L_KEY_RE.test(key)
      if ((keyLike || isIdValue(v)) && v.length >= ID_MIN_LEN && v.length <= ID_MAX_LEN) {
        if (redactSecrets(v) !== v) return // a secret/token — never correlate on it
        if (!seen.has(v)) {
          seen.add(v)
          out.push({ name: key || 'id', value: v })
        }
      }
      return
    }
    if (typeof v === 'number') {
      // a long integer id under an id-like key (uuid keys are strings; numeric ids are common)
      if (L_KEY_RE.test(key) && Number.isInteger(v)) {
        const s = String(v)
        if (s.length >= ID_MIN_LEN && !seen.has(s)) {
          seen.add(s)
          out.push({ name: key, value: s })
        }
      }
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, key, depth + 1)
      return
    }
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        walk((v as Record<string, unknown>)[k], k, depth + 1)
      }
    }
  }
  walk(parsed, '', 0)
  return out
}

/** A consumer request's searchable tokens, each tagged by where it came from (path / query / body). */
export function consumerTokens(
  url: string,
  postData?: string
): { token: string; location: 'path' | 'query' | 'body' }[] {
  const out: { token: string; location: 'path' | 'query' | 'body' }[] = []
  try {
    const u = new URL(url)
    for (const seg of u.pathname.split('/')) if (seg) out.push({ token: seg, location: 'path' })
    for (const [, val] of u.searchParams) if (val) out.push({ token: val, location: 'query' })
  } catch {
    /* relative/unparseable URL — no URL tokens */
  }
  if (postData) {
    // Split request post-data into candidate id tokens (JSON values, form fields, path-ish chunks).
    for (const tok of postData.slice(0, LINEAGE_POSTDATA_CAP).split(/[^A-Za-z0-9_-]+/)) {
      if (tok) out.push({ token: tok, location: 'body' })
    }
  }
  return out
}

/** The minimal record fields the lineage pass reads (the live MAIN `NetRecord` satisfies it). */
export interface LineageRec {
  requestId: string
  url: string
  method: string
  type: string
  startTs: number
  sessionId?: string
}

/**
 * The capped MAIN body-side lineage pass. Reads ≤LINEAGE_SAMPLE_CAP producer response bodies, extracts
 * id values (≤LINEAGE_VALUE_CAP distinct, scrubbed), then searches every request's URL (+ a capped
 * post-data slice for body-carrying methods) for those values, emitting an edge producer→consumer when
 * a value reappears in a LATER, different request. Returns only the value-less edge list.
 */
export async function sampleLineage(
  records: readonly LineageRec[],
  sendCommand: (method: string, params: object, sessionId?: string) => Promise<unknown>,
  capBody: (
    body: unknown,
    base64: boolean
  ) => { body: string; base64: boolean; truncated: boolean },
  requestIds?: string[]
): Promise<OsrNetLineageResult> {
  const byId = new Map(records.map((r) => [r.requestId, r]))
  const producerIds = (
    Array.isArray(requestIds)
      ? requestIds.map(String).filter((id) => byId.has(id))
      : records.map((r) => r.requestId)
  ).slice(0, LINEAGE_SAMPLE_CAP)

  // value → earliest producer (requestId + the field name it rode under + its startTs)
  const valueSource = new Map<string, { requestId: string; name: string; ts: number }>()
  let bytes = 0
  let producersScanned = 0
  for (const rid of producerIds) {
    if (bytes >= LINEAGE_BYTES_CAP || valueSource.size >= LINEAGE_VALUE_CAP) break
    const rec = byId.get(rid)
    if (!rec || rec.type === 'websocket') continue
    try {
      const res = (await sendCommand(
        'Network.getResponseBody',
        { requestId: rec.requestId },
        rec.sessionId
      )) as Record<string, unknown>
      const capped = capBody(res.body, res.base64Encoded === true)
      if (capped.base64) continue // binary — not a JSON id surface
      bytes += capped.body.length
      producersScanned++
      for (const { name, value } of extractIdValues(capped.body)) {
        if (valueSource.size >= LINEAGE_VALUE_CAP) break
        const prev = valueSource.get(value)
        if (!prev || rec.startTs < prev.ts) {
          valueSource.set(value, { requestId: rec.requestId, name, ts: rec.startTs })
        }
      }
    } catch {
      /* body evicted / target gone — skip */
    }
  }

  if (valueSource.size === 0) {
    return { edges: [], producersScanned, consumersScanned: 0, valuesTracked: 0 }
  }

  const edges: RequestLineageEdgeWire[] = []
  const seenEdge = new Set<string>()
  const hasBody = (m: string): boolean => m === 'POST' || m === 'PUT' || m === 'PATCH'
  let consumersScanned = 0
  let postFetches = 0
  for (const rec of records) {
    let postData: string | undefined
    // A capped, bounded number of request-post-data fetches (body-carrying methods only).
    if (hasBody(rec.method) && postFetches < LINEAGE_SAMPLE_CAP) {
      postFetches++
      try {
        const res = (await sendCommand(
          'Network.getRequestPostData',
          { requestId: rec.requestId },
          rec.sessionId
        )) as Record<string, unknown>
        if (typeof res.postData === 'string') postData = res.postData
      } catch {
        /* no post-data / evicted — URL-only for this consumer */
      }
    }
    const tokens = consumerTokens(rec.url, postData)
    if (tokens.length === 0) continue
    consumersScanned++
    for (const { token, location } of tokens) {
      const src = valueSource.get(token)
      if (!src) continue
      if (src.requestId === rec.requestId || rec.startTs <= src.ts) continue // self / not later
      const sig = `${src.requestId} ${rec.requestId} ${src.name} ${location}`
      if (seenEdge.has(sig)) continue
      seenEdge.add(sig)
      edges.push({
        idName: src.name,
        fromRequestId: src.requestId,
        toRequestId: rec.requestId,
        location,
        confidence: 'body-match'
      })
    }
  }

  return { edges, producersScanned, consumersScanned, valuesTracked: valueSource.size }
}

/* ── inference IPC (the two ADR-0010 body-reading channels) ──────────────────────────────────────── */

/** The per-board state the inference IPC reads. `OsrNetEntry` satisfies it structurally — the
 *  `ReadonlyMap`/`readonly` shapes let a `Map<string, NetRecord>` be passed with no cross-module type
 *  import (so no value/type import cycle with `previewOsrNetwork`). */
interface InferenceEntry {
  net: { byId: ReadonlyMap<string, LineageRec>; records: readonly LineageRec[] }
  osrWin: {
    webContents: {
      debugger: {
        sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown>
      }
    }
  }
}
type CapBodyFn = (
  body: unknown,
  base64: boolean
) => { body: string; base64: boolean; truncated: boolean }

/**
 * Register the two ADR-0010 body-reading inference channels — schema sampling (value-less skeletons)
 * and id-lineage (value-less edge list). Both are opt-in-gated in the renderer, `isForeignSender`
 * frame-guarded here, and re-validate the board + requestIds against live MAIN state. Extracted out of
 * `previewOsrNetwork.ts` (the file-size doctrine) so that file stays under its max-lines ratchet.
 */
export function registerOsrNetInferenceIpc(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  getEntry: (id: string) => InferenceEntry | undefined,
  capBody: CapBodyFn
): void {
  ipcMain.handle(
    'preview:osrNetSampleSchema',
    async (ev, args: { id: string; requestIds?: string[] }) => {
      if (isForeignSender(ev, getWin)) return { error: 'forbidden' }
      const e = getEntry(String(args?.id))
      if (!e) return { error: 'no board' }
      return sampleResponseShapes(
        (rid) => e.net.byId.get(rid),
        (method, params, sessionId) =>
          e.osrWin.webContents.debugger.sendCommand(method, params, sessionId),
        capBody,
        Array.isArray(args?.requestIds) ? args.requestIds : []
      )
    }
  )
  ipcMain.handle(
    'preview:osrNetLineage',
    async (ev, args: { id: string; requestIds?: string[] }) => {
      if (isForeignSender(ev, getWin)) return { error: 'forbidden' }
      const e = getEntry(String(args?.id))
      if (!e) return { error: 'no board' }
      return sampleLineage(
        e.net.records,
        (method, params, sessionId) =>
          e.osrWin.webContents.debugger.sendCommand(method, params, sessionId),
        capBody,
        Array.isArray(args?.requestIds) ? args.requestIds : undefined
      )
    }
  )
}
