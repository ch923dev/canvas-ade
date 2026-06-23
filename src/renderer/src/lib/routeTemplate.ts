/**
 * Route-template collapsing for the Data Flow inventory (JD-3, REPORT engine 1).
 *
 * Groups captured requests by `method + origin + normalize(pathname)`, collapsing variable path
 * segments (numeric / UUID / opaque-token → `{id}`/`{uuid}`, high-cardinality variance → `{param}`)
 * so an observed surface does not explode into thousands of per-id rows. Pure, body-free, unit-tested
 * (the table-math → lib doctrine). Keeps an editable example set per template as the escape hatch.
 *
 * Guardrails (REPORT B4): API-version segments (`/v1`, `/v2`) never collapse into each other, and a
 * low-cardinality set of word segments (`/products/shoes` vs `/products/hats`) stays distinct — only a
 * genuinely high-cardinality identifier space promotes to `{param}`.
 */
import type { NetRecord } from '../../../preload'

export type SegKind = 'static' | 'id' | 'uuid' | 'param'

export interface RouteTemplate {
  method: string // GET/POST/… ; websocket records → 'WS'
  origin: string // scheme://host[:port] — kept so /api/v1 vs a different host never merge ('' if unparseable)
  template: string // e.g. /api/v2/users/{id}
  segKinds: SegKind[] // per-path-segment classification (drives the accent-on-dynamic render)
}

export interface StatusMix {
  c2xx: number
  c3xx: number
  c4xx: number
  c5xx: number
  other: number
}

export interface TemplateGroup {
  key: string // `${method} ${origin}${template}` — the inventory row identity
  tpl: RouteTemplate
  records: NetRecord[] // every captured call that collapsed here (insertion order; newest last)
  examples: string[] // distinct concrete pathnames (capped) — the editable escape hatch
  calls: number
  statusMix: StatusMix
  p50Ms?: number
  p95Ms?: number
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const VERSION_RE = /^v\d+$/i
const ALLNUM_RE = /^\d+$/
const SLUG_RE = /^[a-z]+(?:-[a-z]+)*$/ // lowercase word(s) joined by hyphens — a human slug, NOT an id

/** Distinct concrete paths kept per template (the editable example set). */
const EXAMPLE_CAP = 5
/** A static position promotes to `{param}` only at/above this many distinct values (high cardinality
 *  ⇒ an identifier space, not a route fork). Below it, word segments stay their own templates. */
const PARAM_MIN_DISTINCT = 8

/** A long, mixed-or-hex token that reads like an id/hash rather than a word (nanoid, jwt chunk, sha). */
function isOpaqueToken(s: string): boolean {
  if (s.length >= 24 && /^[0-9a-fA-F]+$/.test(s)) return true // long hex (sha-ish)
  if (s.length >= 16 && /[0-9]/.test(s) && /[a-zA-Z]/.test(s)) return !SLUG_RE.test(s)
  return false
}

/** Classify one path segment. Version segments stay static (guardrail); ids/uuids/opaque collapse. */
export function classifySeg(seg: string): SegKind {
  if (UUID_RE.test(seg)) return 'uuid'
  if (VERSION_RE.test(seg)) return 'static'
  if (ALLNUM_RE.test(seg)) return 'id'
  if (isOpaqueToken(seg)) return 'id'
  return 'static'
}

function placeholder(kind: SegKind, literal: string): string {
  switch (kind) {
    case 'uuid':
      return '{uuid}'
    case 'id':
      return '{id}'
    case 'param':
      return '{param}'
    default:
      return literal
  }
}

/** Parse a URL into origin + decoded non-empty path segments (tolerant of non-URL strings). */
function parsePath(url: string): { origin: string; segs: string[] } {
  try {
    const u = new URL(url)
    return { origin: u.origin, segs: u.pathname.split('/').filter(Boolean) }
  } catch {
    const path = url.split(/[?#]/)[0]
    return { origin: '', segs: path.split('/').filter(Boolean) }
  }
}

/** The single-request route template (no `{param}` variance pass — that needs the whole group). */
export function routeTemplate(url: string, method: string): RouteTemplate {
  const { origin, segs } = parsePath(url)
  const segKinds = segs.map(classifySeg)
  const template = '/' + segs.map((s, i) => placeholder(segKinds[i], s)).join('/')
  return { method: (method || 'GET').toUpperCase(), origin, template, segKinds }
}

interface Acc {
  key: string
  tpl: RouteTemplate
  records: NetRecord[]
}

function methodOf(rec: NetRecord): string {
  return rec.type === 'websocket' ? 'WS' : (rec.method || 'GET').toUpperCase()
}

function keyOf(tpl: RouteTemplate): string {
  return `${tpl.method} ${tpl.origin}${tpl.template}`
}

/** Every value in the set matches `re` (used to never promote an all-version position to `{param}`). */
function allMatch(values: Iterable<string>, re: RegExp): boolean {
  for (const v of values) if (!re.test(v)) return false
  return true
}

/**
 * Conservative variance pass: merge groups that are identical except at exactly ONE static position
 * whose value varies across many distinct values (≥ PARAM_MIN_DISTINCT, and not all version-like).
 * Multiple varying positions ⇒ ambiguous ⇒ left distinct. Low cardinality ⇒ categories ⇒ left distinct.
 */
function varianceMerge(groups: Map<string, Acc>): Map<string, Acc> {
  const families = new Map<string, Acc[]>()
  for (const acc of groups.values()) {
    const fam = `${acc.tpl.method}|${acc.tpl.origin}|${acc.tpl.segKinds.join(',')}`
    const list = families.get(fam)
    if (list) list.push(acc)
    else families.set(fam, [acc])
  }

  const out = new Map<string, Acc>()
  for (const fam of families.values()) {
    if (fam.length < 2) {
      out.set(fam[0].key, fam[0])
      continue
    }
    const segLists = fam.map((a) => a.tpl.template.split('/').filter(Boolean))
    const segCount = segLists[0].length
    const kinds = fam[0].tpl.segKinds
    const varyPositions: number[] = []
    for (let i = 0; i < segCount; i++) {
      if (kinds[i] !== 'static') continue
      const vals = new Set(segLists.map((s) => s[i]))
      if (vals.size > 1) varyPositions.push(i)
    }
    const pos = varyPositions.length === 1 ? varyPositions[0] : -1
    const distinct = pos >= 0 ? new Set(segLists.map((s) => s[pos])) : new Set<string>()
    if (pos >= 0 && distinct.size >= PARAM_MIN_DISTINCT && !allMatch(distinct, VERSION_RE)) {
      const segKinds = kinds.slice()
      segKinds[pos] = 'param'
      const baseSegs = segLists[0].slice()
      baseSegs[pos] = '{param}'
      const tpl: RouteTemplate = {
        method: fam[0].tpl.method,
        origin: fam[0].tpl.origin,
        template: '/' + baseSegs.join('/'),
        segKinds
      }
      const merged: Acc = { key: keyOf(tpl), tpl, records: [] }
      for (const a of fam) merged.records.push(...a.records)
      out.set(merged.key, merged)
    } else {
      for (const a of fam) out.set(a.key, a)
    }
  }
  return out
}

function pct(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function distinctExamples(records: NetRecord[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of records) {
    const { segs } = parsePath(r.url)
    const path = '/' + segs.join('/')
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
    if (out.length >= EXAMPLE_CAP) break
  }
  return out
}

function buildGroup(acc: Acc): TemplateGroup {
  const statusMix: StatusMix = { c2xx: 0, c3xx: 0, c4xx: 0, c5xx: 0, other: 0 }
  const durs: number[] = []
  for (const r of acc.records) {
    const s = r.status ?? 0
    if (s >= 200 && s < 300) statusMix.c2xx++
    else if (s >= 300 && s < 400) statusMix.c3xx++
    else if (s >= 400 && s < 500) statusMix.c4xx++
    else if (s >= 500) statusMix.c5xx++
    else statusMix.other++
    if (r.endTs !== undefined && r.endTs > r.startTs) durs.push(r.endTs - r.startTs)
  }
  durs.sort((a, b) => a - b)
  return {
    key: acc.key,
    tpl: acc.tpl,
    records: acc.records,
    examples: distinctExamples(acc.records),
    calls: acc.records.length,
    statusMix,
    p50Ms: pct(durs, 50),
    p95Ms: pct(durs, 95)
  }
}

/** Collapse a board's captured records into route-template inventory rows, sorted by call count desc. */
export function groupByTemplate(records: NetRecord[]): TemplateGroup[] {
  const groups = new Map<string, Acc>()
  for (const rec of records) {
    const tpl = routeTemplate(rec.url, methodOf(rec))
    const key = keyOf(tpl)
    const acc = groups.get(key)
    if (acc) acc.records.push(rec)
    else groups.set(key, { key, tpl, records: [rec] })
  }
  const merged = varianceMerge(groups)
  return [...merged.values()].map(buildGroup).sort((a, b) => b.calls - a.calls)
}
