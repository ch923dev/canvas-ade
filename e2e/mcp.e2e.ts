import { test as base, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @mcp MCP swarm-layer tier enforcement + dispatch, against the REAL running app
 * (dx-audit MT-2 / PR-5 — the port of the retired `CANVAS_SMOKE=mcp` harness).
 *
 * The retired `mcpSmoke.ts` ran the MCP client INSIDE main and logged `MCP_*_OK`
 * markers. This port moves the client into the Playwright TEST process (Node):
 * two real clients — an orchestrator-tier and a worker-tier token — connect over
 * 127.0.0.1 to the SAME MCP server `app.whenReady` mounts. Port + tier tokens come
 * from the env-gated `__canvasE2EMain.mcpInfo()` seam; the renderer is driven through
 * `window.__canvasE2E` (page.evaluate), and the handful of MAIN-side seams the smoke
 * used (`debugSeedOutput`, `recordBoardResult`, `sendMcpCommand`, `listConnectors`,
 * the memory-dir override) are thin `__canvasE2EMain` methods. This is the e2e-only
 * class: a live loopback server + the real renderer mirror + real native preview
 * (browser→failed) + real PTY writes (handoff/assign/relay land in xterm). None of it
 * reproduces in jsdom.
 *
 * `@expanse-ade/mcp@0.9.1` is pinned, so EVERY tier/resource asserted below is
 * registered — a missing one is a real regression (asserted, never skipped). Two
 * blocks the standard smoke run itself skipped/duplicated are intentionally NOT ported
 * — they are proven at the unit tier, where they belong (PR-4 keep-set discipline):
 *   - the close_board human-gate branch matrix (denied/failed/unknown-id — unit-covered in
 *     `mcpOrchestrator.test.ts`; the idle reaper itself was REMOVED 2026-07-02),
 *   - the single-use-nonce replay invariant (a pure in-process unit, covered verbatim
 *     in `dispatchGuard.test.ts`).
 * See docs/testing/TESTING.md › MCP keep-set.
 */

type McpInfo = {
  port: number
  orchestratorToken: string
  workerToken: string
  workerBoardId: string
}

/** A returned tool RESULT, or a thrown transport/protocol error. A tier denial comes
 *  back as an isError RESULT (the call resolves); a broken session REJECTS — keep them
 *  distinct so a thrown 'Session not found' reads as a FAILURE, never as a denial. */
type CallOutcome = { ok: true; result: unknown } | { ok: false; threw: string; code?: number }

interface McpClient {
  tools: string[]
  call(name: string, args?: Record<string, unknown>): Promise<CallOutcome>
  /** Read a resource and JSON-parse its concatenated text content blocks. */
  readJson<T>(uri: string): Promise<T>
  /** Names from prompts/list. A worker gets a well-formed empty array (NOT a throw). */
  listPromptNames(): Promise<string[]>
  /** Render a prompt via prompts/get; each message's role + text (non-text content → ''). */
  getPrompt(
    name: string,
    args?: Record<string, string>
  ): Promise<{ messages: Array<{ role: string; text: string }> }>
  close(): Promise<void>
}

async function connect(url: string, token: string): Promise<McpClient> {
  // Dynamic import mirrors the retired harness — sidesteps any ESM/CJS top-level interop
  // between Playwright's loader and the SDK's CJS dist (the proven-working form).
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'mcp-e2e', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  const tools = (await client.listTools()).tools.map((t) => t.name)
  return {
    tools,
    async call(name, args) {
      try {
        return { ok: true, result: await client.callTool({ name, arguments: args }) }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    async readJson<T>(uri: string): Promise<T> {
      const res = await client.readResource({ uri })
      const text = res.contents
        .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
        .join('')
      return JSON.parse(text) as T
    },
    async listPromptNames(): Promise<string[]> {
      return (await client.listPrompts()).prompts.map((p) => p.name)
    },
    async getPrompt(name, args) {
      const res = await client.getPrompt({ name, arguments: args ?? {} })
      return {
        messages: res.messages.map((m) => ({
          role: m.role,
          text: m.content.type === 'text' ? m.content.text : ''
        }))
      }
    },
    close: () => client.close()
  }
}

/** Concatenated text of a tool result's content blocks. */
function resultText(r: unknown): string {
  const content = (r as { content?: Array<{ text?: string }> })?.content
  return Array.isArray(content) ? content.map((c) => c?.text ?? '').join(' ') : ''
}
function isErrorResult(r: unknown): boolean {
  return (r as { isError?: boolean })?.isError === true
}
/** The trimmed text of a SUCCESS (non-error) tool call, else '' (denials/throws → ''). */
function okText(o: CallOutcome): string {
  return o.ok && !isErrorResult(o.result) ? resultText(o.result).trim() : ''
}
/** True iff the call resolved as the SPECIFIC tool-not-found denial — the SERVER-SIDE
 *  tier split (registration, not prompt). A generic transport miss must NOT pass here. */
function deniedToolNotFound(o: CallOutcome, tool: string): boolean {
  return o.ok && isErrorResult(o.result) && resultText(o.result).includes(`Tool ${tool} not found`)
}
/** True iff the call resolved as ANY isError result (a rejected-but-handled dispatch). */
function rejected(o: CallOutcome): boolean {
  return o.ok && isErrorResult(o.result)
}
/** True iff the call returned a non-error result (an accepted/acked dispatch). */
function acked(o: CallOutcome): boolean {
  return o.ok && !isErrorResult(o.result)
}

/** The status bucket of board `id` from the orchestrator's canvas://boards (null if absent). */
async function boardStatus(c: McpClient, id: string): Promise<string | null> {
  const boards = await c.readJson<Array<{ id?: unknown; status?: unknown }>>('canvas://boards')
  const b = Array.isArray(boards) ? boards.find((x) => x?.id === id) : undefined
  return typeof b?.status === 'string' ? b.status : null
}

/** Read a board's xterm framebuffer text through the renderer hook (assert a write landed). */
function readTerminalText(page: Page, id: string): Promise<string | null> {
  return evalIn<string | null>(page, `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`)
}

/** Whether a board `id` is on the canvas. Structured-arg eval -- the id is passed as DATA, never
 *  interpolated into the eval'd code string (CodeQL js/bad-code-sanitization; the #82 pattern). */
function boardOnCanvas(page: Page, id: string): Promise<boolean> {
  return page.evaluate((boardId) => {
    const hook = (globalThis as unknown as { __canvasE2E: { getBoards(): Array<{ id: string }> } })
      .__canvasE2E
    return !!hook.getBoards().find((b) => b.id === boardId)
  }, id)
}
/** A board's launchCommand (undefined if unset/absent). Structured-arg eval (the #82 pattern). */
function boardLaunchCommand(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((boardId) => {
    const hook = (
      globalThis as unknown as {
        __canvasE2E: { getBoards(): Array<{ id: string; launchCommand?: string }> }
      }
    ).__canvasE2E
    return hook.getBoards().find((b) => b.id === boardId)?.launchCommand
  }, id)
}
/** A board's title via the renderer hook (2b spawn_board title). Structured-arg eval (#82 pattern). */
function boardTitle(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((boardId) => {
    const hook = (
      globalThis as unknown as {
        __canvasE2E: { getBoards(): Array<{ id: string; title?: string }> }
      }
    ).__canvasE2E
    return hook.getBoards().find((b) => b.id === boardId)?.title
  }, id)
}

/** Drive the trusted confirm modal like a human (the dispatch tools block on this gate). */
const MODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
const APPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`
const DENY = `(() => { const b = document.querySelector('[data-testid="confirm-deny"]'); if (b) b.click(); return !!b })()`

type McpPair = { info: McpInfo; orch: McpClient; worker: McpClient }

/**
 * close_board pays the human gate (2026-07-02 — the reaper's replacement): fire the call,
 * approve the confirm modal like a user, await the ack. EVERY close in this spec must go
 * through this — a bare `call('close_board')` hangs on the modal until the 60s SDK timeout
 * and leaves a STALE OPEN MODAL that poisons the next modal-driven test.
 */
async function closeBoardGated(page: Page, mcp: McpPair, id: string): Promise<void> {
  const p = mcp.orch.call('close_board', { id })
  expect(await pollEval(page, MODAL, 8000)).toBe(true)
  await evalIn(page, APPROVE)
  await p
}

// Per-test fixture: connect one orchestrator + one worker client over loopback and
// auto-dispose. A missing server is a FAILURE (the smoke returned exit 1 for it), not a
// skip. The base `page` fixture still runs reset() first, so each test gets a clean canvas.
const test = base.extend<{ mcp: McpPair }>({
  mcp: async ({ electronApp }, use) => {
    const info = await mainCall<McpInfo | null>(electronApp, 'mcpInfo')
    if (!info) throw new Error('MCP server not mounted (mcpInfo returned null)')
    const url = `http://127.0.0.1:${info.port}/mcp`
    const orch = await connect(url, info.orchestratorToken)
    // Close orch if the SECOND connect throws — otherwise the first client leaks before the
    // try/finally below is even entered.
    let worker: McpClient
    try {
      worker = await connect(url, info.workerToken)
    } catch (e) {
      await orch.close().catch(() => {})
      throw e
    }
    try {
      await use({ info, orch, worker })
    } finally {
      await orch.close().catch(() => {})
      await worker.close().catch(() => {})
    }
  }
})

test.describe('@mcp swarm-layer tier enforcement + dispatch (live loopback)', () => {
  test('tier split: tools/list hides orchestrator tools from a worker; tools/call denies them server-side', async ({
    mcp
  }) => {
    // tools/list: the orchestrator sees orchestrator_ping; the worker does not.
    expect(mcp.orch.tools).toContain('orchestrator_ping')
    expect(mcp.worker.tools).not.toContain('orchestrator_ping')
    // tools/call: the orchestrator gets a real pong...
    const orchCall = await mcp.orch.call('orchestrator_ping')
    expect(orchCall.ok).toBe(true)
    if (orchCall.ok) expect(resultText(orchCall.result)).toContain('orchestrator-pong')
    // ...the worker gets the SPECIFIC tool-not-found denial (a tier split, not a transport miss).
    const workerCall = await mcp.worker.call('orchestrator_ping')
    expect(deniedToolNotFound(workerCall, 'orchestrator_ping')).toBe(true)
  })

  // W1-F skills substrate: the MCP prompts primitive is tier-gated server-side, exactly like the
  // tool split above. The orchestrator + a consented `connected` terminal see the canvas-orientation
  // playbook; a worker sees NONE (a well-formed empty array, not a "server does not support prompts"
  // rejection — the capability is declared for every tier, the registry filters by ctx.tier).
  // prompts/get renders the orientation text for a permitted tier and is rejected for a worker.
  test('prompts/list is tier-gated: orchestrator + connected see canvas-orientation, worker sees none; prompts/get renders + worker denied', async ({
    electronApp,
    mcp
  }) => {
    // orchestrator: prompts/list includes canvas-orientation
    const orchNames = await mcp.orch.listPromptNames()
    expect(orchNames).toContain('canvas-orientation')

    // worker: prompts/list is a well-formed EMPTY array (never a capability rejection / throw)
    const workerNames = await mcp.worker.listPromptNames()
    expect(workerNames).toEqual([])

    // connected tier (a consented terminal — the kind the spawn-time provisioner mints): also sees it.
    const minted = await mainCall<{ token: string; port: number } | null>(
      electronApp,
      'mcpMintConnectedToken',
      mcp.info.workerBoardId
    )
    expect(minted).not.toBeNull()
    const connected = await connect(`http://127.0.0.1:${mcp.info.port}/mcp`, minted!.token)
    try {
      expect(await connected.listPromptNames()).toContain('canvas-orientation')
    } finally {
      await connected.close()
    }

    // prompts/get: the orchestrator renders a non-empty orientation message...
    const got = await mcp.orch.getPrompt('canvas-orientation', {})
    expect(got.messages.length).toBeGreaterThan(0)
    expect(got.messages[0]?.role).toBe('user')
    const text = got.messages[0]?.text ?? ''
    expect(text.length).toBeGreaterThan(50)
    // ...spot-check a safety rule is present in the rendered output.
    expect(text).toContain('runGatedWrite')

    // ...the worker is DENIED prompts/get server-side (tier-gated, the call REJECTS).
    let workerGetRejected = false
    await mcp.worker.getPrompt('canvas-orientation', {}).catch(() => {
      workerGetRejected = true
    })
    expect(workerGetRejected).toBe(true)
  })

  test('canvas://boards mirrors all three board types, consistently with the board-states roll-up', async ({
    page,
    mcp
  }) => {
    await seed(page, 'terminal')
    await seed(page, 'browser')
    await seed(page, 'planning')
    // The renderer-derived mirror must carry every seeded type (propagation is async).
    await expect
      .poll(
        async () => {
          const boards = await mcp.orch.readJson<Array<{ type?: unknown }>>('canvas://boards')
          const types = boards.map((b) => b.type)
          return ['terminal', 'browser', 'planning'].every((t) => types.includes(t))
        },
        { timeout: 8000 }
      )
      .toBe(true)
    // The grouped board-states view stays consistent with canvas://boards: every board
    // appears under its own bucket, no extras, no dupes (poll absorbs a settling mirror).
    await expect
      .poll(
        async () => {
          const states = await mcp.orch.readJson<Record<string, string[]>>('canvas://board-states')
          const boards =
            await mcp.orch.readJson<Array<{ id: string; status: string }>>('canvas://boards')
          const groupedIds = Object.values(states).flat()
          return (
            groupedIds.length === boards.length &&
            boards.every((b) => states[b.status]?.includes(b.id))
          )
        },
        { timeout: 6000 }
      )
      .toBe(true)
  })

  test('status buckets propagate a terminal running->idle to the agent view (list + templated resource)', async ({
    page,
    mcp
  }) => {
    const sid = await seed(page, 'terminal')
    // fitView guarantees the board is measured -> the PTY spawns -> status running.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(sid)})`)
    await expect.poll(() => boardStatus(mcp.orch, sid), { timeout: 8000 }).toBe('running')
    // After spawn-success the board emits no further state until exit, so the forced idle
    // is the last writer and cannot be clobbered by a late spawn.
    await evalIn(page, `window.__canvasE2E.setTerminalDown(${JSON.stringify(sid)})`)
    await expect.poll(() => boardStatus(mcp.orch, sid), { timeout: 8000 }).toBe('idle')
    // The templated per-board resource agrees with the list (same bucket, id echoed).
    const res = await mcp.orch.readJson<{ id: string; status: string }>(
      `canvas://board/${sid}/status`
    )
    expect(res.id).toBe(sid)
    expect(res.status).toBe('idle')
  })

  test('a browser that fails to load surfaces in canvas://attention', async ({ page, mcp }) => {
    // Nothing listens on :59999 -> connection refused -> the board reaches `failed`.
    const did = await seed(page, 'browser', { url: 'http://127.0.0.1:59999/' })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(did)})`)
    await expect.poll(() => boardStatus(mcp.orch, did), { timeout: 14000 }).toBe('failed')
    const attention =
      await mcp.orch.readJson<Array<{ id: string; status: string }>>('canvas://attention')
    expect(attention.some((b) => b.id === did && b.status === 'failed')).toBe(true)
  })

  test('canvas://board/{id}/output is capped, paginated, and ANSI-stripped, honestly reporting droppedOlder', async ({
    page,
    electronApp,
    mcp
  }) => {
    type OutputPage = {
      text: string
      total: number
      returned: number
      nextCursor?: number
      droppedOlder: boolean
    }
    const oid = await seed(page, 'terminal')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(oid)})`)
    await expect.poll(() => boardStatus(mcp.orch, oid), { timeout: 8000 }).toBe('running')
    // ~71 chars/line, 9 of them ANSI; 5000 lines ~= 355 KB raw > the 256 KB ring cap.
    const chunk = '\x1b[31m' + 'L'.repeat(60) + '\x1b[0m\n'
    const seeded = await mainCall<boolean>(electronApp, 'mcpSeedOutput', oid, chunk.repeat(5000))
    expect(seeded).toBe(true)
    // Page the resource tail->front: every page <= 25k (capped, never the raw buffer),
    // no ESC bytes survive (stripped), and the OLDEST page reports droppedOlder.
    let cursor: number | undefined
    let pages = 0
    let capped = true
    let sawAnsi = false
    let droppedOlder = false
    let total = 0
    for (;;) {
      const uri =
        cursor === undefined
          ? `canvas://board/${oid}/output`
          : `canvas://board/${oid}/output?cursor=${cursor}`
      const pg = await mcp.orch.readJson<OutputPage>(uri)
      pages++
      total = pg.total
      if (pg.returned > 25_000 || pg.text.length > 25_000) capped = false
      if (pg.text.includes('\x1b')) sawAnsi = true
      if (pg.droppedOlder) droppedOlder = true
      if (pg.nextCursor === undefined || pages > 50) break
      cursor = pg.nextCursor
    }
    expect(pages, 'output paginated into >= 2 pages').toBeGreaterThanOrEqual(2)
    expect(capped, 'every page capped to <= 25k').toBe(true)
    expect(sawAnsi, 'ANSI bytes stripped').toBe(false)
    expect(droppedOlder, 'oldest page honestly reports truncation').toBe(true)
    expect(total).toBeLessThanOrEqual(262_144)
  })

  test('canvas://board/{id}/result is the empty shell, then reflects a recorded structured result', async ({
    page,
    electronApp,
    mcp
  }) => {
    type ResultShell = { present: boolean; status?: string; summary?: string; refs?: string[] }
    const rid = await seed(page, 'terminal')
    const empty = await mcp.orch.readJson<ResultShell>(`canvas://board/${rid}/result`)
    expect(empty.present).toBe(false)
    await mainCall(electronApp, 'mcpRecordResult', rid, {
      present: true,
      status: 'success',
      summary: 'e2e result',
      refs: ['src/x.ts']
    })
    const filled = await mcp.orch.readJson<ResultShell>(`canvas://board/${rid}/result`)
    expect(filled.present).toBe(true)
    expect(filled.status).toBe('success')
    expect(filled.summary).toBe('e2e result')
    expect(filled.refs?.[0]).toBe('src/x.ts')
  })

  test('write_result is a BOTH-tier worker write: a worker records its OWN board result over the wire', async ({
    mcp
  }) => {
    // The tier split cuts BOTH ways here: write_result is the one worker-tier WRITE tool, so it
    // is in BOTH tools/lists (unlike the orchestrator-only spawn/configure/close). The worker
    // token is bound to info.workerBoardId (no client-supplied id), so its write lands on THAT
    // board's result resource — which the orchestrator can then read back.
    type ResultShell = { present: boolean; status?: string; summary?: string; refs?: string[] }
    expect(mcp.worker.tools).toContain('write_result')
    expect(mcp.orch.tools).toContain('write_result')
    const wr = await mcp.worker.call('write_result', {
      status: 'success',
      summary: 'e2e write_result',
      refs: ['src/y.ts']
    })
    expect(acked(wr)).toBe(true)
    await expect
      .poll(
        async () => {
          const res = await mcp.orch.readJson<ResultShell>(
            `canvas://board/${mcp.info.workerBoardId}/result`
          )
          return (
            res.present === true &&
            res.status === 'success' &&
            res.summary === 'e2e write_result' &&
            res.refs?.[0] === 'src/y.ts'
          )
        },
        { timeout: 4000 }
      )
      .toBe(true)
  })

  test('canvas://memory empties gracefully then serves a doc, with a path-traversal guard', async ({
    electronApp,
    mcp
  }) => {
    type MemoryShell = { present: boolean; text: string }
    // Point the engine at a fresh EMPTY temp dir (the realistic ABSENT state).
    const root = await mainCall<string | null>(electronApp, 'mcpMemoryBegin')
    if (!root) throw new Error('mcpMemoryBegin returned null')
    try {
      const emptyMem = await mcp.orch.readJson<MemoryShell>('canvas://memory')
      expect(emptyMem.present).toBe(false) // graceful-empty, never an error
      // Write a fixture under the MAIN dir seam -> the resource now serves it.
      await mainCall(electronApp, 'mcpMemoryServe', root)
      const served = await mcp.orch.readJson<MemoryShell>('canvas://memory')
      expect(served.present).toBe(true)
      expect(served.text).toContain('e2e memory')
      const sum = await mcp.orch.readJson<MemoryShell>('canvas://board/memprobe/summary')
      expect(sum.present).toBe(true)
      expect(sum.text).toContain('memprobe summary')
      // SECURITY: a traversal id must NOT escape the memory dir even with a fixture present.
      const traversal = await mcp.orch.readJson<MemoryShell>(
        'canvas://board/..%2f..%2fMEMORY/summary'
      )
      expect(traversal.present).toBe(false)
    } finally {
      await mainCall(electronApp, 'mcpMemoryEnd', root)
    }
  })

  test('a MAIN->renderer ping command round-trips through the renderer applier', async ({
    electronApp
  }) => {
    // The inverse of the mirror: a control-plane command reaches the renderer and acks.
    const ack = await mainCall<{ ok: boolean; type?: string }>(electronApp, 'mcpPingCommand')
    expect(ack.ok).toBe(true)
    expect(ack.type).toBe('ping')
  })

  test('spawn_board creates a board on the canvas; a worker is denied the write tool', async ({
    page,
    mcp
  }) => {
    // The capability split is the load-bearing safety guarantee: orchestrator-only WRITE.
    expect(mcp.orch.tools).toContain('spawn_board')
    expect(mcp.worker.tools).not.toContain('spawn_board')
    const spawn = await mcp.orch.call('spawn_board', { type: 'terminal' })
    const spawnedId = okText(spawn)
    expect(spawnedId).not.toBe('')
    // The command round-tripped to the renderer: the board is on the canvas.
    await expect.poll(() => boardOnCanvas(page, spawnedId), { timeout: 6000 }).toBe(true)
    // The worker is DENIED server-side (the specific tool-not-found isError).
    const workerSpawn = await mcp.worker.call('spawn_board', { type: 'terminal' })
    expect(deniedToolNotFound(workerSpawn, 'spawn_board')).toBe(true)
    await closeBoardGated(page, mcp, spawnedId) // restore the baseline
  })

  test('spawn_board carries an agent title onto the new board (2b)', async ({ page, mcp }) => {
    // 2b end-to-end: the optional title rides spawn_board → orchestrator → addBoard command →
    // the rendered board's editable title (instead of the generic per-type default).
    const spawn = await mcp.orch.call('spawn_board', {
      type: 'planning',
      title: 'Auth refactor plan'
    })
    const id = okText(spawn)
    expect(id).not.toBe('')
    await expect.poll(() => boardOnCanvas(page, id), { timeout: 6000 }).toBe(true)
    await expect.poll(() => boardTitle(page, id), { timeout: 6000 }).toBe('Auth refactor plan')
    await closeBoardGated(page, mcp, id) // restore the baseline
  })

  // ── W1-G: app-model resource (C1) · spawn_group tool (C2) · write_result caps (C3) ───────────
  test('C1: canvas://app-model serves the orchestrator self-model (incl. spawn_group); worker denied', async ({
    mcp
  }) => {
    type WireAppModel = {
      version: number
      boardTypes: Array<{ type: string }>
      tools: Array<{ name: string; tier: string }>
      canvas: { boards: unknown[]; connectors: unknown[]; groups: unknown[] }
      rules: Record<string, unknown>
    }
    // Orchestrator-tier: the resource is present + shaped, and its tool catalog now lists spawn_group.
    const model = await mcp.orch.readJson<WireAppModel>('canvas://app-model')
    expect(model.version).toBe(1)
    expect(Array.isArray(model.boardTypes)).toBe(true)
    expect(model.canvas).toMatchObject({
      boards: expect.any(Array),
      connectors: expect.any(Array),
      groups: expect.any(Array)
    })
    expect(model.tools.some((t) => t.name === 'spawn_group' && t.tier === 'orchestrator')).toBe(
      true
    )
    // Worker tier: the resource is NOT registered for the tier → reading it REJECTS (orchestrator-only).
    let workerDenied = false
    await mcp.worker.readJson('canvas://app-model').catch(() => {
      workerDenied = true
    })
    expect(workerDenied).toBe(true)
  })

  test('C2: spawn_group creates a feature-zone cluster on the canvas (no confirm gate); a worker is denied', async ({
    page,
    mcp
  }) => {
    // spawn_group is orchestrator-only (unlike spawn_board) and content-less, so it spawns WITHOUT a
    // human confirm — the gate stays on content writes (handoff/assign/relay/add_planning_elements).
    expect(mcp.orch.tools).toContain('spawn_group')
    expect(mcp.worker.tools).not.toContain('spawn_group')
    const spawn = await mcp.orch.call('spawn_group', { name: 'e2e-zone', planning: true })
    const ids = JSON.parse(okText(spawn) || '{}') as {
      groupId?: string
      terminalId?: string
      planningId?: string
      browserId?: string
    }
    expect(ids.groupId).toBeTruthy()
    expect(ids.terminalId).toBeTruthy()
    expect(ids.planningId).toBeTruthy()
    expect(ids.browserId).toBeUndefined() // a browser member was not requested
    // Both members round-tripped to the renderer: they are on the canvas.
    await expect
      .poll(() => boardOnCanvas(page, ids.terminalId as string), { timeout: 6000 })
      .toBe(true)
    await expect
      .poll(() => boardOnCanvas(page, ids.planningId as string), { timeout: 6000 })
      .toBe(true)
    // The worker is DENIED server-side (the specific tool-not-found isError — orchestrator-only).
    const workerSpawn = await mcp.worker.call('spawn_group', { name: 'nope' })
    expect(deniedToolNotFound(workerSpawn, 'spawn_group')).toBe(true)
    // Restore the baseline (close both members; the now-empty group is cleared by the next reset()).
    await closeBoardGated(page, mcp, ids.terminalId as string)
    await closeBoardGated(page, mcp, ids.planningId as string)
  })

  test('spawn_board prompt/cwd: the prompt lands as the launchCommand AND runs as the first PTY line; non-terminal rejected', async ({
    page,
    mcp
  }) => {
    test.slow() // boots a real PTY
    // THE BUG THIS LOCKS OUT: spawn_board accepted `prompt` but silently dropped it — the board
    // spawned a bare shell, ran nothing, and the tool still returned the id (reported success).
    // The prompt is now the terminal's spawn-time launchCommand (spawn_group parity, no confirm
    // gate on a freshly-minted board — the gate stays on content writes to EXISTING boards).
    const sentinel = 'CANVAS_MCP_SPAWN_PROMPT_OK'
    const spawn = await mcp.orch.call('spawn_board', {
      type: 'terminal',
      prompt: `echo ${sentinel}`
    })
    // rc.6: a prompt-carrying spawn returns TWO content blocks — content[0] stays the bare id
    // (back-compat), content[1] is the honest "launch command queued … boots asynchronously"
    // note. Take block 0 for the id and pin the note's presence (the honest-ack contract).
    const blocks = spawn.ok
      ? ((spawn.result as { content?: Array<{ text?: string }> }).content ?? [])
      : []
    const id = (blocks[0]?.text ?? '').trim()
    expect(id).not.toBe('')
    expect(blocks[1]?.text ?? '').toMatch(/launch command queued/i)
    await expect.poll(() => boardOnCanvas(page, id), { timeout: 6000 }).toBe(true)
    // The sanitized prompt landed on the board as its launchCommand…
    await expect
      .poll(() => boardLaunchCommand(page, id), { timeout: 6000 })
      .toBe(`echo ${sentinel}`)
    // …and actually RAN: the PTY output carries the sentinel (not a bare idle shell).
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await expect.poll(() => boardStatus(mcp.orch, id), { timeout: 8000 }).toBe('running')
    await expect
      .poll(
        async () => {
          const txt = await readTerminalText(page, id)
          return typeof txt === 'string' && txt.includes(sentinel)
        },
        { timeout: 15000 }
      )
      .toBe(true)
    // prompt/cwd are terminal-only: a non-terminal spawn with either REJECTS before any board
    // is created (no orphan board that silently ignored them).
    const before = await mcp.orch.readJson<Array<unknown>>('canvas://boards')
    const bad = await mcp.orch.call('spawn_board', { type: 'planning', prompt: 'echo nope' })
    expect(rejected(bad)).toBe(true)
    const after = await mcp.orch.readJson<Array<unknown>>('canvas://boards')
    expect(after.length).toBe(before.length)
    await closeBoardGated(page, mcp, id)
  })

  test('C3 / BUG-009: write_result rejects an oversized summary at the wire (Zod cap), accepts a normal one', async ({
    mcp
  }) => {
    // The package Zod schema caps summary at 100k chars: an oversized payload does NOT ack (it is an
    // isError result before the orchestrator is reached; the MAIN clamp stays as defense-in-depth).
    const oversized = await mcp.worker.call('write_result', { summary: 'x'.repeat(100_001) })
    expect(acked(oversized)).toBe(false)
    // A legitimately-sized result still succeeds — the cap does not break normal writes.
    const ok = await mcp.worker.call('write_result', { summary: 'normal', refs: ['src/x.ts'] })
    expect(acked(ok)).toBe(true)
  })

  test('SECURITY: configure_board sets a launchCommand only through the human confirm gate (BUG-002 exec vector); worker denied', async ({
    page,
    mcp
  }) => {
    test.slow() // launchCommand is the exec vector -> confirm-gated like a live-PTY dispatch
    const id = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    expect(id).not.toBe('')
    expect(mcp.worker.tools).not.toContain('configure_board')
    // SECURITY: launchCommand is written verbatim as the FIRST PTY line on the board's next
    // spawn, so the app's orchestrator adapter routes it through the SAME sanitize->confirm->
    // audit discipline as a live dispatch (the retired smoke never drove this gate -- it would
    // hang against the current BUG-002-hardened adapter). Fire the call, drive the modal, await.
    const cfgP = mcp.orch.call('configure_board', { id, launchCommand: 'echo MCP_CFG' })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, APPROVE)
    expect(acked(await cfgP)).toBe(true)
    // The approved change lands on the board (asserted through the renderer; the boards resource is metadata-only).
    await expect.poll(() => boardLaunchCommand(page, id), { timeout: 6000 }).toBe('echo MCP_CFG')
    const workerCfg = await mcp.worker.call('configure_board', { id, launchCommand: 'x' })
    expect(deniedToolNotFound(workerCfg, 'configure_board')).toBe(true)
    await closeBoardGated(page, mcp, id)
  })

  test('close_board removes a board ONLY through the human gate; deny keeps it; a worker is denied', async ({
    page,
    mcp
  }) => {
    test.slow() // two real confirm-modal round-trips
    const spawn = await mcp.orch.call('spawn_board', { type: 'terminal' })
    const id = okText(spawn)
    expect(id).not.toBe('')
    await expect.poll(() => boardOnCanvas(page, id), { timeout: 6000 }).toBe(true)
    expect(mcp.worker.tools).not.toContain('close_board')
    // DENY path first (2026-07-02 gate — the reaper's replacement): the call blocks on the
    // human gate; click Deny → the board STAYS on the canvas and the call resolves as an error.
    const denyP = mcp.orch.call('close_board', { id })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, DENY)
    expect(rejected(await denyP)).toBe(true)
    expect(await boardOnCanvas(page, id)).toBe(true) // still there — deny is fail-closed
    // APPROVE path: the same close, approved → the board is gone.
    const closeP = mcp.orch.call('close_board', { id })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, APPROVE)
    expect(acked(await closeP)).toBe(true)
    await expect.poll(() => boardOnCanvas(page, id), { timeout: 6000 }).toBe(false) // gone
    // Visibility: the agent-initiated removal raised the "Agent closed board …" toast (with
    // its Undo action) — the silent reaper-era delete is the exact bug this replaces.
    const TOAST = `(() => [...document.querySelectorAll('.toast-msg')].some((t) => /Agent closed board/.test(t.textContent || '')))()`
    expect(await pollEval(page, TOAST, 6000)).toBe(true)
    // The worker is denied the tool regardless of whether the board still exists.
    const workerClose = await mcp.worker.call('close_board', { id })
    expect(deniedToolNotFound(workerClose, 'close_board')).toBe(true)
  })

  test('SECURITY: the orchestrator spawn cap rejects beyond the limit (nothing auto-spawns unbounded)', async ({
    page,
    mcp
  }) => {
    test.slow() // each gated cleanup close pays a real confirm-modal round-trip
    const capIds: string[] = []
    let capRejected = false
    for (let i = 0; i < 8; i++) {
      const r = await mcp.orch.call('spawn_board', { type: 'terminal' })
      const id = okText(r)
      if (id) capIds.push(id)
      else if (r.ok && isErrorResult(r.result) && /cap/i.test(resultText(r.result))) {
        capRejected = true
        break
      } else break // unexpected — fall through to the assertion
    }
    // Restore the baseline BEFORE asserting, so a failed assert still leaves a clean canvas.
    for (const id of capIds) await closeBoardGated(page, mcp, id)
    expect(capRejected, `cap should reject beyond the limit; spawned ${capIds.length}`).toBe(true)
    expect(capIds.length).toBeGreaterThanOrEqual(1)
  })

  test('SECURITY: handoff_prompt writes to a terminal only through the human confirm gate; worker + non-terminal + label denied', async ({
    page,
    mcp
  }) => {
    test.slow() // real shell spawn + confirm + framebuffer poll
    // Tier split + worker denied server-side.
    expect(mcp.worker.tools).not.toContain('handoff_prompt')
    const workerHandoff = await mcp.worker.call('handoff_prompt', {
      boardId: 'any-id',
      prompt: 'echo x'
    })
    expect(deniedToolNotFound(workerHandoff, 'handoff_prompt')).toBe(true)
    // SECURITY: a non-terminal target is rejected BEFORE any write/confirm — Browser
    // content must never reach a PTY.
    const bId = okText(await mcp.orch.call('spawn_board', { type: 'browser' }))
    const nonTerm = bId
      ? await mcp.orch.call('handoff_prompt', { boardId: bId, prompt: 'echo x' })
      : ({ ok: false, threw: 'no-id' } as CallOutcome)
    expect(rejected(nonTerm)).toBe(true)
    // SECURITY: a TITLE is not an opaque id -> label-targeting is rejected for free.
    const labelTargeted = await mcp.orch.call('handoff_prompt', {
      boardId: 'Terminal',
      prompt: 'echo x'
    })
    expect(rejected(labelTargeted)).toBe(true)
    // Happy path: hand off an echo sentinel, drive the confirm modal, assert it lands in the PTY.
    const tId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    expect(tId).not.toBe('')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(tId)})`)
    await expect.poll(() => boardStatus(mcp.orch, tId), { timeout: 8000 }).toBe('running')
    const sentinel = 'CANVAS_MCP_HANDOFF_OK'
    const handoffP = mcp.orch.call('handoff_prompt', { boardId: tId, prompt: `echo ${sentinel}` })
    // The dispatch BLOCKS on the human gate — drive our trusted modal like a user.
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, APPROVE)
    // Flip idle so the bounded await-idle returns promptly (the write already happened).
    await evalIn(page, `window.__canvasE2E.setTerminalDown(${JSON.stringify(tId)})`)
    expect(acked(await handoffP)).toBe(true)
    await expect
      .poll(
        async () => {
          const txt = await readTerminalText(page, tId)
          return typeof txt === 'string' && txt.includes(sentinel)
        },
        { timeout: 10000 }
      )
      .toBe(true)
    await closeBoardGated(page, mcp, tId)
    if (bId) await closeBoardGated(page, mcp, bId)
  })

  test('SECURITY: assign_prompt fire-and-forget writes to a terminal through the gate; worker + non-terminal denied', async ({
    page,
    mcp
  }) => {
    test.slow()
    expect(mcp.worker.tools).not.toContain('assign_prompt')
    const workerAssign = await mcp.worker.call('assign_prompt', {
      boardId: 'any-id',
      prompt: 'echo x'
    })
    expect(deniedToolNotFound(workerAssign, 'assign_prompt')).toBe(true)
    const baId = okText(await mcp.orch.call('spawn_board', { type: 'browser' }))
    const aNonTerm = baId
      ? await mcp.orch.call('assign_prompt', { boardId: baId, prompt: 'echo x' })
      : ({ ok: false, threw: 'no-id' } as CallOutcome)
    expect(rejected(aNonTerm)).toBe(true)
    // Happy path: the call RESOLVES the moment the write lands (no await-idle, unlike handoff).
    const taId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    expect(taId).not.toBe('')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(taId)})`)
    await expect.poll(() => boardStatus(mcp.orch, taId), { timeout: 8000 }).toBe('running')
    const sentinel = 'CANVAS_MCP_ASSIGN_OK'
    const assignP = mcp.orch.call('assign_prompt', { boardId: taId, prompt: `echo ${sentinel}` })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, APPROVE)
    expect(acked(await assignP)).toBe(true) // resolves without flipping the board idle
    await expect
      .poll(
        async () => {
          const txt = await readTerminalText(page, taId)
          return typeof txt === 'string' && txt.includes(sentinel)
        },
        { timeout: 10000 }
      )
      .toBe(true)
    await closeBoardGated(page, mcp, taId)
    if (baId) await closeBoardGated(page, mcp, baId)
  })

  test('readiness gate: a dispatch into a SLOW-BOOTING worker lands AFTER its boot finishes, not mid-boot', async ({
    page,
    mcp
  }) => {
    test.slow() // deliberately boots a worker that streams boot noise for ~4s
    // THE RACE THIS LOCKS OUT: runGatedWrite used to write the moment a PTY session existed —
    // before the launchCommand agent finished booting — so the prompt could land mid-boot (eaten
    // by the boot stream / a trust prompt) while the tool still reported success. The readiness
    // gate (floor → activity → quiet) now holds the write until the boot stream goes quiet.
    // Worker: streams BOOTING lines for ~4s, prints BOOT_DONE, then echoes stdin (a fake REPL).
    const bootScript =
      "node -e \"let n=0;const t=setInterval(()=>{console.log('BOOTING '+n++)},200);" +
      "setTimeout(()=>{clearInterval(t);console.log('BOOT_DONE');" +
      'process.stdin.pipe(process.stdout)},4000)"'
    const wId = await seed(page, 'terminal', { launchCommand: bootScript })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(wId)})`)
    await expect.poll(() => boardStatus(mcp.orch, wId), { timeout: 8000 }).toBe('running')
    // Dispatch IMMEDIATELY — mid-boot, while BOOTING lines are still streaming.
    const sentinel = 'CANVAS_MCP_READINESS_OK'
    const assignP = mcp.orch.call('assign_prompt', { boardId: wId, prompt: `echo ${sentinel}` })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, APPROVE)
    // The call resolves only after the gate's readiness wait + write (boot quiet ≈ t+4.8s).
    expect(acked(await assignP)).toBe(true)
    await expect
      .poll(
        async () => {
          const txt = await readTerminalText(page, wId)
          return typeof txt === 'string' && txt.includes(sentinel)
        },
        { timeout: 15000 }
      )
      .toBe(true)
    // Ordering proof: the sentinel's FIRST appearance is AFTER BOOT_DONE — the write waited out
    // the boot window instead of landing between BOOTING lines.
    const txt = (await readTerminalText(page, wId)) ?? ''
    expect(txt).toContain('BOOT_DONE')
    expect(txt.indexOf(sentinel)).toBeGreaterThan(txt.indexOf('BOOT_DONE'))
    await closeBoardGated(page, mcp, wId)
  })

  test('SECURITY: interrupt sends Ctrl-C to a terminal through the gate, with an audit entry; worker + non-terminal denied', async ({
    page,
    mcp
  }) => {
    test.slow()
    expect(mcp.worker.tools).not.toContain('interrupt')
    const workerInt = await mcp.worker.call('interrupt', { boardId: 'any-id' })
    expect(deniedToolNotFound(workerInt, 'interrupt')).toBe(true)
    const biId = okText(await mcp.orch.call('spawn_board', { type: 'browser' }))
    const iNonTerm = biId
      ? await mcp.orch.call('interrupt', { boardId: biId })
      : ({ ok: false, threw: 'no-id' } as CallOutcome)
    expect(rejected(iNonTerm)).toBe(true)
    // Happy path: a Ctrl-C has no echo, so verify via the audit trail (interrupt/dispatched).
    const tiId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    expect(tiId).not.toBe('')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(tiId)})`)
    await expect.poll(() => boardStatus(mcp.orch, tiId), { timeout: 8000 }).toBe('running')
    const intP = mcp.orch.call('interrupt', { boardId: tiId })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, APPROVE)
    expect(acked(await intP)).toBe(true)
    await expect
      .poll(
        () =>
          evalIn<boolean>(
            page,
            `window.api.mcp.readAudit({ limit: 50 }).then((es) => es.some((e) =>` +
              ` e.type === 'interrupt' && e.targetId === ${JSON.stringify(tiId)} && e.status === 'dispatched'))`
          ),
        { timeout: 4000 }
      )
      .toBe(true)
    await closeBoardGated(page, mcp, tiId)
    if (biId) await closeBoardGated(page, mcp, biId)
  })

  test('SECURITY: relay_prompt A->B is authorized by an orchestration cable; the reverse direction is rejected; worker denied', async ({
    page,
    electronApp,
    mcp
  }) => {
    test.slow()
    expect(mcp.worker.tools).not.toContain('relay_prompt')
    const workerRelay = await mcp.worker.call('relay_prompt', {
      sourceId: 'a',
      targetId: 'b',
      prompt: 'echo x'
    })
    expect(deniedToolNotFound(workerRelay, 'relay_prompt')).toBe(true)
    const raId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    const rbId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    expect(raId).not.toBe('')
    expect(rbId).not.toBe('')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(rbId)})`)
    await expect.poll(() => boardStatus(mcp.orch, rbId), { timeout: 8000 }).toBe('running')
    // Draw the orchestration cable A->B (same store path as the real gesture) + wait for
    // the MAIN mirror to carry it (the cable IS the route).
    await evalIn(
      page,
      `window.__canvasE2E.addConnector(${JSON.stringify(raId)}, ${JSON.stringify(rbId)}, 'orchestration')`
    )
    await expect
      .poll(
        async () => {
          const cables = await mainCall<
            Array<{ sourceId: string; targetId: string; kind: string }>
          >(electronApp, 'mcpListConnectors')
          return cables.some(
            (c) => c.kind === 'orchestration' && c.sourceId === raId && c.targetId === rbId
          )
        },
        { timeout: 6000 }
      )
      .toBe(true)
    // SECURITY: no cable B->A -> relay rejected (direction is the authorization).
    const noCable = await mcp.orch.call('relay_prompt', {
      sourceId: rbId,
      targetId: raId,
      prompt: 'echo nope'
    })
    expect(rejected(noCable)).toBe(true)
    // Happy path: relay A->B, drive the confirm modal, assert it lands in B.
    const sentinel = 'CANVAS_MCP_RELAY_OK'
    const relayP = mcp.orch.call('relay_prompt', {
      sourceId: raId,
      targetId: rbId,
      prompt: `echo ${sentinel}`
    })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, APPROVE)
    expect(acked(await relayP)).toBe(true)
    await expect
      .poll(
        async () => {
          const txt = await readTerminalText(page, rbId)
          return typeof txt === 'string' && txt.includes(sentinel)
        },
        { timeout: 10000 }
      )
      .toBe(true)
    await closeBoardGated(page, mcp, raId)
    await closeBoardGated(page, mcp, rbId)
  })

  // ── Agent Orchestration v1 (P0 authority + P4 connector-aware routing) ──────────────────────
  // A `connected`-tier token (the kind the spawn-time provisioner mints for a CONSENTED terminal
  // the user is talking to) can relay along the canvas cables it OWNS — proving the authority
  // relaxation end-to-end: a REAL terminal agent (not just the in-process 'app' orchestrator) can
  // drive orchestration cables, scoped to its own board as source. This is the umbrella's payoff
  // exercised through the shipped authority path (the consent/provisioner wiring is P1/P3).
  test('SECURITY: a connected-tier terminal relays only along its OWN cables (own-board binding + cable auth); orchestrator-only tools stay hidden', async ({
    page,
    electronApp,
    mcp
  }) => {
    test.slow()
    // Spawn two real terminals; A will be the connected agent's own board, B the cabled target.
    const aId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    const bId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    expect(aId).not.toBe('')
    expect(bId).not.toBe('')
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(bId)})`)
    await expect.poll(() => boardStatus(mcp.orch, bId), { timeout: 8000 }).toBe('running')

    // Mint a connected-tier token BOUND to board A (the seam minter the P3 provisioner uses) and
    // connect a real client over loopback — exactly what a consented terminal agent would hold.
    const minted = await mainCall<{ token: string; port: number } | null>(
      electronApp,
      'mcpMintConnectedToken',
      aId
    )
    expect(minted).not.toBeNull()
    const url = `http://127.0.0.1:${mcp.info.port}/mcp`
    const connected = await connect(url, minted!.token)
    try {
      // tools/list: the connected tier sees relay + canvas-write tools, but NONE of the
      // cross-board/observational orchestrator tools (the split is structural, by registration).
      expect(connected.tools).toContain('relay_prompt')
      expect(connected.tools).toContain('spawn_board')
      expect(connected.tools).toContain('configure_board')
      expect(connected.tools).toContain('add_planning_elements') // planningWrite on under CANVAS_E2E
      for (const hidden of [
        'orchestrator_ping',
        'handoff_prompt',
        'assign_prompt',
        'interrupt',
        'close_board',
        'git_diff'
      ]) {
        expect(connected.tools).not.toContain(hidden)
      }

      // SECURITY (cable auth): relay from its OWN board A→B is rejected while NO cable exists —
      // the connected tier still honors canRelay (the cable is the authorization), no side effect.
      const noCableYet = await connected.call('relay_prompt', {
        sourceId: aId,
        targetId: bId,
        prompt: 'echo too-early'
      })
      expect(rejected(noCableYet)).toBe(true)

      // Draw the orchestration cable A→B (same store path as the real gesture) and wait for the
      // MAIN mirror to carry it (canRelay reads that mirror).
      await evalIn(
        page,
        `window.__canvasE2E.addConnector(${JSON.stringify(aId)}, ${JSON.stringify(bId)}, 'orchestration')`
      )
      await expect
        .poll(
          async () => {
            const cables = await mainCall<
              Array<{ sourceId: string; targetId: string; kind: string }>
            >(electronApp, 'mcpListConnectors')
            return cables.some(
              (c) => c.kind === 'orchestration' && c.sourceId === aId && c.targetId === bId
            )
          },
          { timeout: 6000 }
        )
        .toBe(true)

      // SECURITY (own-board binding): even WITH a cable on the canvas, the connected token may not
      // relay from a board it does not own. sourceId=B (≠ its token board A) is rejected by the
      // tier binding BEFORE the host gate — a connected agent can't drive someone else's cables.
      const notMyBoard = await connected.call('relay_prompt', {
        sourceId: bId,
        targetId: aId,
        prompt: 'echo not-mine'
      })
      expect(rejected(notMyBoard)).toBe(true)
      expect(resultText(notMyBoard.ok ? notMyBoard.result : '')).toContain('own board')

      // Happy path: the connected agent relays A→B along its own cable, drives the SAME human
      // confirm gate, and the prompt lands in B's xterm. The authority relaxation, end-to-end.
      const sentinel = 'CANVAS_MCP_CONNECTED_RELAY_OK'
      const relayP = connected.call('relay_prompt', {
        sourceId: aId,
        targetId: bId,
        prompt: `echo ${sentinel}`
      })
      expect(await pollEval(page, MODAL, 8000)).toBe(true)
      await evalIn(page, APPROVE)
      expect(acked(await relayP)).toBe(true)
      await expect
        .poll(
          async () => {
            const txt = await readTerminalText(page, bId)
            return typeof txt === 'string' && txt.includes(sentinel)
          },
          { timeout: 10000 }
        )
        .toBe(true)
    } finally {
      await connected.close().catch(() => {})
    }
    await closeBoardGated(page, mcp, aId)
    await closeBoardGated(page, mcp, bId)
  })

  test('rc.6 auto-cable: a spawn carrying sourceBoardId mints the spawner→spawned cable; the spawner relays along it with NO hand-drawn connector', async ({
    page,
    electronApp,
    mcp
  }) => {
    test.slow()
    // THE GAP THIS CLOSES: a connected terminal could spawn_board a worker but relay_prompt into
    // it was rejected (no orchestration cable) until the human hand-drew one. With rc.6 the tool
    // passes the caller's token-derived boardId as sourceBoardId; the host verifies terminal→
    // terminal and the renderer creates the cable IN the spawn. Driven here via the in-process
    // `spawnBoardNow` seam (the same orchestrator path the ≥rc.6 package tool calls); the
    // ctx.boardId wire half is locked by the package contract tests.
    const aId = okText(await mcp.orch.call('spawn_board', { type: 'terminal' }))
    expect(aId).not.toBe('')
    await expect.poll(() => boardStatus(mcp.orch, aId), { timeout: 8000 }).toBe('running')
    // Spawn the worker WITH the source id — the auto-cable spawn.
    const spawned = await mainCall<{ id: string } | null>(electronApp, 'spawnBoardNow', {
      type: 'terminal',
      sourceBoardId: aId
    })
    expect(spawned).not.toBeNull()
    const wId = spawned!.id
    await expect.poll(() => boardOnCanvas(page, wId), { timeout: 6000 }).toBe(true)
    // The spawner→spawned orchestration cable landed in MAIN's mirror — no gesture drew it.
    await expect
      .poll(
        async () => {
          const cables = await mainCall<
            Array<{ sourceId: string; targetId: string; kind: string }>
          >(electronApp, 'mcpListConnectors')
          return cables.some(
            (c) => c.kind === 'orchestration' && c.sourceId === aId && c.targetId === wId
          )
        },
        { timeout: 6000 }
      )
      .toBe(true)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(wId)})`)
    await expect.poll(() => boardStatus(mcp.orch, wId), { timeout: 8000 }).toBe('running')
    // A connected client bound to A relays into its freshly-spawned worker — authorized by the
    // auto-cable, still human-confirmed, and readiness-gated into the worker's ready REPL.
    const minted = await mainCall<{ token: string; port: number } | null>(
      electronApp,
      'mcpMintConnectedToken',
      aId
    )
    expect(minted).not.toBeNull()
    const connected = await connect(`http://127.0.0.1:${mcp.info.port}/mcp`, minted!.token)
    try {
      const sentinel = 'CANVAS_MCP_AUTOCABLE_OK'
      const relayP = connected.call('relay_prompt', {
        sourceId: aId,
        targetId: wId,
        prompt: `echo ${sentinel}`
      })
      expect(await pollEval(page, MODAL, 8000)).toBe(true)
      await evalIn(page, APPROVE)
      expect(acked(await relayP)).toBe(true)
      await expect
        .poll(
          async () => {
            const txt = await readTerminalText(page, wId)
            return typeof txt === 'string' && txt.includes(sentinel)
          },
          { timeout: 15000 }
        )
        .toBe(true)
    } finally {
      await connected.close().catch(() => {})
    }
    await closeBoardGated(page, mcp, aId)
    await closeBoardGated(page, mcp, wId)
  })
})

/**
 * @core @planning @mcp — file-tree S5: file boards + Planning file references reach the
 * agent-readable `canvas://boards` resource OVER THE WIRE. This is the faithful, demonstrable proof
 * of S5: the package serializes `orchestrator.listBoards()` verbatim into `canvas://boards`, so an
 * MCP-connected agent that READS that resource sees a File board's `path` and a Planning board's
 * `fileRefs` (path + label) — never file content, never via the PTY. (A live terminal-agent MCP
 * connection — the `.mcp.json` injection — lands on a separate umbrella; here we read the same
 * resource through a real loopback MCP client, exactly the payload such an agent receives.)
 */
test.describe('@core @planning @mcp S5 file context on canvas://boards (over the wire)', () => {
  test('a File board path + a Planning fileRef appear in the agent-readable canvas://boards', async ({
    page,
    electronApp,
    mcp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'file-s5mcp-', 'S5')
    try {
      await mainCall(electronApp, 'writeProjectFile', tmp, 'a.ts', 'export const A = 1\n')
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)

      // A File board bound to a.ts (carries FileBoard.path → the mirror's `path`).
      const fileId = await seed(page, 'file', { path: 'a.ts' })

      // A Planning board with a fileref dropped on it (the real S4 drop path → a `fileref` element).
      const planId = await seed(page, 'planning')
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
      await expect(page.locator(`.react-flow__node[data-id="${planId}"] .pl-well`)).toBeVisible({
        timeout: 6000
      })
      // Drop a fileref on the (only) planning well. Literal selector — no value flows into the
      // eval'd code (CodeQL js/bad-code-sanitization; the #82 structured-arg discipline).
      await evalIn(
        page,
        `(() => {
          const well = document.querySelector('.pl-well')
          const r = well.getBoundingClientRect()
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2
          const dt = new DataTransfer()
          dt.setData('application/x-canvas-ade-fileref', JSON.stringify({ path: 'a.ts', label: 'a.ts' }))
          well.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }))
        })()`
      )
      // Confirm the fileref element landed on the planning board before asserting the wire view.
      // Structured-arg eval — the id is passed as DATA, never interpolated into code (the #82 pattern).
      await expect
        .poll(() =>
          page.evaluate((id) => {
            const hook = (
              globalThis as unknown as {
                __canvasE2E: {
                  getBoards(): Array<{
                    id: string
                    elements?: Array<{ kind: string; path: string }>
                  }>
                }
              }
            ).__canvasE2E
            const b = hook.getBoards().find((x) => x.id === id)
            return ((b && b.elements) || []).filter((e) => e.kind === 'fileref').map((e) => e.path)
          }, planId)
        )
        .toEqual(['a.ts'])

      // THE PROOF: read the live `canvas://boards` resource through a real MCP client and assert the
      // File board's path + the Planning board's fileRefs are present (mirror push is async +
      // debounced → poll). This is exactly the JSON an MCP-connected agent would receive.
      type WireBoard = {
        id: string
        type: string
        path?: string
        fileRefs?: Array<{ path: string; label: string }>
      }
      await expect
        .poll(
          async () => {
            const boards = await mcp.orch.readJson<WireBoard[]>('canvas://boards')
            const f = boards.find((b) => b.id === fileId)
            const p = boards.find((b) => b.id === planId)
            const fileOk = f?.type === 'file' && f.path === 'a.ts'
            const planOk = !!p?.fileRefs?.some((r) => r.path === 'a.ts' && r.label === 'a.ts')
            return fileOk && planOk
          },
          { timeout: 8000 }
        )
        .toBe(true)

      // INVARIANT: a Terminal board carries neither field — file context never leaks across types.
      const termId = await seed(page, 'terminal')
      await expect
        .poll(async () => {
          const boards = await mcp.orch.readJson<WireBoard[]>('canvas://boards')
          const t = boards.find((b) => b.id === termId)
          return !!t && t.path === undefined && t.fileRefs === undefined
        })
        .toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
