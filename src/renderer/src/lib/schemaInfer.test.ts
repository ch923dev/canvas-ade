import { describe, it, expect } from 'vitest'
import {
  mergeShapes,
  isPiiName,
  MAP_VALUE_KEY,
  type ShapeNode,
  type ShapeSample,
  type ShapeType,
  type FormatHint,
  type InferredField
} from './schemaInfer'

/** A 24-hex Mongo-ObjectId-shaped key (the production case that exploded JD-4 before the map collapse). */
const oid = (n: number): string => `6985e4721a7df4910de64${String(n).padStart(3, '0')}`

const sc = (type: ShapeType, format?: FormatHint): ShapeNode => ({ types: [type], format })
const obj = (children: Record<string, ShapeNode>): ShapeNode => ({ types: ['object'], children })
const arr = (elem: ShapeNode): ShapeNode => ({ types: ['array'], elem })
const sample = (root: ShapeNode, complete = true): ShapeSample => ({ root, complete })

const childOf = (schema: ReturnType<typeof mergeShapes>, key: string): InferredField | undefined =>
  schema.root.children?.find((f) => f.key === key)

describe('mergeShapes dictionary/map collapse', () => {
  it('collapses an object keyed by dynamic ids into one {*} value field', () => {
    const entries: Record<string, ShapeNode> = {}
    for (let i = 0; i < 8; i++)
      entries[oid(i)] = obj({ _id: sc('string', 'uuid'), name: sc('string') })
    const schema = mergeShapes([sample(obj(entries))])
    expect(schema.root.map).toBe(true)
    expect(schema.root.children).toHaveLength(1)
    const rep = schema.root.children?.[0]
    expect(rep?.key).toBe(MAP_VALUE_KEY)
    // the representative carries the merged VALUE shape, not the hundreds of id keys
    expect(rep?.children?.map((c) => c.key).sort()).toEqual(['_id', 'name'])
  })

  it('keeps fixed (static) members alongside the collapsed map', () => {
    const entries: Record<string, ShapeNode> = { total: sc('number') }
    for (let i = 0; i < 8; i++) entries[oid(i)] = obj({ _id: sc('string') })
    const keys = mergeShapes([sample(obj(entries))]).root.children?.map((c) => c.key)
    expect(keys).toContain('total')
    expect(keys).toContain(MAP_VALUE_KEY)
  })

  it('does NOT collapse a normal record (few, word-named fields)', () => {
    const schema = mergeShapes([
      sample(obj({ id: sc('string'), name: sc('string'), email: sc('string') }))
    ])
    expect(schema.root.map).toBeUndefined()
    expect(schema.root.children?.map((c) => c.key)).toEqual(['id', 'name', 'email'])
  })
})

describe('isPiiName', () => {
  it('flags PII/secret names (and suffixes), not benign ones', () => {
    expect(isPiiName('email')).toBe(true)
    expect(isPiiName('userEmail')).toBe(true)
    expect(isPiiName('ssn')).toBe(true)
    expect(isPiiName('accessToken')).toBe(true)
    expect(isPiiName('name')).toBe(false)
    expect(isPiiName('id')).toBe(false)
  })
})

describe('mergeShapes', () => {
  it('marks always-present required and sometimes-present optional', () => {
    const schema = mergeShapes([
      sample(obj({ id: sc('string', 'uuid'), avatarUrl: sc('string') })),
      sample(obj({ id: sc('string', 'uuid') }))
    ])
    expect(schema.rootKind).toBe('object')
    expect(childOf(schema, 'id')?.required).toBe(true)
    expect(childOf(schema, 'id')?.format).toBe('uuid')
    const avatar = childOf(schema, 'avatarUrl')
    expect(avatar?.required).toBe(false)
    expect(avatar?.presentIn).toBe(1)
    expect(avatar?.sampleCount).toBe(2)
  })

  it('unions field types across samples (string | null)', () => {
    const schema = mergeShapes([
      sample(obj({ avatarUrl: sc('string') })),
      sample(obj({ avatarUrl: sc('null') }))
    ])
    expect(childOf(schema, 'avatarUrl')?.types.sort()).toEqual(['null', 'string'])
  })

  it('excludes truncated samples from the presence denominator (no false optional)', () => {
    const schema = mergeShapes([
      sample(obj({ id: sc('string'), name: sc('string') })),
      sample(obj({ id: sc('string'), name: sc('string') })),
      sample(obj({ id: sc('string') }), false) // truncated — must NOT make `name` optional
    ])
    expect(schema.truncatedCount).toBe(1)
    expect(childOf(schema, 'name')?.required).toBe(true)
    expect(childOf(schema, 'name')?.sampleCount).toBe(2)
  })

  it('flags a PII-named field', () => {
    const schema = mergeShapes([sample(obj({ email: sc('string', 'email') }))])
    expect(childOf(schema, 'email')?.pii).toBe(true)
  })

  it('merges nested objects and arrays-of-objects', () => {
    const schema = mergeShapes([
      sample(obj({ items: arr(obj({ sku: sc('string'), qty: sc('number') })) })),
      sample(obj({ items: arr(obj({ sku: sc('string') })) }))
    ])
    const items = childOf(schema, 'items')
    expect(items?.types).toEqual(['array'])
    const sku = items?.elem?.children?.find((f) => f.key === 'sku')
    const qty = items?.elem?.children?.find((f) => f.key === 'qty')
    expect(sku?.required).toBe(true)
    expect(qty?.required).toBe(false) // present in one element shape only
  })

  it('handles an empty sample set', () => {
    const schema = mergeShapes([])
    expect(schema.sampleCount).toBe(0)
    expect(schema.root.required).toBe(false)
  })

  it('detects an array-root schema', () => {
    const schema = mergeShapes([sample(arr(obj({ id: sc('string') })))])
    expect(schema.rootKind).toBe('array')
  })
})
