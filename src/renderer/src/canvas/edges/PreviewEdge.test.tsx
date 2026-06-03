import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Position, ReactFlowProvider, type EdgeProps } from '@xyflow/react'
import { PreviewEdge } from './PreviewEdge'
import { edgePositions } from './floatingPath'

// globals:false → RTL's auto-cleanup hook isn't registered, so each render would leak its
// path into the next test (and querySelector would return a stale earlier edge). Clean up.
afterEach(cleanup)

// Stale-styling render (migrated from the e2e `preview-edge-stale` probe): mock
// useInternalNode so the edge resolves its two endpoints WITHOUT a full ReactFlow mount
// (PreviewEdge returns null until both nodes exist). Everything else — BaseEdge,
// getBezierPath, the stale→dash/dim style branch — stays real, so the rendered <path>
// reflects the component's actual styling. The `stale` data flag itself is computed +
// covered in previewEdges.test.ts; this asserts the EDGE renders it.
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  return {
    ...actual,
    useInternalNode: (id: string) => ({
      internals: { positionAbsolute: { x: id === 's' ? 0 : 300, y: 0 } },
      measured: { width: 100, height: 60 }
    })
  }
})

// Bug M4: the bezier's source/target Position pair must follow the boards' geometry
// (the dominant axis between the two centers), not a hardcoded Right→Left, or the
// control arms fishhook/S-curve when the browser board is left/above/below the
// terminal. edgePositions derives the pair; here we drive each cardinal relationship.
describe('edgePositions', () => {
  const source = { x: 0, y: 0 }

  it('browser to the right → Right/Left', () => {
    expect(edgePositions(source, { x: 400, y: 0 })).toEqual({
      sourcePosition: Position.Right,
      targetPosition: Position.Left
    })
  })

  it('browser to the left → Left/Right', () => {
    expect(edgePositions(source, { x: -400, y: 0 })).toEqual({
      sourcePosition: Position.Left,
      targetPosition: Position.Right
    })
  })

  it('browser above → Top/Bottom', () => {
    expect(edgePositions(source, { x: 0, y: -400 })).toEqual({
      sourcePosition: Position.Top,
      targetPosition: Position.Bottom
    })
  })

  it('browser below → Bottom/Top', () => {
    expect(edgePositions(source, { x: 0, y: 400 })).toEqual({
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    })
  })

  it('picks the dominant axis when both deltas are non-zero', () => {
    // Mostly horizontal (|dx| > |dy|), target to the right and slightly below.
    expect(edgePositions(source, { x: 400, y: 50 })).toEqual({
      sourcePosition: Position.Right,
      targetPosition: Position.Left
    })
    // Mostly vertical (|dy| > |dx|), target below and slightly left.
    expect(edgePositions(source, { x: -50, y: 400 })).toEqual({
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top
    })
  })
})

function renderEdge(stale: boolean): SVGPathElement | null {
  render(
    <ReactFlowProvider>
      <svg>
        <PreviewEdge
          {...({
            id: 'preview-b1',
            source: 's',
            target: 't',
            data: { stale }
          } as unknown as EdgeProps)}
        />
      </svg>
    </ReactFlowProvider>
  )
  return document.querySelector('.react-flow__edge-path') as SVGPathElement | null
}

describe('PreviewEdge stale styling (migrated from preview-edge-stale)', () => {
  it('a live edge renders solid (no dash) at full opacity', () => {
    const path = renderEdge(false)
    expect(path).not.toBeNull()
    const dash = path?.style.strokeDasharray ?? ''
    expect(dash === '' || dash === 'none').toBe(true)
    expect(path?.style.opacity).toBe('0.9')
  })

  it('a stale edge renders dashed and dimmed', () => {
    const path = renderEdge(true)
    expect(path?.style.strokeDasharray).toContain('5')
    expect(path?.style.opacity).toBe('0.4')
  })
})
