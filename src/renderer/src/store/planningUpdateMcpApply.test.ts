import { describe, it, expect } from 'vitest'
import { applyPlanningEditOp } from './planningUpdateMcpApply'
import type { PlanningElement } from '../lib/boardSchema'

/**
 * S6: the pure renderer applier for a planning-element edit/remove op. MAIN already validated the patch
 * against the element kind + human-confirmed it; this applies it to the live `elements` array via the
 * per-kind mutators. The `useMcpCommands` applier re-validates the changed element before it lands.
 */
const note: PlanningElement = {
  id: 'n1',
  kind: 'note',
  x: 0,
  y: 0,
  w: 156,
  h: 96,
  tint: 'yellow',
  text: 'old'
}
const text: PlanningElement = { id: 't1', kind: 'text', x: 0, y: 0, text: 'old text' }
const checklist: PlanningElement = {
  id: 'c1',
  kind: 'checklist',
  x: 0,
  y: 0,
  w: 240,
  h: 0,
  title: 'Progress',
  items: [
    { id: 'i1', label: 'one', done: false },
    { id: 'i2', label: 'two', done: false }
  ]
}
const diagram: PlanningElement = {
  id: 'd1',
  kind: 'diagram',
  x: 0,
  y: 0,
  w: 280,
  h: 200,
  source: 'graph TD\n A',
  engine: 'mermaid',
  svgCache: 'assets/old.svg'
}
const arrow: PlanningElement = { id: 'a1', kind: 'arrow', x: 10, y: 20, x2: 30, y2: 40 }
const els: PlanningElement[] = [note, text, checklist, diagram, arrow]

describe('applyPlanningEditOp — in-place element edits', () => {
  it('note: sets text + tint', () => {
    const out = applyPlanningEditOp(els, {
      op: 'update',
      elementId: 'n1',
      kind: 'note',
      patch: { text: 'new', tint: 'green' }
    })
    const n = out.find((e) => e.id === 'n1')
    expect(n).toMatchObject({ kind: 'note', text: 'new', tint: 'green' })
    // other elements untouched (immutable)
    expect(out.find((e) => e.id === 't1')).toBe(text)
  })

  it('text: sets the body', () => {
    const out = applyPlanningEditOp(els, {
      op: 'update',
      elementId: 't1',
      kind: 'text',
      patch: { text: 'fresh' }
    })
    expect(out.find((e) => e.id === 't1')).toMatchObject({ kind: 'text', text: 'fresh' })
  })

  it('checklist: sets item done/label, appends, removes, retitles', () => {
    const out = applyPlanningEditOp(els, {
      op: 'update',
      elementId: 'c1',
      kind: 'checklist',
      patch: {
        title: 'Build progress',
        setItems: [{ id: 'i1', done: true, label: 'first' }],
        addItems: [{ label: 'three', done: false }],
        removeItemIds: ['i2']
      }
    })
    const c = out.find((e) => e.id === 'c1')
    if (!c || c.kind !== 'checklist') throw new Error('expected checklist')
    expect(c.title).toBe('Build progress')
    expect(c.items).toHaveLength(2) // i1 kept (edited), i2 removed, one appended
    expect(c.items[0]).toMatchObject({ id: 'i1', done: true, label: 'first' })
    expect(c.items[1]).toMatchObject({ label: 'three', done: false })
    expect(typeof c.items[1].id).toBe('string')
    expect(c.items[1].id).not.toBe('')
  })

  it('diagram: replaces source and invalidates the SVG cache', () => {
    const out = applyPlanningEditOp(els, {
      op: 'update',
      elementId: 'd1',
      kind: 'diagram',
      patch: { source: 'graph LR\n X-->Y' }
    })
    const d = out.find((e) => e.id === 'd1')
    if (!d || d.kind !== 'diagram') throw new Error('expected diagram')
    expect(d.source).toBe('graph LR\n X-->Y')
    expect(d.svgCache).toBeUndefined()
  })

  it('arrow: sets the endpoint from the delta (relative to the tail)', () => {
    const out = applyPlanningEditOp(els, {
      op: 'update',
      elementId: 'a1',
      kind: 'arrow',
      patch: { dx: 100, dy: 50 }
    })
    const a = out.find((e) => e.id === 'a1')
    expect(a).toMatchObject({ kind: 'arrow', x: 10, y: 20, x2: 110, y2: 70 })
  })

  it('remove: drops the element by id', () => {
    const out = applyPlanningEditOp(els, { op: 'remove', elementId: 'c1' })
    expect(out.find((e) => e.id === 'c1')).toBeUndefined()
    expect(out).toHaveLength(els.length - 1)
  })

  it('throws when the element id is absent (stale read)', () => {
    expect(() => applyPlanningEditOp(els, { op: 'remove', elementId: 'ghost' })).toThrow(
      /not found/
    )
  })

  it('throws when the live kind no longer matches the op kind', () => {
    expect(() =>
      applyPlanningEditOp(els, {
        op: 'update',
        elementId: 'n1',
        kind: 'checklist',
        patch: { title: 'x' }
      })
    ).toThrow(/kind mismatch/)
  })

  const bigChecklist = (): PlanningElement => ({
    id: 'c9',
    kind: 'checklist',
    x: 0,
    y: 0,
    w: 240,
    h: 0,
    title: 'Big',
    items: Array.from({ length: 100 }, (_, i) => ({ id: `x${i}`, label: `${i}`, done: false }))
  })

  it('throws on an unmatched setItems / removeItemIds id (stale read → not a false success)', () => {
    expect(() =>
      applyPlanningEditOp(els, {
        op: 'update',
        elementId: 'c1',
        kind: 'checklist',
        patch: { setItems: [{ id: 'ghost', done: true }] }
      })
    ).toThrow(/unknown checklist item/)
    expect(() =>
      applyPlanningEditOp(els, {
        op: 'update',
        elementId: 'c1',
        kind: 'checklist',
        patch: { removeItemIds: ['ghost'] }
      })
    ).toThrow(/unknown checklist item/)
  })

  it('rejects an add that grows the checklist past the cumulative item cap', () => {
    expect(() =>
      applyPlanningEditOp([bigChecklist()], {
        op: 'update',
        elementId: 'c9',
        kind: 'checklist',
        patch: { addItems: [{ label: 'one more', done: false }] }
      })
    ).toThrow(/item cap exceeded/)
  })

  it('still allows editing/pruning an already-large checklist (only growth is capped)', () => {
    // Tick an item (no add) on a 100-item list → fine.
    const out = applyPlanningEditOp([bigChecklist()], {
      op: 'update',
      elementId: 'c9',
      kind: 'checklist',
      patch: { setItems: [{ id: 'x0', done: true }] }
    })
    const c = out.find((e) => e.id === 'c9')
    if (!c || c.kind !== 'checklist') throw new Error('expected checklist')
    expect(c.items[0].done).toBe(true)
    expect(c.items).toHaveLength(100)
    // Remove 1 then add 1 → net no growth → allowed.
    const swapped = applyPlanningEditOp([bigChecklist()], {
      op: 'update',
      elementId: 'c9',
      kind: 'checklist',
      patch: { removeItemIds: ['x0'], addItems: [{ label: 'replacement', done: false }] }
    })
    const c2 = swapped.find((e) => e.id === 'c9')
    if (!c2 || c2.kind !== 'checklist') throw new Error('expected checklist')
    expect(c2.items).toHaveLength(100)
  })
})
