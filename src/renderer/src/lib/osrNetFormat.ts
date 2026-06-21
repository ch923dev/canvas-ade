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

/** Does a record match a single positive token? Plain tokens match the full URL only. */
export function matchToken(rec: NetRecord, token: FilterToken): boolean {
  return rec.url.toLowerCase().includes(token.text)
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

/** The Initiator cell: a script's file name if it's a url, else the bare CDP type word. */
export function initiatorLabel(initiator: string | undefined): string {
  if (!initiator) return 'other'
  return initiator.includes('://') ? urlName(initiator) : initiator
}
