/**
 * `group_boards` / `edit_groups` / `canvas://contexts` over the REAL wire (`@expanse-ade/mcp` 0.27,
 * SPEC C6, D2): the package tool → `buildOrchestrator` → `mcpGroups`. Pins what the unit suite
 * cannot see — the package binding the caller's board on lead/connected calls, the per-row JSON the
 * agent reads back, and that the orchestrator tier pays the SAME batch confirm (D2: every tier).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { ConfirmBatchRequest } from './mcpConfirm'
import { startMcpToolsHarness, type McpTier, type McpToolsHarness } from './mcpToolsHarness'

describe('group tools over the wire', () => {
  const sent: McpCommand[] = []
  const requests: ConfirmBatchRequest[] = []
  const audits: Array<{ type: string; detail?: string }> = []
  let approve: boolean[] = []
  let h: McpToolsHarness

  beforeAll(async () => {
    h = await startMcpToolsHarness({
      registry: {
        listGroups: () => [{ id: 'g1', name: 'Workers', boardIds: ['t1', 't2'] }],
        confirmBatch: vi.fn(async (req: ConfirmBatchRequest) => {
          requests.push(req)
          return { decisions: req.items.map((_, k) => ({ approved: approve[k] === true })) }
        }),
        sendCommand: async (cmd: McpCommand): Promise<McpCommandAck> => {
          sent.push(cmd)
          const n = cmd.type === 'applyGroups' ? cmd.create.length : 0
          return {
            ok: true,
            type: cmd.type,
            groupIds: Array.from({ length: n }, (_, i) => `G${i}`)
          }
        },
        audit: async (input) => {
          audits.push(input)
        }
      }
    })
  })

  afterAll(async () => {
    await h?.close()
  })

  beforeEach(() => {
    sent.length = 0
    requests.length = 0
    audits.length = 0
    approve = []
  })

  async function call(tier: McpTier, name: string, args: Record<string, unknown>) {
    const s = await h.connect(tier)
    try {
      const r = await s.client.callTool({ name, arguments: args })
      const text = (r.content as Array<{ text: string }>)[0]?.text ?? ''
      return { isError: r.isError, body: JSON.parse(text) as unknown }
    } finally {
      await s.close()
    }
  }

  for (const tier of ['orchestrator', 'lead', 'connected'] as McpTier[]) {
    it(`${tier}: ONE batch confirm, ONE applyGroups with the approved row, per-row JSON back`, async () => {
      approve = [true, false]
      const r = await call(tier, 'group_boards', {
        groups: [
          { name: 'Pair', boardIds: ['t1', 't2'] },
          { name: 'Cards', boardIds: ['k1'] }
        ]
      })
      expect(r.isError).toBeFalsy()
      expect(r.body).toEqual([{ status: 'created', groupId: 'G0' }, { status: 'denied' }])
      expect(requests).toHaveLength(1)
      expect(sent).toEqual([
        { type: 'applyGroups', create: [{ name: 'Pair', boardIds: ['t1', 't2'] }], edits: [] }
      ])
      // lead / connected calls carry the token-bound board (t1 by default); the orchestrator none.
      const by = tier === 'orchestrator' ? 'by=orchestrator' : 'by=t1'
      expect(audits.map((a) => a.detail?.includes(by))).toEqual([true, true])
    })
  }

  it('edit_groups: an unknown group is rejected without a confirm; the rest is gated', async () => {
    approve = [true]
    const r = await call('connected', 'edit_groups', {
      ops: [
        { op: 'rename', groupId: 'nope', name: 'X' },
        { op: 'rename', groupId: 'g1', name: 'Worker pair' }
      ]
    })
    expect(r.body).toEqual([
      { status: 'rejected', detail: 'unknown group id: nope' },
      { status: 'applied' }
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0].items.map((i) => i.label)).toEqual(['Rename "Workers" → "Worker pair"'])
    expect(sent).toEqual([
      {
        type: 'applyGroups',
        create: [],
        edits: [{ op: 'rename', groupId: 'g1', name: 'Worker pair' }]
      }
    ])
  })

  it('canvas://contexts serves the v1 digest (read-only: no confirm, no command)', async () => {
    const s = await h.connect('lead')
    try {
      const res = await s.client.readResource({ uri: 'canvas://contexts' })
      const digest = JSON.parse((res.contents[0] as { text: string }).text) as {
        version: number
        contexts: Array<{ existingGroupId?: string }>
        ungrouped: string[]
      }
      expect(digest.version).toBe(1)
      expect(digest.contexts.map((c) => c.existingGroupId)).toEqual(['g1'])
      expect(digest.ungrouped).toEqual(['k1'])
    } finally {
      await s.close()
    }
    expect(requests).toEqual([])
    expect(sent).toEqual([])
  })
})
