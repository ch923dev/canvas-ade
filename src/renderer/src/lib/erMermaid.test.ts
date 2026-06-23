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
})
