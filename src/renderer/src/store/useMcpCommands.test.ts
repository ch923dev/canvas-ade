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

  it('configureBoard pushes ONE undo checkpoint and undo reverts the config fields (BUG-020)', () => {
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    // Start the config change from a clean history so we assert on the checkpoint the
    // MCP path itself takes (addBoard's own snapshot is out of scope here).
    useCanvasStore.setState({ past: [], future: [] })

    applyMcpCommand({
      type: 'configureBoard',
      id: 'srv-1',
      patch: { launchCommand: 'claude', cwd: '/repo' }
    })

    // The config change must be checkpointed: exactly one pre-change snapshot on `past`.
    expect(useCanvasStore.getState().past).toHaveLength(1)
    const afterConfig = useCanvasStore.getState().boards.find((b) => b.id === 'srv-1') as {
      launchCommand?: string
      cwd?: string
    }
    expect(afterConfig.launchCommand).toBe('claude')

    // Ctrl+Z must revert the agent's config change.
    useCanvasStore.getState().undo()
    const afterUndo = useCanvasStore.getState().boards.find((b) => b.id === 'srv-1') as {
      launchCommand?: string
      cwd?: string
    }
    expect(afterUndo.launchCommand).toBeUndefined()
    expect(afterUndo.cwd).toBeUndefined()
  })

  it('a no-op configureBoard does NOT destroy an armed redo branch (BUG-020)', () => {
    const store = useCanvasStore.getState()
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    useCanvasStore.setState({ past: [], future: [] })

    // Build a real redo branch: an MCP config edit, then undo it.
    applyMcpCommand({ type: 'configureBoard', id: 'srv-1', patch: { launchCommand: 'orig' } })
    store.undo()
    // Sanity: present is back to no launchCommand, with one entry armed for redo.
    expect(useCanvasStore.getState().future).toHaveLength(1)
    expect(
      (useCanvasStore.getState().boards.find((b) => b.id === 'srv-1') as { launchCommand?: string })
        .launchCommand
    ).toBeUndefined()

    // A reconfigure re-applying the CURRENT value is a no-op: it must NOT clear `future`
    // (the redo branch) nor push a phantom checkpoint.
    applyMcpCommand({
      type: 'configureBoard',
      id: 'srv-1',
      patch: { launchCommand: undefined }
    })
    expect(useCanvasStore.getState().future).toHaveLength(1)
    expect(useCanvasStore.getState().past).toHaveLength(0)

    // The redo branch is intact — redo re-applies the config change.
    store.redo()
    expect(
      (useCanvasStore.getState().boards.find((b) => b.id === 'srv-1') as { launchCommand?: string })
        .launchCommand
    ).toBe('orig')
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
