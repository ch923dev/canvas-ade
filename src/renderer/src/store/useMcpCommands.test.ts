import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { applyMcpCommand } from './useMcpCommands'

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    selectedId: null,
    tool: 'select',
    past: [],
    future: []
  })
})

describe('applyMcpCommand (renderer applier for MAIN → renderer MCP commands)', () => {
  it('acks ping', () => {
    expect(applyMcpCommand({ type: 'ping' })).toEqual({ ok: true, type: 'ping' })
  })

  it('addBoard adds a board to the canvas with the orchestrator-issued id', () => {
    const ack = applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    expect(ack).toEqual({ ok: true, type: 'addBoard' })
    const boards = useCanvasStore.getState().boards
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({ id: 'srv-1', type: 'terminal' })
  })

  it('addBoard is idempotent by id — a double add yields one board and acks ok both times', () => {
    const first = applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    const second = applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    expect(first).toEqual({ ok: true, type: 'addBoard' })
    expect(second).toEqual({ ok: true, type: 'addBoard' })
    expect(useCanvasStore.getState().boards).toHaveLength(1)
  })

  it('rejects an unknown board type WITHOUT adding a board (defense in depth)', () => {
    const ack = applyMcpCommand({
      type: 'addBoard',
      // @ts-expect-error — deliberately invalid type, must be rejected
      board: { id: 'x', type: 'malware' }
    })
    expect(ack.ok).toBe(false)
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })

  it('removeBoard removes the board from the canvas (T3.2)', () => {
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    expect(useCanvasStore.getState().boards).toHaveLength(1)
    const ack = applyMcpCommand({ type: 'removeBoard', id: 'srv-1' })
    expect(ack).toEqual({ ok: true, type: 'removeBoard' })
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })

  it('removeBoard on an unknown id acks ok (idempotent close)', () => {
    const ack = applyMcpCommand({ type: 'removeBoard', id: 'ghost' })
    expect(ack.ok).toBe(true)
  })

  it('configureBoard applies durable per-type keys to the board (T3.3)', () => {
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    const ack = applyMcpCommand({
      type: 'configureBoard',
      id: 'srv-1',
      patch: { launchCommand: 'claude', cwd: '/repo' }
    })
    expect(ack).toEqual({ ok: true, type: 'configureBoard' })
    const board = useCanvasStore.getState().boards.find((b) => b.id === 'srv-1') as {
      launchCommand?: string
      cwd?: string
    }
    expect(board.launchCommand).toBe('claude')
    expect(board.cwd).toBe('/repo')
  })

  it('configureBoard drops a non-patchable / ephemeral key (defense in depth)', () => {
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    const ack = applyMcpCommand({
      type: 'configureBoard',
      id: 'srv-1',
      // @ts-expect-error — id is identity, never patchable; must be ignored, not forge a new id
      patch: { id: 'hacked', launchCommand: 'ok' }
    })
    expect(ack.ok).toBe(true)
    expect(useCanvasStore.getState().boards.find((b) => b.id === 'hacked')).toBeUndefined()
    expect(useCanvasStore.getState().boards.find((b) => b.id === 'srv-1')).toBeDefined()
  })

  it('acks an unknown command type as a failure', () => {
    // @ts-expect-error — unknown command shape
    const ack = applyMcpCommand({ type: 'frobnicate' })
    expect(ack.ok).toBe(false)
  })
})
