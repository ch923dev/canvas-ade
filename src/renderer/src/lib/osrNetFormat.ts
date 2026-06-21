/**
 * Pure formatters + the row filter for the DevTools Network panel. Kept out of the component so the
 * table math is unit-tested (file-size doctrine: pure logic → lib/*.ts). All inputs are
 * already-capped record fields from the renderer mirror.
 */
import type { NetRecord } from '../../../preload'

/** Human byte size: "35 B" · "88 kB" · "4.0 MB" (DevTools-style, base-1000). */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** Request duration: "6 ms" · "1.2 s". Needs both timestamps; otherwise "—". */
export function formatDuration(startTs: number, endTs: number | undefined): string {
  if (endTs === undefined || endTs < startTs) return '—'
  const ms = endTs - startTs
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/**
 * The short row Name (DevTools): the last path segment + the query string, preserving a trailing
 * slash; the host for a root/empty path. `…/users?page=1` → `users?page=1`; `/v1/items/` → `items/`.
 */
export function urlName(url: string): string {
  if (!url) return '(empty)'
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    if (segs.length === 0) return u.host + u.search // root path → host (plus any query)
    const last = segs[segs.length - 1] + (u.pathname.endsWith('/') ? '/' : '')
    return last + u.search
  } catch {
    // Non-URL (data:, blob:, malformed) — take the tail after the last slash, capped.
    const tail = url.split(/[?#]/)[0].split('/').filter(Boolean).pop()
    return (tail ?? url).slice(0, 80)
  }
}

/** The Size cell: a cache/SW label when served from one, else the transferred (wire) bytes. */
export function sizeLabel(rec: NetRecord): string {
  switch (rec.cacheSource) {
    case 'disk':
      return '(disk cache)'
    case 'memory':
      return '(memory cache)'
    case 'sw':
      return '(ServiceWorker)'
    case 'prefetch':
      return '(prefetch cache)'
    default:
      return formatSize(rec.encodedDataLength)
  }
}

/** Map a CDP `blockedReason` to DevTools' short `blocked:*` tag (csp/coep/mixed-content/origin/…). */
export function blockedTag(reason: string): string {
  const r = reason.toLowerCase()
  if (r.includes('csp')) return 'blocked:csp'
  if (r.includes('mixed-content')) return 'blocked:mixed-content'
  if (r.includes('coep')) return 'blocked:coep'
  if (r.includes('coop')) return 'blocked:coop'
  if (r.includes('corp') || r === 'origin') return 'blocked:origin'
  return 'blocked:' + r
}

/**
 * The status cell text. A finished request shows its numeric code; an in-flight one shows
 * `(pending)`; a failure shows `(canceled)`, a `(blocked:*)` tag when the browser blocked it, else
 * `(failed)`. (CORS blocks need `corsErrorStatus` — not captured yet — so they read `(failed)`.)
 */
export function statusLabel(rec: NetRecord): string {
  if (rec.failed) {
    if (rec.failed.canceled) return '(canceled)'
    if (rec.failed.blockedReason) return `(${blockedTag(rec.failed.blockedReason)})`
    return '(failed)'
  }
  if (rec.status !== undefined) return String(rec.status)
  // Preserved across a navigation while still in flight → the page that issued it unloaded (Chrome).
  if (rec.preserved) return '(unknown)'
  return '(pending)'
}

/** Should the whole row render red? HTTP ≥400, or any network failure / cancel / block (DevTools). */
export function isErrorRow(rec: NetRecord): boolean {
  return !!rec.failed || (rec.status !== undefined && rec.status >= 400)
}

/**
 * One parsed filter token. A plain token matches the request URL only (DevTools semantics — `get`
 * does NOT match a GET *method*). A leading `-` negates (the row must NOT match). `key`/`value` are
 * populated for `key:value` property filters in P0.2; for now every token is plain text.
 */
export interface FilterToken {
  neg: boolean
  text: string // lowercased match text (the value, for a property token)
  key?: string // property-filter key (lowercased), e.g. 'method' — undefined ⇒ plain URL token
}

/** Split a filter box into tokens: whitespace-separated, leading `-` = negate. Lone `-` is dropped. */
export function parseFilterTokens(query: string): FilterToken[] {
  return query
    .trim()
    .split(/\s+/)
    .map((raw) => {
      const neg = raw.startsWith('-')
      const body = neg ? raw.slice(1) : raw
      const colon = body.indexOf(':')
      if (colon > 0) {
        return {
          neg,
          key: body.slice(0, colon).toLowerCase(),
          text: body.slice(colon + 1).toLowerCase()
        }
      }
      return { neg, text: body.toLowerCase() }
    })
    .filter((t) => t.text.length > 0 || (t.key !== undefined && t.key.length > 0))
}

/** Lowercased hostname of a URL (empty for a non-URL like data:/blob:). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Lowercased scheme of a URL ("https", "ws", …) — robust to non-parseable inputs. */
function schemeOf(url: string): string {
  try {
    return new URL(url).protocol.replace(/:$/, '').toLowerCase()
  } catch {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(url)
    return m ? m[1].toLowerCase() : ''
  }
}

/** Chrome `domain:` semantics — exact host or subdomain; a leading `*.` requires a strict subdomain. */
function matchDomain(host: string, pattern: string): boolean {
  if (!host || !pattern) return false
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2)
    return base.length > 0 && host.endsWith('.' + base)
  }
  return host === pattern || host.endsWith('.' + pattern)
}

/** Parse a `larger-than:` threshold ("500", "1k", "2m") to bytes; null when unparseable. */
export function parseSizeThreshold(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(v.trim())
  if (!m) return null
  const mult = m[2] === 'k' ? 1000 : m[2] === 'm' ? 1_000_000 : 1
  return parseFloat(m[1]) * mult
}

/** True while a request is still in flight (Chrome `is:running`): no terminal event yet. */
function isRunning(rec: NetRecord): boolean {
  return rec.endTs === undefined && !rec.failed
}

/**
 * Does a record match a single positive token? Plain tokens match the full URL only. A `key:value`
 * token dispatches to the matching captured field; an UNKNOWN key falls back to a plain URL substring
 * of the literal `key:value` (Chrome's behavior). All comparisons are case-insensitive (lowercased).
 */
export function matchToken(rec: NetRecord, token: FilterToken): boolean {
  const { key, text } = token
  if (!key) return rec.url.toLowerCase().includes(text)
  switch (key) {
    case 'url':
      return rec.url.toLowerCase().includes(text)
    case 'method':
      return rec.method.toLowerCase() === text
    case 'scheme':
      return schemeOf(rec.url) === text
    case 'status-code': // substring; pending (no status) never matches
      return rec.status !== undefined && String(rec.status).includes(text)
    case 'mime-type':
      return (rec.mimeType ?? '').split(';')[0].trim().toLowerCase().includes(text)
    case 'resource-type': // the only way to split fetch vs xhr
      return (rec.type ?? '').toLowerCase().includes(text)
    case 'domain':
      return matchDomain(hostOf(rec.url), text)
    case 'larger-than': {
      const th = parseSizeThreshold(text)
      return th !== null && (rec.encodedDataLength ?? 0) > th
    }
    case 'has-response-header':
      return !!rec.resHeaders?.some((h) => h.name.toLowerCase() === text)
    case 'is':
      if (text === 'running') return isRunning(rec)
      if (text === 'from-cache') return rec.fromCache === true
      return rec.url.toLowerCase().includes(`is:${text}`) // unknown is: → URL fallback
    default:
      return rec.url.toLowerCase().includes(`${key}:${text}`) // unknown key → literal URL token
  }
}

/**
 * DevTools text filter: tokenize on whitespace, AND every token, honor leading-`-` negation, match
 * the URL only. Empty query passes all. (Property `key:value` tokens are handled in P0.2.)
 */
export function filterRecords(records: NetRecord[], query: string): NetRecord[] {
  const tokens = parseFilterTokens(query)
  if (tokens.length === 0) return records
  return records.filter((r) => tokens.every((t) => (t.neg ? !matchToken(r, t) : matchToken(r, t))))
}

/** The DevTools-style resource-type filter pills (key + label + the CDP resourceTypes each matches). */
export type NetTypeKey =
  | 'all'
  | 'xhr'
  | 'doc'
  | 'css'
  | 'js'
  | 'font'
  | 'img'
  | 'media'
  | 'manifest'
  | 'ws'
  | 'wasm'
  | 'other'
// The fixed Chrome order: All · Fetch/XHR · Doc · CSS · JS · Font · Img · Media · Manifest · WS · Wasm · Other.
export const NET_TYPE_PILLS: { key: NetTypeKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'xhr', label: 'Fetch/XHR' },
  { key: 'doc', label: 'Doc' },
  { key: 'css', label: 'CSS' },
  { key: 'js', label: 'JS' },
  { key: 'font', label: 'Font' },
  { key: 'img', label: 'Img' },
  { key: 'media', label: 'Media' },
  { key: 'manifest', label: 'Manifest' },
  { key: 'ws', label: 'WS' },
  { key: 'wasm', label: 'Wasm' },
  { key: 'other', label: 'Other' }
]
// Which CDP resourceTypes each pill owns. `other` is the catch-all (anything not claimed above).
const TYPE_MATCH: Record<Exclude<NetTypeKey, 'all' | 'other'>, string[]> = {
  xhr: ['xhr', 'fetch'],
  doc: ['document'],
  css: ['stylesheet'],
  js: ['script'],
  font: ['font'],
  img: ['image'],
  media: ['media'],
  manifest: ['manifest'],
  ws: ['websocket'],
  wasm: ['wasm']
}
const CLAIMED = new Set(Object.values(TYPE_MATCH).flat())

/** Does a record belong to the active type pill? `all` passes everything; `other` = anything no pill claims. */
export function matchesType(rec: NetRecord, key: NetTypeKey): boolean {
  if (key === 'all') return true
  const t = (rec.type || '').toLowerCase()
  if (key === 'other') return !CLAIMED.has(t)
  return TYPE_MATCH[key].includes(t)
}

/** Multi-select pills: a row matches if ANY active pill claims it. Empty or `all` ⇒ pass everything. */
export function matchesAnyType(rec: NetRecord, keys: NetTypeKey[]): boolean {
  if (keys.length === 0 || keys.includes('all')) return true
  return keys.some((k) => matchesType(rec, k))
}

/** Apply the type pill then the text filter (DevTools order). */
export function filterByType(records: NetRecord[], key: NetTypeKey, query: string): NetRecord[] {
  const byType = key === 'all' ? records : records.filter((r) => matchesType(r, key))
  return filterRecords(byType, query)
}

/** Compile a case-insensitive regex; null on an invalid pattern (drives the red error state). */
export function compileFilterRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/** Options for the full row filter (type pills + text/regex/property tokens, optionally inverted). */
export interface NetFilterOpts {
  types: NetTypeKey[] // active pills, OR'd; ['all'] or [] = no type narrowing
  query: string
  regex?: boolean // interpret the box as one regex over the URL (not key:value tokens)
  invert?: boolean // flip the text/regex match (the type pills still apply as an AND)
}
export interface NetFilterResult {
  rows: NetRecord[]
  regexError?: boolean // an invalid regex pattern → show the type set + flag the input
}

/**
 * The complete DevTools row filter: resource-type pills (OR'd, then AND'd with the text filter).
 * Invert flips the text/regex/property match only — the pills always narrow normally (Chrome). Regex
 * mode treats the whole box as one case-insensitive `RegExp` over the URL.
 */
export function applyNetFilter(records: NetRecord[], opts: NetFilterOpts): NetFilterResult {
  const { types, query, regex, invert } = opts
  const noTypeNarrow = types.length === 0 || types.includes('all')
  const byType = noTypeNarrow ? records : records.filter((r) => matchesAnyType(r, types))
  if (!query.trim()) return { rows: invert ? [] : byType } // empty filter matches all → invert hides all
  if (regex) {
    const re = compileFilterRegex(query)
    if (!re) return { rows: byType, regexError: true }
    return { rows: byType.filter((r) => (invert ? !re.test(r.url) : re.test(r.url))) }
  }
  const tokens = parseFilterTokens(query)
  const matches = (r: NetRecord): boolean =>
    tokens.every((t) => (t.neg ? !matchToken(r, t) : matchToken(r, t)))
  return { rows: byType.filter((r) => (invert ? !matches(r) : matches(r))) }
}

/** The footer summary over a (filtered) row set: transfer + resource bytes + the finish span. */
export interface NetSummary {
  transferred: number
  resources: number
  finishMs: number
}
export function summaryStats(rows: NetRecord[]): NetSummary {
  let transferred = 0
  let resources = 0
  let min = Infinity
  let max = -Infinity
  for (const r of rows) {
    transferred += r.encodedDataLength ?? 0
    resources += r.decodedLength ?? 0
    if (r.startTs < min) min = r.startTs
    const end = r.endTs ?? r.startTs
    if (end > max) max = end
  }
  return {
    transferred,
    resources,
    finishMs: Number.isFinite(min) && max > min ? max - min : 0
  }
}

/** A sortable table column + direction (the Waterfall sort-mode dropdown is separate). */
export type SortCol = 'name' | 'status' | 'type' | 'initiator' | 'size' | 'time'
export interface SortState {
  col: SortCol
  dir: 'asc' | 'desc'
}

function sortKey(rec: NetRecord, col: SortCol): string | number {
  switch (col) {
    case 'name':
      return urlName(rec.url).toLowerCase()
    case 'status':
      return rec.status ?? -1
    case 'type':
      return (rec.type || '').toLowerCase()
    case 'initiator':
      return initiatorLabel(rec.initiator).toLowerCase()
    case 'size':
      return rec.encodedDataLength ?? -1
    case 'time':
      return rec.endTs !== undefined ? rec.endTs - rec.startTs : -1
  }
}

/**
 * Sort a DISPLAYED copy (store insertion order is preserved). Size sorts on transfer bytes, Time on
 * duration; ties keep their original order (stable). `null` → insertion order. Pure → unit-tested.
 */
export function sortRecords(rows: NetRecord[], sort: SortState | null): NetRecord[] {
  if (!sort) return rows
  const dir = sort.dir === 'asc' ? 1 : -1
  return rows
    .map((r, i) => [r, i] as const)
    .sort((a, b) => {
      const ka = sortKey(a[0], sort.col)
      const kb = sortKey(b[0], sort.col)
      if (ka < kb) return -dir
      if (ka > kb) return dir
      return a[1] - b[1] // stable tiebreak
    })
    .map(([r]) => r)
}

/** The Initiator cell: a script's file name if it's a url, else the bare CDP type word. */
export function initiatorLabel(initiator: string | undefined): string {
  if (!initiator) return 'other'
  return initiator.includes('://') ? urlName(initiator) : initiator
}

/** One Timing-tab phase bar, in ms relative to the request start. */
export interface TimingPhase {
  label: string
  start: number
  end: number
}

/**
 * The DevTools Timing phase breakdown from the captured ResourceTiming. All offsets are ms relative
 * to the request start; Content Download needs the loadingFinished monotonic timestamp. Empty when
 * timing wasn't captured (cached / failed). Pure → unit-tested.
 */
export function timingPhases(rec: NetRecord): TimingPhase[] {
  const t = rec.timing
  if (!t) return []
  const out: TimingPhase[] = []
  const add = (label: string, start: number, end: number): void => {
    if (start >= 0 && end > start) out.push({ label, start, end })
  }
  const firstStart = [t.dnsStart, t.connectStart, t.sendStart].find((x) => x >= 0)
  if (firstStart !== undefined && firstStart > 0) add('Stalled', 0, firstStart)
  add('DNS Lookup', t.dnsStart, t.dnsEnd)
  add('Initial connection', t.connectStart, t.connectEnd)
  add('SSL', t.sslStart, t.sslEnd)
  add('Request sent', t.sendStart, t.sendEnd)
  add('Waiting (TTFB)', t.sendEnd, t.receiveHeadersEnd)
  const endMs =
    rec.finishMono !== undefined && rec.finishMono > t.requestTime
      ? (rec.finishMono - t.requestTime) * 1000
      : -1
  if (endMs >= 0) add('Content Download', t.receiveHeadersEnd, endMs)
  return out
}

/** Time-to-first-byte in ms (receiveHeadersEnd), for the Time-cell secondary; undefined if unknown. */
export function ttfbMs(rec: NetRecord): number | undefined {
  const t = rec.timing
  if (!t || t.receiveHeadersEnd < 0) return undefined
  return Math.round(t.receiveHeadersEnd)
}

/** The shared waterfall window (earliest start → latest end) across the displayed rows. Clock-free
 *  (no `Date.now()` — render must stay pure): a still-pending row contributes only its start, and its
 *  bar extends to the window max in `waterfallBar`. */
export interface WfWindow {
  min: number
  max: number
}
export function waterfallWindow(rows: NetRecord[]): WfWindow {
  let min = Infinity
  let max = -Infinity
  for (const r of rows) {
    if (r.startTs < min) min = r.startTs
    const end = r.endTs ?? r.startTs
    if (end > max) max = end
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 }
  return { min, max: max > min ? max : min + 1 }
}

/** A single row's waterfall bar (percent of the shared window) + the leading wait (TTFB) fraction. */
export interface WfBar {
  leftPct: number
  widthPct: number
  waitPct: number
}
export function waterfallBar(rec: NetRecord, win: WfWindow): WfBar {
  const span = win.max - win.min || 1
  const start = rec.startTs
  const end = rec.endTs ?? win.max // pending → extend to the window edge
  const leftPct = Math.min(Math.max(((start - win.min) / span) * 100, 0), 100)
  const widthPct = Math.max(((end - start) / span) * 100, 0.5)
  let waitPct = 0
  const totalMs = end - start
  const t = rec.timing
  if (t && t.receiveHeadersEnd >= 0 && totalMs > 0) {
    waitPct = Math.min(Math.max((t.receiveHeadersEnd / totalMs) * 100, 0), 100)
  }
  return { leftPct, widthPct, waitPct }
}
