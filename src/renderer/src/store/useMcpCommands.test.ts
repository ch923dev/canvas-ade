import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { applyMcpCommand } from './useMcpCommands'

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: [],
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

  it('rejects a configureBoard with a null/non-object patch instead of throwing (ack {ok:false})', () => {
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal' } })
    const ack = applyMcpCommand({
      type: 'configureBoard',
      id: 'srv-1',
      // @ts-expect-error — malformed patch (null); must be rejected, never throw past the ack
      patch: null
    })
    expect(ack.ok).toBe(false)
    // the board is untouched (no partial apply)
    expect(useCanvasStore.getState().boards.find((b) => b.id === 'srv-1')).toBeDefined()
  })

  it('rejects a removeBoard with a non-string id (ack {ok:false})', () => {
    const ack = applyMcpCommand({
      type: 'removeBoard',
      // @ts-expect-error — malformed id; must be rejected
      id: 123
    })
    expect(ack.ok).toBe(false)
  })

  it('acks an unknown command type as a failure', () => {
    // @ts-expect-error — unknown command shape
    const ack = applyMcpCommand({ type: 'frobnicate' })
    expect(ack.ok).toBe(false)
  })

  describe('patchPlanning (S2 — agent content write)', () => {
    const planning = (id = 'plan-1'): void => {
      applyMcpCommand({ type: 'addBoard', board: { id, type: 'planning' } })
      useCanvasStore.setState({ past: [], future: [] }) // clean history for the assertions
    }
    const find = (id: string): { elements?: unknown[]; h?: number } | undefined =>
      useCanvasStore.getState().boards.find((b) => b.id === id) as never

    it('appends a checklist + notes to a planning board and acks ok', () => {
      planning()
      const ack = applyMcpCommand({
        type: 'patchPlanning',
        id: 'plan-1',
        ops: [
          { kind: 'note', text: 'audit middleware', tint: 'yellow' },
          {
            kind: 'checklist',
            title: 'Auth refactor',
            items: [
              { label: 'Audit current session mw', done: true },
              { label: 'Wire confirm gate', done: false }
            ]
          }
        ]
      })
      expect(ack).toEqual({ ok: true, type: 'patchPlanning' })
      const els = find('plan-1')?.elements as Array<{ kind: string; text?: string; title?: string }>
      expect(els).toHaveLength(2)
      expect(els[0]).toMatchObject({ kind: 'note', text: 'audit middleware', tint: 'yellow' })
      expect(els[1]).toMatchObject({ kind: 'checklist', title: 'Auth refactor' })
    })

    it('is ONE undo step that reverts the whole agent write', () => {
      planning()
      applyMcpCommand({
        type: 'patchPlanning',
        id: 'plan-1',
        ops: [{ kind: 'note', text: 'a', tint: 'blue' }]
      })
      expect(useCanvasStore.getState().past).toHaveLength(1)
      expect((find('plan-1')?.elements as unknown[]).length).toBe(1)
      useCanvasStore.getState().undo()
      expect((find('plan-1')?.elements as unknown[]).length).toBe(0)
    })

    it('chains AFTER an existing element instead of replacing it', () => {
      planning()
      applyMcpCommand({
        type: 'patchPlanning',
        id: 'plan-1',
        ops: [{ kind: 'note', text: 'first', tint: 'green' }]
      })
      applyMcpCommand({
        type: 'patchPlanning',
        id: 'plan-1',
        ops: [{ kind: 'note', text: 'second', tint: 'plain' }]
      })
      const els = find('plan-1')?.elements as Array<{ text?: string; y: number }>
      expect(els.map((e) => e.text)).toEqual(['first', 'second'])
      // The second note stacks strictly below the first (no overlap).
      expect(els[1].y).toBeGreaterThan(els[0].y)
    })

    it('auto-grows the board height to fit tall content (untracked — no extra undo step)', () => {
      planning()
      const before = find('plan-1')?.h ?? 0
      const ops = Array.from({ length: 8 }, (_, i) => ({
        kind: 'note' as const,
        text: `n${i}`,
        tint: 'yellow' as const
      }))
      applyMcpCommand({ type: 'patchPlanning', id: 'plan-1', ops })
      expect(find('plan-1')?.h ?? 0).toBeGreaterThan(before)
      // grow is untracked → still exactly ONE undo step for the content append.
      expect(useCanvasStore.getState().past).toHaveLength(1)
    })

    it('rejects a non-planning target without mutating it', () => {
      applyMcpCommand({ type: 'addBoard', board: { id: 'term-1', type: 'terminal' } })
      const ack = applyMcpCommand({
        type: 'patchPlanning',
        id: 'term-1',
        ops: [{ kind: 'note', text: 'x', tint: 'yellow' }]
      })
      expect(ack.ok).toBe(false)
    })

    it('rejects an unknown board id', () => {
      const ack = applyMcpCommand({
        type: 'patchPlanning',
        id: 'ghost',
        ops: [{ kind: 'note', text: 'x', tint: 'yellow' }]
      })
      expect(ack.ok).toBe(false)
    })

    it('rejects an empty ops array', () => {
      planning()
      const ack = applyMcpCommand({ type: 'patchPlanning', id: 'plan-1', ops: [] })
      expect(ack.ok).toBe(false)
      expect((find('plan-1')?.elements as unknown[]).length).toBe(0)
    })

    it('rejects a write that would exceed the cumulative board element cap', () => {
      planning()
      // Pre-fill near the cap by direct state set (bypassing the per-call batch limit).
      const filler = Array.from({ length: 299 }, (_, i) => ({
        id: `e${i}`,
        kind: 'note' as const,
        x: 0,
        y: 0,
        w: 156,
        h: 96,
        tint: 'yellow' as const,
        text: 't'
      }))
      useCanvasStore.setState({
        boards: useCanvasStore
          .getState()
          .boards.map((b) => (b.id === 'plan-1' ? ({ ...b, elements: filler } as typeof b) : b))
      })
      const ack = applyMcpCommand({
        type: 'patchPlanning',
        id: 'plan-1',
        ops: [
          { kind: 'note', text: 'a', tint: 'yellow' },
          { kind: 'note', text: 'b', tint: 'yellow' }
        ]
      })
      expect(ack.ok).toBe(false)
      expect((find('plan-1')?.elements as unknown[]).length).toBe(299) // unchanged
    })
  })

  describe('spawnGroup (PR-5b — feature-zone cluster)', () => {
    const full = (over?: Partial<{ name: string }>) => ({
      type: 'spawnGroup' as const,
      group: { id: 'grp-1', name: over?.name ?? 'Auth zone' },
      members: { terminal: { id: 't-1' }, planning: { id: 'p-1' }, browser: { id: 'b-1' } }
    })

    it('creates the boards + the Named Group + the browser→terminal preview wiring, acks ok', () => {
      const ack = applyMcpCommand(full())
      expect(ack).toEqual({ ok: true, type: 'spawnGroup' })
      const st = useCanvasStore.getState()
      expect(st.boards.map((b) => b.id).sort()).toEqual(['b-1', 'p-1', 't-1'])
      expect(st.groups).toEqual([
        { id: 'grp-1', name: 'Auth zone', boardIds: ['t-1', 'p-1', 'b-1'] }
      ])
      const browser = st.boards.find((b) => b.id === 'b-1') as { previewSourceId?: string }
      expect(browser.previewSourceId).toBe('t-1') // wired to the terminal
    })

    it('lays the cluster out as a non-overlapping row (terminal | planning | browser)', () => {
      applyMcpCommand(full())
      const st = useCanvasStore.getState()
      const t = st.boards.find((b) => b.id === 't-1')!
      const p = st.boards.find((b) => b.id === 'p-1')!
      const b = st.boards.find((b) => b.id === 'b-1')!
      // strictly increasing x, each starting at/after the previous board's right edge.
      expect(p.x).toBeGreaterThanOrEqual(t.x + t.w)
      expect(b.x).toBeGreaterThanOrEqual(p.x + p.w)
    })

    it('spawns a terminal-only zone when planning/browser are omitted', () => {
      const ack = applyMcpCommand({
        type: 'spawnGroup',
        group: { id: 'grp-2', name: 'Solo' },
        members: { terminal: { id: 't-9' } }
      })
      expect(ack.ok).toBe(true)
      const st = useCanvasStore.getState()
      expect(st.boards.map((b) => b.id)).toEqual(['t-9'])
      expect(st.groups[0].boardIds).toEqual(['t-9'])
    })

    it('is ONE undo step that removes the whole zone (boards + group)', () => {
      applyMcpCommand(full())
      expect(useCanvasStore.getState().past).toHaveLength(1)
      useCanvasStore.getState().undo()
      const st = useCanvasStore.getState()
      expect(st.boards).toHaveLength(0)
      expect(st.groups).toHaveLength(0)
    })

    it('is idempotent by group id — a re-delivered spawnGroup yields one zone and acks ok both times', () => {
      const first = applyMcpCommand(full())
      const second = applyMcpCommand(full())
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(useCanvasStore.getState().groups).toHaveLength(1)
      expect(useCanvasStore.getState().boards).toHaveLength(3)
    })

    it('rejects a malformed envelope (missing terminal / empty name) without mutating the canvas', () => {
      const noName = applyMcpCommand({
        type: 'spawnGroup',
        group: { id: 'g', name: '' },
        members: { terminal: { id: 't' } }
      })
      expect(noName.ok).toBe(false)
      const noTerminal = applyMcpCommand({
        type: 'spawnGroup',
        group: { id: 'g', name: 'X' },
        // @ts-expect-error — terminal member is required; a missing one must be rejected
        members: { planning: { id: 'p' } }
      })
      expect(noTerminal.ok).toBe(false)
      expect(useCanvasStore.getState().boards).toHaveLength(0)
      expect(useCanvasStore.getState().groups).toHaveLength(0)
    })

    it('rejects a malformed optional member rather than silently dropping it', () => {
      const ack = applyMcpCommand({
        type: 'spawnGroup',
        group: { id: 'g', name: 'X' },
        // @ts-expect-error — browser member present but malformed (no id)
        members: { terminal: { id: 't' }, browser: {} }
      })
      expect(ack.ok).toBe(false)
      expect(useCanvasStore.getState().boards).toHaveLength(0)
    })
  })
})
