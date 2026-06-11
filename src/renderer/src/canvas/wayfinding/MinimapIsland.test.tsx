// @vitest-environment jsdom
/**
 * MinimapIsland (D4-C) — component contract tests with React Flow mocked (the real
 * <MiniMap> needs a live RF store/measured pane, neither available in jsdom; the real
 * rendering + camera-jump are pinned by e2e/wayfinding.e2e.ts on real input).
 * Covers: hidden ⇒ null (no DOM, no chrome zone) · visible ⇒ themed MiniMap ·
 * board-rect click jumps via the injected D4-B focus path AND stops propagation
 * (the svg-level teleport handler must not also fire) · empty-map click teleports
 * (setCenter at the clicked flow position, current zoom kept).
 */
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { MouseEvent } from 'react'

const setCenter = vi.fn().mockResolvedValue(true)
const getViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 0.7 }))

// Capture the props the wrapper hands to RF's <MiniMap> (rendered as a stub).
let miniMapProps: Record<string, unknown> = {}
vi.mock('@xyflow/react', () => ({
  MiniMap: (props: Record<string, unknown>): React.ReactElement => {
    miniMapProps = props
    return <div data-testid="rf-minimap-stub" className={props.className as string} />
  },
  useReactFlow: () => ({ setCenter, getViewport })
}))

import { MinimapIsland } from './MinimapIsland'
import { useWayfindingStore } from '../../store/wayfindingStore'

beforeEach(() => {
  vi.clearAllMocks()
  miniMapProps = {}
  useWayfindingStore.setState({ minimapVisible: false })
})

// globals:false → testing-library's auto-cleanup never registers; unmount explicitly
// or stubs (and their captured props) leak across tests.
afterEach(cleanup)

describe('MinimapIsland (D4-C)', () => {
  it('renders nothing while hidden (no DOM → no ADR 0002 chrome zone)', () => {
    const { container } = render(<MinimapIsland onJumpToBoard={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the themed MiniMap while visible (pannable, zoomable, labelled)', () => {
    useWayfindingStore.setState({ minimapVisible: true })
    render(<MinimapIsland onJumpToBoard={vi.fn()} />)
    expect(screen.getByTestId('rf-minimap-stub')).toBeTruthy()
    expect(miniMapProps.className).toBe('wayfinding-minimap')
    expect(miniMapProps.pannable).toBe(true)
    expect(miniMapProps.zoomable).toBe(true)
    expect(miniMapProps.ariaLabel).toBe('Canvas minimap')
  })

  it('board-rect click jumps via the injected focus path and stops propagation', () => {
    useWayfindingStore.setState({ minimapVisible: true })
    const onJumpToBoard = vi.fn()
    render(<MinimapIsland onJumpToBoard={onJumpToBoard} />)
    const stopPropagation = vi.fn()
    const onNodeClick = miniMapProps.onNodeClick as (e: unknown, node: { id: string }) => void
    onNodeClick({ stopPropagation } as unknown as MouseEvent, { id: 'b1' })
    expect(onJumpToBoard).toHaveBeenCalledWith('b1')
    expect(stopPropagation).toHaveBeenCalled() // svg-level teleport must NOT also fire
    expect(setCenter).not.toHaveBeenCalled()
  })

  it('empty-map click teleports: setCenter at the clicked flow position, zoom kept', () => {
    useWayfindingStore.setState({ minimapVisible: true })
    render(<MinimapIsland onJumpToBoard={vi.fn()} />)
    const onClick = miniMapProps.onClick as (e: unknown, p: { x: number; y: number }) => void
    onClick({} as MouseEvent, { x: 1200, y: -340 })
    expect(setCenter).toHaveBeenCalledTimes(1)
    const [x, y, opts] = (setCenter as Mock).mock.calls[0]
    expect(x).toBe(1200)
    expect(y).toBe(-340)
    expect((opts as { zoom: number }).zoom).toBe(0.7) // current camera zoom, not a re-fit
  })
})
