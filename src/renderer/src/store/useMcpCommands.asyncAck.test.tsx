/**
 * `useMcpCommands` replying to a command whose ack is ASYNC. `tidyBoards` loads the tidy engine
 * as a lazy chunk (entry-chunk budget), so the hook must wait for the Promise before it replies,
 * and a rejected apply must still resolve as `{ ok: false }` — never strand MAIN's ack wait.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useMcpCommands } from './useMcpCommands'
import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'

const { runTidy } = vi.hoisted(() => ({ runTidy: vi.fn() }))
vi.mock('./spatialTidy', () => ({ runTidy }))

type Handler = (c: McpCommand, reply: (a: McpCommandAck) => void) => void
let handler: Handler | null = null

function Harness(): null {
  useMcpCommands()
  return null
}

beforeEach(() => {
  runTidy.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    mcp: {
      onCommand: (cb: Handler) => {
        handler = cb
        return () => {
          handler = null
        }
      }
    }
  }
  render(<Harness />)
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('useMcpCommands — async acks (tidyBoards)', () => {
  it('replies with the tidy ack only once the lazy engine has run', async () => {
    runTidy.mockReturnValue({ ok: true, moved: 2 })
    const reply = vi.fn()
    handler!({ type: 'tidyBoards', mode: 'grid' }, reply)
    expect(reply).not.toHaveBeenCalled()
    await waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    expect(reply).toHaveBeenCalledWith({ ok: true, type: 'tidyBoards', moved: 2 })
    expect(runTidy).toHaveBeenCalledWith({ mode: 'grid' })
  })

  it('a throwing engine still completes the round-trip as { ok: false }', async () => {
    runTidy.mockImplementation(() => {
      throw new Error('engine exploded')
    })
    const reply = vi.fn()
    handler!({ type: 'tidyBoards' }, reply)
    await waitFor(() => expect(reply).toHaveBeenCalledTimes(1))
    expect(reply).toHaveBeenCalledWith({ ok: false, error: 'engine exploded' })
  })

  it('a synchronous command still replies in the same tick', () => {
    const reply = vi.fn()
    handler!({ type: 'ping' }, reply)
    expect(reply).toHaveBeenCalledWith({ ok: true, type: 'ping' })
  })
})
