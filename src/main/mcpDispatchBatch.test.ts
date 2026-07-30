/**
 * mcpDispatchBatch — the base-P5 all-consented skip on the batch modal. The pre-P5 behaviour
 * (validate → ONE modal → per-row independent gate) is covered end-to-end by the orchestrator
 * integration suites; this file pins the NEW branch: a round whose every valid row is
 * session-consented skips the modal, while a MIXED round still shows it for every row.
 */
import { describe, expect, it } from 'vitest'
import { createDispatchBatchMethod, type DispatchBatchDeps } from './mcpDispatchBatch'
import type { GatedWriteInput, GatedWriteResult } from './dispatchGate'

function makeDeps(over?: { consented?: (id: string) => boolean; confirmRows?: boolean }): {
  deps: DispatchBatchDeps
  gateRuns: GatedWriteInput[]
  modals: number[]
} {
  const gateRuns: GatedWriteInput[] = []
  const modals: number[] = []
  const deps: DispatchBatchDeps = {
    listBoards: () => [
      { id: 'w1', type: 'terminal', title: 'Rev A' },
      { id: 'w2', type: 'terminal', title: 'Rev B' }
    ],
    confirmBatch: async (req) => {
      modals.push(req.items.length)
      return { decisions: req.items.map(() => ({ approved: over?.confirmRows !== false })) }
    },
    runGatedWrite: async (d): Promise<GatedWriteResult> => {
      gateRuns.push(d)
      // Mirror the real gate: an omitted confirmOverride resolves via its own decision source
      // (session consent in the all-consented case); an override supplies the batch row's answer.
      if (d.confirmOverride) {
        const { approved } = await d.confirmOverride()
        if (!approved) throw new Error('assign_prompt: dispatch denied by the human gate')
      }
      return { safeText: d.text, nonce: 'n', seq: 1, delivery: 'ready' }
    },
    audit: async () => {},
    ...(over?.consented ? { isDispatchConsented: over.consented } : {})
  }
  return { deps, gateRuns, modals }
}

const items = [
  { boardId: 'w1', text: 'review the diff' },
  { boardId: 'w2', text: 'review the tests' }
]

describe('dispatchPrompts — session-consent batch skip (base P5)', () => {
  it('EVERY row consented → no batch modal; rows run the gate WITHOUT confirmOverride', async () => {
    const { deps, gateRuns, modals } = makeDeps({ consented: () => true })
    const results = await createDispatchBatchMethod(deps).dispatchPrompts(items)
    expect(modals).toEqual([]) // the modal never rendered
    expect(gateRuns).toHaveLength(2)
    // No override — the gate re-derives consent itself per row (BUG-021) and stamps the audit.
    expect(gateRuns.every((d) => d.confirmOverride === undefined)).toBe(true)
    expect(results.map((r) => r.status)).toEqual(['dispatched', 'dispatched'])
  })

  it('a MIXED round (one row unconsented) shows the full modal for every row', async () => {
    const { deps, gateRuns, modals } = makeDeps({ consented: (id) => id === 'w1' })
    const results = await createDispatchBatchMethod(deps).dispatchPrompts(items)
    expect(modals).toEqual([2]) // one modal, both rows
    expect(gateRuns.every((d) => d.confirmOverride !== undefined)).toBe(true)
    expect(results.map((r) => r.status)).toEqual(['dispatched', 'dispatched'])
  })

  it('no consent probe wired keeps the pre-P5 batch (modal always)', async () => {
    const { deps, modals } = makeDeps()
    await createDispatchBatchMethod(deps).dispatchPrompts(items)
    expect(modals).toEqual([2])
  })

  it('a denied row on the modal path still maps to denied, not rejected', async () => {
    const { deps } = makeDeps({ confirmRows: false })
    const results = await createDispatchBatchMethod(deps).dispatchPrompts(items)
    expect(results.map((r) => r.status)).toEqual(['denied', 'denied'])
  })
})
