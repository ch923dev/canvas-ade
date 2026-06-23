/**
 * Entity + PK/FK inference for the Data Flow inventory (JD-3, REPORT engine 3).
 *
 * Walks the FULL inferred-schema tree of each route and treats **any object that carries an identity
 * field** (`id`/`_id`/`uuid`/`guid`, scalar) as an entity — wherever it lives. So an enveloped response
 * `{ status, data: { id, … } }` or `{ data: [ { id, … } ] }` is unwrapped (the `data`/`result`/`payload`
 * wrapper is transparent and the inner object becomes the route's entity), and a nested object with its
 * own id (`order.customer`) is promoted to its own entity too. Detection is **structural** — presence of
 * an identity field + field NAMES/TYPES, never values (ADR 0010; value-overlap is deferred).
 *
 * Relationships are inferred two ways, both name+type only: a scalar `<x>Id` foreign key whose base name
 * matches another entity, and an embedded object/array that is itself an entity (containment). A shape
 * with no identity field anywhere, referenced by nothing, stays a LEAF — and we **never invent an edge**.
 */
import {
  MAP_VALUE_KEY,
  type InferredField,
  type InferredSchema,
  type ShapeType
} from './schemaInfer'
import { classifySeg } from './routeTemplate'

export interface FkField {
  via: string // the FK field key (e.g. customerId)
  target: string // the inferred target entity base name (e.g. customer)
}
export interface Entity {
  name: string // PascalCase singular (User, Order, LineItem)
  kind: 'entity' | 'shape' // 'shape' = no identity field anywhere (a response shape, possibly a leaf)
  pk?: string // primary-key field name (id/_id/uuid)
  schemaKey: string // a representative route template key
  fields: InferredField[] // the entity's own member nodes (unwrapped — for the inspector display)
  fieldKeys: string[] // member names (union across producing routes)
  producedBy: string[] // GET/HEAD/WS route keys returning this shape
  consumedBy: string[] // POST/PUT/PATCH/DELETE route keys returning this shape
  fkFields: FkField[] // foreign-key candidate fields on this entity
  isLeaf: boolean // no id, referenced by nothing, references nothing
}
export interface Relationship {
  from: string // the "one" side (referenced / containing entity)
  to: string // the "many" side (holds the FK) or the contained entity
  via: string // the FK field key, or the embedding field key
  kind: '1-*' | '1-1'
  confidence: 'name+type'
}
export interface EntityModel {
  entities: Entity[]
  relationships: Relationship[]
}
export interface EntityInput {
  key: string // route template key
  routeName: string // last static path segment (users / orders / weather) — normalized here
  method: string // GET / POST / WS …
  schema: InferredSchema
}

const ID_KEY_RE = /^_?(id|uuid|guid)$/i
const FK_CAMEL_RE = /^([a-z][a-zA-Z0-9]*)Id$/ // customerId → customer
const FK_SNAKE_RE = /^(.+)_id$/ // customer_id → customer
// Generic response wrappers: when the root has no id and one of these holds the payload, it is unwrapped
// transparently so the inner object/array becomes the ROUTE's entity (named by the route, not the wrapper).
const ENVELOPE_KEYS = new Set([
  'data',
  'result',
  'results',
  'payload',
  'record',
  'records',
  'item',
  'items',
  'response',
  'content',
  'body',
  'value'
])

function singular(s: string): string {
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y'
  if (/s$/i.test(s) && s.length > 1) return s.slice(0, -1)
  return s
}
function singularLower(s: string): string {
  return singular(s).toLowerCase()
}
function pascalSingular(s: string): string {
  const w = singular(s)
  return w ? w[0].toUpperCase() + w.slice(1) : w
}
/** Name a nested object's entity. A collapsed map's representative value (`{*}`) and any stray id-shaped
 *  key (a sub-threshold id map that escaped the schema collapse) are named after their CONTAINER — an id
 *  VALUE must never become an entity name: it would leak a value AND break the Mermaid export (the JD-4
 *  production-data fix). Any normal key becomes its PascalCase singular. */
function childEntityName(key: string, containerName: string): string {
  if (key === MAP_VALUE_KEY || classifySeg(key) !== 'static') return containerName
  return pascalSingular(key)
}
function isScalarId(types: ShapeType[]): boolean {
  return types.includes('string') || types.includes('number')
}

/** An object's identity field (drives entity-hood + the PK), or undefined. */
function identityField(fields: InferredField[]): InferredField | undefined {
  return fields.find((f) => ID_KEY_RE.test(f.key) && isScalarId(f.types))
}

/** The target entity base name a scalar FK field references, or null if the key isn't an FK. Exported
 *  so the inventory display can accent/tag FK fields against the inferred entity set. */
export function fkBaseName(key: string): string | null {
  if (ID_KEY_RE.test(key)) return null
  const m = FK_CAMEL_RE.exec(key) ?? FK_SNAKE_RE.exec(key)
  return m ? m[1] : null
}

/** The object members at a node, whether it is an object or an array-of-object. */
function objectFields(node: InferredField): InferredField[] | undefined {
  if (node.children) return node.children
  if (node.elem?.children) return node.elem.children
  return undefined
}

interface Embed {
  via: string
  target: string
  many: boolean
}

function ensure(
  byName: Map<string, Entity>,
  embeds: Map<string, Embed[]>,
  name: string,
  schemaKey: string
): Entity {
  const k = singularLower(name)
  let e = byName.get(k)
  if (!e) {
    e = {
      name: pascalSingular(name),
      kind: 'shape',
      schemaKey,
      fields: [],
      fieldKeys: [],
      producedBy: [],
      consumedBy: [],
      fkFields: [],
      isLeaf: false
    }
    byName.set(k, e)
    embeds.set(k, [])
  }
  return e
}

function bucketFor(e: Entity, method: string): string[] {
  return method === 'GET' || method === 'HEAD' || method === 'WS' ? e.producedBy : e.consumedBy
}

/**
 * Recursively collect entities from a schema node. `nameHint` names the entity if THIS node has an id;
 * `atRoot` lets envelope keys keep the route name while we descend through the wrapper.
 */
function collect(
  node: InferredField,
  nameHint: string,
  atRoot: boolean,
  input: EntityInput,
  byName: Map<string, Entity>,
  embeds: Map<string, Embed[]>
): void {
  const fields = objectFields(node)
  if (!fields) return // scalar / array-of-scalar — no entity here
  const idf = identityField(fields)

  if (idf) {
    const e = ensure(byName, embeds, nameHint, input.key)
    e.kind = 'entity'
    e.pk = idf.key
    for (const f of fields) {
      if (!e.fieldKeys.includes(f.key)) {
        e.fieldKeys.push(f.key)
        e.fields.push(f)
      }
    }
    const bucket = bucketFor(e, input.method)
    if (!bucket.includes(input.key)) bucket.push(input.key)
    for (const f of fields) {
      const t = fkBaseName(f.key)
      if (t && f.key !== idf.key && !e.fkFields.some((x) => x.via === f.key)) {
        e.fkFields.push({ via: f.key, target: t })
      }
    }
    // descend into nested containers — each is its own (possibly embedded) entity, named by its key
    const list = embeds.get(singularLower(nameHint))
    for (const f of fields) {
      if (objectFields(f)) {
        const childName = childEntityName(f.key, nameHint)
        collect(f, childName, false, input, byName, embeds)
        if (list && !list.some((x) => x.via === f.key)) {
          list.push({ via: f.key, target: childName, many: !!f.elem || !!f.map })
        }
      }
    }
  } else {
    // no id at this level — descend; an envelope wrapper keeps the ROUTE name for its payload
    for (const f of fields) {
      if (objectFields(f)) {
        const env = ENVELOPE_KEYS.has(f.key.toLowerCase())
        const childName = env && atRoot ? input.routeName : childEntityName(f.key, nameHint)
        collect(f, childName, env && atRoot, input, byName, embeds)
      }
    }
  }
}

export function inferEntities(inputs: EntityInput[]): EntityModel {
  const byName = new Map<string, Entity>()
  const embeds = new Map<string, Embed[]>()

  for (const input of inputs) {
    collect(input.schema.root, input.routeName || 'shape', true, input, byName, embeds)
    // A route whose tree had NO identity field anywhere → register it as a leaf shape so the inspector
    // still shows it (named by route, its top-level fields displayed).
    const produced = [...byName.values()].some(
      (e) => e.producedBy.includes(input.key) || e.consumedBy.includes(input.key)
    )
    if (!produced) {
      const e = ensure(byName, embeds, input.routeName || 'shape', input.key)
      const fields = objectFields(input.schema.root) ?? []
      for (const f of fields) {
        if (!e.fieldKeys.includes(f.key)) {
          e.fieldKeys.push(f.key)
          e.fields.push(f)
        }
      }
      const bucket = bucketFor(e, input.method)
      if (!bucket.includes(input.key)) bucket.push(input.key)
    }
  }

  const relationships: Relationship[] = []
  const seen = new Set<string>()
  const referenced = new Set<string>()
  const add = (from: string, to: string, via: string, kind: Relationship['kind']): void => {
    const sig = `${from}|${to}|${via}|${kind}`
    if (seen.has(sig)) return
    seen.add(sig)
    relationships.push({ from, to, via, kind, confidence: 'name+type' })
    referenced.add(from)
    referenced.add(to)
  }

  for (const e of byName.values()) {
    for (const fk of e.fkFields) {
      const t = byName.get(singularLower(fk.target))
      if (t && t !== e) add(t.name, e.name, fk.via, '1-*') // target (one) 1—* e (holds the FK)
    }
    for (const em of embeds.get(singularLower(e.name)) ?? []) {
      const t = byName.get(singularLower(em.target))
      if (t && t !== e) add(e.name, t.name, em.via, em.many ? '1-*' : '1-1') // e contains target
    }
  }

  const entities = [...byName.values()]
  for (const e of entities) {
    e.isLeaf = e.kind === 'shape' && e.fkFields.length === 0 && !referenced.has(e.name)
  }
  return { entities, relationships }
}
