import { ipcMain, type BrowserWindow } from 'electron'
import type { RunningMcp } from './mcp'
import { sendMcpCommand } from './mcpCommand'

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
      if (ranRunning && ranIdle) log('MCP_STATUS_OK')
      else {
        log(`MCP_FAIL status running=${ranRunning} idle=${ranIdle}`)
        code = 1
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

    await orch.close()
    await worker.close()
  } catch (err) {
    log(`MCP_FAIL ${(err as Error).message}`)
    code = 1
  }
  log('MCP_DONE')
  return code
}
