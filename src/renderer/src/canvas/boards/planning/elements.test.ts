import { describe, it, expect } from 'vitest'
import type { ChecklistElement, PlanningElement } from '../../../lib/boardSchema'
import {
  makeNote,
  makeText,
  makeChecklist,
  makeArrow,
  makeStroke,
  moveElement,
  removeElement,
  toggleItem,
  addItem,
  removeItem,
  setItemLabel,
  checklistProgress,
  NOTE_SIZE,
  CHECKLIST_W
} from './elements'

describe('element factories', () => {
  it('makeNote centres on the drop point and cycles tint + rotation by index', () => {
    const n0 = makeNote('n0', { x: 200, y: 120 }, 0)
    expect(n0.kind).toBe('note')
    expect(n0.w).toBe(NOTE_SIZE.w)
    expect(n0.x).toBe(200 - NOTE_SIZE.w / 2)
    expect(n0.tint).toBe('yellow')
    const n1 = makeNote('n1', { x: 0, y: 0 }, 1)
    expect(n1.tint).toBe('blue')
    expect(n1.rotation).not.toBe(n0.rotation)
  })

  it('makeNote honours an explicit tint', () => {
    expect(makeNote('n', { x: 0, y: 0 }, 0, 'green').tint).toBe('green')
  })

  it('makeText anchors at the drop point with empty text', () => {
    const t = makeText('t', { x: 12.4, y: 30.9 })
    expect(t).toEqual({ id: 't', kind: 'text', x: 12, y: 31, text: '' })
  })

  it('makeChecklist seeds one empty item, centred horizontally', () => {
    const cl = makeChecklist('cl', 'i0', { x: 300, y: 90 })
    expect(cl.kind).toBe('checklist')
    expect(cl.w).toBe(CHECKLIST_W)
    expect(cl.x).toBe(300 - CHECKLIST_W / 2)
    expect(cl.items).toEqual([{ id: 'i0', label: '', done: false }])
  })

  it('makeArrow seeds a zero-length arrow at the drop point', () => {
    const a = makeArrow('a', { x: 5, y: 7 })
    expect(a).toEqual({ id: 'a', kind: 'arrow', x: 5, y: 7, x2: 5, y2: 7 })
  })

  it('makeStroke wraps a flat point list at the origin', () => {
    const s = makeStroke('s', [0, 0, 4, 4])
    expect(s).toEqual({ id: 's', kind: 'stroke', x: 0, y: 0, points: [0, 0, 4, 4] })
  })
})

describe('array transforms (immutable)', () => {
  const cl = makeChecklist('cl', 'i0', { x: 0, y: 0 })
  const note = makeNote('n', { x: 0, y: 0 }, 0)
  const base: PlanningElement[] = [cl, note]

  it('moveElement repositions only the target, leaving the array immutable', () => {
    const next = moveElement(base, 'n', 50, 60)
    expect(next).not.toBe(base)
    const moved = next.find((e) => e.id === 'n')!
    expect([moved.x, moved.y]).toEqual([50, 60])
    expect(base.find((e) => e.id === 'n')!.x).toBe(note.x) // original untouched
  })

  it('removeElement drops the target by id', () => {
    expect(removeElement(base, 'n').map((e) => e.id)).toEqual(['cl'])
    expect(removeElement(base, 'nope')).toHaveLength(2)
  })
})

describe('checklist mutations + live progress', () => {
  const seed = (): PlanningElement[] => [makeChecklist('cl', 'i0', { x: 0, y: 0 })]

  it('addItem appends an empty item', () => {
    const next = addItem(seed(), 'cl', 'i1')
    const cl = next[0] as ChecklistElement
    expect(cl.items.map((i) => i.id)).toEqual(['i0', 'i1'])
    expect(cl.items[1]).toEqual({ id: 'i1', label: '', done: false })
  })

  it('toggleItem flips a single item without touching siblings', () => {
    let els = addItem(seed(), 'cl', 'i1')
    els = toggleItem(els, 'cl', 'i1')
    const cl = els[0] as ChecklistElement
    expect(cl.items.find((i) => i.id === 'i1')!.done).toBe(true)
    expect(cl.items.find((i) => i.id === 'i0')!.done).toBe(false)
    // Toggling again flips back (live, idempotent in pairs).
    const back = toggleItem(els, 'cl', 'i1')[0] as ChecklistElement
    expect(back.items.find((i) => i.id === 'i1')!.done).toBe(false)
  })

  it('setItemLabel edits one item label', () => {
    const cl = setItemLabel(seed(), 'cl', 'i0', 'Ship it')[0] as ChecklistElement
    expect(cl.items[0].label).toBe('Ship it')
  })

  it('removeItem drops one item', () => {
    let els = addItem(seed(), 'cl', 'i1')
    els = removeItem(els, 'cl', 'i0')
    expect((els[0] as ChecklistElement).items.map((i) => i.id)).toEqual(['i1'])
  })

  it('checklistProgress reflects live done/total ratio', () => {
    let els = seed()
    els = addItem(els, 'cl', 'i1')
    els = addItem(els, 'cl', 'i2')
    expect(checklistProgress(els[0] as ChecklistElement)).toEqual({ done: 0, total: 3, pct: 0 })

    els = toggleItem(els, 'cl', 'i0')
    expect(checklistProgress(els[0] as ChecklistElement)).toEqual({ done: 1, total: 3, pct: 33 })

    els = toggleItem(els, 'cl', 'i1')
    els = toggleItem(els, 'cl', 'i2')
    expect(checklistProgress(els[0] as ChecklistElement)).toEqual({ done: 3, total: 3, pct: 100 })
  })

  it('progress is 0% for an empty checklist (no divide-by-zero)', () => {
    const empty: ChecklistElement = {
      id: 'cl',
      kind: 'checklist',
      x: 0,
      y: 0,
      w: CHECKLIST_W,
      h: 0,
      title: 'Empty',
      items: []
    }
    expect(checklistProgress(empty)).toEqual({ done: 0, total: 0, pct: 0 })
  })
})
