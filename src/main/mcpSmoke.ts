import type { RunningMcp } from './mcp'

/** stdout marker (EPIPE-safe like index.ts's smokeLog). */
function log(line: string): void {
  try {
    console.log(line)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  }
}

/** Outcome of a callTool: a returned result, or a thrown transport/protocol error. */
type CallOutcome = { ok: true; result: unknown } | { ok: false; threw: string; code?: number }

interface SmokeClient {
  list: string[]
  pingOrchestrator(): Promise<CallOutcome>
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
export async function runMcpSmoke(mcp: RunningMcp | null): Promise<number> {
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

    await orch.close()
    await worker.close()
  } catch (err) {
    log(`MCP_FAIL ${(err as Error).message}`)
    code = 1
  }
  log('MCP_DONE')
  return code
}
