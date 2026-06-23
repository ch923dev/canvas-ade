import { describe, it, expect } from 'vitest'
import { toErMermaid } from './erMermaid'
import type { Entity, EntityModel } from './entityInfer'
import type { FormatHint, InferredField, ShapeType } from './schemaInfer'

const field = (
  key: string,
  types: ShapeType[],
  extra: Partial<InferredField> = {}
): InferredField => ({ key, types, presentIn: 1, sampleCount: 1, required: true, ...extra })

const entity = (e: Partial<Entity> & Pick<Entity, 'name' | 'kind'>): Entity => ({
  schemaKey: 'k',
  fields: [],
  fieldKeys: [],
  producedBy: [],
  consumedBy: [],
  fkFields: [],
  isLeaf: false,
  ...e
})

function model(): EntityModel {
  return {
    entities: [
      entity({
        name: 'User',
        kind: 'entity',
        pk: 'id',
        fields: [
          field('id', ['string'], { format: 'uuid' as FormatHint }),
          field('email', ['string'], { format: 'email' as FormatHint, pii: true })
        ]
      }),
      entity({
        name: 'Order',
        kind: 'entity',
        pk: 'id',
        fkFields: [{ via: 'customerId', target: 'user' }],
        fields: [
          field('id', ['string'], { format: 'uuid' as FormatHint }),
          field('customerId', ['string']),
          field('total', ['number']),
          field('items', ['array'], { elem: field('[]', ['object']) })
        ]
      }),
      // a leaf shape (no identity) — must NOT be drawn
      entity({ name: 'Weather', kind: 'shape', isLeaf: true, fields: [field('tempC', ['number'])] })
    ],
    relationships: [
      { from: 'User', to: 'Order', via: 'customerId', kind: '1-*', confidence: 'name+type' }
    ]
  }
}

describe('toErMermaid', () => {
  const src = toErMermaid(model())

  it('starts with the erDiagram header', () => {
    expect(src.startsWith('erDiagram')).toBe(true)
  })

  it('draws identity entities but not leaf shapes', () => {
    expect(src).toContain('User {')
    expect(src).toContain('Order {')
    expect(src).not.toContain('Weather')
  })

  it('marks the primary key with PK and uses the format hint as the type', () => {
    expect(src).toContain('uuid id PK')
  })

  it('marks a foreign-key field with FK', () => {
    expect(src).toContain('string customerId FK')
  })

  it('maps arrays to list and numbers to number (structure only, no values)', () => {
    expect(src).toContain('number total')
    expect(src).toContain('list items')
  })

  it('emits the relationship with the right cardinality and label', () => {
    expect(src).toContain('User ||--o{ Order : "customerId"')
  })

  it('renders a 1-1 relationship with ||--||', () => {
    const m = model()
    m.relationships = [
      { from: 'User', to: 'Order', via: 'profileId', kind: '1-1', confidence: 'name+type' }
    ]
    expect(toErMermaid(m)).toContain('User ||--|| Order : "profileId"')
  })

  it('drops a relationship whose endpoint is not an emitted entity box', () => {
    const m = model()
    m.relationships = [
      { from: 'User', to: 'Ghost', via: 'ghostId', kind: '1-*', confidence: 'name+type' }
    ]
    expect(toErMermaid(m)).not.toContain('Ghost')
  })

  it('sanitizes entity names to valid Mermaid identifiers', () => {
    const m: EntityModel = {
      entities: [
        entity({ name: 'Line Item', kind: 'entity', pk: 'id', fields: [field('id', ['string'])] })
      ],
      relationships: []
    }
    expect(toErMermaid(m)).toContain('Line_Item {')
  })

  it('returns a header-only diagram for a flat API (no identity entities)', () => {
    const flat: EntityModel = {
      entities: [entity({ name: 'Weather', kind: 'shape', fields: [field('tempC', ['number'])] })],
      relationships: []
    }
    const out = toErMermaid(flat)
    expect(out.startsWith('erDiagram')).toBe(true)
    expect(out).toContain('no entities inferred')
    expect(out).not.toContain('Weather {')
  })

  it('prefixes a digit-leading entity name so Mermaid can never fail to lex it (the export-crash fix)', () => {
    // A 24-hex ObjectId that escaped upstream as an entity name — Mermaid would otherwise reject it with
    // "Expecting 'COLON', got 'UNICODE_TEXT'" because an identifier may not start with a digit.
    const m: EntityModel = {
      entities: [
        entity({ name: 'User', kind: 'entity', pk: 'id', fields: [field('id', ['string'])] }),
        entity({
          name: '6985e4721a7df4910de6434e',
          kind: 'entity',
          pk: '_id',
          fields: [field('_id', ['string'])]
        })
      ],
      relationships: [
        {
          from: 'User',
          to: '6985e4721a7df4910de6434e',
          via: 'ref',
          kind: '1-*',
          confidence: 'name+type'
        }
      ]
    }
    const out = toErMermaid(m)
    expect(out).toContain('E_6985e4721a7df4910de6434e {') // entity box header prefixed
    expect(out).toMatch(/User \|\|--o\{ E_6985e4721a7df4910de6434e/) // relationship target prefixed
    expect(out).not.toMatch(/\s6985e4721a7df4910de6434e\b/) // the raw id never appears as a bare token
  })
})
