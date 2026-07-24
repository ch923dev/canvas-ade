// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

afterEach(cleanup) // globals:false ⇒ RTL auto-cleanup never registers (house convention)
import { DiagramCard } from './DiagramCard'
import { useDiagramMotionStore } from '../../../store/diagramMotionStore'
import type { DiagramSpec } from '@expanse-ade/diagram'
import type { DiagramElement } from '../../../lib/boardSchema'

// The engine-branch host tests for the extracted @expanse-ade/diagram renderer (the view-level
// suite moved INTO the package with the Phase 5 Card 2 extraction). No worker factory is
// configured here (the bridge is wired from main.tsx, not tests), so the package's specElk falls
// back to the REAL in-thread elk.bundled engine — assertions pin text/classes, never coordinates.

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
        onChangeSpec={noop}
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
        onChangeSpec={noop}
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
        onChangeSpec={noop}
        onEditStart={noop}
        onCache={noop}
        onResize={noop}
      />
    )
    await waitFor(() => expect(screen.getByText('Lint')).toBeTruthy())
    expect(screen.getByText('2/2')).toBeTruthy() // head of a 1-revision history
    fireEvent.click(screen.getByTitle('Older revision'))
    await waitFor(() => expect(screen.getByText('OldNode')).toBeTruthy())
    // The peek replaces the live render; the displaced 'Lint' node lingers one EXIT_MS exit-fade
    // ghost, so await its disappearance (a bare sync assert races the async layout vs the fade).
    await waitFor(() => expect(screen.queryByText('Lint')).toBeNull())
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
          onChangeSpec={noop}
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
