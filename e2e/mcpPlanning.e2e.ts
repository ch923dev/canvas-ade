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
 * it. It requires `@expanse-ade/mcp` ≥ 0.11.0 (the version that ships the tool), which the app
 * now pins — so its absence is a real regression, asserted (not skipped).
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

/** Planning-board layout probe (@planning): note rects (real w/h) + the x of every other element,
 *  plus the diagram rect (2c footprint) — to assert the masonry spreads across columns, that no two
 *  notes overlap, and that an agent diagram materializes at its orientation-aware footprint. */
function planningLayout(
  page: Page,
  id: string
): Promise<{
  noteRects: Array<{ x: number; y: number; w: number; h: number }>
  otherXs: number[]
  diagramRects: Array<{ x: number; y: number; w: number; h: number }>
}> {
  return page.evaluate((boardId) => {
    const hook = (
      globalThis as unknown as {
        __canvasE2E: {
          getBoards(): Array<{
            id: string
            type: string
            elements?: Array<{ kind: string; x: number; y: number; w?: number; h?: number }>
          }>
        }
      }
    ).__canvasE2E
    const els = hook.getBoards().find((x) => x.id === boardId)?.elements ?? []
    const rect = (e: {
      x: number
      y: number
      w?: number
      h?: number
    }): {
      x: number
      y: number
      w: number
      h: number
    } => ({ x: e.x, y: e.y, w: e.w ?? 0, h: e.h ?? 0 })
    return {
      noteRects: els.filter((e) => e.kind === 'note').map(rect),
      otherXs: els.filter((e) => e.kind !== 'note').map((e) => e.x),
      diagramRects: els.filter((e) => e.kind === 'diagram').map(rect)
    }
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
    // The orchestrator MUST see the tool (pkg ≥ 0.11.0 + the CANVAS_E2E flag) — absence is a
    // real regression, asserted here.
    expect(mcp.orch.tools).toContain(TOOL)
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

    // APPROVE path: write a LONG prose note + a checklist + a note + a Mermaid diagram; drive the
    // modal; assert they land. The long note exercises the content-height estimate (the bug class:
    // a tall note overlapping the card beneath it). The diagram proves the v0.12.0
    // add_planning_elements `diagram` kind end-to-end (real schema → confirm → DiagramElement).
    //
    // 2a: every element carries a `section` so the host lays out AGENT-DECLARED COLUMNS, not the
    // height-balanced masonry. First-appearance order Overview → Build = two columns: the two
    // `Overview` notes stack in column 0, the `Build` checklist + diagram stack in column 1. This
    // proves `section` survives the wire (requires @expanse-ade/mcp ≥ 0.16.0, which the app pins).
    const longNote =
      'CANVAS_MCP_PLANNING_OK\n\nThis planning note is deliberately long so the column layout must ' +
      'estimate its wrapped height from the text — the cards beneath it must NOT overlap it: ' +
      'alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota, kappa, lambda, mu, nu, xi.'
    const writeP = mcp.orch.call(TOOL, {
      boardId: planId,
      elements: [
        { kind: 'note', text: longNote, tint: 'blue', section: 'Overview' },
        {
          kind: 'checklist',
          title: 'Auth refactor',
          section: 'Build',
          items: [
            { label: 'Audit current session mw', done: true },
            { label: 'Wire confirm gate', done: false }
          ]
        },
        { kind: 'note', text: 'second note', tint: 'green', section: 'Overview' },
        { kind: 'diagram', source: 'graph TD\n  A[Plan]-->B[Build]', section: 'Build' }
      ]
    })
    expect(await pollEval(page, MODAL, 8000)).toBe(true)
    // The confirm body shows the FULL content (not a bare count) — the security premise. Includes
    // the Mermaid source so the human sees what the diagram will render before approving.
    const bodyShowsContent = await evalIn<boolean>(
      page,
      `(() => { const m = document.querySelector('[data-testid="confirm-modal"]'); return !!m && m.textContent.includes('CANVAS_MCP_PLANNING_OK') && m.textContent.includes('Wire confirm gate') && m.textContent.includes('graph TD') })()`
    )
    expect(bodyShowsContent).toBe(true)
    await evalIn(page, APPROVE)
    expect(acked(await writeP)).toBe(true)
    await expect
      .poll(() => planningElementKinds(page, planId), { timeout: 8000 })
      .toEqual(['note', 'checklist', 'note', 'diagram'])

    // SECTIONED layout (2a): the batch lands across exactly two AGENT-DECLARED columns. Both
    // `Overview` notes share ONE column (same x, stacked) and both `Build` elements (checklist +
    // diagram) share the NEXT column to the right — deterministic grouping, NOT height-balancing
    // (under the old masonry the two same-section notes would scatter into different columns).
    const layout = await planningLayout(page, planId)
    const noteXs = new Set(layout.noteRects.map((r) => r.x))
    expect(noteXs.size).toBe(1) // both Overview notes in one column
    const otherXs = new Set(layout.otherXs)
    expect(otherXs.size).toBe(1) // checklist + diagram in one column
    expect(layout.otherXs[0]).toBeGreaterThan(layout.noteRects[0].x) // Build column right of Overview
    // No two notes overlap (notes carry a real w/h; the tall note is positioned by its estimate).
    for (let i = 0; i < layout.noteRects.length; i++) {
      for (let j = i + 1; j < layout.noteRects.length; j++) {
        const a = layout.noteRects[i]
        const b = layout.noteRects[j]
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlap).toBe(false)
      }
    }
    // 2c: the `graph TD` diagram materializes at the orientation-aware TALL (portrait) footprint —
    // bigger than the legacy fixed 280×200 and taller than wide (the host honored the source's
    // vertical layout). Proves the footprint path end-to-end through the real MCP write → element.
    expect(layout.diagramRects).toHaveLength(1)
    const dia = layout.diagramRects[0]
    expect(dia.w).toBeGreaterThan(280)
    expect(dia.h).toBeGreaterThan(200)
    expect(dia.h).toBeGreaterThan(dia.w) // portrait, since the source is `graph TD` (vertical)
    // Frame the planning board + let the cards measure/grow, then capture a visual of the columns.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await page.waitForTimeout(700)
    await page.screenshot({ path: 'test-results/planning-mcp-sections.png' })
  })
})
