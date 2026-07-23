// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

afterEach(cleanup) // globals:false ⇒ RTL auto-cleanup never registers (house convention)
import { DiagramPalette } from './DiagramPalette'

/** The rail is collapsed by default (a ＋ toggle); expand it before interacting with the swatches. */
function openPalette(): void {
  fireEvent.click(screen.getByTitle('Add node'))
}

describe('DiagramPalette (palette mapping)', () => {
  it('is collapsed by default and expands on the ＋ toggle', () => {
    render(<DiagramPalette onAddNode={vi.fn()} />)
    expect(screen.queryByTitle('decision')).toBeNull() // collapsed: no swatches yet
    openPalette()
    expect(screen.getByTitle('decision')).toBeTruthy()
  })

  it('adds a node with the clicked kind, default neutral status, no icon', () => {
    const onAdd = vi.fn()
    render(<DiagramPalette onAddNode={onAdd} />)
    openPalette()
    fireEvent.click(screen.getByTitle('decision'))
    expect(onAdd).toHaveBeenCalledWith({ kind: 'decision', status: 'neutral', icon: undefined })
  })

  it('applies the selected status + icon to a subsequently added kind', () => {
    const onAdd = vi.fn()
    render(<DiagramPalette onAddNode={onAdd} />)
    openPalette()
    fireEvent.click(screen.getByTitle('active')) // status
    fireEvent.click(screen.getByTitle('cpu')) // icon
    fireEvent.click(screen.getByTitle('service')) // kind → add
    expect(onAdd).toHaveBeenCalledWith({ kind: 'service', status: 'active', icon: 'cpu' })
  })

  it('toggling the same icon twice clears it (back to the kind glyph)', () => {
    const onAdd = vi.fn()
    render(<DiagramPalette onAddNode={onAdd} />)
    openPalette()
    fireEvent.click(screen.getByTitle('cpu'))
    fireEvent.click(screen.getByTitle('cpu')) // toggle off
    fireEvent.click(screen.getByTitle('step'))
    expect(onAdd).toHaveBeenCalledWith({ kind: 'step', status: 'neutral', icon: undefined })
  })

  it('offers exactly the closed kind + status vocabularies', () => {
    render(<DiagramPalette onAddNode={vi.fn()} />)
    openPalette()
    for (const k of ['step', 'decision', 'data', 'service', 'artifact', 'actor', 'note']) {
      expect(screen.getByTitle(k)).toBeTruthy()
    }
    for (const s of ['neutral', 'active', 'done', 'error', 'warn', 'muted']) {
      expect(screen.getByTitle(s)).toBeTruthy()
    }
  })
})
