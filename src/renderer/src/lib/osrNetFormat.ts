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

/** The short row name: the last path segment, or the host for a root/empty path. */
export function urlName(url: string): string {
  if (!url) return '(empty)'
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean)
    return segs.length ? segs[segs.length - 1] : u.host
  } catch {
    // Non-URL (data:, blob:, malformed) — take the tail after the last slash, capped.
    const tail = url.split(/[?#]/)[0].split('/').filter(Boolean).pop()
    return (tail ?? url).slice(0, 80)
  }
}

/** The status cell text: a number, "(failed)" / the error tag, or "—" while pending. */
export function statusLabel(rec: NetRecord): string {
  if (rec.failed) return rec.failed.canceled ? '(canceled)' : '(failed)'
  return rec.status !== undefined ? String(rec.status) : '—'
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
  | 'ws'
  | 'wasm'
  | 'other'
export const NET_TYPE_PILLS: { key: NetTypeKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'xhr', label: 'Fetch/XHR' },
  { key: 'doc', label: 'Doc' },
  { key: 'css', label: 'CSS' },
  { key: 'js', label: 'JS' },
  { key: 'font', label: 'Font' },
  { key: 'img', label: 'Img' },
  { key: 'media', label: 'Media' },
  { key: 'ws', label: 'Socket' },
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

/** Options for the full row filter (type pill + text/regex/property tokens, optionally inverted). */
export interface NetFilterOpts {
  type: NetTypeKey
  query: string
  regex?: boolean // interpret the box as one regex over the URL (not key:value tokens)
  invert?: boolean // flip the text/regex match (the type pill still applies as an AND)
}
export interface NetFilterResult {
  rows: NetRecord[]
  regexError?: boolean // an invalid regex pattern → show the type set + flag the input
}

/**
 * The complete DevTools row filter: resource-type pill (AND) combined with the text filter. Invert
 * flips the text/regex/property match only — the type pill always narrows normally (Chrome). Regex
 * mode treats the whole box as one case-insensitive `RegExp` over the URL.
 */
export function applyNetFilter(records: NetRecord[], opts: NetFilterOpts): NetFilterResult {
  const { type, query, regex, invert } = opts
  const byType = type === 'all' ? records : records.filter((r) => matchesType(r, type))
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

/** The Initiator cell: a script's file name if it's a url, else the bare CDP type word. */
export function initiatorLabel(initiator: string | undefined): string {
  if (!initiator) return 'other'
  return initiator.includes('://') ? urlName(initiator) : initiator
}
