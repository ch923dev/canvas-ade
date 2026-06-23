/**
 * Monoid schema-merge for the Data Flow inventory (JD-3, REPORT engine 2).
 *
 * Folds the **value-less shape skeletons** MAIN returns (`ShapeSample`, one per sampled response body)
 * into a single inferred schema: type unions, required-iff-present-in-every-COMPLETE-sample, array
 * element merge, format-hint carry-through. **Shape, not values** — a `ShapeNode` never carries a raw
 * value; values are dropped in MAIN before the skeleton crosses IPC (ADR 0010). Pure, unit-tested.
 *
 * Truncated samples (`complete:false`) contribute TYPES but are excluded from the presence denominator,
 * so a field clipped by the 5 MB body cap is never mis-inferred as `optional` (REPORT B3).
 */

import { classifySeg } from './routeTemplate'

export type ShapeType = 'string' | 'number' | 'bool' | 'null' | 'object' | 'array' | 'unknown'
/** A format CLASS label derived in MAIN by pattern (never the matched value). */
export type FormatHint = 'uuid' | 'date-time' | 'email' | 'uri' | 'int64'

/** The synthetic key the dictionary-collapse uses for a map's representative VALUE field — a stand-in
 *  for "any id key" (`{ "<objectId>": V, … }` → one `{*}: V` member). Entity inference names the value
 *  after the map's container, never after an id value (the JD-4 production-data fix). */
export const MAP_VALUE_KEY = '{*}'
/** A map must have at least this many keys, and at least this fraction id-shaped, before it collapses
 *  (below the floor, a couple of numeric/id-ish keys stay literal fields). */
const MAP_MIN_KEYS = 6
const MAP_ID_RATIO = 0.8

/** One node of a captured body's SHAPE — emitted by MAIN with every value dropped (wire-mirrored). */
export interface ShapeNode {
  types: ShapeType[]
  format?: FormatHint
  children?: Record<string, ShapeNode> // object members (MAIN preserves key insertion order)
  elem?: ShapeNode // array element (MAIN merges an array's elements into one node)
}
/** One sampled response body's shape. `complete:false` ⇒ the body was truncated/clipped (shape-only). */
export interface ShapeSample {
  root: ShapeNode
  complete: boolean
}

export interface InferredField {
  key: string // '' for the root; '[]' for an array element
  types: ShapeType[]
  format?: FormatHint
  presentIn: number // # of COMPLETE parent samples that contained this key
  sampleCount: number // # of COMPLETE parent samples at this level
  required: boolean // presentIn === sampleCount && sampleCount > 0
  pii?: boolean // key matches a PII/secret NAME pattern (no value is ever present to leak)
  children?: InferredField[] // object members
  elem?: InferredField // array element
  map?: boolean // object is a dictionary keyed by dynamic ids — children collapsed to one `{*}` value
}
export interface InferredSchema {
  root: InferredField
  rootKind: 'object' | 'array' | 'scalar'
  sampleCount: number // total samples merged (complete + truncated)
  truncatedCount: number
}

const PII_RE =
  /^(?:e?mail|ssn|sin|phone|tel|telephone|password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|card(?:number)?|cc|cvv|cvc|iban|dob|birthdate)$/i
const PII_SUFFIX_RE = /(?:email|token|secret|password|apikey|api_key)$/i

/** Whether a field NAME reads as PII/secret — drives the ⚠ chip (the value is already absent). */
export function isPiiName(key: string): boolean {
  return PII_RE.test(key) || PII_SUFFIX_RE.test(key)
}

interface SrcNode {
  node: ShapeNode
  complete: boolean
}

function unionTypes(srcs: SrcNode[]): ShapeType[] {
  const set = new Set<ShapeType>()
  for (const s of srcs) for (const t of s.node.types) set.add(t)
  return set.size ? [...set] : ['unknown']
}

function mergeFormat(srcs: SrcNode[]): FormatHint | undefined {
  const set = new Set<FormatHint>()
  for (const s of srcs) if (s.node.format) set.add(s.node.format)
  return set.size === 1 ? [...set][0] : undefined
}

/** Merge a set of source nodes (one per sample, at one position) into a field. The parent assigns the
 *  returned field's presentIn/sampleCount/required; this fills types/format/children/elem. */
function mergeField(key: string, srcs: SrcNode[]): InferredField {
  const field: InferredField = {
    key,
    types: unionTypes(srcs),
    format: mergeFormat(srcs),
    presentIn: 0,
    sampleCount: 0,
    required: false,
    pii: key ? isPiiName(key) || undefined : undefined
  }

  // object members
  const objSrcs = srcs.filter((s) => s.node.children)
  if (objSrcs.length) {
    const completeObjs = objSrcs.filter((s) => s.complete)
    const denom = completeObjs.length
    const order: string[] = []
    const seen = new Set<string>()
    for (const s of objSrcs) {
      for (const k of Object.keys(s.node.children as Record<string, ShapeNode>)) {
        if (!seen.has(k)) {
          seen.add(k)
          order.push(k)
        }
      }
    }
    // Dictionary/map collapse: when an object is dominated by dynamic id-shaped keys it is a MAP, not a
    // record with hundreds of fields. Keep any fixed (static) members as normal fields, and merge ALL the
    // id-keyed values into ONE representative `{*}` field — so inference can't explode into an entity per
    // id (the production-data crash/noise fix). `classifySeg` is the same id detector the route templater
    // uses (numeric / uuid / opaque-hex like a Mongo ObjectId).
    const dynamicKeys = order.filter((k) => classifySeg(k) !== 'static')
    const isMap = order.length >= MAP_MIN_KEYS && dynamicKeys.length / order.length >= MAP_ID_RATIO
    const memberKeys = isMap ? order.filter((k) => classifySeg(k) === 'static') : order

    const children: InferredField[] = []
    for (const k of memberKeys) {
      const childSrcs: SrcNode[] = []
      for (const s of objSrcs) {
        const cn = (s.node.children as Record<string, ShapeNode>)[k]
        if (cn) childSrcs.push({ node: cn, complete: s.complete })
      }
      const child = mergeField(k, childSrcs)
      child.sampleCount = denom
      child.presentIn = completeObjs.filter(
        (s) => (s.node.children as Record<string, ShapeNode>)[k] !== undefined
      ).length
      child.required = denom > 0 && child.presentIn === denom
      children.push(child)
    }
    if (isMap) {
      const repSrcs: SrcNode[] = []
      for (const s of objSrcs) {
        const cs = s.node.children as Record<string, ShapeNode>
        for (const k of dynamicKeys) if (cs[k]) repSrcs.push({ node: cs[k], complete: s.complete })
      }
      const rep = mergeField(MAP_VALUE_KEY, repSrcs)
      rep.sampleCount = repSrcs.length
      rep.presentIn = repSrcs.filter((s) => s.complete).length
      rep.required = repSrcs.length > 0
      children.push(rep)
      field.map = true
    }
    field.children = children
  }

  // array element (MAIN already merged an array's elements into one node)
  const arrSrcs = srcs.filter((s) => s.node.elem)
  if (arrSrcs.length) {
    const elem = mergeField(
      '[]',
      arrSrcs.map((s) => ({ node: s.node.elem as ShapeNode, complete: s.complete }))
    )
    elem.sampleCount = arrSrcs.length
    elem.presentIn = arrSrcs.length
    elem.required = arrSrcs.length > 0
    field.elem = elem
  }

  return field
}

/** Fold the sampled shapes into one inferred schema (associative; order-independent). */
export function mergeShapes(samples: ShapeSample[]): InferredSchema {
  const srcs: SrcNode[] = samples.map((s) => ({ node: s.root, complete: s.complete }))
  const root = mergeField('', srcs)
  const completeCount = samples.filter((s) => s.complete).length
  root.sampleCount = completeCount
  root.presentIn = completeCount
  root.required = completeCount > 0
  const rootKind: InferredSchema['rootKind'] = root.children
    ? 'object'
    : root.elem
      ? 'array'
      : 'scalar'
  return {
    root,
    rootKind,
    sampleCount: samples.length,
    truncatedCount: samples.filter((s) => !s.complete).length
  }
}
