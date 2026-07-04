import { describe, it, expect } from 'vitest'
import {
  buildPlanningUpdateOp,
  describeElement,
  renderPlanningEditConfirmBody
} from './mcpPlanningEdit'
import { PlanningContentError } from './mcpPlanning'

/**
 * S6: MAIN-authoritative validation/sanitization for a planning-element edit. `buildPlanningUpdateOp`
 * validates the patch AGAINST the resolved element kind — a field for another kind is rejected — and
 * reuses the S2 planning sanitizers so an edit lands byte-identical to an add.
 */
describe('buildPlanningUpdateOp — kind-validated planning edits', () => {
  it('note: accepts text + tint', () => {
    const op = buildPlanningUpdateOp('n1', 'note', { text: 'now correct', tint: 'green' })
    expect(op).toEqual({
      op: 'update',
      elementId: 'n1',
      kind: 'note',
      patch: { text: 'now correct', tint: 'green' }
    })
  })

  it('note: rejects a checklist field (title)', () => {
    expect(() => buildPlanningUpdateOp('n1', 'note', { title: 'x' })).toThrow(PlanningContentError)
  })

  it('note: rejects a bad tint enum', () => {
    expect(() => buildPlanningUpdateOp('n1', 'note', { tint: 'chartreuse' })).toThrow(
      PlanningContentError
    )
  })

  it('text: accepts text, rejects tint', () => {
    expect(buildPlanningUpdateOp('t1', 'text', { text: 'hi' }).patch).toEqual({ text: 'hi' })
    expect(() => buildPlanningUpdateOp('t1', 'text', { tint: 'blue' })).toThrow(
      PlanningContentError
    )
  })

  it('checklist: accepts title + setItems + addItems + removeItemIds', () => {
    const op = buildPlanningUpdateOp('c1', 'checklist', {
      title: 'Build progress',
      setItems: [{ id: 'i1', done: true }],
      addItems: [{ label: 'new task' }],
      removeItemIds: ['i2']
    })
    expect(op.op).toBe('update')
    if (op.op !== 'update') throw new Error('expected update')
    expect(op.patch.title).toBe('Build progress')
    expect(op.patch.setItems).toEqual([{ id: 'i1', done: true }])
    expect(op.patch.addItems).toEqual([{ label: 'new task', done: false }])
    expect(op.patch.removeItemIds).toEqual(['i2'])
  })

  it('checklist: rejects a note field (text)', () => {
    expect(() => buildPlanningUpdateOp('c1', 'checklist', { text: 'x' })).toThrow(
      PlanningContentError
    )
  })

  it('checklist: rejects a setItems entry with neither label nor done', () => {
    expect(() => buildPlanningUpdateOp('c1', 'checklist', { setItems: [{ id: 'i1' }] })).toThrow(
      PlanningContentError
    )
  })

  it('checklist: rejects a setItems entry with an empty id', () => {
    expect(() =>
      buildPlanningUpdateOp('c1', 'checklist', { setItems: [{ id: '', done: true }] })
    ).toThrow(PlanningContentError)
  })

  it('diagram: accepts source, rejects dx', () => {
    expect(
      buildPlanningUpdateOp('d1', 'diagram', { source: 'graph TD\n A-->B' }).patch.source
    ).toBe('graph TD\n A-->B')
    expect(() => buildPlanningUpdateOp('d1', 'diagram', { dx: 10 })).toThrow(PlanningContentError)
  })

  it('arrow: requires BOTH dx and dy', () => {
    expect(buildPlanningUpdateOp('a1', 'arrow', { dx: 10, dy: -5 }).patch).toEqual({
      dx: 10,
      dy: -5
    })
    expect(() => buildPlanningUpdateOp('a1', 'arrow', { dx: 10 })).toThrow(PlanningContentError)
  })

  it('rejects an un-editable kind (image) — remove it instead', () => {
    expect(() => buildPlanningUpdateOp('img1', 'image', { text: 'x' })).toThrow(
      PlanningContentError
    )
  })

  it('rejects an empty patch (no applicable field)', () => {
    expect(() => buildPlanningUpdateOp('n1', 'note', {})).toThrow(PlanningContentError)
  })

  it('sanitizes control characters out of text (mirrors the add path)', () => {
    // A C1 escape (0x9b) is stripped; the newline is kept.
    const op = buildPlanningUpdateOp('n1', 'note', { text: 'ab\nc' })
    expect(op.patch.text).toBe('ab\nc')
  })
})

describe('describeElement / renderPlanningEditConfirmBody', () => {
  it('describeElement previews the label + truncates a long one', () => {
    expect(describeElement('checklist', 'Build progress')).toBe('checklist "Build progress"')
    expect(describeElement('note', undefined)).toBe('note element')
    expect(describeElement('note', 'x'.repeat(80))).toMatch(/…"$/)
  })

  it('remove body names the element + says it deletes', () => {
    const body = renderPlanningEditConfirmBody(
      'My plan',
      { op: 'remove', elementId: 'c1' },
      'checklist "Build progress"'
    )
    expect(body).toContain('REMOVE checklist "Build progress"')
    expect(body).toContain('My plan')
  })

  it('update body lists each changed field for the human to see', () => {
    const op = buildPlanningUpdateOp('c1', 'checklist', {
      setItems: [{ id: 'i1', done: true }],
      addItems: [{ label: 'ship it' }]
    })
    const body = renderPlanningEditConfirmBody('My plan', op, 'checklist "Build progress"')
    expect(body).toContain('Item i1: mark done')
    expect(body).toContain('Add item ☐ ship it')
  })
})
