import { describe, it, expect } from 'vitest'
import { inferEntities, fkBaseName, type EntityInput } from './entityInfer'
import { mergeShapes, type ShapeNode, type ShapeType } from './schemaInfer'

const sc = (t: ShapeType): ShapeNode => ({ types: [t] })
const obj = (c: Record<string, ShapeNode>): ShapeNode => ({ types: ['object'], children: c })
const arr = (e: ShapeNode): ShapeNode => ({ types: ['array'], elem: e })
const schemaOf = (root: ShapeNode): EntityInput['schema'] => mergeShapes([{ root, complete: true }])

const inp = (p: Partial<EntityInput> & { schema: EntityInput['schema'] }): EntityInput => ({
  key: `GET ${p.routeName ?? 'x'}`,
  routeName: 'x',
  method: 'GET',
  ...p
})

const named = (
  m: ReturnType<typeof inferEntities>,
  n: string
): ReturnType<typeof inferEntities>['entities'][number] | undefined =>
  m.entities.find((e) => e.name === n)

describe('fkBaseName', () => {
  it('extracts the FK base name; ignores PKs', () => {
    expect(fkBaseName('customerId')).toBe('customer')
    expect(fkBaseName('customer_id')).toBe('customer')
    expect(fkBaseName('id')).toBeNull()
    expect(fkBaseName('uuid')).toBeNull()
    expect(fkBaseName('name')).toBeNull()
  })
})

describe('inferEntities', () => {
  it('infers a FK relationship when a *Id field matches another entity by name+type', () => {
    const model = inferEntities([
      inp({ routeName: 'users', schema: schemaOf(obj({ id: sc('string'), name: sc('string') })) }),
      inp({
        routeName: 'orders',
        schema: schemaOf(obj({ id: sc('string'), userId: sc('string') }))
      })
    ])
    expect(model.relationships).toContainEqual(
      expect.objectContaining({ from: 'User', to: 'Order', via: 'userId', kind: '1-*' })
    )
  })

  it('collapses an id-keyed dictionary into one entity named by its container, not by id values', () => {
    const entries: Record<string, ShapeNode> = {}
    for (let i = 0; i < 8; i++)
      entries[`6985e4721a7df4910de64${String(i).padStart(3, '0')}`] = obj({
        _id: sc('string'),
        name: sc('string')
      })
    const model = inferEntities([inp({ routeName: 'users', schema: schemaOf(obj(entries)) })])
    expect(named(model, 'User')).toBeDefined()
    expect(model.entities.every((e) => !/^[0-9a-f]{24}$/.test(e.name))).toBe(true)
  })

  it('never names an entity from an id value, even below the map-collapse threshold', () => {
    const entries: Record<string, ShapeNode> = {}
    for (let i = 0; i < 3; i++)
      entries[`6985e4721a7df4910de64${String(i).padStart(3, '0')}`] = obj({ _id: sc('string') })
    const model = inferEntities([inp({ routeName: 'inbox', schema: schemaOf(obj(entries)) })])
    expect(model.entities.every((e) => !/^[0-9a-f]{24}$/.test(e.name))).toBe(true)
  })

  it('never invents an edge when no entity name matches the FK target', () => {
    const model = inferEntities([
      inp({ routeName: 'users', schema: schemaOf(obj({ id: sc('string') })) }),
      inp({
        routeName: 'orders',
        schema: schemaOf(obj({ id: sc('string'), widgetId: sc('string') }))
      })
    ])
    expect(model.relationships).toHaveLength(0)
  })

  it('treats a flat response shape (no id, no fk) as a leaf with zero relationships', () => {
    const model = inferEntities([
      inp({
        routeName: 'weather',
        schema: schemaOf(obj({ city: sc('string'), tempC: sc('number') }))
      })
    ])
    expect(model.relationships).toHaveLength(0)
    const weather = named(model, 'Weather')
    expect(weather?.kind).toBe('shape')
    expect(weather?.isLeaf).toBe(true)
  })

  it('merges two routes that yield the same entity (array list + single item)', () => {
    const model = inferEntities([
      inp({
        key: 'GET /orders',
        routeName: 'orders',
        schema: schemaOf(arr(obj({ id: sc('string') })))
      }),
      inp({
        key: 'GET /orders/{id}',
        routeName: 'orders',
        schema: schemaOf(obj({ id: sc('string'), total: sc('number') }))
      })
    ])
    const order = named(model, 'Order')
    expect(order?.kind).toBe('entity')
    expect(order?.producedBy).toHaveLength(2)
    expect(order?.fieldKeys).toEqual(expect.arrayContaining(['id', 'total']))
  })

  it('routes POST responses to consumedBy', () => {
    const model = inferEntities([
      inp({
        key: 'POST /orders',
        routeName: 'orders',
        method: 'POST',
        schema: schemaOf(obj({ id: sc('string') }))
      })
    ])
    expect(named(model, 'Order')?.consumedBy).toEqual(['POST /orders'])
    expect(named(model, 'Order')?.producedBy).toEqual([])
  })

  it('UNWRAPS an envelope: { status, data: { id, customerId } } → the data object is the route entity', () => {
    const model = inferEntities([
      inp({
        routeName: 'orders',
        schema: schemaOf(
          obj({ status: sc('string'), data: obj({ id: sc('string'), customerId: sc('string') }) })
        )
      }),
      inp({ routeName: 'customers', schema: schemaOf(obj({ id: sc('string') })) })
    ])
    const order = named(model, 'Order')
    expect(order?.kind).toBe('entity') // NOT a shape — unwrapped from `data`
    expect(order?.fieldKeys).toEqual(expect.arrayContaining(['id', 'customerId']))
    // the FK inside the envelope is seen → relationship inferred
    expect(model.relationships).toContainEqual(
      expect.objectContaining({ from: 'Customer', to: 'Order', via: 'customerId', kind: '1-*' })
    )
  })

  it('UNWRAPS an envelope list: { data: [ { id } ] } → the element is the route entity', () => {
    const model = inferEntities([
      inp({ routeName: 'users', schema: schemaOf(obj({ data: arr(obj({ id: sc('string') })) })) })
    ])
    expect(named(model, 'User')?.kind).toBe('entity')
  })

  it('promotes a NESTED object with its own id to an embedded entity + a containment edge', () => {
    const model = inferEntities([
      inp({
        routeName: 'orders',
        schema: schemaOf(
          obj({ id: sc('string'), customer: obj({ id: sc('string'), name: sc('string') }) })
        )
      })
    ])
    expect(named(model, 'Order')?.kind).toBe('entity')
    expect(named(model, 'Customer')?.kind).toBe('entity')
    expect(model.relationships).toContainEqual(
      expect.objectContaining({ from: 'Order', to: 'Customer', via: 'customer', kind: '1-1' })
    )
  })

  it('a value object with NO id stays nested shape, not an entity', () => {
    const model = inferEntities([
      inp({
        routeName: 'users',
        schema: schemaOf(
          obj({ id: sc('string'), address: obj({ street: sc('string'), city: sc('string') }) })
        )
      })
    ])
    expect(named(model, 'User')?.kind).toBe('entity')
    expect(named(model, 'Address')).toBeUndefined() // no id → not promoted
    expect(model.relationships).toHaveLength(0)
  })
})
