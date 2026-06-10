import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import ConfirmModal from './ConfirmModal'

interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  denyLabel?: string
}
type Reply = (decision: { approved: boolean }) => void
type ConfirmCb = (request: ConfirmRequest, reply: Reply) => void

let captured: ConfirmCb | null = null

// Stub the preload bridge: ConfirmModal subscribes via `window.api.mcp.onConfirm(cb)`;
// the test captures that cb so it can push a request + a reply spy, exactly as MAIN's
// requestConfirm would over the `mcp:confirm` channel.
function stubOnConfirm(): void {
  captured = null
  ;(window as unknown as { api: unknown }).api = {
    mcp: {
      onConfirm: (cb: ConfirmCb) => {
        captured = cb
        return () => {
          captured = null
        }
      }
    }
  }
}

/** Push a confirm request through the captured bridge cb (wrapped in act — it setStates). */
function pushRequest(req: ConfirmRequest): ReturnType<typeof vi.fn> {
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

// Mirrors the deleted `dispatch-confirm` e2e probe's renderer half: the modal renders the
// MAIN request and approve/deny resolve the reply. The fail-closed gate LOGIC (timeout,
// foreign-frame, window-gone) is covered MAIN-side in mcpConfirm.integration.test.ts.
describe('ConfirmModal (integration)', () => {
  it('renders nothing until a request arrives', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    expect(screen.queryByTestId('confirm-modal')).toBeNull()
  })

  it('shows the request, and Approve replies { approved: true } then dismisses', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    const reply = pushRequest({ title: 'Dispatch', body: 'Run "echo hi" in board X?' })
    expect(screen.getByTestId('confirm-modal')).toBeTruthy()
    expect(screen.getByText('Dispatch')).toBeTruthy()
    expect(screen.getByText('Run "echo hi" in board X?')).toBeTruthy()

    fireEvent.click(screen.getByTestId('confirm-approve'))
    expect(reply).toHaveBeenCalledWith({ approved: true })
    expect(screen.queryByTestId('confirm-modal')).toBeNull()
  })

  it('Deny replies { approved: false }', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    const reply = pushRequest({ title: 'Dispatch', body: 'do thing' })
    fireEvent.click(screen.getByTestId('confirm-deny'))
    expect(reply).toHaveBeenCalledWith({ approved: false })
  })

  it('Esc and a backdrop pointerdown both deny (fail-safe direction)', () => {
    stubOnConfirm()
    render(<ConfirmModal />)

    const escReply = pushRequest({ title: 'A', body: 'a' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(escReply).toHaveBeenCalledWith({ approved: false })

    // The shared Modal closes on the scrim's pointerdown (a click's down half) — pointerdown
    // only, so a queue advance can't be double-fired by the down+click pair of one gesture.
    const backdropReply = pushRequest({ title: 'B', body: 'b' })
    fireEvent.pointerDown(screen.getByTestId('confirm-backdrop'))
    expect(backdropReply).toHaveBeenCalledWith({ approved: false })
  })

  it('queues FIFO so two dispatches cannot share one modal; answering the head advances', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    const reply1 = pushRequest({ title: 'First', body: 'first body' })
    const reply2 = pushRequest({ title: 'Second', body: 'second body' })

    // Only the head shows.
    expect(screen.getByText('First')).toBeTruthy()
    expect(screen.queryByText('Second')).toBeNull()

    fireEvent.click(screen.getByTestId('confirm-approve'))
    expect(reply1).toHaveBeenCalledWith({ approved: true })
    // The second now shows; its reply is still pending.
    expect(screen.getByText('Second')).toBeTruthy()
    expect(reply2).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('confirm-deny'))
    expect(reply2).toHaveBeenCalledWith({ approved: false })
    expect(screen.queryByTestId('confirm-modal')).toBeNull()
  })

  it('honours custom confirm/deny labels', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    pushRequest({ title: 'T', body: 'b', confirmLabel: 'Run it', denyLabel: 'Cancel' })
    expect(screen.getByText('Run it')).toBeTruthy()
    expect(screen.getByText('Cancel')).toBeTruthy()
  })
})
