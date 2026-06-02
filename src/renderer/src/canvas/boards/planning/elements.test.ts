import { describe, it, expect } from 'vitest'
import type { ChecklistElement, PlanningElement } from '../../../lib/boardSchema'
import {
  makeNote,
  makeText,
  makeChecklist,
  makeArrow,
  makeStroke,
  moveElement,
  translateElement,
  nextNoteIndex,
  removeElement,
  toggleItem,
  addItem,
  removeItem,
  setItemLabel,
  checklistProgress,
  NOTE_SIZE,
  CHECKLIST_W,
  elementBBox,
  anchors,
  unionBBox,
  translateMany,
  shiftElement,
  nominalChecklistHeight,
  TEXT_NOMINAL
} from './elements'
import { TINT_CYCLE } from './tints'

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

  it('makeNote cycles tint off the shared TINT_CYCLE source of truth (#46)', () => {
    // No hardcoded copy: the cycle is exactly TINT_CYCLE, wrapping by its length.
    TINT_CYCLE.forEach((tint, i) => {
      expect(makeNote(`n${i}`, { x: 0, y: 0 }, i).tint).toBe(tint)
    })
    // Wraps modulo the cycle length.
    expect(makeNote('w', { x: 0, y: 0 }, TINT_CYCLE.length).tint).toBe(TINT_CYCLE[0])
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

  it('a single moveElement to the final position matches the committed drag result (#9)', () => {
    // The Planning board renders mid-drag positions transiently and commits only
    // the final position once on pointer-up. A drag through several frames must
    // therefore equal one moveElement to the last position — i.e. intermediate
    // frames never need to touch the store.
    const frames = [
      [10, 10],
      [20, 25],
      [37, 42] // final (pointer-up position)
    ] as const
    const committedOnce = moveElement(base, 'n', 37, 42)
    // Replaying every frame against the store would yield the same final state…
    let replayed = base
    for (const [x, y] of frames) replayed = moveElement(replayed, 'n', x, y)
    const a = committedOnce.find((e) => e.id === 'n')!
    const b = replayed.find((e) => e.id === 'n')!
    expect([a.x, a.y]).toEqual([b.x, b.y])
    expect([a.x, a.y]).toEqual([37, 42])
    // …and crucially the base array is never mutated by the transient frames.
    expect(base.find((e) => e.id === 'n')!.x).toBe(note.x)
  })
})

describe('nextNoteIndex (tint variety survives deletions — #27)', () => {
  it('starts at the first slot for an empty board', () => {
    expect(nextNoteIndex([])).toBe(0)
  })

  it('picks the least-used tint, not the live note count', () => {
    // Drop yellow(0), blue(1), green(2). The old count-based index (3) would pick
    // plain. With one of each, the least-used tie-break picks the earliest empty
    // slot — here `plain` (index 3) is the only unused one.
    let els: PlanningElement[] = []
    els = [...els, makeNote('a', { x: 0, y: 0 }, nextNoteIndex(els))] // yellow
    els = [...els, makeNote('b', { x: 0, y: 0 }, nextNoteIndex(els))] // blue
    els = [...els, makeNote('c', { x: 0, y: 0 }, nextNoteIndex(els))] // green
    expect(els.map((e) => (e as { tint: string }).tint)).toEqual(['yellow', 'blue', 'green'])

    // Delete the first (yellow). Old behaviour: count===2 → green (collides with c).
    // New behaviour: yellow is now the least-used (0) → reuse yellow, no collision
    // with the remaining green.
    const afterDelete = removeElement(els, 'a')
    const idx = nextNoteIndex(afterDelete)
    expect(TINT_CYCLE[idx]).toBe('yellow')
    expect(TINT_CYCLE[idx]).not.toBe('green')
  })

  it('ignores non-note elements when counting tints', () => {
    const els: PlanningElement[] = [
      makeChecklist('cl', 'i', { x: 0, y: 0 }),
      makeArrow('ar', { x: 0, y: 0 })
    ]
    expect(nextNoteIndex(els)).toBe(0)
  })
})

describe('translateElement (move any kind by a delta — #28, #37)', () => {
  it('shifts a note/text/checklist top-left like moveElement would', () => {
    const note = makeNote('n', { x: 100, y: 100 }, 0)
    const moved = translateElement([note], 'n', 10, -5)[0]
    expect([moved.x, moved.y]).toEqual([note.x + 10, note.y - 5])
  })

  it('shifts BOTH arrow endpoints so the arrow translates without deforming', () => {
    const a = makeArrow('a', { x: 10, y: 20 })
    const arrow = { ...a, x2: 60, y2: 80 }
    const out = translateElement([arrow], 'a', 5, 7)[0]
    expect(out).toMatchObject({ x: 15, y: 27, x2: 65, y2: 87 })
  })

  it('shifts every stroke point pair (origin-pinned absolute points)', () => {
    const s = makeStroke('s', [0, 0, 10, 4, 20, 8])
    const out = translateElement([s], 's', 3, -2)[0] as typeof s
    expect(out.points).toEqual([3, -2, 13, 2, 23, 6])
    expect([out.x, out.y]).toEqual([3, -2])
  })

  it('is immutable and a no-op for an absent id', () => {
    const base: PlanningElement[] = [makeNote('n', { x: 0, y: 0 }, 0)]
    const same = translateElement(base, 'nope', 5, 5)
    expect(same).not.toBe(base)
    expect((same[0] as { x: number }).x).toBe((base[0] as { x: number }).x)
  })

  it('a zero delta leaves coordinates unchanged', () => {
    const a = { ...makeArrow('a', { x: 1, y: 2 }), x2: 9, y2: 9 }
    expect(translateElement([a], 'a', 0, 0)[0]).toMatchObject({ x: 1, y: 2, x2: 9, y2: 9 })
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

describe('elementBBox (per-kind, ± measured) — W2', () => {
  it('note uses schema x/y/w/h', () => {
    const n = makeNote('n', { x: 100, y: 100 }, 0)
    expect(elementBBox(n)).toEqual({ x: n.x, y: n.y, w: n.w, h: n.h })
  })
  it('text falls back to TEXT_NOMINAL, or uses measured when given', () => {
    const t = makeText('t', { x: 10, y: 20 })
    expect(elementBBox(t)).toEqual({ x: 10, y: 20, w: TEXT_NOMINAL.w, h: TEXT_NOMINAL.h })
    expect(elementBBox(t, { w: 80, h: 40 })).toEqual({ x: 10, y: 20, w: 80, h: 40 })
  })
  it('checklist uses nominal height from item count, or measured h', () => {
    const cl = makeChecklist('cl', 'i0', { x: 0, y: 0 }) // 1 item
    expect(elementBBox(cl)).toEqual({ x: cl.x, y: cl.y, w: cl.w, h: nominalChecklistHeight(1) })
    expect(elementBBox(cl, { w: cl.w, h: 222 }).h).toBe(222)
  })
  it('arrow returns the endpoint extent box (no top-left assumption)', () => {
    const a = { ...makeArrow('a', { x: 30, y: 50 }), x2: 10, y2: 90 }
    expect(elementBBox(a)).toEqual({ x: 10, y: 50, w: 20, h: 40 })
  })
  it('stroke returns the min/max extent of its points', () => {
    const s = makeStroke('s', [5, 5, 25, 15, 15, 35])
    expect(elementBBox(s)).toEqual({ x: 5, y: 5, w: 20, h: 30 })
  })
})

describe('anchors / unionBBox — W2', () => {
  it('anchors derives edges + centers', () => {
    expect(anchors({ x: 10, y: 20, w: 100, h: 40 })).toEqual({
      left: 10,
      centerX: 60,
      right: 110,
      top: 20,
      centerY: 40,
      bottom: 60
    })
  })
  it('unionBBox spans all boxes; single box is itself; empty is a zero box', () => {
    expect(
      unionBBox([
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 20, y: 5, w: 10, h: 30 }
      ])
    ).toEqual({ x: 0, y: 0, w: 30, h: 35 })
    expect(unionBBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('shiftElement / translateMany — W2', () => {
  it('shiftElement moves a note top-left, an arrow both ends, a stroke all points', () => {
    // makeNote centres on the drop point, so assert the shift relative to its base x/y.
    const n = makeNote('n', { x: 0, y: 0 }, 0)
    expect(shiftElement(n, 5, 7)).toMatchObject({ x: n.x + 5, y: n.y + 7 })
    expect(shiftElement({ ...makeArrow('a', { x: 1, y: 2 }), x2: 3, y2: 4 }, 10, 10)).toMatchObject(
      { x: 11, y: 12, x2: 13, y2: 14 }
    )
    expect(
      (shiftElement(makeStroke('s', [0, 0, 2, 2]), 1, 1) as { points: number[] }).points
    ).toEqual([1, 1, 3, 3])
  })
  it('translateMany shifts only ids in the set, in one immutable pass', () => {
    const els: PlanningElement[] = [
      makeNote('a', { x: 0, y: 0 }, 0),
      makeNote('b', { x: 50, y: 0 }, 1),
      makeNote('c', { x: 100, y: 0 }, 2)
    ]
    const [ax, bx, cx] = els.map((e) => e.x)
    const [ay, by, cy] = els.map((e) => e.y)
    const out = translateMany(els, new Set(['a', 'c']), 10, 20)
    expect(out).not.toBe(els)
    expect(out.map((e) => e.x)).toEqual([ax + 10, bx, cx + 10])
    expect(out.map((e) => e.y)).toEqual([ay + 20, by, cy + 20])
  })
  it('translateMany accepts an array of ids and is a no-op for an empty set', () => {
    const els: PlanningElement[] = [makeNote('a', { x: 0, y: 0 }, 0)]
    const baseX = els[0].x
    expect(translateMany(els, [], 9, 9)[0].x).toBe(baseX)
    expect(translateMany(els, ['a'], 3, 0)[0].x).toBe(baseX + 3)
  })
})

import {
  isLocked,
  expandGroups,
  duplicateElements,
  groupElements,
  ungroupElements,
  setLocked
} from './elements'

const note = (id: string, x = 0, y = 0, extra: Partial<PlanningElement> = {}): PlanningElement => ({
  id,
  kind: 'note',
  x,
  y,
  w: 100,
  h: 60,
  tint: 'yellow',
  text: '',
  ...extra
}) as PlanningElement

let counter = 0
const seqId = (): string => `new-${counter++}`

describe('W3 mutators', () => {
  it('isLocked reads the optional flag', () => {
    expect(isLocked(note('a'))).toBe(false)
    expect(isLocked(note('b', 0, 0, { locked: true }))).toBe(true)
  })

  it('expandGroups pulls in siblings sharing a groupId', () => {
    const els = [note('a', 0, 0, { groupId: 'g' }), note('b', 0, 0, { groupId: 'g' }), note('c')]
    expect([...expandGroups(els, ['a'])].sort()).toEqual(['a', 'b'])
    expect([...expandGroups(els, ['c'])]).toEqual(['c']) // ungrouped passes through
  })

  it('groupElements / ungroupElements set and clear groupId', () => {
    const els = [note('a'), note('b')]
    const grouped = groupElements(els, ['a', 'b'], 'g1')
    expect(grouped.every((e) => e.groupId === 'g1')).toBe(true)
    const ungrouped = ungroupElements(grouped, ['a', 'b'])
    expect(ungrouped.every((e) => e.groupId === undefined)).toBe(true)
  })

  it('setLocked sets and removes the flag', () => {
    const els = [note('a'), note('b')]
    const locked = setLocked(els, ['a'], true)
    expect(isLocked(locked.find((e) => e.id === 'a')!)).toBe(true)
    expect(isLocked(locked.find((e) => e.id === 'b')!)).toBe(false)
    const unlocked = setLocked(locked, ['a'], false)
    expect(unlocked.find((e) => e.id === 'a')).not.toHaveProperty('locked')
  })

  it('duplicateElements clones, shifts, fresh ids, fresh per-group groupId, originals untouched', () => {
    counter = 0
    const els = [note('a', 0, 0, { groupId: 'g' }), note('b', 10, 10, { groupId: 'g' }), note('c', 50, 50)]
    const { elements, newIds } = duplicateElements(els, ['a', 'b', 'c'], 12, 12, seqId)
    expect(elements).toHaveLength(6)
    expect(newIds).toHaveLength(3)
    // originals untouched
    expect(elements.slice(0, 3)).toEqual(els)
    const copies = elements.slice(3)
    // shifted
    expect(copies[0].x).toBe(12)
    expect(copies[0].y).toBe(12)
    // a and b shared a group → their copies share ONE fresh group, distinct from 'g'
    const ga = copies[0].groupId
    const gb = copies[1].groupId
    expect(ga).toBe(gb)
    expect(ga).not.toBe('g')
    expect(ga).toBeTruthy()
    // c had no group → its copy has none
    expect(copies[2].groupId).toBeUndefined()
  })

  it('duplicateElements shifts arrows by both endpoints', () => {
    counter = 0
    const arrow: PlanningElement = { id: 'ar', kind: 'arrow', x: 0, y: 0, x2: 30, y2: 40 }
    const { elements } = duplicateElements([arrow], ['ar'], 5, 7, seqId)
    expect(elements[1]).toMatchObject({ kind: 'arrow', x: 5, y: 7, x2: 35, y2: 47 })
  })
})
