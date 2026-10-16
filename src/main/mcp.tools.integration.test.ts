/**
 * tools/list MEMBERSHIP over the real wire, per tier (`./mcpToolsHarness`).
 *
 * The P1 this pins: `publish_findings` was absent from EVERY tier since PR #400. MAIN wired
 * `registry.publishFindings` (mcpBoot.ts), but `buildOrchestrator` never forwarded it, and the
 * package registers the tool only when `typeof orchestrator.publishFindings === 'function'` — so
 * nothing failed, nothing logged, the tool just was not there. Every lower tier missed it: the type
 * is optional, the human IPC button path does not touch the orchestrator, and the package's drift
 * guard runs against its own MockOrchestrator. Only a tools/list against the HOST orchestrator can
 * see the class, so that is what this asserts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FindingsPublishResult } from './findingsPublish'
import {
  expectTools,
  listToolsForTier,
  startMcpToolsHarness,
  type McpTier,
  type McpToolsHarness
} from './mcpToolsHarness'

const PUBLISH = 'publish_findings'

const published: FindingsPublishResult = {
  ok: true,
  published: 2,
  summary: 'published 2 cards · 2 workers reported',
  outcome: 'published'
}

describe('publish_findings tools/list membership (P4 wiring)', () => {
  const publishFindings = vi.fn(async (): Promise<FindingsPublishResult> => published)
  let h: McpToolsHarness

  beforeAll(async () => {
    h = await startMcpToolsHarness({ registry: { publishFindings } })
  })

  afterAll(async () => {
    await h?.close()
  })

  it('🔒 planningWrite ON: present for orchestrator + lead, absent for connected + worker', async () => {
    const byTier = await h.toolsByTier({ planningWrite: true })
    expectTools(byTier.orchestrator, { present: [PUBLISH] }, 'orchestrator + planningWrite')
    expectTools(byTier.lead, { present: [PUBLISH] }, 'lead + planningWrite')
    expectTools(byTier.connected, { absent: [PUBLISH] }, 'connected + planningWrite')
    expectTools(byTier.worker, { absent: [PUBLISH] }, 'worker + planningWrite')
    // Non-vacuity: the flag really was on for the connected session (it gets the OTHER planning
    // writes), so its missing publish_findings is the tier split, not a dead gate.
    expectTools(byTier.connected, { present: ['add_card'] }, 'connected sees the flag')
    expectTools(byTier.worker, { present: ['write_result'], absent: ['add_card'] }, 'worker')
  })

  it('🔒 planningWrite OFF: absent from every tier (a durable plan surface is flag-gated, ADR 0003)', async () => {
    const byTier = await h.toolsByTier({ planningWrite: false })
    for (const tier of Object.keys(byTier) as McpTier[]) {
      expectTools(byTier[tier], { present: ['ping'], absent: [PUBLISH] }, `${tier} flag off`)
    }
  })

  it('a wire call from the orchestrator tier delegates to the registry and relays the summary', async () => {
    publishFindings.mockClear()
    const s = await h.connect('orchestrator', { planningWrite: true })
    try {
      const r = await s.client.callTool({
        name: PUBLISH,
        arguments: { boardId: 'k1', lane: 'review' }
      })
      expect(publishFindings).toHaveBeenCalledWith('k1', { lane: 'review' })
      expect(r.isError).toBeFalsy()
      expect(r.content).toEqual([{ type: 'text', text: published.summary }])
    } finally {
      await s.close()
    }
  })

  it('a refused publish surfaces as a tool ERROR, never as a success', async () => {
    publishFindings.mockResolvedValueOnce({
      ok: false,
      published: 0,
      summary: 'board k1 is a planning, not a kanban',
      outcome: 'refused'
    })
    const s = await h.connect('lead', { planningWrite: true })
    try {
      const r = await s.client.callTool({ name: PUBLISH, arguments: { boardId: 'k1' } })
      expect(publishFindings).toHaveBeenLastCalledWith('k1', undefined)
      expect(r.isError).toBe(true)
      expect(r.content).toEqual([{ type: 'text', text: 'board k1 is a planning, not a kanban' }])
    } finally {
      await s.close()
    }
  })
})

describe('publish_findings on a host that does NOT wire it', () => {
  it('🔒 stays out of tools/list even with planningWrite on — presence of the method IS the gate', async () => {
    const names = await listToolsForTier('orchestrator', { planningWrite: true })
    expectTools(names, { present: ['add_card'], absent: [PUBLISH] }, 'unwired orchestrator')
  })
})
