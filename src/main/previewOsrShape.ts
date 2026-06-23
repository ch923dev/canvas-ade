/**
 * Data-shape inference (JD-3, ADR 0010) — turn a sampled response body into a VALUE-LESS shape
 * skeleton, in MAIN. Split out of `previewOsrNetwork.ts` (the file-size doctrine) and consumed by its
 * `preview:osrNetSampleSchema` handler.
 *
 * The renderer never receives raw sampled bodies through this path — only these skeletons (types /
 * field names / presence / a format-hint LABEL). Values are dropped here, before anything crosses IPC.
 * The renderer libs merge skeletons into a schema (`schemaInfer.ts`) + entities (`entityInfer.ts`).
 * Wire types are mirrored in preload + `schemaInfer.ts` (process boundary — no shared import).
 */
import { redactSecrets } from './summaryLoop'

export type ShapeType = 'string' | 'number' | 'bool' | 'null' | 'object' | 'array' | 'unknown'
export type FormatHint = 'uuid' | 'date-time' | 'email' | 'uri' | 'int64'
export interface ShapeNode {
  types: ShapeType[]
  format?: FormatHint
  children?: Record<string, ShapeNode>
  elem?: ShapeNode
}
export interface ShapeSampleWire {
  root: ShapeNode
  complete: boolean
}
export interface OsrNetSchemaResult {
  samples: ShapeSampleWire[]
  requested: number
  sampled: number
}

export const SCHEMA_SAMPLE_CAP = 20 // bodies sampled per pass (per expanded template)
export const SCHEMA_BYTES_CAP = 8 * 1024 * 1024 // total decoded bytes read per pass
const SHAPE_MAX_DEPTH = 64 // page-controlled nesting clamp (no stack overflow)
const FORMAT_MAX_LEN = 2048 // only classify a string's format below this length (formats are short)

const SHAPE_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const SHAPE_ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const SHAPE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SHAPE_URI_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i

/** Classify a string's FORMAT by pattern (returns a label, never the value). `redactSecrets` is applied
 *  defensively first — the value is discarded after; only the enum label can ever leave MAIN. */
function classifyFormat(raw: string): FormatHint | undefined {
  if (raw.length === 0 || raw.length > FORMAT_MAX_LEN) return undefined
  const s = redactSecrets(raw)
  if (SHAPE_UUID_RE.test(s)) return 'uuid'
  if (SHAPE_ISO_RE.test(s)) return 'date-time'
  if (SHAPE_EMAIL_RE.test(s)) return 'email'
  if (SHAPE_URI_RE.test(s)) return 'uri'
  return undefined
}

/** Merge two shape nodes (array-element union within one sampled body; value-less throughout). */
function mergeShapeNode(a: ShapeNode, b: ShapeNode): ShapeNode {
  const out: ShapeNode = { types: [...new Set([...a.types, ...b.types])] }
  if (a.format && a.format === b.format) out.format = a.format
  if (a.children || b.children) {
    const children: Record<string, ShapeNode> = {}
    if (a.children) for (const k of Object.keys(a.children)) children[k] = a.children[k]
    if (b.children)
      for (const k of Object.keys(b.children))
        children[k] = children[k] ? mergeShapeNode(children[k], b.children[k]) : b.children[k]
    out.children = children
  }
  if (a.elem && b.elem) out.elem = mergeShapeNode(a.elem, b.elem)
  else if (a.elem || b.elem) out.elem = (a.elem ?? b.elem) as ShapeNode
  return out
}

/** Walk a parsed JSON value into a VALUE-LESS ShapeNode (types / keys / format only). */
function shapeOf(v: unknown, depth: number): ShapeNode {
  if (depth > SHAPE_MAX_DEPTH) return { types: ['unknown'] }
  if (v === null) return { types: ['null'] }
  if (Array.isArray(v)) {
    let elem: ShapeNode | undefined
    for (const item of v) {
      const en = shapeOf(item, depth + 1)
      elem = elem ? mergeShapeNode(elem, en) : en
    }
    return elem ? { types: ['array'], elem } : { types: ['array'] }
  }
  switch (typeof v) {
    case 'object': {
      const children: Record<string, ShapeNode> = {}
      for (const k of Object.keys(v as Record<string, unknown>))
        children[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1)
      return { types: ['object'], children }
    }
    case 'string': {
      const format = classifyFormat(v as string)
      return format ? { types: ['string'], format } : { types: ['string'] }
    }
    case 'number': {
      const n = v as number
      return Number.isInteger(n) && !Number.isSafeInteger(n)
        ? { types: ['number'], format: 'int64' }
        : { types: ['number'] }
    }
    case 'boolean':
      return { types: ['bool'] }
    default:
      return { types: ['unknown'] }
  }
}

/** Value-less shape skeleton from a (≤BODY_CAP) JSON body; null on parse failure (skip the sample,
 *  never partially trust it for presence). Exported for unit tests. */
export function extractShape(body: string): ShapeNode | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  return shapeOf(parsed, 0)
}

/** A capped record the sampler resolves a body for (the live `NetRecord` satisfies it). */
interface SampleRec {
  requestId: string
  type: string
  sessionId?: string
}
interface CappedBody {
  body: string
  base64: boolean
  truncated: boolean
}

/**
 * The capped, response-only sampling pass (ADR 0010): for each requestId (≤SCHEMA_SAMPLE_CAP, ≤
 * SCHEMA_BYTES_CAP total), fetch the response body, cap it, and extract a VALUE-LESS skeleton. Returns
 * only skeletons — no raw value. `capBody` is injected so this stays free of a `previewOsrNetwork` cycle.
 */
export async function sampleResponseShapes(
  getRecord: (id: string) => SampleRec | undefined,
  sendCommand: (method: string, params: object, sessionId?: string) => Promise<unknown>,
  capBody: (body: unknown, base64: boolean) => CappedBody,
  requestIds: string[]
): Promise<OsrNetSchemaResult> {
  const ids = Array.isArray(requestIds) ? requestIds.slice(0, SCHEMA_SAMPLE_CAP) : []
  const samples: ShapeSampleWire[] = []
  let bytes = 0
  for (const rid of ids) {
    if (bytes >= SCHEMA_BYTES_CAP) break // hard byte ceiling per pass
    const rec = getRecord(String(rid))
    if (!rec || rec.type === 'websocket') continue // re-validate; responses only
    try {
      const res = (await sendCommand(
        'Network.getResponseBody',
        { requestId: rec.requestId },
        rec.sessionId
      )) as Record<string, unknown>
      const capped = capBody(res.body, res.base64Encoded === true)
      if (capped.base64) continue // binary — not inferable
      bytes += capped.body.length
      const root = extractShape(capped.body)
      if (root) samples.push({ root, complete: !capped.truncated })
    } catch {
      /* body evicted / target gone — skip this sample */
    }
  }
  return { samples, requested: ids.length, sampled: samples.length }
}
