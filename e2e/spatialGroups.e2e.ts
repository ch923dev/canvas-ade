import { test as base, expect } from './fixtures'
import { callE2E, evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * @mcp spatial I1 — `group_boards` against the REAL running app (SPEC C5–C7, D2, DESIGN W1).
 *
 * The one class no lower tier reproduces: an agent's call crossing the live loopback MCP server,
 * MAIN's ONE batch confirm reaching the real `BatchConfirmModal` through preload (with the W1
 * `preselected` starting state), the human's per-row answer, and the ONE `applyGroups` command the
 * renderer lands as ONE undo step. Row validation, audit and the edit ops are unit- and
 * integration-tested (`mcpGroups.test.ts`, `mcpGroups.integration.test.ts`,
 * `groupsMcpApply.integration.test.ts`); this spec proves the end-to-end round trip.
 *
 * Planning boards only: no PTY, no offscreen preview — nothing here needs a live process.
 */

type McpInfo = { port: number; orchestratorToken: string }
type Row = { status: string; groupId?: string; detail?: string }

interface OrchClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>
  readJson<T>(uri: string): Promise<T>
  close(): Promise<void>
}

async function connect(url: string, token: string): Promise<OrchClient> {
  // Dynamic import: the mcp.e2e.ts form (sidesteps Playwright-loader ESM/CJS interop).
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'spatial-groups-e2e', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return {
    // A confirm-gated call can outlive the SDK's 60 s default while a slow box renders the modal.
    call: (name, args) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 }),
    async readJson<T>(uri: string): Promise<T> {
      const res = await client.readResource({ uri })
      const text = res.contents.map((c) => ('text' in c ? String(c.text) : '')).join('')
      return JSON.parse(text) as T
    },
    close: () => client.close()
  }
}

const test = base.extend<{ orch: OrchClient }>({
  orch: async ({ electronApp }, use) => {
    const info = await mainCall<McpInfo | null>(electronApp, 'mcpInfo')
    if (!info) throw new Error('MCP server not mounted (mcpInfo returned null)')
    const orch = await connect(`http://127.0.0.1:${info.port}/mcp`, info.orchestratorToken)
    try {
      await use(orch)
    } finally {
      await orch.close().catch(() => {})
    }
  }
})

const MODAL = `!!document.querySelector('[data-testid="batch-confirm-modal"]')`
const rowChecked = (i: number): string =>
  `document.querySelector('[data-testid="batch-confirm-row-${i}"]')?.getAttribute('aria-checked')`
const click = (testId: string): string =>
  `(() => { const b = document.querySelector('[data-testid="${testId}"]'); if (b) b.click(); return !!b })()`

test.describe('@mcp spatial groups — group_boards round trip (live loopback)', () => {
  test('a batch with one denied row creates only the approved groups, and ONE undo removes them', async ({
    page,
    orch
  }) => {
    test.slow() // a real human-confirm round trip through the live modal
    const ids: string[] = []
    for (const title of ['Auth plan', 'Billing plan', 'API notes', 'Web notes']) {
      ids.push(await seed(page, 'planning', { title }))
    }
    const [p1, p2, p3, p4] = ids

    // The renderer mirror reaches MAIN on a ~150 ms debounce: wait until canvas://contexts sees
    // every board (all ungrouped — planning boards with no shared refs carry no context signal).
    await expect
      .poll(
        async () =>
          (await orch.readJson<{ ungrouped: string[] }>('canvas://contexts')).ungrouped.length,
        { timeout: 10_000 }
      )
      .toBe(4)

    // The call BLOCKS on the batch confirm: fire it, then answer the modal like a human.
    const pending = orch.call('group_boards', {
      groups: [
        { name: 'Auth', boardIds: [p1] },
        { name: 'Billing', boardIds: [p2] },
        // No link between these two ⇒ low confidence ⇒ the row starts UNCHECKED (W1).
        { name: 'Docs', boardIds: [p3, p4] }
      ]
    })
    expect(await pollEval(page, MODAL, 15_000)).toBe(true)
    expect(await evalIn<string>(page, rowChecked(0))).toBe('true')
    expect(await evalIn<string>(page, rowChecked(1))).toBe('true')
    expect(await evalIn<string>(page, rowChecked(2))).toBe('false')
    // Deny "Billing" (untick a preselected row) and opt "Docs" in.
    expect(await evalIn<boolean>(page, click('batch-confirm-row-1'))).toBe(true)
    expect(await evalIn<boolean>(page, click('batch-confirm-row-2'))).toBe(true)
    expect(
      await evalIn<string>(
        page,
        `document.querySelector('[data-testid="batch-confirm-approve"]')?.textContent`
      )
    ).toBe('Approve 2')
    expect(await evalIn<boolean>(page, click('batch-confirm-approve'))).toBe(true)

    const result = (await pending) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBeFalsy()
    const rows = JSON.parse(result.content[0].text) as Row[]
    expect(rows.map((r) => r.status)).toEqual(['created', 'denied', 'created'])

    // Only the approved groups exist, with the ids the tool returned.
    const groups = await callE2E<Array<{ id: string; name: string; boardIds: string[] }>>(page, {
      m: 'getGroups'
    })
    expect(groups.map((g) => ({ id: g.id, name: g.name, boardIds: g.boardIds }))).toEqual([
      { id: rows[0].groupId, name: 'Auth', boardIds: [p1] },
      { id: rows[2].groupId, name: 'Docs', boardIds: [p3, p4] }
    ])
    expect(await evalIn<boolean>(page, MODAL)).toBe(false)

    // ONE undo removes every group the batch created.
    await evalIn(page, 'window.__canvasE2E.undo()')
    expect(await pollEval(page, `window.__canvasE2E.getGroups().length === 0`, 3000)).toBe(true)
    // …and the boards themselves were never touched.
    expect(await evalIn<number>(page, `window.__canvasE2E.getBoards().length`)).toBe(4)
  })
})
