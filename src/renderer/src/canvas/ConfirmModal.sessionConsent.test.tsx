import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import ConfirmModal from './ConfirmModal'
import type { ConfirmSessionConsent } from '../../../shared/mcpTypes'

/* eslint-disable @typescript-eslint/no-explicit-any */

// The same onConfirm capture as the workerConfig suite — deliver a request carrying the base-P5
// session-consent OFFER and assert the opt-in block's behaviour + the reply shape.
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

afterEach(() => {
  cleanup()
  delete (window as any).api
})

// Typed with the SHARED contract type so this fixture cannot drift from MAIN's envelope.
const OFFER: ConfirmSessionConsent = {
  roleId: 'code-reviewer',
  roleName: 'Code reviewer',
  workerCount: 2
}
const REQUEST = {
  title: 'Dispatch to terminal',
  body: 'send "review the diff" to Reviewer A',
  sessionConsent: OFFER
}

describe('ConfirmModal — base P5 session-consent opt-in', () => {
  it('renders the opt-in block DEFAULT OFF; a plain Approve replies without the grant', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!(REQUEST, reply)
    })
    const toggle = screen.getByTestId('confirm-session-consent-toggle')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('confirm-approve').textContent).toBe('Approve')
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-approve'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: true }) // no sessionConsent field at all
  })

  it('checkbox ON flips the primary label and the approve carries sessionConsent: true', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!(REQUEST, reply)
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-session-consent-toggle'))
    })
    expect(screen.getByTestId('confirm-session-consent-toggle').getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(screen.getByTestId('confirm-approve').textContent).toBe('Approve + pre-authorize')
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-approve'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: true, sessionConsent: true })
  })

  it('a DENY never carries the grant, even with the checkbox on (fail-safe)', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!(REQUEST, reply)
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-session-consent-toggle'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-deny'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: false })
  })

  it('the checkbox state never leaks onto the NEXT queued request', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply1 = vi.fn()
    const reply2 = vi.fn()
    act(() => {
      getHandler()!(REQUEST, reply1)
      getHandler()!(REQUEST, reply2)
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-session-consent-toggle'))
    })
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-approve'))
    })
    expect(reply1).toHaveBeenCalledWith({ approved: true, sessionConsent: true })
    // The second request's box starts OFF again.
    expect(screen.getByTestId('confirm-session-consent-toggle').getAttribute('aria-checked')).toBe(
      'false'
    )
    act(() => {
      fireEvent.click(screen.getByTestId('confirm-approve'))
    })
    expect(reply2).toHaveBeenCalledWith({ approved: true })
  })

  it('a request WITHOUT the offer renders no consent block (the ordinary modal)', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    act(() => {
      getHandler()!({ title: 'Dispatch', body: 'plain' }, vi.fn())
    })
    expect(screen.queryByTestId('confirm-session-consent')).toBeNull()
  })
})
