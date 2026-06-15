import { test as base, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @mcp @planning  S2 planning content-write path, against the REAL running app.
 *
 * An orchestrator-tier MCP client (over loopback, mirroring `mcp.e2e.ts`) writes structured
 * content (checklist + notes) to a planning board through the new `add_planning_elements`
 * tool — gated by the MAIN write-time human confirm. Asserts: the worker tier never sees the
 * tool; a non-planning target is rejected; APPROVE lands the content on the canvas; DENY
 * writes nothing.
 *
 * The tool is FLAG-GATED (ADR 0003); the e2e harness boots with CANVAS_E2E=1 so MAIN enables
 * it. It also requires the @expanse-ade/mcp version that ships the tool — publishing that
 * version is a separate follow-up, so when the INSTALLED package predates it the whole block
 * self-skips with a logged reason (never a silent pass). It runs fully once the package lands.
 */

type McpInfo = {
  port: number
  orchestratorToken: string
  workerToken: string
  workerBoardId: string
}
type CallOutcome = { ok: true; result: unknown } | { ok: false; threw: string }

interface McpClient {
  tools: string[]
  call(name: string, args?: Record<string, unknown>): Promise<CallOutcome>
  readJson<T>(uri: string): Promise<T>
  close(): Promise<void>
}

async function connect(url: string, token: string): Promise<McpClient> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'mcp-planning-e2e', version: '0.0.0' })
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
        return { ok: false, threw: String(e) }
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

function resultText(r: unknown): string {
  const content = (r as { content?: Array<{ text?: string }> })?.content
  return Array.isArray(content) ? content.map((c) => c?.text ?? '').join(' ') : ''
}
function isErrorResult(r: unknown): boolean {
  return (r as { isError?: boolean })?.isError === true
}
function acked(o: CallOutcome): boolean {
  return o.ok && !isErrorResult(o.result)
}
function rejected(o: CallOutcome): boolean {
  return o.ok && isErrorResult(o.result)
}
function deniedToolNotFound(o: CallOutcome, tool: string): boolean {
  return o.ok && isErrorResult(o.result) && resultText(o.result).includes(`Tool ${tool} not found`)
}

/** Planning-board element kinds (read through the renderer hook; structured-arg eval, #82). */
function planningElementKinds(page: Page, id: string): Promise<string[] | null> {
  return page.evaluate((boardId) => {
    const hook = (
      globalThis as unknown as {
        __canvasE2E: {
          getBoards(): Array<{ id: string; type: string; elements?: Array<{ kind: string }> }>
        }
      }
    ).__canvasE2E
    const b = hook.getBoards().find((x) => x.id === boardId)
    if (!b || b.type !== 'planning') return null
    return (b.elements ?? []).map((e) => e.kind)
  }, id)
}

const MODAL = `!!document.querySelector('[data-testid="confirm-modal"]')`
const APPROVE = `(() => { const b = document.querySelector('[data-testid="confirm-approve"]'); if (b) b.click(); return !!b })()`
const DENY = `(() => { const b = document.querySelector('[data-testid="confirm-deny"]'); if (b) b.click(); return !!b })()`

type McpPair = { info: McpInfo; orch: McpClient; worker: McpClient }

const test = base.extend<{ mcp: McpPair }>({
  mcp: async ({ electronApp }, use) => {
    const info = await mainCall<McpInfo | null>(electronApp, 'mcpInfo')
    if (!info) throw new Error('MCP server not mounted (mcpInfo returned null)')
    const url = `http://127.0.0.1:${info.port}/mcp`
    const orch = await connect(url, info.orchestratorToken)
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

const TOOL = 'add_planning_elements'

test.describe('@mcp @planning agent → planning content write (live loopback, confirm-gated)', () => {
  test('worker never sees the tool; orchestrator writes a checklist + notes only via the confirm gate; non-planning rejected; DENY writes nothing', async ({
    page,
    mcp
  }) => {
    test.slow() // real confirm modal + mirror propagation + canvas apply
    // The tool ships in a later @expanse-ade/mcp version (publish is a separate follow-up).
    // If the installed package predates it, skip the whole block WITH a logged reason — never
    // a silent pass. It exercises fully once the package lands.
    test.skip(
      !mcp.orch.tools.includes(TOOL),
      `${TOOL} not registered — installed @expanse-ade/mcp predates the S2 tool (publish pending)`
    )

    // Capability split: a worker tier must never even see the content-write tool.
    expect(mcp.worker.tools).not.toContain(TOOL)
    const workerCall = await mcp.worker.call(TOOL, {
      boardId: 'any',
      elements: [{ kind: 'note', text: 'x' }]
    })
    expect(deniedToolNotFound(workerCall, TOOL)).toBe(true)

    // SECURITY: a non-planning target is rejected BEFORE any confirm/write.
    const termId = await seed(page, 'terminal')
    await expect
      .poll(
        async () => {
          const boards = await mcp.orch.readJson<Array<{ id: string }>>('canvas://boards')
          return boards.some((b) => b.id === termId)
        },
        { timeout: 8000 }
      )
      .toBe(true)
    const nonPlanning = await mcp.orch.call(TOOL, {
      boardId: termId,
      elements: [{ kind: 'note', text: 'x' }]
    })
    expect(rejected(nonPlanning)).toBe(true)

    // Seed a planning board + wait for it to reach the MAIN mirror (the orchestrator resolves
    // the target from there).
    const planId = await seed(page, 'planning')
    await expect
      .poll(
        async () => {
          const boards =
            await mcp.orch.readJson<Array<{ id: string; type: string }>>('canvas://boards')
          return boards.some((b) => b.id === planId && b.type === 'planning')
        },
        { timeout: 8000 }
      )
      .toBe(true)
    expect(await planningElementKinds(page, planId)).toEqual([]) // empty to start

    // DENY path first: the call blocks on the human gate; click Deny → nothing is written.
    const denyP = mcp.orch.call(TOOL, {
      boardId: planId,
      elements: [{ kind: 'note', text: 'should not land', tint: 'yellow' }]
    })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    await evalIn(page, DENY)
    expect(rejected(await denyP)).toBe(true) // a denied write resolves as an isError result
    expect(await planningElementKinds(page, planId)).toEqual([]) // still empty

    // APPROVE path: write a checklist + two notes; drive the modal; assert they land.
    const writeP = mcp.orch.call(TOOL, {
      boardId: planId,
      elements: [
        { kind: 'note', text: 'CANVAS_MCP_PLANNING_OK', tint: 'blue' },
        {
          kind: 'checklist',
          title: 'Auth refactor',
          items: [
            { label: 'Audit current session mw', done: true },
            { label: 'Wire confirm gate', done: false }
          ]
        },
        { kind: 'note', text: 'second note', tint: 'green' }
      ]
    })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    // The confirm body shows the FULL content (not a bare count) — the security premise.
    const bodyShowsContent = await evalIn<boolean>(
      page,
      `(() => { const m = document.querySelector('[data-testid="confirm-modal"]'); return !!m && m.textContent.includes('CANVAS_MCP_PLANNING_OK') && m.textContent.includes('Wire confirm gate') })()`
    )
    expect(bodyShowsContent).toBe(true)
    await evalIn(page, APPROVE)
    expect(acked(await writeP)).toBe(true)
    await expect
      .poll(() => planningElementKinds(page, planId), { timeout: 8000 })
      .toEqual(['note', 'checklist', 'note'])
  })
})
