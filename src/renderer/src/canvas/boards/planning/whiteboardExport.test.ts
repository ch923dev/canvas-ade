import { describe, it, expect } from 'vitest'
import { boardToSvg, ARROW_COLOR } from './whiteboardExport'
import type { PlanningBoard } from '../../../lib/boardSchema'

const board = (elements: PlanningBoard['elements']): PlanningBoard => ({
  id: 'p1',
  type: 'planning',
  x: 0,
  y: 0,
  w: 516,
  h: 366,
  title: 'Plan',
  elements
})

describe('boardToSvg — frame', () => {
  it('an empty board exports a non-empty, well-formed svg with a background rect', () => {
    const { svg, width, height } = boardToSvg(board([]), {})
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.includes('xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.trim().endsWith('</svg>')).toBe(true)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(svg).toContain('#141416')
  })

  it('sizes the viewport to the element union plus padding (origin-normalised)', () => {
    const { width, height } = boardToSvg(
      board([{ id: 's', kind: 'stroke', x: 0, y: 0, points: [100, 100, 140, 160] }]),
      {}
    )
    // union is 40×60 at (100,100); + 2*PAD(24) → 88×108
    expect(width).toBe(88)
    expect(height).toBe(108)
  })
})

describe('boardToSvg — vectors', () => {
  it('emits a bezier path for an arrow and a fill path for a stroke', () => {
    const { svg } = boardToSvg(
      board([
        { id: 'a', kind: 'arrow', x: 10, y: 10, x2: 90, y2: 70 },
        { id: 's', kind: 'stroke', x: 0, y: 0, points: [10, 10, 40, 40, 70, 20] }
      ]),
      {}
    )
    expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(svg).toContain(' C ') // cubic bezier from arrowPath
    expect(svg).toContain(ARROW_COLOR)
  })

  it('renders an arrowhead marker so the arrow has a head', () => {
    const { svg } = boardToSvg(
      board([{ id: 'a', kind: 'arrow', x: 0, y: 0, x2: 50, y2: 0 }]),
      {}
    )
    expect(svg).toContain('<marker')
    expect(svg).toContain('marker-end="url(#wb-export-arrow)"')
  })
})

describe('boardToSvg — cards', () => {
  it('renders a note as a tinted rounded rect with its text', () => {
    const { svg } = boardToSvg(
      board([{ id: 'n', kind: 'note', x: 0, y: 0, w: 156, h: 96, tint: 'yellow', text: 'hello', rotation: 0 }]),
      {}
    )
    expect(svg).toContain('<rect')
    expect(svg).toContain('#2a2818') // yellow tint fill
    expect(svg).toContain('hello')
  })

  it('escapes text content (no raw markup injection)', () => {
    const { svg } = boardToSvg(
      board([{ id: 't', kind: 'text', x: 0, y: 0, text: '<b>x</b> & y' }]),
      {}
    )
    expect(svg).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(svg).not.toContain('<b>x</b>')
  })

  it('renders a checklist with title, count, progress bar and item labels', () => {
    const { svg } = boardToSvg(
      board([
        {
          id: 'c',
          kind: 'checklist',
          x: 0,
          y: 0,
          w: 240,
          h: 0,
          title: 'Tasks',
          items: [
            { id: 'i1', label: 'done one', done: true },
            { id: 'i2', label: 'todo two', done: false }
          ]
        }
      ]),
      {}
    )
    expect(svg).toContain('Tasks')
    expect(svg).toContain('1/2') // done/total
    expect(svg).toContain('done one')
    expect(svg).toContain('todo two')
  })
})
