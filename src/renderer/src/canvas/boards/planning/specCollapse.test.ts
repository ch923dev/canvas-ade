import { describe, it, expect } from 'vitest'
import {
  SPEC_CHIP_PREFIX,
  applyCollapse,
  specChipGroupId,
  specEffectiveCollapsed
} from './specCollapse'
import type { DiagramSpec } from '../../../lib/diagramSpec'

// build{a,b} · ship{c} · loose d. Edge shapes: internal (a→b), two boundaries converging on one
// target (a→c, b→c — the dedupe case), untouched (c→d), inbound boundary (d→a).
const spec = (over: Partial<DiagramSpec> = {}): DiagramSpec => ({
  version: 1,
  direction: 'right',
  groups: [
    { id: 'build', label: 'Build', status: 'active' },
    { id: 'ship', label: 'Ship' }
  ],
  nodes: [
    { id: 'a', label: 'A', group: 'build' },
    { id: 'b', label: 'B', group: 'build' },
    { id: 'c', label: 'C', group: 'ship' },
    { id: 'd', label: 'D' }
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'a', to: 'c', animated: true },
    { id: 'e3', from: 'b', to: 'c' },
    { id: 'e4', from: 'c', to: 'd' },
    { id: 'e5', from: 'd', to: 'a' }
  ],
  ...over
})

describe('specChipGroupId', () => {
  it('extracts the group id from a chip id; real (slug) ids return null', () => {
    expect(specChipGroupId(`${SPEC_CHIP_PREFIX}build`)).toBe('build')
    expect(specChipGroupId('build')).toBeNull()
    expect(specChipGroupId('a.b-c_d')).toBeNull()
  })
})

describe('specEffectiveCollapsed — authored XOR session toggle', () => {
  it('starts from the authored collapsed flags', () => {
    const s = spec({
      groups: [
        { id: 'build', label: 'Build', collapsed: true },
        { id: 'ship', label: 'Ship' }
      ]
    })
    expect([...specEffectiveCollapsed(s, new Set())]).toEqual(['build'])
  })

  it('a toggle opens an authored-collapsed group and closes an open one', () => {
    const s = spec({
      groups: [
        { id: 'build', label: 'Build', collapsed: true },
        { id: 'ship', label: 'Ship' }
      ]
    })
    expect([...specEffectiveCollapsed(s, new Set(['build', 'ship']))]).toEqual(['ship'])
  })
})

describe('applyCollapse', () => {
  it('is the identity (same object) when nothing collapses', () => {
    const s = spec()
    expect(applyCollapse(s, new Set())).toBe(s)
    expect(applyCollapse(s, new Set(['no-such-group']))).toBe(s)
  })

  it('folds a group to one chip at the first member slot — label carries the member count', () => {
    const out = applyCollapse(spec(), new Set(['build']))
    expect(out.nodes.map((n) => n.id)).toEqual([`${SPEC_CHIP_PREFIX}build`, 'c', 'd'])
    const chip = out.nodes[0]
    expect(chip.label).toBe('Build (2)')
    expect(chip.status).toBe('active') // group chrome status carries onto the chip
    expect(chip.group).toBeUndefined()
    expect(out.groups?.map((g) => g.id)).toEqual(['ship']) // the folded cluster rectangle is gone
  })

  it('drops internal edges, remaps boundaries to the chip, and dedupes converging remaps', () => {
    const s = spec()
    const out = applyCollapse(s, new Set(['build']))
    // e1 internal → gone; e2+e3 both become chip→c → one edge (first wins, keeps e2's animated).
    expect(out.edges.map((e) => e.id)).toEqual(['e2', 'e4', 'e5'])
    expect(out.edges[0]).toMatchObject({
      from: `${SPEC_CHIP_PREFIX}build`,
      to: 'c',
      animated: true
    })
    expect(out.edges[2]).toMatchObject({ from: 'd', to: `${SPEC_CHIP_PREFIX}build` })
    expect(out.edges[1]).toBe(s.edges[3]) // untouched edges keep their identity (no churn)
  })

  it('collapsing both groups chips both ends of a boundary edge (no self-loops survive)', () => {
    const out = applyCollapse(spec(), new Set(['build', 'ship']))
    expect(out.nodes.map((n) => n.id)).toEqual([
      `${SPEC_CHIP_PREFIX}build`,
      `${SPEC_CHIP_PREFIX}ship`,
      'd'
    ])
    // e2/e3 → chip(build)→chip(ship), deduped to e2; e4 → chip(ship)→d; e5 → d→chip(build).
    expect(out.edges.map((e) => [e.id, e.from, e.to])).toEqual([
      ['e2', `${SPEC_CHIP_PREFIX}build`, `${SPEC_CHIP_PREFIX}ship`],
      ['e4', `${SPEC_CHIP_PREFIX}ship`, 'd'],
      ['e5', 'd', `${SPEC_CHIP_PREFIX}build`]
    ])
  })

  it('chips an empty collapsed group as "(0)"', () => {
    const s = spec({
      groups: [
        { id: 'build', label: 'Build' },
        { id: 'ship', label: 'Ship' },
        { id: 'empty', label: 'Empty' }
      ]
    })
    const out = applyCollapse(s, new Set(['empty']))
    expect(out.nodes.at(-1)).toMatchObject({ id: `${SPEC_CHIP_PREFIX}empty`, label: 'Empty (0)' })
  })
})
