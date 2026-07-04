import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ServerFactory, MockOrchestrator } from '@expanse-ade/mcp'
import type { Tier } from '@expanse-ade/mcp'
import { APP_TOOLS } from './appModel'

/**
 * F25 — the `APP_TOOLS` drift guard. `appModel.ts` hand-maintains `APP_TOOLS`, a static mirror of the
 * `@expanse-ade/mcp` tool registration. A package bump that adds or removes a tool can silently drift
 * the catalog (the file's own comment says "update the matching table here", but nothing ENFORCED it).
 *
 * This test builds a real server through the package's `ServerFactory` (exported for exactly this
 * purpose since 0.15.0) and asserts the set of tools the package actually registers for an
 * orchestrator session equals the set of names in `APP_TOOLS` — so the next package bump that touches
 * the tool surface fails the build here unless `APP_TOOLS` is updated in lockstep. It also anchors
 * C1's `canvas://app-model` resource as orchestrator-only.
 *
 * `planningWrite: true` is passed so `add_planning_elements` is registered — `APP_TOOLS` lists it
 * (the flag-gated planning write path), so the comparison is only exact with the flag on.
 */
async function connect(tier: Tier, planningWrite = true): Promise<Client> {
  const factory = new ServerFactory(new MockOrchestrator(), undefined, planningWrite)
  const { server } = factory.getServer({ tier, scopes: [], boardId: 'drift' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'app-tools-drift', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

/**
 * S6: tools the catalog lists AHEAD of the installed `@expanse-ade/mcp` — the two planning-edit tools
 * ship in the host (gate + apply + read) but only appear in `tools/list` once the rc.7 that REGISTERS
 * them is installed (the pin bump + install is the last-mile). Until then they are an INTENTIONAL,
 * enumerated catalog-only extra: the drift guard still forbids a silently-dropped registered tool and any
 * UNEXPECTED catalog extra, but tolerates exactly these. Once rc.7 is installed, `registered` includes
 * them and the extras set is empty — the guard tightens back to exact equality with no test change.
 */
const PENDING_TOOLS = new Set(['update_planning_element', 'remove_planning_element'])

describe('F25: APP_TOOLS drift guard — catalog matches @expanse-ade/mcp registration', () => {
  it('every registered tool is cataloged, and the only catalog extras are the pending rc.7 tools', async () => {
    const client = await connect('orchestrator')
    const registered = new Set((await client.listTools()).tools.map((t) => t.name))
    const cataloged = new Set(APP_TOOLS.map((t) => t.name))
    // (a) No registered tool is missing from the catalog (a silent drop is real drift).
    const missingFromCatalog = [...registered].filter((t) => !cataloged.has(t))
    expect(missingFromCatalog).toEqual([])
    // (b) Every catalog entry not (yet) registered is one of the enumerated pending rc.7 tools —
    //     never an unexpected stale/typo'd extra.
    const extraInCatalog = [...cataloged].filter((t) => !registered.has(t))
    expect(extraInCatalog.filter((t) => !PENDING_TOOLS.has(t))).toEqual([])
    await client.close()
  })

  it('spawn_group is registered (orchestrator) and cataloged with tier orchestrator', async () => {
    const client = await connect('orchestrator')
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('spawn_group')
    expect(APP_TOOLS.find((t) => t.name === 'spawn_group')?.tier).toBe('orchestrator')
    await client.close()
  })

  it('canvas://app-model (C1) is an orchestrator-only resource', async () => {
    const orch = await connect('orchestrator')
    const orchUris = (await orch.listResources()).resources.map((r) => r.uri)
    expect(orchUris).toContain('canvas://app-model')
    await orch.close()

    const worker = await connect('worker')
    const workerUris = (await worker.listResources()).resources.map((r) => r.uri)
    expect(workerUris).not.toContain('canvas://app-model')
    await worker.close()
  })
})
