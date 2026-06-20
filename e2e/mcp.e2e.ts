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
 *   - idle-reap (the smoke's `MCP_REAP_SKIP` is skip-by-default; the orchestrator sweep
 *     is unit-covered with a fake clock in `mcpOrchestrator.test.ts`),
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

/** Drive the trusted confirm modal like a human (the dispatch tools block on this gate). */
const MODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
const APPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`

type McpPair = { info: McpInfo; orch: McpClient; worker: McpClient }

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
    await mcp.orch.call('close_board', { id: spawnedId }) // restore the baseline
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
    await mcp.orch.call('close_board', { id })
  })

  test('close_board removes a board from the canvas; a worker is denied', async ({ page, mcp }) => {
    const spawn = await mcp.orch.call('spawn_board', { type: 'terminal' })
    const id = okText(spawn)
    expect(id).not.toBe('')
    await expect.poll(() => boardOnCanvas(page, id), { timeout: 6000 }).toBe(true)
    expect(mcp.worker.tools).not.toContain('close_board')
    const close = await mcp.orch.call('close_board', { id })
    expect(acked(close)).toBe(true)
    await expect.poll(() => boardOnCanvas(page, id), { timeout: 6000 }).toBe(false) // gone
    // The worker is denied the tool regardless of whether the board still exists.
    const workerClose = await mcp.worker.call('close_board', { id })
    expect(deniedToolNotFound(workerClose, 'close_board')).toBe(true)
  })

  test('SECURITY: the orchestrator spawn cap rejects beyond the limit (nothing auto-spawns unbounded)', async ({
    mcp
  }) => {
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
    for (const id of capIds) await mcp.orch.call('close_board', { id })
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
    await mcp.orch.call('close_board', { id: tId })
    if (bId) await mcp.orch.call('close_board', { id: bId })
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
    await mcp.orch.call('close_board', { id: taId })
    if (baId) await mcp.orch.call('close_board', { id: baId })
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
    await mcp.orch.call('close_board', { id: tiId })
    if (biId) await mcp.orch.call('close_board', { id: biId })
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
    await mcp.orch.call('close_board', { id: raId })
    await mcp.orch.call('close_board', { id: rbId })
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
    await mcp.orch.call('close_board', { id: aId })
    await mcp.orch.call('close_board', { id: bId })
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
