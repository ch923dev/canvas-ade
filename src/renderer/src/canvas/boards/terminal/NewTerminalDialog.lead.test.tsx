import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { NewTerminalDialog } from './NewTerminalDialog'
import { useCanvasStore } from '../../../store/canvasStore'
import { useOrchestrationStore } from '../../../store/orchestrationStore'
import type { TerminalBoard } from '../../../lib/boardSchema'

/**
 * Creation-time lead grant (orchestration S1) — the ordering contract the whole revamp exists
 * for: a ticked "Spawn as orchestrator" must land its DESIGNATION (grantLead) BEFORE onClose
 * releases the held spawn, and a failed grant must keep the dialog open with the board
 * un-spawned (never a silent downgrade to a plain terminal).
 */
const board: TerminalBoard = {
  id: 'tb-1',
  type: 'terminal',
  x: 0,
  y: 0,
  w: 420,
  h: 340,
  title: 'Terminal'
}

const grantLead = vi.fn()

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  grantLead.mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = {
    listShells: vi.fn(async () => [{ path: 'pwsh', label: 'PowerShell', default: true }]),
    orchestration: { grantLead }
  }
  useCanvasStore.setState({
    boards: [board] as never,
    project: { dir: 'C:/proj', name: 'proj', status: 'open' } as never
  })
  useOrchestrationStore.setState({ enabled: true, leadBoardId: null })
})

const $ = (sel: string): HTMLElement => {
  const el = document.querySelector(`[data-test="${sel}"]`)
  if (!el) throw new Error(`missing [data-test=${sel}]`)
  return el as HTMLElement
}

const tickAndCreate = (): void => {
  fireEvent.click($('new-terminal-lead-toggle'))
  fireEvent.click($('new-terminal-create'))
}

describe('NewTerminalDialog — creation-time lead grant', () => {
  it('unticked Create never touches grantLead and closes immediately', () => {
    const onClose = vi.fn()
    render(<NewTerminalDialog board={board} mode="create" onClose={onClose} />)
    fireEvent.click($('new-terminal-create'))
    expect(grantLead).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('ticked Create grants FIRST, then releases the spawn (onClose)', async () => {
    const onClose = vi.fn()
    render(<NewTerminalDialog board={board} mode="create" onClose={onClose} />)
    tickAndCreate()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(grantLead).toHaveBeenCalledWith('tb-1')
    // Ordering: the grant resolved before onClose fired (mock resolves → then applyPatch).
    expect(grantLead.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0])
  })

  it('a failed grant keeps the dialog OPEN (no onClose) with the reason inline', async () => {
    grantLead.mockResolvedValue({ ok: false, reason: 'no-server' })
    const onClose = vi.fn()
    render(<NewTerminalDialog board={board} mode="create" onClose={onClose} />)
    tickAndCreate()
    await waitFor(() =>
      expect($('new-terminal-lead-error').textContent).toMatch(/could not start/i)
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('retries a not-found grant (mirror debounce) and succeeds', async () => {
    grantLead
      .mockResolvedValueOnce({ ok: false, reason: 'not-found' })
      .mockResolvedValueOnce({ ok: true })
    const onClose = vi.fn()
    render(<NewTerminalDialog board={board} mode="create" onClose={onClose} />)
    tickAndCreate()
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 })
    expect(grantLead).toHaveBeenCalledTimes(2)
  })

  it('consent off → the row is disabled with the reason inline; tick is inert', () => {
    useOrchestrationStore.setState({ enabled: false })
    render(<NewTerminalDialog board={board} mode="create" onClose={vi.fn()} />)
    const row = $('new-terminal-lead-row')
    expect(row.textContent).toMatch(/enable agent orchestration/i)
    fireEvent.click($('new-terminal-lead-toggle'))
    fireEvent.click($('new-terminal-create'))
    expect(grantLead).not.toHaveBeenCalled()
  })

  it('lead held elsewhere → disabled, the holder is NAMED', () => {
    useCanvasStore.setState({
      boards: [board, { ...board, id: 'other', title: 'build agent' }] as never
    })
    useOrchestrationStore.setState({ leadBoardId: 'other' })
    render(<NewTerminalDialog board={board} mode="create" onClose={vi.fn()} />)
    expect($('new-terminal-lead-row').textContent).toContain('build agent')
  })

  it('edit mode renders NO lead row (live boards promote from the board menu)', () => {
    render(<NewTerminalDialog board={board} mode="edit" onClose={vi.fn()} />)
    expect(document.querySelector('[data-test="new-terminal-lead-row"]')).toBeNull()
  })
})
