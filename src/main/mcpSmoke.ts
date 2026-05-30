import type { RunningMcp } from './mcp'

/** stdout marker (EPIPE-safe like index.ts's smokeLog). */
function log(line: string): void {
  try {
    console.log(line)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err
  }
}

async function connect(
  url: string,
  token: string
): Promise<{ list: string[]; call: unknown; close: () => Promise<void> }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )
  const client = new Client({ name: 'mcp-smoke', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  await client.connect(transport)
  const list = (await client.listTools()).tools.map((t) => t.name)
  return {
    list,
    call: await client
      .callTool({ name: 'orchestrator_ping' })
      .catch((e: unknown) => ({ threw: String(e) })),
    close: () => client.close()
  }
}

/**
 * Live test against the REAL running Canvas ADE: the MCP server is already mounted
 * in app.whenReady. Connect two clients (orchestrator + worker tokens) over
 * loopback and assert the tier split holds in the real process. Returns an exit
 * code (0 = pass). Mirrors e2eSmoke's run/exit contract.
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

    const orchHas = orch.list.includes('orchestrator_ping')
    const workerHas = worker.list.includes('orchestrator_ping')
    if (orchHas && !workerHas) log('MCP_LIST_OK')
    else {
      log(`MCP_FAIL list orch=${orchHas} worker=${workerHas}`)
      code = 1
    }

    const orchPong = JSON.stringify(orch.call).includes('orchestrator-pong')
    const workerDenied = JSON.stringify(worker.call).toLowerCase().includes('not found')
    if (orchPong && workerDenied) log('MCP_TIER_OK')
    else {
      log(`MCP_FAIL tier orchPong=${orchPong} workerDenied=${workerDenied}`)
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
