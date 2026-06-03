import { ipcMain, type BrowserWindow } from 'electron'
import type { RunningMcp } from './mcp'
import { sendMcpCommand } from './mcpCommand'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { debugSeedOutput } from './pty'
import { recordBoardResult } from './boardResults'
import { createDispatchGuard } from './dispatchGuard'
import { __setMemoryDirForTest } from './boardMemory'
import { listConnectors } from './boardRegistry'

/** One capped page of board output as the resource serializes it (T1.4). */
interface OutputPage {
  text: string
  total: number
  returned: number
  nextCursor?: number
  droppedOlder: boolean
}

/** A board's structured last result as the resource serializes it (T1.5). */
interface ResultShell {
  present: boolean
  status?: string
  summary?: string
  refs?: string[]
  at?: string
}

/** A memory doc as the resource serializes it (T1.7). */
interface MemoryShell {
  present: boolean
  text: string
}

/** stdout marker (EPIPE-safe like index.ts's smokeLog). */
function log(line: string): void {
  try {
    console.log(line)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it resolves truthy or the timeout elapses (copied from e2eSmoke). */
async function poll(fn: () => Promise<boolean>, timeoutMs: number, stepMs = 120): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await delay(stepMs)
  }
}

/** Outcome of a callTool: a returned result, or a thrown transport/protocol error. */
type CallOutcome = { ok: true; result: unknown } | { ok: false; threw: string; code?: number }

interface SmokeClient {
  list: string[]
  pingOrchestrator(): Promise<CallOutcome>
  /** Read the canvas://boards resource and return each board's `type` (control plane). */
  readBoardTypes(): Promise<string[]>
  /** Read canvas://boards and return the status bucket of board `id` (null if absent). */
  readBoardStatus(id: string): Promise<string | null>
  /** Read the templated canvas://board/{id}/status resource → { id, status }. */
  readBoardStatusResource(id: string): Promise<{ id: string; status: string }>
  /** Read canvas://boards and return each board's id + status bucket. */
  readBoards(): Promise<Array<{ id: string; status: string }>>
  /**
   * Read the canvas://board-states roll-up. Returns the grouped map, or `null` when
   * the resource is not registered (an older installed pkg) — so the probe can SKIP
   * gracefully instead of failing. Rethrows any other (real transport) error.
   */
  readBoardStates(): Promise<Record<string, string[]> | null>
  /**
   * Read canvas://attention (boards needing a human). Returns the list, or `null`
   * when the resource is not registered (older installed pkg) → SKIP. Rethrows any
   * other (real transport) error.
   */
  readAttention(): Promise<Array<{ id: string; status: string }> | null>
  /**
   * Read one capped page of canvas://board/{id}/output (tail when `cursor` omitted;
   * older via the ?cursor query template). Returns the page, or `null` when the
   * resource is not registered (older installed pkg) → SKIP. Rethrows transport errors.
   */
  readBoardOutput(id: string, cursor?: number): Promise<OutputPage | null>
  /**
   * Read canvas://board/{id}/result (structured last result). Returns the page, or
   * `null` when the resource is not registered (older installed pkg) → SKIP. Rethrows
   * transport errors.
   */
  readBoardResult(id: string): Promise<ResultShell | null>
  /** Read canvas://memory (project index). Null when not registered (older pkg) → SKIP. */
  readMemory(): Promise<MemoryShell | null>
  /** Read canvas://board/{id}/summary. Null when not registered → SKIP. */
  readSummaryDoc(id: string): Promise<MemoryShell | null>
  /** Call the spawn_board write tool (T3.1). Resolves with the outcome (isError on tier denial). */
  callSpawn(type: string): Promise<CallOutcome>
  /** Call the close_board write tool (T3.2). Resolves with the outcome (isError on tier denial). */
  callClose(id: string): Promise<CallOutcome>
  /** Call the configure_board write tool (T3.3). Resolves with the outcome (isError on tier denial). */
  callConfigure(id: string, args: Record<string, string>): Promise<CallOutcome>
  /** Call the handoff_prompt dispatch tool (T4.3). Blocks until confirm+idle; isError on tier denial/rejection. */
  callHandoff(boardId: string, prompt: string): Promise<CallOutcome>
  /** Call the assign_prompt dispatch tool (T4.4). Fire-and-forget; isError on tier denial/rejection. */
  callAssign(boardId: string, prompt: string): Promise<CallOutcome>
  /** Call the write_result worker-tier write tool (T4.4). Binds to the caller's token board (no id arg). */
  callWriteResult(args: Record<string, unknown>): Promise<CallOutcome>
  /** Call the interrupt dispatch tool (T4.5). Sends Ctrl-C; isError on tier denial/rejection. */
  callInterrupt(boardId: string): Promise<CallOutcome>
  /** Call the relay_prompt agent-to-agent tool (T4.6). Relays along an orchestration cable. */
  callRelay(sourceId: string, targetId: string, prompt: string): Promise<CallOutcome>
  close(): Promise<void>
}

async function connect(url: string, token: string): Promise<SmokeClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  const list = (await client.listTools()).tools.map((t) => t.name)
  return {
    list,
    // Do NOT swallow generically: a tier denial comes back as an isError RESULT
    // (the call resolves), whereas a broken session/transport REJECTS. We must
    // tell those apart, so capture the error + its code rather than flattening
    // every rejection into a vague string (a thrown 'Session not found' must read
    // as a FAILURE, not a denial).
    pingOrchestrator: async (): Promise<CallOutcome> => {
      try {
        return { ok: true, result: await client.callTool({ name: 'orchestrator_ping' }) }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    // canvas://boards returns JSON.stringify(BoardSummary[]) in a single text content
    // block. Parse it and project the `type` of each board (no board content read).
    readBoardTypes: async (): Promise<string[]> => {
      const res = await client.readResource({ uri: 'canvas://boards' })
      const text = res.contents
        .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
        .join('')
      try {
        const boards = JSON.parse(text) as Array<{ type?: unknown }>
        return Array.isArray(boards)
          ? boards.map((b) => b?.type).filter((t): t is string => typeof t === 'string')
          : []
      } catch {
        // A malformed (non-JSON) resource payload is a distinct failure from "boards
        // not yet propagated" — surface it so the log is actionable, not a silent [].
        log(`MCP_FAIL boards-unparseable len=${text.length}`)
        return []
      }
    },
    readBoardStatus: async (id: string): Promise<string | null> => {
      const res = await client.readResource({ uri: 'canvas://boards' })
      const text = res.contents
        .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
        .join('')
      try {
        const boards = JSON.parse(text) as Array<{ id?: unknown; status?: unknown }>
        const board = Array.isArray(boards) ? boards.find((b) => b?.id === id) : undefined
        return typeof board?.status === 'string' ? board.status : null
      } catch {
        log(`MCP_FAIL board-status-unparseable len=${text.length}`)
        return null
      }
    },
    readBoardStatusResource: async (id: string): Promise<{ id: string; status: string }> => {
      const res = await client.readResource({ uri: `canvas://board/${id}/status` })
      const text = res.contents
        .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
        .join('')
      const parsed = JSON.parse(text) as { id?: unknown; status?: unknown }
      return {
        id: typeof parsed.id === 'string' ? parsed.id : '',
        status: typeof parsed.status === 'string' ? parsed.status : ''
      }
    },
    readBoards: async (): Promise<Array<{ id: string; status: string }>> => {
      const res = await client.readResource({ uri: 'canvas://boards' })
      const text = res.contents
        .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
        .join('')
      try {
        const boards = JSON.parse(text) as Array<{ id?: unknown; status?: unknown }>
        return Array.isArray(boards)
          ? boards
              .filter(
                (b): b is { id: string; status: string } =>
                  typeof b?.id === 'string' && typeof b?.status === 'string'
              )
              .map((b) => ({ id: b.id, status: b.status }))
          : []
      } catch {
        log(`MCP_FAIL boards-unparseable len=${text.length}`)
        return []
      }
    },
    readBoardStates: async (): Promise<Record<string, string[]> | null> => {
      try {
        const res = await client.readResource({ uri: 'canvas://board-states' })
        const text = res.contents
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .join('')
        return JSON.parse(text) as Record<string, string[]>
      } catch (e: unknown) {
        // A not-registered resource (older installed pkg) yields McpError -32602
        // "Resource ... not found" → treat as ABSENT (skip), not a smoke failure.
        // Match the RESOURCE-not-found shape specifically so a "Session not found"
        // (-32001) transport failure can't masquerade as a skip. Anything else rethrows.
        const code = (e as { code?: number })?.code
        if (code === -32602 || /resource .*not found/i.test(String(e))) return null
        throw e
      }
    },
    readAttention: async (): Promise<Array<{ id: string; status: string }> | null> => {
      try {
        const res = await client.readResource({ uri: 'canvas://attention' })
        const text = res.contents
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .join('')
        const boards = JSON.parse(text) as Array<{ id?: unknown; status?: unknown }>
        return Array.isArray(boards)
          ? boards
              .filter(
                (b): b is { id: string; status: string } =>
                  typeof b?.id === 'string' && typeof b?.status === 'string'
              )
              .map((b) => ({ id: b.id, status: b.status }))
          : []
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code
        if (code === -32602 || /resource .*not found/i.test(String(e))) return null
        throw e
      }
    },
    readBoardOutput: async (id: string, cursor?: number): Promise<OutputPage | null> => {
      const uri =
        cursor === undefined
          ? `canvas://board/${id}/output`
          : `canvas://board/${id}/output?cursor=${cursor}`
      try {
        const res = await client.readResource({ uri })
        const text = res.contents
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .join('')
        return JSON.parse(text) as OutputPage
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code
        if (code === -32602 || /resource .*not found/i.test(String(e))) return null
        throw e
      }
    },
    readBoardResult: async (id: string): Promise<ResultShell | null> => {
      try {
        const res = await client.readResource({ uri: `canvas://board/${id}/result` })
        const text = res.contents
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .join('')
        return JSON.parse(text) as ResultShell
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code
        if (code === -32602 || /resource .*not found/i.test(String(e))) return null
        throw e
      }
    },
    readMemory: async (): Promise<MemoryShell | null> => {
      try {
        const res = await client.readResource({ uri: 'canvas://memory' })
        const text = res.contents
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .join('')
        return JSON.parse(text) as MemoryShell
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code
        if (code === -32602 || /resource .*not found/i.test(String(e))) return null
        throw e
      }
    },
    readSummaryDoc: async (id: string): Promise<MemoryShell | null> => {
      try {
        const res = await client.readResource({ uri: `canvas://board/${id}/summary` })
        const text = res.contents
          .map((c) => ('text' in c && typeof c.text === 'string' ? c.text : ''))
          .join('')
        return JSON.parse(text) as MemoryShell
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code
        if (code === -32602 || /resource .*not found/i.test(String(e))) return null
        throw e
      }
    },
    callSpawn: async (type: string): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({ name: 'spawn_board', arguments: { type } })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    callClose: async (id: string): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({ name: 'close_board', arguments: { id } })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    callConfigure: async (id: string, args: Record<string, string>): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({ name: 'configure_board', arguments: { id, ...args } })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    callHandoff: async (boardId: string, prompt: string): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({ name: 'handoff_prompt', arguments: { boardId, prompt } })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    callAssign: async (boardId: string, prompt: string): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({ name: 'assign_prompt', arguments: { boardId, prompt } })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    callWriteResult: async (args: Record<string, unknown>): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({ name: 'write_result', arguments: args })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    callInterrupt: async (boardId: string): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({ name: 'interrupt', arguments: { boardId } })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    callRelay: async (sourceId: string, targetId: string, prompt: string): Promise<CallOutcome> => {
      try {
        return {
          ok: true,
          result: await client.callTool({
            name: 'relay_prompt',
            arguments: { sourceId, targetId, prompt }
          })
        }
      } catch (e: unknown) {
        return { ok: false, threw: String(e), code: (e as { code?: number })?.code }
      }
    },
    close: () => client.close()
  }
}

/** Concatenated text of a callTool result's content blocks. */
function resultText(r: unknown): string {
  const content = (r as { content?: Array<{ text?: string }> })?.content
  return Array.isArray(content) ? content.map((c) => c?.text ?? '').join(' ') : ''
}

function isErrorResult(r: unknown): boolean {
  return (r as { isError?: boolean })?.isError === true
}

/**
 * Live test against the REAL running Canvas ADE: the MCP server is already mounted
 * in app.whenReady. Connect two clients (orchestrator + worker tokens) over
 * loopback and assert the tier split holds in the real process. Returns an exit
 * code (0 = pass). Mirrors e2eSmoke's run/exit contract.
 *
 * The denial check is SPECIFIC on purpose: a worker calling an unregistered tool
 * gets an isError result whose text is "Tool orchestrator_ping not found"
 * (McpError -32602). A dropped/unknown HTTP session ALSO yields a generic "Session
 * not found" (-32001), so a loose substring match would let broken wiring pass for
 * the wrong reason. We require the exact tool-not-found result AND treat any thrown
 * transport error as a smoke failure.
 */
export async function runMcpSmoke(mcp: RunningMcp | null, win: BrowserWindow): Promise<number> {
  if (!mcp) {
    log('MCP_FAIL server-not-mounted')
    return 1
  }
  const url = `http://127.0.0.1:${mcp.port}/mcp`
  let code = 0
  try {
    const workerToken = mcp.mintWorkerToken('smoke-worker')
    const orch = await connect(url, mcp.orchestratorToken)
    const worker = await connect(url, workerToken)

    // tools/list: orchestrator sees the orchestrator tool, worker does not.
    const orchHas = orch.list.includes('orchestrator_ping')
    const workerHas = worker.list.includes('orchestrator_ping')
    if (orchHas && !workerHas) log('MCP_LIST_OK')
    else {
      log(`MCP_FAIL list orch=${orchHas} worker=${workerHas}`)
      code = 1
    }

    // tools/call: orchestrator gets a real pong; worker gets the SPECIFIC
    // tool-not-found isError result (not a transport error, not a generic miss).
    const orchCall = await orch.pingOrchestrator()
    const workerCall = await worker.pingOrchestrator()

    const orchPong = orchCall.ok && resultText(orchCall.result).includes('orchestrator-pong')
    if (!orchPong) {
      log(`MCP_FAIL orchestrator call: ${JSON.stringify(orchCall)}`)
      code = 1
    }

    const workerDenied =
      workerCall.ok &&
      isErrorResult(workerCall.result) &&
      resultText(workerCall.result).includes('Tool orchestrator_ping not found')
    if (!workerDenied) {
      log(`MCP_FAIL worker call (expected tool-not-found denial): ${JSON.stringify(workerCall)}`)
      code = 1
    }

    if (orchPong && workerDenied) log('MCP_TIER_OK')

    // ── all-board-types listBoards: seed one of each type through the renderer hook,
    // then poll canvas://boards (the orchestrator's resource) until the mirror has
    // propagated all three. The hook installs after React mounts (?e2e=1 seedHarness). ──
    const evalIn = <T>(expr: string): Promise<T> =>
      win.webContents.executeJavaScript(expr, true) as Promise<T>
    const hookReady = await poll(() => evalIn<boolean>('!!window.__canvasE2E'), 8000)
    if (!hookReady) {
      log('MCP_FAIL no-seed-hook')
      code = 1
    } else {
      await evalIn("window.__canvasE2E.seedBoard('terminal')")
      await evalIn("window.__canvasE2E.seedBoard('browser')")
      await evalIn("window.__canvasE2E.seedBoard('planning')")
      const want = ['terminal', 'browser', 'planning']
      let types: string[] = []
      const ok = await poll(async () => {
        types = await orch.readBoardTypes()
        return want.every((t) => types.includes(t))
      }, 8000)
      if (ok) log('MCP_BOARDS_OK')
      else {
        log(`MCP_FAIL boards types=${types.join(',')}`)
        code = 1
      }
    }

    // ── status buckets (T1.1): a terminal that goes running→idle must move the
    // board's `status` in canvas://boards through the SAME transition — proving the
    // renderer-derived bucket (terminalRuntimeStore) actually propagates to the
    // agent's view, not just that the resource returns *a* value. The board's own
    // lifecycle drives `running` (fitView guarantees it is measured → the PTY spawns);
    // we poll for that natural `running` FIRST so the spawn has settled, then force the
    // store down — after spawn-success the board emits no further state until exit, so
    // the forced `idle` is the last writer and can't be clobbered by a late spawn. ──
    if (hookReady) {
      const sid = await evalIn<string>("window.__canvasE2E.seedBoard('terminal')")
      await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(sid)})`)
      const ranRunning = await poll(
        async () => (await orch.readBoardStatus(sid)) === 'running',
        8000
      )
      await evalIn(`window.__canvasE2E.setTerminalDown(${JSON.stringify(sid)})`)
      const ranIdle = await poll(async () => (await orch.readBoardStatus(sid)) === 'idle', 8000)
      // Also assert the templated per-board resource (T1.1) agrees with the list: same
      // bucket, id echoed. Reads as the final resting state ('idle' after the down).
      const res = ranIdle ? await orch.readBoardStatusResource(sid) : null
      const resOk = res?.id === sid && res?.status === 'idle'
      if (ranRunning && ranIdle && resOk) log('MCP_STATUS_OK')
      else {
        log(`MCP_FAIL status running=${ranRunning} idle=${ranIdle} resource=${JSON.stringify(res)}`)
        code = 1
      }
    }

    // ── board-states roll-up (T1.2): the grouped view must stay consistent with
    // canvas://boards — every board appears under its own bucket, no extras, no
    // dupes. Self-activating: canvas://board-states only exists in pkg >=0.2.3, so on
    // the currently-installed pkg it 404s → SKIP (not a failure); the assertion turns
    // on automatically once 0.2.3 is published + consumed. ──
    const states = await orch.readBoardStates()
    if (states === null) {
      log('MCP_STATES_SKIP pkg<0.2.3-unpublished')
    } else {
      const boards = await orch.readBoards()
      const groupedIds = Object.values(states).flat()
      const consistent =
        boards.length === groupedIds.length && boards.every((b) => states[b.status]?.includes(b.id))
      if (consistent) log('MCP_STATES_OK')
      else {
        log(
          `MCP_FAIL board-states inconsistent boards=${boards.length} grouped=${groupedIds.length}`
        )
        code = 1
      }
    }

    // ── attention (T1.3): a board in an attention bucket (blocked/awaiting-review/
    // failed) must surface in canvas://attention. The reachable case TODAY is a
    // browser that fails to load → `failed` (blocked/awaiting-review get their emit
    // sites in M8). The bucket is observable now via canvas://boards (assert it
    // end-to-end through the real native preview); the canvas://attention resource is
    // self-activating (skip on pkg <0.2.4). ──
    if (hookReady) {
      const deadUrl = 'http://127.0.0.1:59999/' // nothing listens → connection refused
      const did = await evalIn<string>(
        `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(deadUrl)} })`
      )
      await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(did)})`)
      const failedOk = await poll(async () => (await orch.readBoardStatus(did)) === 'failed', 14000)
      if (!failedOk) {
        log('MCP_FAIL attention browser did not reach failed bucket')
        code = 1
      } else {
        const attention = await orch.readAttention()
        if (attention === null) {
          log('MCP_ATTENTION_SKIP pkg<0.2.4-unpublished')
        } else if (attention.some((b) => b.id === did && b.status === 'failed')) {
          log('MCP_ATTENTION_OK')
        } else {
          log(`MCP_FAIL attention missing failed board ids=${attention.map((b) => b.id).join(',')}`)
          code = 1
        }
      }
    }

    // ── output (T1.4 🔒): a board's scrollback is exposed capped + paginated +
    // ANSI-stripped. Seed the live ring PAST the 256 KB cap with known ANSI-wrapped
    // content via the MAIN-side debug seam (shell-agnostic + deterministic), then page
    // the resource tail→front: every page ≤ 25k (capped, never the raw buffer), no ESC
    // bytes survive (stripped), and the OLDEST page reports droppedOlder (the cap
    // discarded older output — honest truncation). Self-activating: SKIP on pkg without
    // the resource. ──
    if (hookReady) {
      const oid = await evalIn<string>("window.__canvasE2E.seedBoard('terminal')")
      await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(oid)})`)
      const live = await poll(async () => (await orch.readBoardStatus(oid)) === 'running', 8000)
      // ~71 chars/line, 9 of them ANSI; 5000 lines ≈ 355 KB raw > the 256 KB ring cap.
      const chunk = '\x1b[31m' + 'L'.repeat(60) + '\x1b[0m\n'
      const seeded = live && debugSeedOutput(oid, chunk.repeat(5000))
      const first = seeded ? await orch.readBoardOutput(oid) : null
      if (first === null) {
        log('MCP_OUTPUT_SKIP pkg<0.3.0-unpublished')
      } else {
        let cursor: number | undefined
        let pages = 0
        let capped = true
        let sawAnsi = false
        let droppedOlder = false
        let total = 0
        for (;;) {
          const pg = await orch.readBoardOutput(oid, cursor)
          if (pg === null) break
          pages++
          total = pg.total
          if (pg.returned > 25_000 || pg.text.length > 25_000) capped = false
          if (pg.text.includes('\x1b')) sawAnsi = true
          if (pg.droppedOlder) droppedOlder = true
          if (pg.nextCursor === undefined || pages > 50) break
          cursor = pg.nextCursor
        }
        const ok = pages >= 2 && capped && !sawAnsi && droppedOlder && total <= 262_144
        if (ok) log('MCP_OUTPUT_OK')
        else {
          log(
            `MCP_FAIL output seeded=${seeded} pages=${pages} capped=${capped} ansi=${sawAnsi} dropped=${droppedOlder} total=${total}`
          )
          code = 1
        }
      }
    }

    // ── result (T1.5): a board's structured last result is observable. v1 has no
    // writer until M4 write_result, so a fresh board reads the empty shell
    // {present:false}; after recording one (the M4 entry point, driven here), the
    // resource returns it structured (references, not raw logs). Self-activating: SKIP
    // on a pkg without the resource. ──
    if (hookReady) {
      const rid = await evalIn<string>("window.__canvasE2E.seedBoard('terminal')")
      const empty = await orch.readBoardResult(rid)
      if (empty === null) {
        log('MCP_RESULT_SKIP pkg<0.3.1-unpublished')
      } else {
        const emptyOk = empty.present === false
        recordBoardResult(rid, {
          present: true,
          status: 'success',
          summary: 'smoke result',
          refs: ['src/x.ts']
        })
        const filled = await orch.readBoardResult(rid)
        const filledOk =
          filled?.present === true &&
          filled.status === 'success' &&
          filled.summary === 'smoke result' &&
          Array.isArray(filled.refs) &&
          filled.refs[0] === 'src/x.ts'
        if (emptyOk && filledOk) log('MCP_RESULT_OK')
        else {
          log(`MCP_FAIL result empty=${emptyOk} filled=${JSON.stringify(filled)}`)
          code = 1
        }
      }
    }

    // ── memory (T1.7 🔒): canvas://memory + canvas://board/{id}/summary expose the
    // sibling Brain/Memory engine's .canvas/memory/ READ-ONLY (passive context). The
    // engine ships on a separate track, so the realistic state is ABSENT → the resource
    // must GRACEFULLY EMPTY ({present:false}), never error. Then, with a fixture written
    // under the MAIN dir seam, it serves the doc. Self-activating: SKIP without the pkg
    // resource. ──
    {
      const root = mkdtempSync(join(tmpdir(), 'canvas-mem-smoke-'))
      __setMemoryDirForTest(root) // empty dir → no .canvas/memory yet
      const emptyMem = await orch.readMemory()
      if (emptyMem === null) {
        __setMemoryDirForTest(null)
        rmSync(root, { recursive: true, force: true })
        log('MCP_MEMORY_SKIP pkg<0.3.2-unpublished')
      } else {
        const gracefulOk = emptyMem.present === false
        const memDir = join(root, '.canvas', 'memory')
        mkdirSync(memDir, { recursive: true })
        writeFileSync(join(memDir, 'MEMORY.md'), '# smoke memory', 'utf8')
        writeFileSync(join(memDir, 'board-memprobe.md'), 'memprobe summary', 'utf8')
        const served = await orch.readMemory()
        const sum = await orch.readSummaryDoc('memprobe')
        // 🔒 a traversal id must NOT escape the memory dir even with a fixture present.
        const traversal = await orch.readSummaryDoc('..%2f..%2fMEMORY')
        __setMemoryDirForTest(null)
        rmSync(root, { recursive: true, force: true })
        const servedOk =
          served?.present === true &&
          served.text.includes('smoke memory') &&
          sum?.present === true &&
          sum.text.includes('memprobe summary')
        const guardOk = traversal?.present === false
        if (gracefulOk && servedOk && guardOk) log('MCP_MEMORY_OK')
        else {
          log(
            `MCP_FAIL memory graceful=${gracefulOk} served=${JSON.stringify(served)} sum=${JSON.stringify(sum)} guard=${guardOk}`
          )
          code = 1
        }
      }
    }

    // ── MAIN→renderer command channel (T0.3): a `ping` must round-trip through the
    // renderer applier (useMcpCommands) and ack. Proves the inverse of the mirror. ──
    const ack = await sendMcpCommand(ipcMain, () => win, { type: 'ping' })
    if (ack.ok && ack.type === 'ping') log('MCP_COMMAND_OK')
    else {
      log(`MCP_FAIL command ${JSON.stringify(ack)}`)
      code = 1
    }

    // ── lifecycle spawn (T3.1, the first WRITE tool): the capability split is the
    // load-bearing safety guarantee — the orchestrator tier can spawn_board (and the
    // renderer actually creates the board, round-tripping the command channel), while a
    // worker tier is DENIED the tool SERVER-SIDE (registration, not prompt). Verified
    // against the real running app. Self-activating: SKIP on a pkg without spawn_board
    // (the published ^0.2.4 floor) so the gate stays green until 0.4.0 is published. ──
    if (hookReady) {
      const orchHasSpawn = orch.list.includes('spawn_board')
      if (!orchHasSpawn) {
        log('MCP_SPAWN_SKIP pkg<0.4.0-unpublished')
      } else {
        // 1) tier split: a worker's tools/list must NOT contain the write tool.
        const splitOk = !worker.list.includes('spawn_board')
        // 2) orchestrator spawns a terminal → the tool returns the new board id, and
        //    that board lands on the canvas (the command round-tripped to the renderer).
        const spawn = await orch.callSpawn('terminal')
        const spawnedId =
          spawn.ok && !isErrorResult(spawn.result) ? resultText(spawn.result).trim() : ''
        const onCanvas = spawnedId
          ? await poll(
              () =>
                evalIn<boolean>(
                  `!!window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(spawnedId)})`
                ),
              6000
            )
          : false
        // 3) worker DENIED: calling the unregistered write tool yields the SPECIFIC
        //    tool-not-found isError (not a transport error, not a generic miss).
        const workerSpawn = await worker.callSpawn('terminal')
        const workerDenied =
          workerSpawn.ok &&
          isErrorResult(workerSpawn.result) &&
          resultText(workerSpawn.result).includes('Tool spawn_board not found')
        if (splitOk && spawnedId && onCanvas && workerDenied) log('MCP_SPAWN_OK')
        else {
          log(
            `MCP_FAIL spawn split=${splitOk} id=${spawnedId} onCanvas=${onCanvas} workerDenied=${workerDenied}`
          )
          code = 1
        }

        // ── lifecycle configure (T3.3): the orchestrator changes the spawned board's
        // durable config (launchCommand) via the REAL configure_board tool → the change
        // lands on the board (asserted through the renderer, since the boards resource is
        // metadata-only); a worker tier is DENIED configure_board. Self-skips on a pkg
        // with spawn_board but not yet configure_board. ──
        if (spawnedId && orch.list.includes('configure_board')) {
          const cfgSplitOk = !worker.list.includes('configure_board')
          const cfg = await orch.callConfigure(spawnedId, { launchCommand: 'echo MCP_CFG' })
          const cfgAcked = cfg.ok && !isErrorResult(cfg.result)
          const cfgApplied = await poll(
            () =>
              evalIn<boolean>(
                `(window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(spawnedId)}) || {}).launchCommand === 'echo MCP_CFG'`
              ),
            6000
          )
          const workerCfg = await worker.callConfigure(spawnedId, { launchCommand: 'x' })
          const workerCfgDenied =
            workerCfg.ok &&
            isErrorResult(workerCfg.result) &&
            resultText(workerCfg.result).includes('Tool configure_board not found')
          if (cfgSplitOk && cfgAcked && cfgApplied && workerCfgDenied) log('MCP_CONFIGURE_OK')
          else {
            log(
              `MCP_FAIL configure split=${cfgSplitOk} acked=${cfgAcked} applied=${cfgApplied} workerDenied=${workerCfgDenied}`
            )
            code = 1
          }
        } else if (spawnedId) {
          log('MCP_CONFIGURE_SKIP pkg<0.4.2-unpublished')
        }

        // ── lifecycle close (T3.2): the orchestrator closes the spawned board via the
        // REAL close_board tool (graceful drain → removeBoard round-trip) → it leaves the
        // canvas; a worker tier is DENIED close_board (same server-side capability split).
        // This also restores the baseline (no store-hook cleanup needed). Self-activating:
        // SKIP on a pkg with spawn_board but not yet close_board (and still clean up). ──
        if (!orch.list.includes('close_board')) {
          if (spawnedId)
            await evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(spawnedId)})`)
          log('MCP_CLOSE_SKIP pkg<0.4.1-unpublished')
        } else {
          const closeSplitOk = !worker.list.includes('close_board')
          const close = spawnedId
            ? await orch.callClose(spawnedId)
            : { ok: false as const, threw: 'no-id' }
          const closeAcked = close.ok && !isErrorResult(close.result)
          const goneFromCanvas = spawnedId
            ? await poll(
                () =>
                  evalIn<boolean>(
                    `!window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(spawnedId)})`
                  ),
                6000
              )
            : false
          const workerClose = await worker.callClose(spawnedId || 'x')
          const workerCloseDenied =
            workerClose.ok &&
            isErrorResult(workerClose.result) &&
            resultText(workerClose.result).includes('Tool close_board not found')
          if (closeSplitOk && closeAcked && goneFromCanvas && workerCloseDenied) log('MCP_CLOSE_OK')
          else {
            log(
              `MCP_FAIL close split=${closeSplitOk} acked=${closeAcked} gone=${goneFromCanvas} workerDenied=${workerCloseDenied}`
            )
            code = 1
          }
        }

        // ── 🔒 concurrency cap (T3.4, the M3 gate): the orchestrator may spawn up to the
        // cap; the next spawn is REJECTED with a clear "cap" error (the tool surfaces the
        // adapter throw as an isError result). Nothing auto-spawns unbounded. Closing the
        // spawned boards restores the baseline. ──
        const capIds: string[] = []
        let capRejected = false
        for (let i = 0; i < 8; i++) {
          const r = await orch.callSpawn('terminal')
          const rid = r.ok && !isErrorResult(r.result) ? resultText(r.result).trim() : ''
          if (rid) capIds.push(rid)
          else if (r.ok && isErrorResult(r.result) && /cap/i.test(resultText(r.result))) {
            capRejected = true
            break
          } else break // unexpected — fall through to the failure log
        }
        for (const id of capIds) await orch.callClose(id)
        if (capRejected && capIds.length >= 1) log('MCP_CAP_OK')
        else {
          log(`MCP_FAIL cap rejected=${capRejected} spawned=${capIds.length}`)
          code = 1
        }

        // ── 🔒 idle-reaping (T3.4): a spawned board left idle past the TTL is reaped.
        // Only runs when a short TTL is injected (CANVAS_MCP_IDLE_TTL_MS) so the normal
        // gate stays fast; otherwise SKIP. Drives the sweep explicitly via mcp.reapIdle. ──
        const ttl = Number(process.env.CANVAS_MCP_IDLE_TTL_MS)
        if (mcp && ttl && ttl < 5_000) {
          const r = await orch.callSpawn('terminal')
          const rid = r.ok && !isErrorResult(r.result) ? resultText(r.result).trim() : ''
          await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(rid)})`)
          // Wait for the board to mount + its PTY to come up (status running) BEFORE
          // forcing it down — setTerminalDown is a no-op until the runtime registers
          // (same ordering the T1.1 status block relies on).
          const ranRunning = await poll(
            async () => (await orch.readBoardStatus(rid)) === 'running',
            8000
          )
          await evalIn(`window.__canvasE2E.setTerminalDown(${JSON.stringify(rid)})`)
          const wentIdle =
            ranRunning &&
            (await poll(async () => (await orch.readBoardStatus(rid)) === 'idle', 8000))
          await mcp.reapIdle() // sweep 1: arm idleSince
          await delay(ttl + 600)
          const reaped = await mcp.reapIdle() // sweep 2: reap (idle span ≥ TTL)
          const gone = await poll(
            () =>
              evalIn<boolean>(
                `!window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(rid)})`
              ),
            4000
          )
          if (wentIdle && reaped.includes(rid) && gone) log('MCP_REAP_OK')
          else {
            log(`MCP_FAIL reap idle=${wentIdle} reaped=${JSON.stringify(reaped)} gone=${gone}`)
            code = 1
          }
        } else {
          log('MCP_REAP_SKIP set-CANVAS_MCP_IDLE_TTL_MS<5000-to-test')
        }

        // ── 🔒 dispatch handoff_prompt (T4.3, the M4 keystone): the orchestrator writes
        // a prompt into a TARGET TERMINAL's PTY — but ONLY through a single-use nonce +
        // a mandatory human confirm + an audit entry, and NEVER into a non-terminal.
        // A worker tier is DENIED the tool server-side. Self-activating: SKIP on a pkg
        // without handoff_prompt (the published ^0.2.4 floor) until 0.5.0 is published. ──
        if (!orch.list.includes('handoff_prompt')) {
          log('MCP_HANDOFF_SKIP pkg<0.5.0-unpublished')
        } else {
          const MODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
          const APPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`
          // 1) tier split: a worker's tools/list must NOT contain the dispatch tool.
          const hSplitOk = !worker.list.includes('handoff_prompt')
          // 2) worker DENIED server-side (specific tool-not-found isError, not a transport error).
          const workerHandoff = await worker.callHandoff('any-id', 'echo x')
          const workerHandoffDenied =
            workerHandoff.ok &&
            isErrorResult(workerHandoff.result) &&
            resultText(workerHandoff.result).includes('Tool handoff_prompt not found')
          // 3) 🔒 non-terminal target rejected BEFORE any write / confirm: Browser content
          //    must never reach a PTY. Spawn a browser, target it → isError, NO modal.
          const bSpawn = await orch.callSpawn('browser')
          const bId =
            bSpawn.ok && !isErrorResult(bSpawn.result) ? resultText(bSpawn.result).trim() : ''
          const nonTerm = bId
            ? await orch.callHandoff(bId, 'echo x')
            : { ok: false as const, threw: 'no-id' }
          const nonTermRejected = nonTerm.ok && isErrorResult(nonTerm.result)
          // 4) 🔒 label-targeting rejected for free: a TITLE is not an opaque id → not found.
          const labelTargeted = await orch.callHandoff('Terminal', 'echo x')
          const labelRejected = labelTargeted.ok && isErrorResult(labelTargeted.result)
          // 5) happy path: spawn a terminal, hand off an echo sentinel, DRIVE the confirm
          //    modal (no human in the smoke), and assert the text lands in the PTY. The
          //    interim await-idle polls until the board leaves `running`; a live shell
          //    never does, so we flip it idle via the e2e hook (M5 brings real attention).
          const tSpawn = await orch.callSpawn('terminal')
          const tId =
            tSpawn.ok && !isErrorResult(tSpawn.result) ? resultText(tSpawn.result).trim() : ''
          let landed = false
          let handoffOk = false
          let modalShown = false
          if (tId) {
            await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(tId)})`)
            await poll(async () => (await orch.readBoardStatus(tId)) === 'running', 8000)
            const sentinel = 'CANVAS_MCP_HANDOFF_OK'
            const handoffP = orch.callHandoff(tId, `echo ${sentinel}`)
            // The dispatch BLOCKS on the human gate — drive our trusted modal like a user.
            modalShown = await poll(() => evalIn<boolean>(MODAL), 8000)
            if (modalShown) await evalIn(APPROVE)
            // Flip the terminal idle so the bounded await-idle poll returns promptly (the
            // write already happened; the echo output still lands in the framebuffer).
            await evalIn(`window.__canvasE2E.setTerminalDown(${JSON.stringify(tId)})`)
            const handoff = await handoffP
            handoffOk = handoff.ok && !isErrorResult(handoff.result)
            landed = await poll(async () => {
              const text = await evalIn<string | null>(
                `window.__canvasE2E.readTerminal(${JSON.stringify(tId)})`
              )
              return typeof text === 'string' && text.includes(sentinel)
            }, 10000)
          }
          // 6) 🔒 single-use-nonce replay invariant (in-process security unit): a nonce
          //    consumes true exactly once, then false — replay can never re-authorize a write.
          const g = createDispatchGuard()
          const { nonce } = g.issue()
          const replayRejected = g.consume(nonce) === true && g.consume(nonce) === false
          // cleanup the boards we spawned (free the cap budget; the process exits anyway).
          if (tId) await orch.callClose(tId)
          if (bId) await orch.callClose(bId)
          if (
            hSplitOk &&
            workerHandoffDenied &&
            nonTermRejected &&
            labelRejected &&
            modalShown &&
            handoffOk &&
            landed &&
            replayRejected
          )
            log('MCP_HANDOFF_OK')
          else {
            log(
              `MCP_FAIL handoff split=${hSplitOk} workerDenied=${workerHandoffDenied} nonTerm=${nonTermRejected} label=${labelRejected} modal=${modalShown} ok=${handoffOk} landed=${landed} replay=${replayRejected}`
            )
            code = 1
          }
        }

        // ── 🔒 dispatch assign_prompt (T4.4, FIRE-AND-FORGET): the orchestrator writes a
        // prompt into a TARGET TERMINAL's PTY — gated by a single-use nonce + a mandatory
        // human confirm + an audit entry, terminal-only — and RETURNS the moment the write
        // lands (no await-idle, unlike handoff). A worker tier is DENIED the tool
        // server-side. Self-activating: SKIP on a pkg without assign_prompt (until 0.6.0). ──
        if (!orch.list.includes('assign_prompt')) {
          log('MCP_ASSIGN_SKIP pkg<0.6.0-unpublished')
        } else {
          const AMODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
          const AAPPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`
          // 1) tier split: a worker's tools/list must NOT contain assign_prompt.
          const aSplitOk = !worker.list.includes('assign_prompt')
          // 2) worker DENIED server-side (specific tool-not-found isError).
          const workerAssign = await worker.callAssign('any-id', 'echo x')
          const workerAssignDenied =
            workerAssign.ok &&
            isErrorResult(workerAssign.result) &&
            resultText(workerAssign.result).includes('Tool assign_prompt not found')
          // 3) 🔒 non-terminal target rejected BEFORE any write — Browser never reaches a PTY.
          const baSpawn = await orch.callSpawn('browser')
          const baId =
            baSpawn.ok && !isErrorResult(baSpawn.result) ? resultText(baSpawn.result).trim() : ''
          const aNonTerm = baId
            ? await orch.callAssign(baId, 'echo x')
            : { ok: false as const, threw: 'no-id' }
          const aNonTermRejected = aNonTerm.ok && isErrorResult(aNonTerm.result)
          // 4) happy path: spawn a terminal, assign an echo sentinel, DRIVE the confirm
          //    modal — and the call RESOLVES without flipping the board idle (fire-and-forget).
          const taSpawn = await orch.callSpawn('terminal')
          const taId =
            taSpawn.ok && !isErrorResult(taSpawn.result) ? resultText(taSpawn.result).trim() : ''
          let aLanded = false
          let assignOk = false
          let aModalShown = false
          if (taId) {
            await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(taId)})`)
            await poll(async () => (await orch.readBoardStatus(taId)) === 'running', 8000)
            const sentinel = 'CANVAS_MCP_ASSIGN_OK'
            const assignP = orch.callAssign(taId, `echo ${sentinel}`)
            aModalShown = await poll(() => evalIn<boolean>(AMODAL), 8000)
            if (aModalShown) await evalIn(AAPPROVE)
            // NO setTerminalDown: fire-and-forget resolves on its own once the write lands.
            const assign = await assignP
            assignOk = assign.ok && !isErrorResult(assign.result)
            aLanded = await poll(async () => {
              const text = await evalIn<string | null>(
                `window.__canvasE2E.readTerminal(${JSON.stringify(taId)})`
              )
              return typeof text === 'string' && text.includes(sentinel)
            }, 10000)
          }
          if (taId) await orch.callClose(taId)
          if (baId) await orch.callClose(baId)
          if (
            aSplitOk &&
            workerAssignDenied &&
            aNonTermRejected &&
            aModalShown &&
            assignOk &&
            aLanded
          )
            log('MCP_ASSIGN_OK')
          else {
            log(
              `MCP_FAIL assign split=${aSplitOk} workerDenied=${workerAssignDenied} nonTerm=${aNonTermRejected} modal=${aModalShown} ok=${assignOk} landed=${aLanded}`
            )
            code = 1
          }
        }

        // ── 🔒 write_result (T4.4, the FIRST worker-tier WRITE): a WORKER records its OWN
        // board's structured result (bound to its token board id, no client-supplied id)
        // → canvas://board/{id}/result reflects it. The tier split now cuts BOTH ways:
        // write_result is in BOTH tools/lists (orchestrator AND worker). The worker token
        // is bound to 'smoke-worker', so reading that board's result resource shows the
        // recorded fields. Self-activating: SKIP on a pkg without write_result (until 0.6.0). ──
        if (!worker.list.includes('write_result')) {
          log('MCP_WRITE_RESULT_SKIP pkg<0.6.0-unpublished')
        } else {
          const bothTiersHave =
            worker.list.includes('write_result') && orch.list.includes('write_result')
          const wr = await worker.callWriteResult({
            status: 'success',
            summary: 'smoke write_result',
            refs: ['src/y.ts']
          })
          const wrOk = wr.ok && !isErrorResult(wr.result)
          // The worker token is bound to boardId 'smoke-worker' → read its result resource.
          const reflected = await poll(async () => {
            const res = await orch.readBoardResult('smoke-worker')
            return (
              res?.present === true &&
              res.status === 'success' &&
              res.summary === 'smoke write_result' &&
              Array.isArray(res.refs) &&
              res.refs[0] === 'src/y.ts'
            )
          }, 4000)
          if (bothTiersHave && wrOk && reflected) log('MCP_WRITE_RESULT_OK')
          else {
            log(
              `MCP_FAIL write-result bothTiers=${bothTiersHave} ok=${wrOk} reflected=${reflected}`
            )
            code = 1
          }
        }

        // ── 🔒 dispatch interrupt (T4.5): the orchestrator sends Ctrl-C to a target
        // terminal's PTY — gated by a single-use nonce + a mandatory human confirm + an
        // audit entry, terminal-only. A worker tier is DENIED. A Ctrl-C has no echo to
        // read, so the happy path is verified via the audit trail (an `interrupt`
        // `dispatched` entry). Self-activating: SKIP on a pkg without interrupt (until 0.7.0). ──
        if (!orch.list.includes('interrupt')) {
          log('MCP_INTERRUPT_SKIP pkg<0.7.0-unpublished')
        } else {
          const IMODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
          const IAPPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`
          const iSplitOk = !worker.list.includes('interrupt')
          const workerInt = await worker.callInterrupt('any-id')
          const workerIntDenied =
            workerInt.ok &&
            isErrorResult(workerInt.result) &&
            resultText(workerInt.result).includes('Tool interrupt not found')
          // 🔒 non-terminal rejected before any write.
          const biSpawn = await orch.callSpawn('browser')
          const biId =
            biSpawn.ok && !isErrorResult(biSpawn.result) ? resultText(biSpawn.result).trim() : ''
          const iNonTerm = biId
            ? await orch.callInterrupt(biId)
            : { ok: false as const, threw: 'no-id' }
          const iNonTermRejected = iNonTerm.ok && isErrorResult(iNonTerm.result)
          // happy path: spawn a terminal, interrupt it, drive the confirm modal, assert the
          // call resolves AND an `interrupt`/`dispatched` audit entry is readable.
          const tiSpawn = await orch.callSpawn('terminal')
          const tiId =
            tiSpawn.ok && !isErrorResult(tiSpawn.result) ? resultText(tiSpawn.result).trim() : ''
          let iModalShown = false
          let interruptOk = false
          let iAudited = false
          if (tiId) {
            await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(tiId)})`)
            await poll(async () => (await orch.readBoardStatus(tiId)) === 'running', 8000)
            const intP = orch.callInterrupt(tiId)
            iModalShown = await poll(() => evalIn<boolean>(IMODAL), 8000)
            if (iModalShown) await evalIn(IAPPROVE)
            const intr = await intP
            interruptOk = intr.ok && !isErrorResult(intr.result)
            iAudited = await poll(
              () =>
                evalIn<boolean>(
                  `window.api.mcp.readAudit({ limit: 50 }).then((es) => es.some((e) =>` +
                    ` e.type === 'interrupt' && e.targetId === ${JSON.stringify(tiId)} && e.status === 'dispatched'))`
                ),
              4000
            )
          }
          if (tiId) await orch.callClose(tiId)
          if (biId) await orch.callClose(biId)
          if (
            iSplitOk &&
            workerIntDenied &&
            iNonTermRejected &&
            iModalShown &&
            interruptOk &&
            iAudited
          )
            log('MCP_INTERRUPT_OK')
          else {
            log(
              `MCP_FAIL interrupt split=${iSplitOk} workerDenied=${workerIntDenied} nonTerm=${iNonTermRejected} modal=${iModalShown} ok=${interruptOk} audited=${iAudited}`
            )
            code = 1
          }
        }

        // ── 🔒 agent-to-agent relay_prompt (T4.6, the M4 GATE): a dispatch A→B is
        // authorized by an ORCHESTRATION connector A→B — the spatial cable IS the route.
        // Spawn two terminals, draw the cable (the e2e hook, same store path as the real
        // gesture), wait for it to mirror to MAIN, then relay A→B and assert it lands in B;
        // a relay with no cable in that direction (B→A) is rejected. Worker DENIED.
        // Self-activating: SKIP on a pkg without relay_prompt (until 0.8.0). ──
        if (!orch.list.includes('relay_prompt')) {
          log('MCP_RELAY_SKIP pkg<0.8.0-unpublished')
        } else {
          const RMODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
          const RAPPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`
          const rSplitOk = !worker.list.includes('relay_prompt')
          const workerRelay = await worker.callRelay('a', 'b', 'echo x')
          const workerRelayDenied =
            workerRelay.ok &&
            isErrorResult(workerRelay.result) &&
            resultText(workerRelay.result).includes('Tool relay_prompt not found')
          // spawn A + B terminals.
          const raSpawn = await orch.callSpawn('terminal')
          const raId =
            raSpawn.ok && !isErrorResult(raSpawn.result) ? resultText(raSpawn.result).trim() : ''
          const rbSpawn = await orch.callSpawn('terminal')
          const rbId =
            rbSpawn.ok && !isErrorResult(rbSpawn.result) ? resultText(rbSpawn.result).trim() : ''
          let relayOk = false
          let rLanded = false
          let rModalShown = false
          let noCableRejected = false
          let cableMirrored = false
          if (raId && rbId) {
            await evalIn(`window.__canvasE2E.fitView(${JSON.stringify(rbId)})`)
            await poll(async () => (await orch.readBoardStatus(rbId)) === 'running', 8000)
            // Draw the orchestration cable A→B and wait for the MAIN mirror to carry it.
            await evalIn(
              `window.__canvasE2E.addConnector(${JSON.stringify(raId)}, ${JSON.stringify(rbId)}, 'orchestration')`
            )
            cableMirrored = await poll(
              async () =>
                listConnectors().some(
                  (c) => c.kind === 'orchestration' && c.sourceId === raId && c.targetId === rbId
                ),
              6000
            )
            // 🔒 no cable B→A → relay rejected (direction is the authorization).
            const noCable = await orch.callRelay(rbId, raId, 'echo nope')
            noCableRejected = noCable.ok && isErrorResult(noCable.result)
            // happy path: relay A→B → drive the confirm modal → text lands in B.
            const sentinel = 'CANVAS_MCP_RELAY_OK'
            const relayP = orch.callRelay(raId, rbId, `echo ${sentinel}`)
            rModalShown = await poll(() => evalIn<boolean>(RMODAL), 8000)
            if (rModalShown) await evalIn(RAPPROVE)
            const relay = await relayP
            relayOk = relay.ok && !isErrorResult(relay.result)
            rLanded = await poll(async () => {
              const text = await evalIn<string | null>(
                `window.__canvasE2E.readTerminal(${JSON.stringify(rbId)})`
              )
              return typeof text === 'string' && text.includes(sentinel)
            }, 10000)
          }
          if (raId) await orch.callClose(raId)
          if (rbId) await orch.callClose(rbId)
          if (
            rSplitOk &&
            workerRelayDenied &&
            cableMirrored &&
            noCableRejected &&
            rModalShown &&
            relayOk &&
            rLanded
          )
            log('MCP_RELAY_OK')
          else {
            log(
              `MCP_FAIL relay split=${rSplitOk} workerDenied=${workerRelayDenied} cable=${cableMirrored} noCableRej=${noCableRejected} modal=${rModalShown} ok=${relayOk} landed=${rLanded}`
            )
            code = 1
          }
        }
      }
    }

    await orch.close()
    await worker.close()
  } catch (err) {
    log(`MCP_FAIL ${(err as Error).message}`)
    code = 1
  }
  log('MCP_DONE')
  return code
}
