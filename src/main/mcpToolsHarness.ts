/**
 * Test-only harness: which MCP tools does each TIER actually see over the wire?
 *
 * Boots the REAL host server (`startMcpServer` → the pinned `@expanse-ade/mcp` package's
 * `createMcpHttpServer`, fed the REAL `buildOrchestrator` output) on a stub {@link BoardRegistry},
 * mints a bearer for the requested tier through the host's own minting paths, connects a real MCP
 * client over streamable HTTP and returns what `tools/list` says. It exists because the package's
 * tool registration is CONDITIONAL on the host orchestrator — `registerPublishFindings` (and others)
 * return early when the method is missing — so a host-side wiring slip removes a tool with no type
 * error, no failing unit test and no log line. The package's own drift guard (`appModelDrift.test`)
 * runs against its `MockOrchestrator`, which implements everything, so it cannot see that class.
 * Only a tools/list against the host orchestrator can (the `publish_findings` P1, PR #400).
 *
 * Reuse it for any tier-membership assertion: `startMcpToolsHarness()` once per suite, then
 * `listTools(tier, { planningWrite })` / `toolsByTier(...)` + `expectTools(...)`; `connect(...)`
 * hands back the live client when a test also needs `callTool`.
 *
 * NOT production code: nothing under src/main/*.ts (non-test) may import this, so electron-vite
 * tree-shakes it out of the app bundle. Vitest ignores it (no `.test.` infix); it is only
 * typechecked under tsconfig.node (the `ipcTestHarness.ts` convention).
 */
import { expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import { startMcpServer, type RunningMcp } from './mcp'
import type { BoardRegistry } from './mcpOrchestrator'
import { mintTerminalToken } from './orchestration/seam'

/** Every capability tier the package's `ServerFactory` splits tools/list by. */
export type McpTier = 'orchestrator' | 'lead' | 'connected' | 'worker'
export const MCP_TIERS: readonly McpTier[] = ['orchestrator', 'lead', 'connected', 'worker']

export interface McpSessionOpts {
  /**
   * The host's `planningWrite` gate for THIS session (it is re-evaluated per session at
   * `initialize`). true ⇒ `CANVAS_MCP_PLANNING_WRITE=1` while the session initializes; false ⇒ the
   * opt-ins are cleared (incl. `CANVAS_E2E`, which force-enables it). Default false — the shipped
   * posture with no orchestration consent.
   */
  planningWrite?: boolean
  /**
   * The board the bearer binds to (worker / connected / lead). Must be a TERMINAL on the stub
   * registry for `lead` (the grant validates it). Default `'t1'`. The orchestrator tier is always
   * the app's `'app'` token.
   */
  boardId?: string
}

export interface McpSession {
  client: Client
  close(): Promise<void>
}

export interface McpToolsHarness {
  running: RunningMcp
  url: string
  /** A live, initialized client session for `tier` (close it, or let `harness.close()` reap it). */
  connect(tier: McpTier, opts?: McpSessionOpts): Promise<McpSession>
  /** The tool names a fresh `tier` session sees, sorted. */
  listTools(tier: McpTier, opts?: McpSessionOpts): Promise<string[]>
  /** {@link listTools} for every tier at once — one session per tier, same opts. */
  toolsByTier(opts?: Omit<McpSessionOpts, 'boardId'>): Promise<Record<McpTier, string[]>>
  close(): Promise<void>
}

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

/**
 * A minimal live-mirror fake: two terminals (`t1`, `t2`) + one kanban (`k1`); every command acks,
 * every confirm approves, audits are dropped. Spread `over` on top to wire optional registry
 * methods (e.g. `publishFindings`) or swap the board list — tool REGISTRATION keys off which
 * optional methods exist, so that is the lever a membership test pulls.
 */
export function stubRegistry(over: Partial<BoardRegistry> = {}): BoardRegistry {
  return {
    listBoards: () => [
      { id: 't1', type: 'terminal', title: 'Worker 1', status: 'idle' },
      { id: 't2', type: 'terminal', title: 'Worker 2', status: 'idle' },
      { id: 'k1', type: 'kanban', title: 'Findings' }
    ],
    listSessions: () => [],
    listConnectors: () => [],
    readOutput: () => EMPTY_OUTPUT,
    readResult: () => EMPTY_RESULT,
    readMemory: () => EMPTY_MEMORY,
    readSummary: () => EMPTY_MEMORY,
    sendCommand: async (cmd) => ({ ok: true, type: cmd.type }),
    drainPty: async () => {},
    writeToPty: () => true,
    confirm: async () => ({ approved: true }),
    audit: async () => {},
    recordResult: () => {},
    subscribeStatus: () => () => {},
    ...over
  }
}

/** Run `fn` with the planning-write env opt-ins forced to `on`, then restore them exactly. */
async function withPlanningWrite<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const keys = ['CANVAS_E2E', 'CANVAS_MCP_PLANNING_WRITE'] as const
  const saved = keys.map((k) => [k, process.env[k]] as const)
  // `process.env.X = undefined` would store the STRING "undefined" — delete instead.
  for (const k of keys) delete process.env[k]
  if (on) process.env.CANVAS_MCP_PLANNING_WRITE = '1'
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Mint a bearer for `tier` through the host's OWN paths (so the routing under test is the real one). */
function tokenFor(running: RunningMcp, tier: McpTier, boardId: string): string {
  switch (tier) {
    case 'orchestrator':
      return running.orchestratorToken
    case 'worker':
      return running.mintWorkerToken(boardId)
    case 'connected':
      return running.mintConnectedToken(boardId).token
    case 'lead': {
      // Single-active-lead: drop any prior designation so a suite can move the lead between boards,
      // grant it, then mint through the spawn-time seam — which routes the designated board to a
      // LEAD token (the production path; there is no direct lead minter on RunningMcp by design).
      running.revokeLead()
      const granted = running.grantLead(boardId)
      if (!granted.ok) throw new Error(`grantLead(${boardId}) refused: ${granted.reason}`)
      const minted = mintTerminalToken(boardId)
      if (minted.tier !== 'lead') throw new Error(`expected a lead token, got ${minted.tier}`)
      return minted.token
    }
  }
}

/** Start the real host MCP server on a stub registry. One per suite; `close()` it in `afterAll`. */
export async function startMcpToolsHarness(
  opts: { registry?: Partial<BoardRegistry> } = {}
): Promise<McpToolsHarness> {
  const started = await startMcpServer(stubRegistry(opts.registry))
  // A bind failure returns null (graceful degrade in prod) — in a test that would silently skip
  // every assertion, so fail loud.
  if (!started) throw new Error('startMcpServer returned null (bind/load failure)')
  const running = started
  const url = `http://127.0.0.1:${running.port}/mcp`
  const open: McpSession[] = []

  const connect = async (tier: McpTier, o: McpSessionOpts = {}): Promise<McpSession> => {
    const token = tokenFor(running, tier, o.boardId ?? 't1')
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
    const client = new Client({ name: 'mcp-tools-harness', version: '0.0.0' })
    // The package builds the per-session tool set at `initialize` — that is the moment the
    // planning-write gate is read, so only the connect needs the env forced.
    await withPlanningWrite(o.planningWrite ?? false, () => client.connect(transport))
    const session: McpSession = {
      client,
      close: async () => {
        const i = open.indexOf(session)
        if (i >= 0) open.splice(i, 1)
        await client.close()
      }
    }
    open.push(session)
    return session
  }

  const listTools = async (tier: McpTier, o: McpSessionOpts = {}): Promise<string[]> => {
    const s = await connect(tier, o)
    try {
      return (await s.client.listTools()).tools.map((t) => t.name).sort()
    } finally {
      await s.close()
    }
  }

  return {
    running,
    url,
    connect,
    listTools,
    async toolsByTier(o = {}) {
      const out = {} as Record<McpTier, string[]>
      for (const tier of MCP_TIERS) out[tier] = await listTools(tier, o)
      return out
    },
    async close() {
      for (const s of [...open]) await s.close().catch(() => {})
      await running.close()
    }
  }
}

/** One-shot {@link McpToolsHarness.listTools}: boot, list one tier, tear down. */
export async function listToolsForTier(
  tier: McpTier,
  opts: McpSessionOpts & { registry?: Partial<BoardRegistry> } = {}
): Promise<string[]> {
  const h = await startMcpToolsHarness({ registry: opts.registry })
  try {
    return await h.listTools(tier, opts)
  } finally {
    await h.close()
  }
}

/**
 * Assert tools/list membership with ONE readable diff: every `present` name is listed and no
 * `absent` name is. `label` names the case in the failure (e.g. `'lead + planningWrite'`).
 */
export function expectTools(
  names: readonly string[],
  spec: { present?: readonly string[]; absent?: readonly string[] },
  label = 'tools/list'
): void {
  const listed = new Set(names)
  const missing = (spec.present ?? []).filter((n) => !listed.has(n))
  const unexpected = (spec.absent ?? []).filter((n) => listed.has(n))
  expect({ missing, unexpected }, label).toEqual({ missing: [], unexpected: [] })
}
