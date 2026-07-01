import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import ConfirmModal from './ConfirmModal'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Capture the handler ConfirmModal registers via window.api.mcp.onConfirm so the test can deliver a
// confirm request (the P5 chooser) and assert the reply the modal sends back.
function stubOnConfirm(): () => ((req: any, reply: any) => void) | null {
  let handler: ((req: any, reply: any) => void) | null = null
  ;(window as any).api = {
    mcp: {
      onConfirm: (h: (req: any, reply: any) => void) => {
        handler = h
        return () => {}
      }
    }
  }
  return () => handler
}

const CHOICES = {
  label: 'Visualization',
  options: [
    { id: 'kanban', label: 'Kanban' },
    { id: 'grid', label: 'Grid' },
    { id: 'checklist', label: 'Checklist' },
    { id: 'columns', label: 'Columns' }
  ],
  default: 'kanban'
}

afterEach(() => {
  cleanup()
  delete (window as any).api
})

describe('ConfirmModal — P5 layout chooser', () => {
  it('renders the options, preselects the default, and returns the PICKED choice on approve', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!(
        {
          title: 'Visualize a 2-item plan',
          body: 'plan…',
          confirmLabel: 'Create on canvas',
          choices: CHOICES
        },
        reply
      )
    })
    // The default is preselected; the others are not.
    expect(screen.getByTestId('confirm-choice-kanban').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('confirm-choice-grid').getAttribute('aria-checked')).toBe('false')
    // Pick a different shape, then approve → the reply carries the human's pick.
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-choice-columns'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-approve'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: true, choice: 'columns' })
  })

  it('approving without changing keeps the default choice', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!({ title: 't', body: 'b', choices: CHOICES }, reply)
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-approve'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: true, choice: 'kanban' })
  })

  it('denying a chooser request returns approved:false', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!({ title: 't', body: 'b', choices: CHOICES }, reply)
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-deny'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: false })
  })

  it('a request WITHOUT choices replies a bare {approved} (back-compat, no chooser rendered)', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!({ title: 't', body: 'b' }, reply)
    })
    expect(screen.queryByTestId('confirm-choice-kanban')).toBeNull()
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-approve'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: true })
  })
})
