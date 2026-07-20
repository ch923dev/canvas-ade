// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

afterEach(cleanup) // globals:false ⇒ RTL auto-cleanup never registers (house convention)
import { DiagramSpecView } from './DiagramSpecView'
import { DiagramCard } from './DiagramCard'
import type { DiagramSpec } from '../../../lib/diagramSpec'
import type { DiagramElement } from '../../../lib/boardSchema'

// The ELK engine is a lazy worker chunk — deterministic fake here (the pure mapping around it is
// covered by specLayout.test.ts; e2e exercises the real engine in the app).
vi.mock('./specElk', () => ({
  elkLayout: (graph: { children: { id: string; width?: number; height?: number }[] }) =>
    Promise.resolve({
      id: 'root',
      children: graph.children.map((c, i) => ({
        ...c,
        x: 16 + i * 240,
        y: 16,
        width: c.width ?? 180,
        height: c.height ?? 60,
        children: undefined
      }))
    })
}))

const spec: DiagramSpec = {
  version: 1,
  title: 'Pipeline',
  direction: 'right',
  nodes: [
    { id: 'lint', label: 'Lint', status: 'done', detail: '0 errors' },
    { id: 'gate', label: 'Matrix green?', kind: 'decision' },
    { id: 'evil', label: '<b>not markup</b>', status: 'error' }
  ],
  edges: [
    { id: 'e1', from: 'lint', to: 'gate', label: 'then', animated: true },
    { id: 'e2', from: 'gate', to: 'evil', kind: 'dependency' }
  ]
}

describe('DiagramSpecView (static expanse renderer)', () => {
  it('renders labels, details and status glyphs as plain text nodes', async () => {
    render(<DiagramSpecView spec={spec} w={800} h={400} />)
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    expect(screen.getByText('0 errors')).toBeTruthy()
    expect(screen.getByText('Matrix green?')).toBeTruthy()
    expect(screen.getByText('✓')).toBeTruthy() // done glyph
    expect(screen.getByText('✕')).toBeTruthy() // error glyph
  })

  it('never interprets a spec string as markup (React text-node contract)', async () => {
    const { container } = render(<DiagramSpecView spec={spec} w={800} h={400} />)
    await waitFor(() => expect(screen.getByText('<b>not markup</b>')).toBeTruthy())
    expect(container.querySelector('b')).toBeNull()
  })

  it('draws one edge path per edge, styling animated (accent dash) and dependency (dashed)', async () => {
    const { container } = render(<DiagramSpecView spec={spec} w={800} h={400} />)
    await waitFor(() => expect(container.querySelectorAll('.pl-spec-edge')).toHaveLength(2))
    const paths = [...container.querySelectorAll<SVGPathElement>('.pl-spec-edge path')]
    const animated = paths.find((p) => p.getAttribute('stroke') === '#4f8cff')
    expect(animated?.getAttribute('stroke-dasharray')).toBe('6 5')
    const dep = paths.find((p) => p.getAttribute('stroke-dasharray') === '3 4')
    expect(dep).toBeTruthy()
    expect(screen.getByText('then')).toBeTruthy() // edge label
  })

  it('adds NO focusable/interactive elements and stays pointer-inert (the #363 keystroke class)', async () => {
    const { container } = render(<DiagramSpecView spec={spec} w={800} h={400} />)
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    expect(container.querySelector('button, input, textarea, select, [tabindex]')).toBeNull()
    const root = container.querySelector<HTMLElement>('.pl-specview')
    expect(root?.style.pointerEvents).toBe('none')
  })

  it('positions a down-direction edge label on the down anchors (not the right formula)', async () => {
    const down: DiagramSpec = {
      version: 1,
      direction: 'down',
      nodes: [
        { id: 'a', label: 'A', kind: 'actor' }, // 120×32
        { id: 'b', label: 'B', detail: 'sub' } // 168×49 — unequal boxes split the two formulas
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', label: 'next' }]
    }
    const { container } = render(<DiagramSpecView spec={down} w={800} h={400} />)
    await waitFor(() => expect(screen.getByText('next')).toBeTruthy())
    const label = container.querySelector<SVGTextElement>('.pl-spec-edge text')
    // mock layout: a(16,16), b(256,16) → bottom-mid (76,48) → top-mid (340,16), midpoint (208,32)
    expect(label?.getAttribute('x')).toBe('208')
    expect(label?.getAttribute('y')).toBe('27') // midpoint y − 5 lift
  })

  it('renders a group as a labelled cluster', async () => {
    const grouped: DiagramSpec = {
      ...spec,
      groups: [{ id: 'build', label: 'Build' }],
      nodes: spec.nodes.map((n) => (n.id === 'lint' ? { ...n, group: 'build' } : n))
    }
    render(<DiagramSpecView spec={grouped} w={800} h={400} />)
    await waitFor(() => expect(screen.getByText('Build')).toBeTruthy())
  })
})

describe('DiagramCard engine branch (expanse)', () => {
  const element: DiagramElement = {
    id: 'd1',
    kind: 'diagram',
    engine: 'expanse',
    spec,
    x: 0,
    y: 0,
    w: 600,
    h: 380
  }
  const noop = (): void => undefined

  it('renders the spec view, shows the spec title chip, and hides the source editor toggle', async () => {
    const { container } = render(
      <DiagramCard
        element={element}
        boardId="b1"
        interactive
        selected
        onDragStart={noop}
        onChangeSource={noop}
        onEditStart={noop}
        onCache={noop}
        onResize={noop}
      />
    )
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    expect(container.querySelector('.pl-specview')).toBeTruthy()
    expect(screen.getByText('Pipeline')).toBeTruthy() // header chip = spec title
    expect(screen.queryByTitle('Edit source')).toBeNull() // spec editing is Phase-4 gated
    expect(screen.getByTitle('Reset to fit')).toBeTruthy() // zoom controls still live
  })
})
