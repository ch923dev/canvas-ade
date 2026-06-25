import { describe, it, expect } from 'vitest'
import type {
  ArrowElement,
  ChecklistElement,
  DiagramElement,
  FileRefElement,
  ImageElement,
  NoteElement,
  PlanningElement,
  StrokeElement
} from '../../../lib/boardSchema'
import { MIN_TEXT_WIDTH_PX } from './textStyle'
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
  makeImage,
  fitImageSize,
  makeFileRef,
  FILEREF_SIZE,
  setArrowEndpoint
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
  it('note uses schema x/y/w/h when no measurement', () => {
    const n = makeNote('n', { x: 100, y: 100 }, 0)
    expect(elementBBox(n)).toEqual({ x: n.x, y: n.y, w: n.w, h: n.h })
  })
  it('BUG-050: note uses measured h when positive, falls back to schema h when 0 or absent', () => {
    const n = makeNote('n', { x: 100, y: 100 }, 0) // h:96 schema default
    // Measured height > 0: use it (one-line note ~34px)
    expect(elementBBox(n, { w: 156, h: 34 }).h).toBe(34)
    // Measured height = 0: fall back to schema h (no layout yet)
    expect(elementBBox(n, { w: 156, h: 0 }).h).toBe(96)
    // No measurement: fall back to schema h
    expect(elementBBox(n, undefined).h).toBe(96)
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
  setLocked,
  setNoteTint
} from './elements'

const note = (id: string, x = 0, y = 0, extra: Partial<PlanningElement> = {}): PlanningElement =>
  ({
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
    const els = [
      note('a', 0, 0, { groupId: 'g' }),
      note('b', 10, 10, { groupId: 'g' }),
      note('c', 50, 50)
    ]
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

describe('setNoteTint (D3-A tint picker)', () => {
  it('sets the tint on every selected note', () => {
    const els = [note('a'), note('b'), note('c')]
    const next = setNoteTint(els, ['a', 'b'], 'blue')
    expect((next.find((e) => e.id === 'a') as NoteElement).tint).toBe('blue')
    expect((next.find((e) => e.id === 'b') as NoteElement).tint).toBe('blue')
    expect((next.find((e) => e.id === 'c') as NoteElement).tint).toBe('yellow')
  })

  it('leaves non-note elements untouched (same object reference)', () => {
    const arrow: PlanningElement = { id: 'ar', kind: 'arrow', x: 0, y: 0, x2: 10, y2: 10 }
    const els = [note('a'), arrow]
    const next = setNoteTint(els, ['a', 'ar'], 'green')
    expect(next.find((e) => e.id === 'ar')).toBe(arrow)
    expect((next.find((e) => e.id === 'a') as NoteElement).tint).toBe('green')
  })

  it('skips locked notes', () => {
    const els = [note('a', 0, 0, { locked: true }), note('b')]
    const next = setNoteTint(els, ['a', 'b'], 'plain')
    expect((next.find((e) => e.id === 'a') as NoteElement).tint).toBe('yellow')
    expect((next.find((e) => e.id === 'b') as NoteElement).tint).toBe('plain')
  })

  it('returns the input BY REFERENCE when every targeted note already has the tint (no phantom undo)', () => {
    const els = [note('a'), note('b', 0, 0, { tint: 'blue' })]
    expect(setNoteTint(els, ['a'], 'yellow')).toBe(els)
  })

  it('returns the input by reference when the selection holds no notes', () => {
    const arrow: PlanningElement = { id: 'ar', kind: 'arrow', x: 0, y: 0, x2: 10, y2: 10 }
    const els = [note('a'), arrow]
    expect(setNoteTint(els, ['ar'], 'blue')).toBe(els)
  })

  it('returns the input by reference when every targeted note is locked', () => {
    const els = [note('a', 0, 0, { locked: true })]
    expect(setNoteTint(els, ['a'], 'blue')).toBe(els)
  })

  it('keeps unchanged element references in a mixed apply', () => {
    const els = [note('a'), note('b', 0, 0, { tint: 'blue' }), note('c')]
    const next = setNoteTint(els, ['a', 'b'], 'blue')
    expect(next).not.toBe(els)
    expect(next.find((e) => e.id === 'b')).toBe(els[1]) // already blue — untouched
    expect(next.find((e) => e.id === 'c')).toBe(els[2]) // unselected — untouched
    expect((next.find((e) => e.id === 'a') as NoteElement).tint).toBe('blue')
  })
})

describe('makeText', () => {
  it('makes point text (no width) by default', () => {
    const t = makeText('t', { x: 10.4, y: 20.6 })
    expect(t).toEqual({ id: 't', kind: 'text', x: 10, y: 21, text: '' })
    expect('width' in t).toBe(false)
  })
  it('carries width + fontSize for area text', () => {
    const t = makeText('t', { x: 0, y: 0 }, { width: 200, fontSize: 'XL' })
    expect(t.width).toBe(200)
    expect(t.fontSize).toBe('XL')
  })
  it('clamps a below-minimum / non-finite width to MIN_TEXT_WIDTH_PX', () => {
    expect(makeText('t', { x: 0, y: 0 }, { width: 5 }).width).toBe(MIN_TEXT_WIDTH_PX)
    expect(makeText('t', { x: 0, y: 0 }, { width: 0 }).width).toBe(MIN_TEXT_WIDTH_PX)
    expect(makeText('t', { x: 0, y: 0 }, { width: Number.NaN }).width).toBe(MIN_TEXT_WIDTH_PX)
    expect(makeText('t', { x: 0, y: 0 }, { width: Number.POSITIVE_INFINITY }).width).toBe(
      MIN_TEXT_WIDTH_PX
    )
  })
})

describe('W4 image helpers', () => {
  it('fitImageSize scales down to the max longest side, preserving aspect', () => {
    expect(fitImageSize(720, 360, 360)).toEqual({ w: 360, h: 180 })
  })
  it('fitImageSize does not upscale a small image', () => {
    expect(fitImageSize(100, 50, 360)).toEqual({ w: 100, h: 50 })
  })
  it('fitImageSize floors degenerate input to a square', () => {
    expect(fitImageSize(0, 0, 360)).toEqual({ w: 360, h: 360 })
  })
  it('makeImage centers the box on the point', () => {
    const el = makeImage('i1', { x: 200, y: 100 }, 'assets/a.png', 120, 80)
    expect(el).toMatchObject({
      id: 'i1',
      kind: 'image',
      x: 140,
      y: 60,
      w: 120,
      h: 80,
      assetId: 'assets/a.png'
    })
  })
  it('elementBBox returns the image box', () => {
    const el: ImageElement = {
      id: 'i1',
      kind: 'image',
      x: 5,
      y: 6,
      w: 30,
      h: 40,
      assetId: 'assets/a.png'
    }
    expect(elementBBox(el)).toEqual({ x: 5, y: 6, w: 30, h: 40 })
  })
  it('shiftElement translates an image by the top-left (default branch)', () => {
    const el: ImageElement = {
      id: 'i1',
      kind: 'image',
      x: 5,
      y: 6,
      w: 30,
      h: 40,
      assetId: 'assets/a.png'
    }
    expect(shiftElement(el, 10, -3)).toMatchObject({ x: 15, y: 3, w: 30, h: 40 })
  })
})

describe('S4 file-reference chip', () => {
  it('makeFileRef centers the box on the point and carries path + label', () => {
    const el = makeFileRef('f1', { x: 300, y: 150 }, 'src/a.ts', 'a.ts')
    expect(el).toMatchObject({
      id: 'f1',
      kind: 'fileref',
      x: Math.round(300 - FILEREF_SIZE.w / 2),
      y: Math.round(150 - FILEREF_SIZE.h / 2),
      w: FILEREF_SIZE.w,
      h: FILEREF_SIZE.h,
      path: 'src/a.ts',
      label: 'a.ts'
    })
  })
  it('elementBBox returns the chip box; shiftElement moves its top-left', () => {
    const el = makeFileRef('f1', { x: 100, y: 100 }, 'a.ts', 'a.ts')
    expect(elementBBox(el)).toEqual({ x: el.x, y: el.y, w: FILEREF_SIZE.w, h: FILEREF_SIZE.h })
    expect(shiftElement(el, 10, -4)).toMatchObject({ x: el.x + 10, y: el.y - 4 })
  })
})

describe('setArrowEndpoint (D3-B endpoint editing)', () => {
  const arrow = (): PlanningElement => ({ id: 'a1', kind: 'arrow', x: 10, y: 20, x2: 110, y2: 220 })

  it("moves only the 'start' endpoint (x/y); the head stays fixed", () => {
    const next = setArrowEndpoint([arrow()], 'a1', 'start', 50, 60)
    expect(next[0]).toMatchObject({ x: 50, y: 60, x2: 110, y2: 220 })
  })

  it("moves only the 'end' endpoint (x2/y2); the tail stays fixed", () => {
    const next = setArrowEndpoint([arrow()], 'a1', 'end', 300, 40)
    expect(next[0]).toMatchObject({ x: 10, y: 20, x2: 300, y2: 40 })
  })

  it('is immutable: the input element object is untouched', () => {
    const a = arrow()
    setArrowEndpoint([a], 'a1', 'end', 300, 40)
    expect(a).toMatchObject({ x: 10, y: 20, x2: 110, y2: 220 })
  })

  it('no-ops on a missing id and on a non-arrow kind (same refs back)', () => {
    const a = arrow()
    const n = makeNote('n1', { x: 0, y: 0 }, 0)
    expect(setArrowEndpoint([a, n], 'nope', 'end', 1, 2)[0]).toBe(a)
    expect(setArrowEndpoint([a, n], 'n1', 'end', 1, 2)[1]).toBe(n)
  })

  it('leaves untargeted siblings by reference (render-cache friendly)', () => {
    const a = arrow()
    const s = makeStroke('s1', [0, 0, 5, 5])
    const next = setArrowEndpoint([a, s], 'a1', 'start', 1, 2)
    expect(next[1]).toBe(s)
    expect(next[0]).not.toBe(a)
  })
})

import { extractForTransfer, insertTransferred } from './elements'

describe('cross-board transfer engine (extractForTransfer / insertTransferred)', () => {
  // Reuses the `note(id,x,y,extra)` factory + `seqId`/`counter` defined above.

  it('normalizes the payload so the selection union-bbox top-left is the origin', () => {
    const els = [note('a', 40, 60), note('b', 100, 200)]
    const { payload } = extractForTransfer(els, ['a', 'b'])
    // union top-left = (min x, min y) = (40, 60) → payload shifts by (-40, -60).
    const a = payload.find((e) => e.id === 'a')!
    const b = payload.find((e) => e.id === 'b')!
    expect([a.x, a.y]).toEqual([0, 0])
    expect([b.x, b.y]).toEqual([60, 140])
    // Immutable + deep-cloned: source untouched, payload is a distinct object graph.
    expect(els[0].x).toBe(40)
    expect(payload[0]).not.toBe(els[0])
  })

  it('empty selection → empty payload, source ref unchanged (no-op signal for the store)', () => {
    const els = [note('a')]
    const { payload, remaining } = extractForTransfer(els, [])
    expect(payload).toEqual([])
    expect(remaining).toBe(els)
  })

  it('expands groups on extract and remaps to ONE fresh group per source group on insert', () => {
    counter = 0
    const els = [
      note('a', 0, 0, { groupId: 'g' }),
      note('b', 10, 10, { groupId: 'g' }),
      note('c', 50, 50)
    ]
    // Selecting only 'a' pulls its group-sibling 'b'; ungrouped 'c' is left behind.
    const { payload } = extractForTransfer(els, ['a'])
    expect(payload.map((e) => e.id).sort()).toEqual(['a', 'b'])
    const { elements, newIds } = insertTransferred([], payload, { x: 0, y: 0 }, seqId)
    expect(elements).toHaveLength(2)
    expect(newIds).toHaveLength(2)
    // Fresh ids (not the source 'a'/'b').
    expect(elements.every((e) => e.id.startsWith('new-'))).toBe(true)
    // Both inserts share ONE fresh group, remapped away from the source 'g'.
    expect(elements[0].groupId).toBe(elements[1].groupId)
    expect(elements[0].groupId).not.toBe('g')
    expect(elements[0].groupId).toBeTruthy()
  })

  it('move skips locked members (lock-precedence): excluded from payload, kept in remaining', () => {
    const els = [note('a', 0, 0), note('b', 10, 10, { locked: true })]
    const { payload, remaining } = extractForTransfer(els, ['a', 'b'], 'move')
    expect(payload.map((e) => e.id)).toEqual(['a']) // locked 'b' does NOT re-home
    expect(remaining.map((e) => e.id)).toEqual(['b']) // locked 'b' stays in source
  })

  it('copy includes locked members (they copy normally) and leaves the source ref intact', () => {
    const els = [note('a', 0, 0), note('b', 10, 10, { locked: true })]
    const { payload, remaining } = extractForTransfer(els, ['a', 'b'], 'copy')
    expect(payload.map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(remaining).toBe(els) // copy never touches the source
  })

  it('move whose every member is locked yields an empty payload + unchanged source', () => {
    const els = [note('a', 0, 0, { locked: true })]
    const { payload, remaining } = extractForTransfer(els, ['a'], 'move')
    expect(payload).toEqual([])
    expect(remaining).toBe(els)
  })

  it('copies asset refs (assetId / source / svgCache / path) verbatim through extract → insert', () => {
    counter = 0
    const img: PlanningElement = {
      id: 'img',
      kind: 'image',
      x: 0,
      y: 0,
      w: 100,
      h: 80,
      assetId: 'assets/abc.png'
    }
    const diag: PlanningElement = {
      id: 'd',
      kind: 'diagram',
      x: 0,
      y: 0,
      w: 280,
      h: 200,
      source: 'graph TD\n  A-->B',
      engine: 'mermaid',
      svgCache: 'assets/def.svg'
    }
    const fref: PlanningElement = {
      id: 'f',
      kind: 'fileref',
      x: 0,
      y: 0,
      w: 224,
      h: 46,
      path: 'src/x.ts',
      label: 'x.ts'
    }
    const { payload } = extractForTransfer([img, diag, fref], ['img', 'd', 'f'])
    const { elements } = insertTransferred([], payload, { x: 5, y: 5 }, seqId)
    const outImg = elements.find((e) => e.kind === 'image') as ImageElement
    expect(outImg.assetId).toBe('assets/abc.png')
    const outDiag = elements.find((e) => e.kind === 'diagram') as DiagramElement
    expect(outDiag.source).toBe('graph TD\n  A-->B')
    expect(outDiag.svgCache).toBe('assets/def.svg')
    expect(outDiag.engine).toBe('mermaid')
    const outFref = elements.find((e) => e.kind === 'fileref') as FileRefElement
    expect(outFref.path).toBe('src/x.ts')
    expect(outFref.label).toBe('x.ts')
  })

  it('preserves arrow endpoints + stroke points through extract → insert (shifted, not deformed)', () => {
    counter = 0
    const arrowEl: PlanningElement = { id: 'ar', kind: 'arrow', x: 10, y: 10, x2: 40, y2: 50 }
    const strokeEl: PlanningElement = {
      id: 'st',
      kind: 'stroke',
      x: 0,
      y: 0,
      points: [10, 10, 20, 30, 40, 50]
    }
    const { payload } = extractForTransfer([arrowEl, strokeEl], ['ar', 'st'])
    // union top-left = (10, 10) → normalize by (-10, -10); then insert translates by (100, 200).
    const { elements } = insertTransferred([], payload, { x: 100, y: 200 }, seqId)
    const outArrow = elements.find((e) => e.kind === 'arrow') as ArrowElement
    expect([outArrow.x, outArrow.y, outArrow.x2, outArrow.y2]).toEqual([100, 200, 130, 240])
    const outStroke = elements.find((e) => e.kind === 'stroke') as StrokeElement
    expect(outStroke.points).toEqual([100, 200, 110, 220, 130, 240])
    expect(outStroke.points).not.toBe(strokeEl.points) // fresh array, source untouched
  })

  it('deep-clones so the payload never aliases the source (checklist items array is fresh)', () => {
    const cl: PlanningElement = {
      id: 'cl',
      kind: 'checklist',
      x: 0,
      y: 0,
      w: 240,
      h: 0,
      title: 'T',
      items: [{ id: 'i', label: 'x', done: false }]
    }
    const { payload } = extractForTransfer([cl], ['cl'])
    const outCl = payload[0] as ChecklistElement
    expect(outCl.items).not.toBe((cl as ChecklistElement).items)
    expect(outCl.items).toEqual([{ id: 'i', label: 'x', done: false }])
  })

  it('insertTransferred appends to the target without mutating it', () => {
    counter = 0
    const target = [note('keep', 5, 5)]
    const { payload } = extractForTransfer([note('a', 0, 0)], ['a'])
    const { elements } = insertTransferred(target, payload, { x: 0, y: 0 }, seqId)
    expect(elements.map((e) => e.id)).toEqual(['keep', 'new-0'])
    expect(target).toHaveLength(1) // target array not mutated
  })

  it('mints distinct ids + objects on repeated inserts of one payload (paste-twice safe)', () => {
    counter = 0
    const { payload } = extractForTransfer([note('a', 0, 0)], ['a'])
    const first = insertTransferred([], payload, { x: 0, y: 0 }, seqId)
    const second = insertTransferred(first.elements, payload, { x: 10, y: 10 }, seqId)
    expect(second.elements).toHaveLength(2)
    expect(first.newIds[0]).not.toBe(second.newIds[0])
    expect(second.elements[0]).not.toBe(second.elements[1])
  })
})
