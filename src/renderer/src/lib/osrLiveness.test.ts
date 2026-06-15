import { describe, it, expect } from 'vitest'
import {
  rectsOverlap,
  isOsrVisible,
  rankOsrAlive,
  type Box,
  type OsrAliveCandidate
} from './osrLiveness'

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height })
const PANE = box(0, 0, 1000, 800)

describe('rectsOverlap', () => {
  it('detects overlap', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(50, 50, 100, 100))).toBe(true)
  })
  it('shared edge does NOT overlap (strict)', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(100, 0, 100, 100))).toBe(false)
  })
  it('disjoint boxes do not overlap', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(200, 200, 100, 100))).toBe(false)
  })
  it('zero-area box never overlaps', () => {
    expect(rectsOverlap(box(0, 0, 0, 100), box(0, 0, 100, 100))).toBe(false)
  })
})

describe('isOsrVisible', () => {
  it('is visible when on-screen and zoomed in', () => {
    expect(isOsrVisible({ screen: box(100, 100, 400, 300), pane: PANE, zoom: 1, lod: 0.4 })).toBe(
      true
    )
  })
  it('freezes below the LOD floor', () => {
    expect(isOsrVisible({ screen: box(100, 100, 400, 300), pane: PANE, zoom: 0.3, lod: 0.4 })).toBe(
      false
    )
  })
  it('freezes when fully off the pane (no overlap)', () => {
    expect(isOsrVisible({ screen: box(2000, 100, 400, 300), pane: PANE, zoom: 1, lod: 0.4 })).toBe(
      false
    )
  })
  it('stays visible when only PARTIALLY on-screen — even above the pane top (canvas clips)', () => {
    // A board whose top sits ABOVE the pane (negative y) but still intersects it. The native
    // path would reject this (screenY < paneTop); OSR keeps it live (the <canvas> clips).
    expect(isOsrVisible({ screen: box(100, -200, 400, 300), pane: PANE, zoom: 1, lod: 0.4 })).toBe(
      true
    )
  })
  it('freezes a degenerate (≤1px) stage', () => {
    expect(isOsrVisible({ screen: box(100, 100, 1, 300), pane: PANE, zoom: 1, lod: 0.4 })).toBe(
      false
    )
  })
  it('is visible exactly at the LOD floor', () => {
    expect(isOsrVisible({ screen: box(0, 0, 400, 300), pane: PANE, zoom: 0.4, lod: 0.4 })).toBe(
      true
    )
  })
})

describe('rankOsrAlive', () => {
  const center = { x: 500, y: 400 }
  const mk = (id: string, x: number, y: number, visible: boolean): OsrAliveCandidate => ({
    id,
    screen: box(x, y, 100, 100),
    visible
  })

  it('keeps everything alive under the cap', () => {
    const alive = rankOsrAlive({
      candidates: [mk('a', 0, 0, true), mk('b', 0, 0, false)],
      cap: 4,
      center
    })
    expect(alive).toEqual(new Set(['a', 'b']))
  })

  it('caps the alive set to `cap`', () => {
    const cands = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => mk(id, i * 50, 0, true))
    expect(rankOsrAlive({ candidates: cands, cap: 4, center }).size).toBe(4)
  })

  it('prefers VISIBLE boards over off-screen ones even when the off-screen one is nearer', () => {
    // off-screen board sits dead-centre (nearest); a visible board is farther — visible wins.
    const alive = rankOsrAlive({
      candidates: [mk('offscreen', 500, 400, false), mk('visible', 0, 0, true)],
      cap: 1,
      center
    })
    expect(alive).toEqual(new Set(['visible']))
  })

  it('among same-visibility boards, the nearest the centre wins', () => {
    const near = mk('near', 450, 350, false)
    const far = mk('far', 0, 0, false)
    const alive = rankOsrAlive({ candidates: [far, near], cap: 1, center })
    expect(alive).toEqual(new Set(['near']))
  })

  it('breaks distance ties by original order (stable, no per-settle churn)', () => {
    // two equidistant off-screen boards, cap 1 → the first-listed wins deterministically.
    const a = mk('a', 1000, 800, false) // dist to centre identical to b (mirror)
    const b = mk('b', 0, 0, false)
    // make them exactly equidistant: place symmetric around the centre.
    a.screen = box(450, 350, 100, 100) // centre (500,400) — dist 0
    b.screen = box(450, 350, 100, 100) // identical
    expect(rankOsrAlive({ candidates: [a, b], cap: 1, center })).toEqual(new Set(['a']))
  })

  it('cap 0 → nothing alive', () => {
    expect(rankOsrAlive({ candidates: [mk('a', 0, 0, true)], cap: 0, center }).size).toBe(0)
  })
})
