import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import ConfirmModal from './ConfirmModal'
import { packOptionValues, rolePackById } from '../lib/rolePacks'
import type { ConfirmWorkerConfig } from '../../../shared/mcpTypes'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Capture the handler ConfirmModal registers via window.api.mcp.onConfirm so the test can deliver
// a workerConfig confirm request (the S1 swarm spawn gate) and assert the reply it sends back.
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

// Typed with the SHARED contract type (the same declaration MAIN's requestConfirm posts) so
// this fixture cannot drift from the real envelope — the cross-process field-name bridge.
const WORKER_CONFIG: ConfirmWorkerConfig = {
  workerName: 'builder-1',
  roleId: 'builder',
  modelDefault: 'opus',
  defaultLaunch: 'claude --model opus --dangerously-skip-permissions'
}
const REQUEST = {
  title: 'Spawn a swarm worker?',
  body: 'spawn…',
  workerConfig: WORKER_CONFIG
}

describe('ConfirmModal — S1 swarm workerConfig routing', () => {
  it('renders the FULL worker-config dialog (spawn mode) instead of the plain modal', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    act(() => {
      getHandler()!(REQUEST, vi.fn())
    })
    expect(screen.getByTestId('worker-config-dialog')).toBeTruthy()
    expect(screen.queryByTestId('confirm-modal')).toBeNull()
    // Spawn mode: no task-prompt editor (dispatch pays its own gate later); button reads Spawn.
    expect(screen.queryByTestId('worker-prompt')).toBeNull()
    expect(screen.getByTestId('worker-dispatch').textContent).toBe('Spawn')
    // Seeded from the requested pack + the brain's model override.
    const pack = rolePackById('builder')!
    const expected = { ...packOptionValues(pack), model: 'opus' }
    const command = (screen.getByTestId('worker-command') as HTMLInputElement).value
    expect(command).toContain(`--model ${expected.model}`)
  })

  it('commit replies approved + the dialog-committed launchCommand + rolePackId', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!(REQUEST, reply)
    })
    act(() => {
      fireEvent.change(screen.getByTestId('worker-command'), {
        target: { value: 'claude --model haiku' }
      })
    })
    act(() => {
      fireEvent.click(screen.getByTestId('worker-dispatch'))
    })
    expect(reply).toHaveBeenCalledWith({
      approved: true,
      launchCommand: 'claude --model haiku',
      rolePackId: 'builder'
    })
  })

  it('Cancel denies (fail-closed) and advances the queue', () => {
    const getHandler = stubOnConfirm()
    render(<ConfirmModal />)
    const reply = vi.fn()
    act(() => {
      getHandler()!(REQUEST, reply)
    })
    act(() => {
      fireEvent.click(screen.getByTestId('worker-cancel'))
    })
    expect(reply).toHaveBeenCalledWith({ approved: false })
    expect(screen.queryByTestId('worker-config-dialog')).toBeNull()
  })
})
