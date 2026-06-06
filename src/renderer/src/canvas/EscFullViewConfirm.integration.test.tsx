import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { createRef, useRef } from 'react'
import ConfirmModal from './ConfirmModal'
import { useCanvasKeybindings, type CanvasKeybindingDeps } from './hooks/useCanvasKeybindings'

// --- ConfirmModal bridge stub (mirrors ConfirmModal.integration.test.tsx) ----------------
interface ConfirmRequest {
  title: string
  body: string
}
type Reply = (decision: { approved: boolean }) => void
type ConfirmCb = (request: ConfirmRequest, reply: Reply) => void

let captured: ConfirmCb | null = null
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
function pushRequest(req: ConfirmRequest): ReturnType<typeof vi.fn> {
  const reply = vi.fn()
  act(() => {
    captured?.(req, reply)
  })
  return reply
}

// --- A minimal harness that wires the keybinding hook exactly as Canvas does -------------
// We only exercise the full-view-Esc capture listener; the other deps are no-op spies.
function makeDeps(over: Partial<CanvasKeybindingDeps>): CanvasKeybindingDeps {
  return {
    rf: { fitView: vi.fn() } as unknown as CanvasKeybindingDeps['rf'],
    clearSelection: vi.fn(),
    doUndo: vi.fn(),
    doRedo: vi.fn(),
    tidyAndFit: vi.fn(),
    setDiag: vi.fn(),
    selectedConnectorId: null,
    removeConnector: vi.fn(),
    setSelectedConnectorId: vi.fn(),
    fullViewId: null,
    cameraFullViewId: null,
    closeFullView: vi.fn(),
    exitCameraFullView: vi.fn(),
    snapSuppressRef: createRef<boolean>() as CanvasKeybindingDeps['snapSuppressRef'],
    ...over
  }
}

function Keybindings({ deps }: { deps: CanvasKeybindingDeps }): null {
  const snapSuppressRef = useRef(false)
  useCanvasKeybindings({ ...deps, snapSuppressRef })
  return null
}

afterEach(() => {
  cleanup()
  captured = null
  delete (window as unknown as { api?: unknown }).api
})

/**
 * BUG-005: the keybindings' Esc-full-view listener runs in the CAPTURE phase and
 * stopPropagation()s, so Esc during full-view never reaches ConfirmModal's bubble-phase
 * listener → a pending dangerous MCP confirm is NOT denied (fail-open). We dispatch a real
 * bubbling KeyboardEvent from a child node (document.body) so capture-then-bubble ordering
 * is exercised honestly — fireEvent(window) would run every listener at-target and mask it.
 */
describe('Esc during full-view + active ConfirmModal (BUG-005)', () => {
  it('denies the pending confirm and does NOT steal Esc to close full-view (fail-closed)', () => {
    stubOnConfirm()
    const closeFullView = vi.fn()
    const deps = makeDeps({ fullViewId: 'board-1', closeFullView })

    render(
      <>
        <Keybindings deps={deps} />
        <ConfirmModal />
      </>
    )

    // A dangerous MCP action is awaiting human confirmation while a board is full-view.
    const reply = pushRequest({ title: 'Dispatch', body: 'run rm -rf in board-1?' })

    // Real bubbling Escape from a child node (NOT fireEvent at window).
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    // The pending confirm MUST be DENIED (fail-closed). Pre-fix this fails: the capture-phase
    // stopPropagation() kept Esc from reaching ConfirmModal's bubble listener.
    expect(reply).toHaveBeenCalledWith({ approved: false })
    // The confirm wins this Esc; full-view stays open (a second Esc — no modal — exits it).
    expect(closeFullView).not.toHaveBeenCalled()

    // Second Esc, now with no modal up, exits full-view as before.
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(closeFullView).toHaveBeenCalledTimes(1)
  })

  it('without a modal up, Esc still exits full-view as before', () => {
    stubOnConfirm()
    const closeFullView = vi.fn()
    const deps = makeDeps({ fullViewId: 'board-1', closeFullView })

    render(
      <>
        <Keybindings deps={deps} />
        <ConfirmModal />
      </>
    )

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    expect(closeFullView).toHaveBeenCalledTimes(1)
  })

  it('camera full-view: Esc denies the confirm first, then a second Esc exits', () => {
    stubOnConfirm()
    const exitCameraFullView = vi.fn()
    const deps = makeDeps({ cameraFullViewId: 'board-2', exitCameraFullView })

    render(
      <>
        <Keybindings deps={deps} />
        <ConfirmModal />
      </>
    )

    const reply = pushRequest({ title: 'Merge', body: 'merge worktree?' })

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    // Confirm denied first; camera full-view stays open until a second (modal-free) Esc.
    expect(reply).toHaveBeenCalledWith({ approved: false })
    expect(exitCameraFullView).not.toHaveBeenCalled()

    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(exitCameraFullView).toHaveBeenCalledTimes(1)
  })
})
