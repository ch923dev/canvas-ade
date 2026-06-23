/**
 * Lenient JSON model for the Network inspector's body viewer (JD-1).
 *
 * The viewer is built on a hand-written **source-string tokenizer**, NOT `JSON.parse`. Walking the
 * raw text (never constructing a JS value) keeps the display wire-faithful: duplicate keys, key
 * order, and oversized integers all survive verbatim, and a truncated body yields a partial tree
 * instead of throwing. All of this is pure (no React/DOM) so the table-math is unit-tested — the
 * file-size doctrine atop `osrNetFormat.ts`.
 */

/** Strip a single leading UTF-8 BOM so the `looksJson` heuristic and the scanner see `{`/`[` first. */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/**
 * Shared JSON detector (extracted from `osrNetFormat.prettyBody`): the mime says JSON, OR the
 * BOM-stripped body begins with `{`/`[`. Used by both the viewer and the legacy `prettyBody`
 * fallback so there is exactly one gate.
 */
export function looksJson(body: string, mime?: string): boolean {
  if ((mime ?? '').toLowerCase().includes('json')) return true
  return /^\s*[{[]/.test(stripBom(body))
}

export type BodyKind = 'json' | 'form' | 'text' | 'binary'

/**
 * Classify a body for display. Responses carry a mime; request payloads don't, so we also sniff:
 * a `key=value(&…)` shape with no leading whitespace ⇒ form-urlencoded.
 */
export function detectBodyKind(body: string, mime?: string, base64?: boolean): BodyKind {
  if (base64) return 'binary'
  if (looksJson(body, mime)) return 'json'
  const m = (mime ?? '').toLowerCase()
  if (m.includes('x-www-form-urlencoded')) return 'form'
  if (/^[^=&\s]+=[^&]*(?:&|$)/.test(body.trim())) return 'form'
  return 'text'
}

export type RowKind = 'open' | 'scalar' | 'close'
export type ValueType = 'string' | 'number' | 'bigint' | 'bool' | 'null' | 'raw'

/** One rendered line. Containers emit a paired `open`/`close`; scalars emit one row. */
export interface JsonRow {
  id: number
  depth: number
  key?: string
  kind: RowKind
  brace?: '{' | '[' | '}' | ']'
  valueType?: ValueType
  /** SOURCE slice of the value (e.g. `12345678901234567890`, `1e999`) — never round-tripped. */
  valueText?: string
  /** on `open`: member/element count for the collapsed summary. */
  childCount?: number
  /** on `open`: id of the matching `close` row (the fold target). */
  closeId?: number
  duplicateKey?: boolean
  truncatedHere?: boolean
}

export interface JsonMeta {
  duplicateKeys: number
  bigInts: number
  truncated: boolean
  parseError: boolean
  /** Hit the recursion cap — body is page-controlled, so deep nesting is clamped, not crashed. */
  maxDepth: boolean
}

/**
 * Recursion cap for the scanner. The body is page-controlled, so a crafted `[[[[…` (millions of
 * levels under the 5 MB cap) would otherwise overflow V8's call stack and crash the panel. 200 is
 * far above any real API nesting; past it the tree is clamped + flagged (graceful, not a throw).
 */
const MAX_DEPTH = 200

export interface JsonModel {
  rows: JsonRow[]
  kind: BodyKind
  meta: JsonMeta
}

function zeroMeta(): JsonMeta {
  return { duplicateKeys: 0, bigInts: 0, truncated: false, parseError: false, maxDepth: false }
}

/**
 * Build the row model for a body. JSON → the lenient scanner; form → one kv row per pair;
 * text/binary → a single `raw` row carrying the original text (the component renders the
 * passthrough / `[binary]` cases).
 */
export function buildModel(body: string, mime: string | undefined, base64?: boolean): JsonModel {
  const kind = detectBodyKind(body, mime, base64)
  if (kind === 'json') return scanJson(stripBom(body))
  if (kind === 'form') return buildForm(body)
  return {
    rows: [{ id: 0, depth: 0, kind: 'scalar', valueType: 'raw', valueText: body }],
    kind,
    meta: zeroMeta()
  }
}

function buildForm(body: string): JsonModel {
  const rows: JsonRow[] = []
  let id = 0
  for (const pair of body.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const rawK = eq >= 0 ? pair.slice(0, eq) : pair
    const rawV = eq >= 0 ? pair.slice(eq + 1) : ''
    rows.push({
      id: id++,
      depth: 0,
      key: decodeFormPart(rawK),
      kind: 'scalar',
      valueType: 'string',
      valueText: decodeFormPart(rawV)
    })
  }
  return { rows, kind: 'form', meta: zeroMeta() }
}

function decodeFormPart(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

/** Position cursor for the scanner (mutated in place across the recursive walk). */
interface Pos {
  i: number
}

function scanJson(src: string): JsonModel {
  const rows: JsonRow[] = []
  const meta = zeroMeta()
  const p: Pos = { i: 0 }
  const n = src.length
  let nextId = 0

  const skipWs = (): void => {
    while (p.i < n && /\s/.test(src[p.i])) p.i++
  }

  /** Read a JSON string literal; returns the raw inner text (without the surrounding quotes). */
  const readStringInner = (): string => {
    p.i++ // opening quote
    let inner = ''
    while (p.i < n) {
      const c = src[p.i]
      if (c === '\\') {
        inner += src.slice(p.i, p.i + 2)
        p.i += 2
        continue
      }
      if (c === '"') {
        p.i++
        return inner
      }
      inner += c
      p.i++
    }
    meta.truncated = true // unterminated string at EOF
    return inner
  }

  const readNumber = (): { type: ValueType; text: string } => {
    const start = p.i
    if (src[p.i] === '-') p.i++
    while (p.i < n && src[p.i] >= '0' && src[p.i] <= '9') p.i++
    let isInt = true
    if (src[p.i] === '.') {
      isInt = false
      p.i++
      while (p.i < n && src[p.i] >= '0' && src[p.i] <= '9') p.i++
    }
    if (src[p.i] === 'e' || src[p.i] === 'E') {
      isInt = false
      p.i++
      if (src[p.i] === '+' || src[p.i] === '-') p.i++
      while (p.i < n && src[p.i] >= '0' && src[p.i] <= '9') p.i++
    }
    const text = src.slice(start, p.i)
    if (isInt && !Number.isSafeInteger(Number(text))) {
      meta.bigInts++
      return { type: 'bigint', text }
    }
    return { type: 'number', text }
  }

  const pushClose = (depth: number, brace: '}' | ']', truncated?: boolean): number => {
    const id = nextId++
    rows.push({ id, depth, kind: 'close', brace, truncatedHere: truncated || undefined })
    return id
  }

  /** Scan one value at the cursor, appending its rows. Returns false on a hard parse error / EOF. */
  const scanValue = (depth: number, key: string | undefined, dup: boolean): boolean => {
    if (depth > MAX_DEPTH) {
      meta.maxDepth = true // clamp page-controlled deep nesting instead of overflowing the stack
      return false
    }
    skipWs()
    if (p.i >= n) {
      meta.truncated = true
      return false
    }
    const c = src[p.i]

    if (c === '{' || c === '[') {
      const brace = c as '{' | '['
      const closeChar = brace === '{' ? '}' : ']'
      const openRow: JsonRow = {
        id: nextId++,
        depth,
        key,
        kind: 'open',
        brace,
        duplicateKey: dup || undefined
      }
      rows.push(openRow)
      p.i++ // consume the brace
      skipWs()
      if (src[p.i] === closeChar) {
        p.i++
        openRow.closeId = pushClose(depth, closeChar)
        openRow.childCount = 0
        return true
      }
      const seen = new Set<string>()
      let count = 0
      for (;;) {
        skipWs()
        if (p.i >= n) {
          meta.truncated = true
          openRow.truncatedHere = true
          openRow.closeId = pushClose(depth, closeChar, true)
          openRow.childCount = count
          return true
        }
        let childKey: string | undefined
        let childDup = false
        if (brace === '{') {
          if (src[p.i] !== '"') {
            meta.parseError = true
            openRow.closeId = pushClose(depth, closeChar)
            openRow.childCount = count
            return false
          }
          childKey = readStringInner()
          if (seen.has(childKey)) {
            childDup = true
            meta.duplicateKeys++
          } else {
            seen.add(childKey)
          }
          skipWs()
          if (src[p.i] !== ':') {
            meta.parseError = true
            openRow.closeId = pushClose(depth, closeChar)
            openRow.childCount = count
            return false
          }
          p.i++ // consume ':'
        }
        const ok = scanValue(depth + 1, childKey, childDup)
        count++
        if (!ok) {
          openRow.closeId = pushClose(depth, closeChar, meta.truncated)
          openRow.childCount = count
          return false
        }
        skipWs()
        if (src[p.i] === ',') {
          p.i++
          continue
        }
        if (src[p.i] === closeChar) {
          p.i++
          openRow.closeId = pushClose(depth, closeChar)
          openRow.childCount = count
          return true
        }
        if (p.i >= n) {
          meta.truncated = true
          openRow.truncatedHere = true
          openRow.closeId = pushClose(depth, closeChar, true)
          openRow.childCount = count
          return true
        }
        meta.parseError = true // unexpected token between members
        openRow.closeId = pushClose(depth, closeChar)
        openRow.childCount = count
        return false
      }
    }

    if (c === '"') {
      const inner = readStringInner()
      rows.push({
        id: nextId++,
        depth,
        key,
        kind: 'scalar',
        valueType: 'string',
        valueText: `"${inner}"`,
        duplicateKey: dup || undefined,
        truncatedHere: meta.truncated && p.i >= n ? true : undefined
      })
      return true
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const num = readNumber()
      rows.push({
        id: nextId++,
        depth,
        key,
        kind: 'scalar',
        valueType: num.type,
        valueText: num.text,
        duplicateKey: dup || undefined
      })
      return true
    }
    for (const [lit, type] of [
      ['true', 'bool'],
      ['false', 'bool'],
      ['null', 'null']
    ] as const) {
      if (src.startsWith(lit, p.i)) {
        p.i += lit.length
        rows.push({
          id: nextId++,
          depth,
          key,
          kind: 'scalar',
          valueType: type,
          valueText: lit,
          duplicateKey: dup || undefined
        })
        return true
      }
    }

    meta.parseError = true // unknown token
    return false
  }

  scanValue(0, undefined, false)
  return { rows, kind: 'json', meta }
}

/** Open-container ids whose depth ≥ `depth` (default 2) — the initial collapsed set (top two levels open). */
export function initialCollapsed(rows: JsonRow[], depth = 2): Set<number> {
  const s = new Set<number>()
  for (const r of rows) if (r.kind === 'open' && r.depth >= depth) s.add(r.id)
  return s
}

/**
 * The rows to render given the fold state: a collapsed `open` row is shown (with a summary) but its
 * children and matching `close` row are skipped. Pure — memoize on `(rows, collapsed)`.
 */
export function visibleRows(rows: JsonRow[], collapsed: Set<number>): JsonRow[] {
  const out: JsonRow[] = []
  let skipTo = -1
  for (const r of rows) {
    if (skipTo >= 0) {
      if (r.id < skipTo) continue // inside a collapsed container
      if (r.id === skipTo) {
        skipTo = -1 // the close row itself — hide it
        continue
      }
    }
    out.push(r)
    if (r.kind === 'open' && r.closeId !== undefined && collapsed.has(r.id)) skipTo = r.closeId
  }
  return out
}

/**
 * Raw mode: re-indent the SOURCE losslessly (string contents, number text, duplicate keys, and key
 * order all preserved — no `JSON.parse` round-trip). Non-JSON / binary returns the body verbatim.
 */
export function reindent(body: string, mime?: string, base64?: boolean): string {
  if (base64 || !looksJson(body, mime)) return body
  const src = stripBom(body)
  const n = src.length
  let out = ''
  let depth = 0
  let i = 0
  const pad = (): string => '  '.repeat(depth)
  while (i < n) {
    const c = src[i]
    if (c === '"') {
      const start = i
      i++
      while (i < n) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === '"') {
          i++
          break
        }
        i++
      }
      out += src.slice(start, i)
      continue
    }
    if (c === '{' || c === '[') {
      let j = i + 1
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] === '}' || src[j] === ']') {
        out += c + src[j] // empty container stays on one line
        i = j + 1
        continue
      }
      depth++
      out += c + '\n' + pad()
      i++
      continue
    }
    if (c === '}' || c === ']') {
      depth = Math.max(0, depth - 1)
      out += '\n' + pad() + c
      i++
      continue
    }
    if (c === ',') {
      out += ',\n' + pad()
      i++
      continue
    }
    if (c === ':') {
      out += ': '
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++ // collapse original whitespace
      continue
    }
    out += c
    i++
  }
  return out
}
