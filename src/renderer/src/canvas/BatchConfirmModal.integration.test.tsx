import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import BatchConfirmModal from './BatchConfirmModal'

interface BatchRequest {
  title: string
  items: Array<{ label: string; body: string }>
}
type Reply = (decision: { decisions: Array<{ approved: boolean }> }) => void
type Cb = (request: BatchRequest, reply: Reply) => void

let captured: Cb | null = null

// Stub the preload bridge: BatchConfirmModal subscribes via `window.api.mcp.onConfirmBatch(cb)`;
// the test captures that cb to push a request + a reply spy, exactly as MAIN's requestConfirmBatch
// would over the `mcp:confirm:batch` channel.
function stub(): void {
  captured = null
  ;(window as unknown as { api: unknown }).api = {
    mcp: {
      onConfirmBatch: (cb: Cb) => {
        captured = cb
        return () => {
          captured = null
        }
      }
    }
  }
}

function push(req: BatchRequest): ReturnType<typeof vi.fn> {
  const reply = vi.fn()
  act(() => {
    captured?.(req, reply)
  })
  return reply
}

afterEach(() => {
  cleanup()
  captured = null
  delete (window as unknown as { api?: unknown }).api
})

const REQ: BatchRequest = {
  title: 'Relay 3 prompts',
  items: [
    { label: 'A → B', body: 'npm run build' },
    { label: 'A → C', body: 'npm test' },
    { label: 'A → D', body: 'rm -rf dist' }
  ]
}
const yes = { approved: true }
const no = { approved: false }

describe('BatchConfirmModal (integration)', () => {
  it('renders nothing until a batch request arrives', () => {
    stub()
    render(<BatchConfirmModal />)
    expect(screen.queryByTestId('batch-confirm-modal')).toBeNull()
  })

  it('shows every row; all selected by default → Approve approves every row', () => {
    stub()
    render(<BatchConfirmModal />)
    const reply = push(REQ)
    expect(screen.getByTestId('batch-confirm-modal')).toBeTruthy()
    expect(screen.getByText('npm run build')).toBeTruthy()
    expect(screen.getByText('rm -rf dist')).toBeTruthy()
    expect(screen.getByTestId('batch-confirm-approve').textContent).toContain('3')
    fireEvent.click(screen.getByTestId('batch-confirm-approve'))
    expect(reply).toHaveBeenCalledWith({ decisions: [yes, yes, yes] })
  })

  it('unticking a row denies just that row on approve, and the count updates', () => {
    stub()
    render(<BatchConfirmModal />)
    const reply = push(REQ)
    fireEvent.click(screen.getByTestId('batch-confirm-row-2')) // untick row 2 (rm -rf dist)
    expect(screen.getByTestId('batch-confirm-approve').textContent).toContain('2')
    fireEvent.click(screen.getByTestId('batch-confirm-approve'))
    expect(reply).toHaveBeenCalledWith({ decisions: [yes, yes, no] })
  })

  it('Deny all denies every row', () => {
    stub()
    render(<BatchConfirmModal />)
    const reply = push(REQ)
    fireEvent.click(screen.getByTestId('batch-confirm-deny'))
    expect(reply).toHaveBeenCalledWith({ decisions: [no, no, no] })
  })

  it('Approve is disabled when no rows are selected', () => {
    stub()
    render(<BatchConfirmModal />)
    push(REQ)
    fireEvent.click(screen.getByTestId('batch-confirm-row-0'))
    fireEvent.click(screen.getByTestId('batch-confirm-row-1'))
    fireEvent.click(screen.getByTestId('batch-confirm-row-2'))
    expect((screen.getByTestId('batch-confirm-approve') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Esc denies all; a backdrop pointerdown is INERT (scrimClose={false})', () => {
    stub()
    render(<BatchConfirmModal />)

    const escReply = push(REQ)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(escReply).toHaveBeenCalledWith({ decisions: [no, no, no] })

    // 🔒 Click-outside neither approves nor denies; the modal stays up for an explicit answer.
    const inertReply = push(REQ)
    fireEvent.pointerDown(screen.getByTestId('batch-confirm-backdrop'))
    expect(inertReply).not.toHaveBeenCalled()
    expect(screen.getByTestId('batch-confirm-modal')).toBeTruthy()
  })

  it('queues FIFO — the second batch shows only after the first is answered', () => {
    stub()
    render(<BatchConfirmModal />)
    const r1 = push({ title: 'First', items: [{ label: 'x', body: 'one' }] })
    const r2 = push({ title: 'Second', items: [{ label: 'y', body: 'two' }] })

    expect(screen.getByText('First')).toBeTruthy()
    expect(screen.queryByText('Second')).toBeNull()

    fireEvent.click(screen.getByTestId('batch-confirm-approve'))
    expect(r1).toHaveBeenCalledWith({ decisions: [yes] })
    expect(screen.getByText('Second')).toBeTruthy()
    expect(r2).not.toHaveBeenCalled()
  })
})
