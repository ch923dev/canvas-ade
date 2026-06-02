import { describe, it, expect } from 'vitest'
import type {
  ChecklistElement,
  NoteElement,
  PlanningElement,
  StrokeElement
} from '../../../lib/boardSchema'
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
  TEXT_NOMINAL,
  duplicateElements
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

describe('duplicateElements', () => {
  const newIdSeq = (): (() => string) => {
    let n = 0
    return () => `clone-${++n}`
  }
  const dupNote = (id: string, x = 0, groupId?: string): NoteElement => ({
    id,
    kind: 'note',
    x,
    y: 0,
    w: 100,
    h: 50,
    tint: 'yellow',
    text: '',
    ...(groupId ? { groupId } : {})
  })

  it('clones selected elements with fresh ids, appended after originals', () => {
    const els = [dupNote('a'), dupNote('b')]
    const { next, cloneIds } = duplicateElements(els, ['a'], newIdSeq())
    expect(next).toHaveLength(3)
    expect(next.map((e) => e.id)).toEqual(['a', 'b', 'clone-1'])
    expect(cloneIds).toEqual(['clone-1'])
  })

  it('remaps a shared groupId to ONE new shared group across the clones', () => {
    const els = [dupNote('a', 0, 'g1'), dupNote('b', 0, 'g1'), dupNote('c', 0, 'g2')]
    const { next } = duplicateElements(els, ['a', 'b', 'c'], newIdSeq())
    const clones = next.slice(3)
    expect(clones[0].groupId).toBe(clones[1].groupId)
    expect(clones[2].groupId).not.toBe(clones[0].groupId)
    expect(clones.every((c) => c.groupId !== 'g1' && c.groupId !== 'g2')).toBe(true)
  })

  it('deep-clones (no aliasing of the source array references)', () => {
    const els = [dupNote('a')]
    const { next } = duplicateElements(els, ['a'], newIdSeq())
    expect(next[1]).not.toBe(next[0])
  })

  it('preserves the locked flag on a cloned element', () => {
    const els = [{ ...dupNote('a'), locked: true }]
    const { next } = duplicateElements(els, ['a'], newIdSeq())
    expect(next[1].locked).toBe(true)
  })

  it('populates idMap from each source id to its clone id', () => {
    const els = [dupNote('a'), dupNote('b')]
    const { idMap } = duplicateElements(els, ['a', 'b'], newIdSeq())
    expect(idMap.get('a')).toBe('clone-1')
    expect(idMap.get('b')).toBe('clone-2')
  })

  it('deep-clones nested arrays (mutating a clone never touches the source)', () => {
    const stroke: StrokeElement = { id: 's', kind: 'stroke', x: 0, y: 0, points: [0, 0, 5, 5] }
    const { next } = duplicateElements([stroke], ['s'], newIdSeq())
    const clone = next[1] as StrokeElement
    clone.points.push(9, 9)
    expect((next[0] as StrokeElement).points).toEqual([0, 0, 5, 5]) // source untouched
  })
})

import { expandGroups, groupElements, ungroupElements, setLocked, notLocked } from './elements'

describe('group + lock helpers', () => {
  const gNote = (id: string, groupId?: string, locked?: boolean): NoteElement => ({
    id,
    kind: 'note',
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    tint: 'yellow',
    text: '',
    ...(groupId ? { groupId } : {}),
    ...(locked ? { locked } : {})
  })

  it('expandGroups pulls in every co-grouped element', () => {
    const els = [gNote('a', 'g1'), gNote('b', 'g1'), gNote('c')]
    expect([...expandGroups(els, ['a'])].sort()).toEqual(['a', 'b'])
  })

  it('expandGroups passes ungrouped ids through unchanged', () => {
    const els = [gNote('a'), gNote('b')]
    expect([...expandGroups(els, ['a'])]).toEqual(['a'])
  })

  it('groupElements assigns the shared groupId to the selected', () => {
    const els = [gNote('a'), gNote('b'), gNote('c')]
    const out = groupElements(els, ['a', 'b'], 'gX')
    expect(out.find((e) => e.id === 'a')!.groupId).toBe('gX')
    expect(out.find((e) => e.id === 'b')!.groupId).toBe('gX')
    expect(out.find((e) => e.id === 'c')!.groupId).toBeUndefined()
  })

  it('ungroupElements clears the groupId on the selected', () => {
    const els = [gNote('a', 'g1'), gNote('b', 'g1')]
    const out = ungroupElements(els, ['a'])
    expect(out.find((e) => e.id === 'a')!.groupId).toBeUndefined()
    expect(out.find((e) => e.id === 'b')!.groupId).toBe('g1')
  })

  it('setLocked sets/clears the locked flag on the selected', () => {
    const els = [gNote('a')]
    expect(setLocked(els, ['a'], true)[0].locked).toBe(true)
    expect(setLocked(setLocked(els, ['a'], true), ['a'], false)[0].locked).toBe(false)
  })

  it('notLocked is true for an unlocked element', () => {
    expect(notLocked(gNote('a'))).toBe(true)
    expect(notLocked(gNote('a', undefined, true))).toBe(false)
  })
})
