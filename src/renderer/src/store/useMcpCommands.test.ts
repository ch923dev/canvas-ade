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
      // 'malware' is a structurally-valid string in the canonical union (board.type is a loose
      // `string`); the renderer's SPAWNABLE guard rejects it at runtime (defense in depth).
      board: { id: 'x', type: 'malware' }
    })
    expect(ack.ok).toBe(false)
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })

  it('addBoard applies an agent-supplied title (2b)', () => {
    applyMcpCommand({
      type: 'addBoard',
      board: { id: 'srv-1', type: 'planning', title: 'Auth refactor plan' }
    })
    expect(useCanvasStore.getState().boards[0]).toMatchObject({
      id: 'srv-1',
      title: 'Auth refactor plan'
    })
  })

  it('addBoard falls back to the per-type default title for an empty/whitespace title (2b)', () => {
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal', title: '   ' } })
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-2', type: 'terminal' } })
    const [a, b] = useCanvasStore.getState().boards
    // A whitespace-only title is ignored ⇒ the board keeps the same default as a no-title spawn.
    expect(a.title).toBe(b.title)
  })

  it('addBoard clamps an over-long agent title (2b defense in depth)', () => {
    applyMcpCommand({
      type: 'addBoard',
      board: { id: 'srv-1', type: 'terminal', title: 'x'.repeat(200) }
    })
    expect(useCanvasStore.getState().boards[0].title).toBe('x'.repeat(80))
  })

  it('addBoard re-clamps an agent title by code point (emoji at the boundary stays whole)', () => {
    // 79 ASCII + emoji + tail = 91 code points / 92 UTF-16 units; the defense-in-depth re-clamp must
    // cut at 80 CODE POINTS (keeping the emoji whole), not 80 code units (which would split it).
    const title = 'a'.repeat(79) + '😀' + 'b'.repeat(10)
    applyMcpCommand({ type: 'addBoard', board: { id: 'srv-1', type: 'terminal', title } })
    const t = useCanvasStore.getState().boards[0].title
    expect(t).toBe('a'.repeat(79) + '😀')
    expect([...t]).toHaveLength(80)
  })

  it('addBoard ignores a non-string forged title (2b defense in depth)', () => {
    applyMcpCommand({
      type: 'addBoard',
      // title is `string | undefined` in the union; a number can only arrive as hand-rolled IPC
      // JSON — the renderer guard must keep it from reaching createBoard as a non-string title.
      board: { id: 'srv-1', type: 'terminal', title: 123 as unknown as string }
    })
    const t = useCanvasStore.getState().boards[0].title
    expect(typeof t).toBe('string')
    expect(t.length).toBeGreaterThan(0)
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
      // Tall content: 8 multi-line notes — the masonry estimates each note's wrapped height, so
      // several rows of long notes exceed the default board height and force a grow.
      const body = Array.from({ length: 12 }, (_, j) => `line ${j} of a fairly long note`).join(
        '\n'
      )
      const ops = Array.from({ length: 8 }, () => ({
        kind: 'note' as const,
        text: body,
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

  describe('patchPlanning — canvas-aware nudge (a grown plan never sits under a neighbour)', () => {
    type Rect = { x: number; y: number; w: number; h: number; elements?: unknown[] }
    // Seed a planning board + a neighbour at EXACT positions (bypassing addBoard's freeSlot) so a
    // width-growing write deterministically collides. plan-1 (0,0,400,300); term-1 to its right.
    const seed = (opts?: { group?: boolean; termX?: number }): void => {
      applyMcpCommand({ type: 'addBoard', board: { id: 'plan-1', type: 'planning' } })
      applyMcpCommand({ type: 'addBoard', board: { id: 'term-1', type: 'terminal' } })
      const termX = opts?.termX ?? 450
      useCanvasStore.setState((s) => ({
        boards: s.boards.map((b) => {
          if (b.id === 'plan-1') return { ...b, x: 0, y: 0, w: 400, h: 300 }
          if (b.id === 'term-1') return { ...b, x: termX, y: 0, w: 400, h: 300 }
          return b
        }),
        groups: opts?.group ? [{ id: 'g1', name: 'Zone', boardIds: ['plan-1'] }] : [],
        past: [],
        future: []
      }))
    }
    const rect = (id: string): Rect =>
      useCanvasStore.getState().boards.find((b) => b.id === id) as never
    const overlaps = (a: Rect, b: Rect): boolean =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    // A 4-section write — one column per section — forces the board far wider than its 400px seed.
    const wideWrite = (id = 'plan-1'): void => {
      applyMcpCommand({
        type: 'patchPlanning',
        id,
        ops: ['Overview', 'Build', 'Test', 'Ship'].map((section) => ({
          kind: 'note' as const,
          text: section.toLowerCase(),
          tint: 'yellow' as const,
          section
        }))
      })
    }

    it('moves the grown board to a free slot off the neighbour; the neighbour stays put', () => {
      seed()
      wideWrite()
      const plan = rect('plan-1')
      const term = rect('term-1')
      expect(plan.w).toBeGreaterThan(450) // grew wide enough to have collided in place…
      expect(overlaps(plan, term)).toBe(false) // …so it was nudged clear
      expect(plan.x === 0 && plan.y === 0).toBe(false) // the plan board moved off (0,0)
      expect({ x: term.x, y: term.y, w: term.w, h: term.h }).toEqual({
        x: 450,
        y: 0,
        w: 400,
        h: 300
      }) // the neighbour never moves
    })

    it('the nudge is part of the SAME one undo step — undo restores position + size + content', () => {
      seed()
      wideWrite()
      expect(useCanvasStore.getState().past).toHaveLength(1) // one step for the whole write
      useCanvasStore.getState().undo()
      const plan = rect('plan-1')
      expect({ x: plan.x, y: plan.y, w: plan.w }).toEqual({ x: 0, y: 0, w: 400 }) // fully reverted
      expect((plan.elements as unknown[]).length).toBe(0)
    })

    it('does NOT move a GROUPED board (a feature zone owns its own arrangement)', () => {
      seed({ group: true })
      wideWrite()
      const plan = rect('plan-1')
      expect(plan.w).toBeGreaterThan(450) // it grew (would have collided)…
      expect(plan.x).toBe(0) // …but stayed put because it belongs to a group
    })

    it('does NOT move when the board grows into EMPTY space (no collision)', () => {
      seed({ termX: 4000 }) // neighbour far away → the grown board never reaches it
      wideWrite()
      const plan = rect('plan-1')
      expect(plan.w).toBeGreaterThan(400) // it grew…
      expect(plan.x).toBe(0) // …but had no reason to move
    })

    it('does NOT move when nothing grew (a small write into a board the user placed overlapping)', () => {
      seed({ termX: 200 }) // overlapping from the start (the user's deliberate placement)
      applyMcpCommand({
        type: 'patchPlanning',
        id: 'plan-1',
        ops: [{ kind: 'note', text: 'hi', tint: 'yellow' }]
      })
      const plan = rect('plan-1')
      expect(plan.w).toBe(400) // a single short note doesn't grow the board…
      expect(plan.x).toBe(0) // …so we never move a board the user placed overlapping on purpose
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
