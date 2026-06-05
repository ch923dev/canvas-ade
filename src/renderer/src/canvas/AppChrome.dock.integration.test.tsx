// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Dock } from './AppChrome'
import { useCanvasStore } from '../store/canvasStore'

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    selectedId: null,
    tool: 'select',
    past: [],
    future: []
  })
})
afterEach(() => cleanup())

describe('Dock arms a board type (drag-to-create)', () => {
  it('clicking +Terminal sets tool to terminal and adds NO board', () => {
    render(<Dock />)
    fireEvent.click(screen.getByText('Terminal'))
    expect(useCanvasStore.getState().tool).toBe('terminal')
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })

  it('clicking Select clears the armed tool back to select', () => {
    useCanvasStore.setState({ tool: 'browser' })
    render(<Dock />)
    fireEvent.click(screen.getByTitle('Select'))
    expect(useCanvasStore.getState().tool).toBe('select')
  })
})
