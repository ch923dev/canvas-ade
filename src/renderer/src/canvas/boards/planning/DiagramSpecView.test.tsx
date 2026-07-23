// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

afterEach(cleanup) // globals:false ⇒ RTL auto-cleanup never registers (house convention)
import type { ReactElement } from 'react'
import { DiagramSpecView } from './DiagramSpecView'
import { DiagramCard } from './DiagramCard'
import { useSpecLayout } from './useSpecLayout'
import { useDiagramMotionStore } from '../../../store/diagramMotionStore'
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

/** Since Phase 2 the card owns the layout (hit-testing / revision memo) — this host stands in for
 *  DiagramCard so the view's tests exercise the same hook→props wiring the app uses. */
function Host({
  spec,
  motion = false,
  focusId = null,
  w = 800,
  h = 400
}: {
  spec: DiagramSpec
  motion?: boolean
  focusId?: string | null
  w?: number
  h?: number
}): ReactElement {
  const { layout, error } = useSpecLayout(spec)
  return (
    <DiagramSpecView
      spec={spec}
      w={w}
      h={h}
      motion={motion}
      layout={layout}
      error={error}
      focusId={focusId}
    />
  )
}

describe('DiagramSpecView (static expanse renderer)', () => {
  it('renders labels, details and status glyphs as plain text nodes', async () => {
    render(<Host spec={spec} />)
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    expect(screen.getByText('0 errors')).toBeTruthy()
    expect(screen.getByText('Matrix green?')).toBeTruthy()
    expect(screen.getByText('✓')).toBeTruthy() // done glyph
    expect(screen.getByText('✕')).toBeTruthy() // error glyph
  })

  it('never interprets a spec string as markup (React text-node contract)', async () => {
    const { container } = render(<Host spec={spec} />)
    await waitFor(() => expect(screen.getByText('<b>not markup</b>')).toBeTruthy())
    expect(container.querySelector('b')).toBeNull()
  })

  it('draws one edge path per edge, styling animated (accent dash) and dependency (dashed)', async () => {
    const { container } = render(<Host spec={spec} />)
    await waitFor(() => expect(container.querySelectorAll('.pl-spec-edge')).toHaveLength(2))
    const paths = [...container.querySelectorAll<SVGPathElement>('.pl-spec-edge path')]
    const animated = paths.find((p) => p.getAttribute('stroke') === '#4f8cff')
    expect(animated?.getAttribute('stroke-dasharray')).toBe('6 5')
    const dep = paths.find((p) => p.getAttribute('stroke-dasharray') === '3 4')
    expect(dep).toBeTruthy()
    expect(screen.getByText('then')).toBeTruthy() // edge label
  })

  it('adds NO focusable/interactive elements and stays pointer-inert (the #363 keystroke class)', async () => {
    const { container } = render(<Host spec={spec} />)
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
    const { container } = render(<Host spec={down} />)
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
    render(<Host spec={grouped} />)
    await waitFor(() => expect(screen.getByText('Build')).toBeTruthy())
  })

  it('tints a statused group cluster (border + label pick up the status hue)', async () => {
    const grouped: DiagramSpec = {
      ...spec,
      groups: [{ id: 'build', label: 'Build', status: 'done' }],
      nodes: spec.nodes.map((n) => (n.id === 'lint' ? { ...n, group: 'build' } : n))
    }
    const { container } = render(<Host spec={grouped} />)
    await waitFor(() => expect(screen.getByText('Build')).toBeTruthy())
    const cluster = container.querySelector<HTMLElement>('.pl-spec-group')
    // jsdom has no :root tokens ⇒ specGroupStyle falls back to the literal ok hue at 0.5 alpha.
    expect(cluster?.style.border).toContain('dashed')
    expect(cluster?.style.border).toContain('rgba(62, 207, 142, 0.5)')
  })

  it('stamps the composed motion gate on the root (pl-motion-on / pl-motion-off)', async () => {
    const on = render(<Host spec={spec} motion />)
    await waitFor(() => expect(on.container.querySelector('.pl-specview')).toBeTruthy())
    expect(on.container.querySelector('.pl-specview')?.classList.contains('pl-motion-on')).toBe(
      true
    )
    cleanup()
    const off = render(<Host spec={spec} />)
    await waitFor(() => expect(off.container.querySelector('.pl-specview')).toBeTruthy())
    expect(off.container.querySelector('.pl-specview')?.classList.contains('pl-motion-off')).toBe(
      true
    )
  })

  it('pulses a node once when its status flips (and only under motion)', async () => {
    const { container, rerender } = render(<Host spec={spec} motion />)
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    expect(container.querySelector('.pl-spec-pulse')).toBeNull() // first paint never pulses
    const flipped: DiagramSpec = {
      ...spec,
      nodes: spec.nodes.map((n) => (n.id === 'lint' ? { ...n, status: 'active' as const } : n))
    }
    rerender(<Host spec={flipped} motion />)
    await waitFor(() => {
      const pulsing = container.querySelector<HTMLElement>('.pl-spec-pulse')
      expect(pulsing?.textContent).toContain('Lint')
    })
  })

  it('never pulses with motion off (status flip renders statically)', async () => {
    const { container, rerender } = render(<Host spec={spec} />)
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    const flipped: DiagramSpec = {
      ...spec,
      nodes: spec.nodes.map((n) => (n.id === 'lint' ? { ...n, status: 'active' as const } : n))
    }
    rerender(<Host spec={flipped} />)
    await waitFor(() => expect(screen.getByText('●')).toBeTruthy()) // active glyph landed
    expect(container.querySelector('.pl-spec-pulse')).toBeNull()
  })

  it('fades a removed node out as an exit ghost — never counted as a live pl-spec-node', async () => {
    const { container, rerender } = render(<Host spec={spec} motion />)
    await waitFor(() => expect(container.querySelectorAll('.pl-spec-node')).toHaveLength(3))
    const dropped: DiagramSpec = {
      ...spec,
      nodes: spec.nodes.filter((n) => n.id !== 'evil'),
      edges: spec.edges.filter((e) => e.to !== 'evil')
    }
    rerender(<Host spec={dropped} motion />)
    await waitFor(() => {
      const ghost = container.querySelector<HTMLElement>('.pl-spec-node-exit')
      expect(ghost?.textContent).toContain('<b>not markup</b>')
    })
    // The count pin the e2e suite relies on: ghosts are NOT .pl-spec-node.
    expect(container.querySelectorAll('.pl-spec-node')).toHaveLength(2)
    await waitFor(() => expect(container.querySelector('.pl-spec-node-exit')).toBeNull())
  })

  it('spawns no ghosts with motion off (removal is instant)', async () => {
    const { container, rerender } = render(<Host spec={spec} />)
    await waitFor(() => expect(container.querySelectorAll('.pl-spec-node')).toHaveLength(3))
    const dropped: DiagramSpec = {
      ...spec,
      nodes: spec.nodes.filter((n) => n.id !== 'evil'),
      edges: spec.edges.filter((e) => e.to !== 'evil')
    }
    rerender(<Host spec={dropped} />)
    await waitFor(() => expect(container.querySelectorAll('.pl-spec-node')).toHaveLength(2))
    expect(container.querySelector('.pl-spec-node-exit')).toBeNull()
  })

  it('dims non-neighbours (inline 0.22 — inline status opacity outranks the stylesheet)', async () => {
    // Focus 'lint': lit = lint + e1 + gate; 'evil' and e2 dim.
    const { container } = render(<Host spec={spec} focusId="lint" />)
    await waitFor(() => expect(container.querySelectorAll('.pl-spec-node')).toHaveLength(3))
    const nodes = [...container.querySelectorAll<HTMLElement>('.pl-spec-node')]
    const evil = nodes.find((n) => n.textContent?.includes('not markup'))
    const lint = nodes.find((n) => n.textContent?.includes('Lint'))
    const gate = nodes.find((n) => n.textContent?.includes('Matrix'))
    expect(evil?.classList.contains('pl-spec-dim')).toBe(true)
    expect(evil?.style.opacity).toBe('0.22')
    expect(lint?.classList.contains('pl-spec-dim')).toBe(false)
    expect(gate?.classList.contains('pl-spec-dim')).toBe(false)
    const dimEdges = [...container.querySelectorAll('.pl-spec-edge.pl-spec-dim')]
    expect(dimEdges).toHaveLength(1) // e2 (gate→evil); e1 touches the focus and stays lit
  })

  it('ignores a stale focus id (focused node removed by a spec edit ⇒ nothing dims)', async () => {
    const { container } = render(<Host spec={spec} focusId="no-such-node" />)
    await waitFor(() => expect(container.querySelectorAll('.pl-spec-node')).toHaveLength(3))
    expect(container.querySelector('.pl-spec-dim')).toBeNull()
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
        onConvert={noop}
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

  it('folds an authored-collapsed group to its chip through the derived spec (M4)', async () => {
    const grouped: DiagramSpec = {
      ...spec,
      groups: [{ id: 'build', label: 'Build', collapsed: true }],
      nodes: spec.nodes.map((n) => (n.id === 'lint' ? { ...n, group: 'build' } : n))
    }
    const { container } = render(
      <DiagramCard
        element={{ ...element, spec: grouped }}
        boardId="b1"
        interactive
        selected
        onDragStart={noop}
        onChangeSource={noop}
        onConvert={noop}
        onEditStart={noop}
        onCache={noop}
        onResize={noop}
      />
    )
    await waitFor(() => expect(screen.getByText('Build (1)')).toBeTruthy())
    expect(screen.queryByText('Lint')).toBeNull() // the member folded away
    expect(container.querySelector('.pl-spec-chip')).toBeTruthy()
  })

  it('scrubs revision history read-only from the header (M6/B4)', async () => {
    const oldSpec: DiagramSpec = {
      version: 1,
      title: 'Old pipeline',
      direction: 'right',
      nodes: [{ id: 'old1', label: 'OldNode' }],
      edges: []
    }
    render(
      <DiagramCard
        element={{ ...element, revisions: [{ spec: oldSpec, ts: 1, author: 'agent' }] }}
        boardId="b1"
        interactive
        selected
        onDragStart={noop}
        onChangeSource={noop}
        onConvert={noop}
        onEditStart={noop}
        onCache={noop}
        onResize={noop}
      />
    )
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    expect(screen.getByText('2/2')).toBeTruthy() // head of a 1-revision history
    fireEvent.click(screen.getByTitle('Older revision'))
    await waitFor(() => expect(screen.getByText('OldNode')).toBeTruthy())
    expect(screen.queryByText('Lint')).toBeNull() // the peek replaces the live render…
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.getByText('Old pipeline')).toBeTruthy() // …title chip follows the peek
    fireEvent.click(screen.getByTitle('Newer revision'))
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy()) // back to the live head
  })

  it('the app motion setting gates the view (M7): off ⇒ pl-motion-off even without OS reduced-motion', async () => {
    useDiagramMotionStore.setState({ setting: 'off' })
    try {
      const { container } = render(
        <DiagramCard
          element={element}
          boardId="b1"
          interactive
          selected
          onDragStart={noop}
          onChangeSource={noop}
          onConvert={noop}
          onEditStart={noop}
          onCache={noop}
          onResize={noop}
        />
      )
      await waitFor(() => expect(container.querySelector('.pl-specview')).toBeTruthy())
      expect(container.querySelector('.pl-specview')?.classList.contains('pl-motion-off')).toBe(
        true
      )
    } finally {
      useDiagramMotionStore.setState({ setting: 'auto' })
    }
  })
})
