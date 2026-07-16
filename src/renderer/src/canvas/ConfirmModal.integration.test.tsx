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

  it('Esc denies (fail-safe direction)', () => {
    stubOnConfirm()
    render(<ConfirmModal />)

    const escReply = pushRequest({ title: 'A', body: 'a' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(escReply).toHaveBeenCalledWith({ approved: false })
  })

  it('a backdrop pointerdown is INERT — no approve, no deny (scrimClose={false})', () => {
    stubOnConfirm()
    render(<ConfirmModal />)

    // 🔒 Click-outside must not decide a dangerous dispatch: the scrim pointerdown neither
    // approves nor denies, and the modal stays up so the human still answers via a button.
    const reply = pushRequest({ title: 'B', body: 'b' })
    fireEvent.pointerDown(screen.getByTestId('confirm-backdrop'))
    expect(reply).not.toHaveBeenCalled()
    expect(screen.getByTestId('confirm-modal')).toBeTruthy()

    // The explicit Deny still answers it.
    fireEvent.click(screen.getByTestId('confirm-deny'))
    expect(reply).toHaveBeenCalledWith({ approved: false })
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

// ── J4: origin routing — a MAIN-stamped Jarvis confirm parks on the panel store ──
import { useJarvisStore } from '../store/jarvisStore'

describe('J4 origin routing', () => {
  afterEach(() => {
    useJarvisStore.getState().answerPendingConfirm(false)
    useJarvisStore.setState({ panelOpen: false })
  })

  it('origin:"jarvis" + open panel → routes to the panel store, NO modal', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    useJarvisStore.setState({ panelOpen: true })
    const reply = pushRequest({
      title: 'Jarvis: spawn a board',
      body: 'Spawn a terminal',
      origin: 'jarvis'
    } as never)
    expect(screen.queryByTestId('confirm-modal')).toBeNull()
    const pending = useJarvisStore.getState().pendingConfirm
    expect(pending?.body).toBe('Spawn a terminal')
    useJarvisStore.getState().answerPendingConfirm(true)
    expect(reply).toHaveBeenCalledWith({ approved: true })
  })

  it('a CHOOSER request keeps the modal even with origin:"jarvis"', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    useJarvisStore.setState({ panelOpen: true })
    pushRequest({
      title: 'Visualize',
      body: 'plan',
      origin: 'jarvis',
      choices: { options: [{ id: 'kanban', label: 'Kanban' }], default: 'kanban' }
    } as never)
    expect(screen.getByTestId('confirm-modal')).toBeTruthy()
    expect(useJarvisStore.getState().pendingConfirm).toBeNull()
    fireEvent.click(screen.getByTestId('confirm-deny'))
  })

  it('a CLOSED panel falls back to the modal (no dead gates)', () => {
    stubOnConfirm()
    render(<ConfirmModal />)
    useJarvisStore.setState({ panelOpen: false })
    pushRequest({ title: 'Jarvis: spawn a board', body: 'x', origin: 'jarvis' } as never)
    expect(screen.getByTestId('confirm-modal')).toBeTruthy()
    fireEvent.click(screen.getByTestId('confirm-deny'))
  })
})
