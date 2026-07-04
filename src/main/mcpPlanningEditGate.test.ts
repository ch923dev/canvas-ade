import { describe, it, expect } from 'vitest'
import { createPlanningEditMethods, type PlanningEditGateDeps } from './mcpPlanningEditGate'
import type { McpCommand, McpCommandAck } from './mcpCommand'

/**
 * S6: the planning-element edit gate — resolve board + planning-check + resolve element by id + build
 * (validate against kind) + human-confirm + patchPlanningEdit + audit EVERY branch. No PTY / nonce (an
 * element is passive content, ADR 0003). This mirrors the kanban gate contract.
 */
function makeDeps(overrides: Partial<PlanningEditGateDeps> = {}): {
  deps: PlanningEditGateDeps
  sent: McpCommand[]
  audits: Array<{ status: string; type: string; detail?: string }>
} {
  const sent: McpCommand[] = []
  const audits: Array<{ status: string; type: string; detail?: string }> = []
  const deps: PlanningEditGateDeps = {
    listBoards: () => [
      {
        id: 'p1',
        type: 'planning',
        title: 'My plan',
        planning: {
          elements: [
            {
              id: 'c1',
              kind: 'checklist',
              title: 'Build progress',
              items: [{ id: 'i1', label: 'x', done: false }]
            },
            { id: 'n1', kind: 'note', text: 'Phase 1' }
          ]
        }
      },
      { id: 't1', type: 'terminal', title: 'Term' }
    ],
    confirm: async () => ({ approved: true }),
    sendCommand: async (cmd) => {
      sent.push(cmd)
      return { ok: true, type: cmd.type } as McpCommandAck
    },
    audit: async (input) => {
      audits.push({ status: input.status, type: input.type, detail: input.detail })
    },
    ...overrides
  }
  return { deps, sent, audits }
}

describe('createPlanningEditMethods — updatePlanningElement', () => {
  it('routes a valid checklist edit into a patchPlanningEdit command', async () => {
    const { deps, sent, audits } = makeDeps()
    const { updatePlanningElement } = createPlanningEditMethods(deps)
    await updatePlanningElement('p1', 'c1', { setItems: [{ id: 'i1', done: true }] })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'patchPlanningEdit',
      id: 'p1',
      op: {
        op: 'update',
        elementId: 'c1',
        kind: 'checklist',
        patch: { setItems: [{ id: 'i1', done: true }] }
      }
    })
    expect(audits.map((a) => a.status)).toEqual(['applied'])
  })

  it('rejects an unknown board (audit rejected, no command)', async () => {
    const { deps, sent, audits } = makeDeps()
    const { updatePlanningElement } = createPlanningEditMethods(deps)
    await expect(updatePlanningElement('nope', 'c1', { title: 'x' })).rejects.toThrow(
      /board not found/
    )
    expect(sent).toEqual([])
    expect(audits[0]?.status).toBe('rejected')
  })

  it('rejects a non-planning target', async () => {
    const { deps, sent } = makeDeps()
    const { updatePlanningElement } = createPlanningEditMethods(deps)
    await expect(updatePlanningElement('t1', 'c1', { title: 'x' })).rejects.toThrow(
      /not a planning board/
    )
    expect(sent).toEqual([])
  })

  it('rejects an unknown element id (agent must READ the board first)', async () => {
    const { deps, sent, audits } = makeDeps()
    const { updatePlanningElement } = createPlanningEditMethods(deps)
    await expect(updatePlanningElement('p1', 'ghost', { title: 'x' })).rejects.toThrow(
      /element not found/
    )
    expect(sent).toEqual([])
    expect(audits[0]?.detail).toContain('element not found')
  })

  it('rejects a patch field that does not apply to the element kind', async () => {
    const { deps, sent, audits } = makeDeps()
    const { updatePlanningElement } = createPlanningEditMethods(deps)
    // n1 is a note; `title` is a checklist-only field.
    await expect(updatePlanningElement('p1', 'n1', { title: 'x' })).rejects.toThrow()
    expect(sent).toEqual([])
    expect(audits[0]?.status).toBe('rejected')
  })

  it('throws + audits denied when the human declines (no command)', async () => {
    const { deps, sent, audits } = makeDeps({ confirm: async () => ({ approved: false }) })
    const { updatePlanningElement } = createPlanningEditMethods(deps)
    await expect(updatePlanningElement('p1', 'n1', { text: 'y' })).rejects.toThrow(
      /denied by the human gate/
    )
    expect(sent).toEqual([])
    expect(audits[0]?.status).toBe('denied')
  })

  it('throws + audits failed when the apply ack is false', async () => {
    const { deps, audits } = makeDeps({
      sendCommand: async () => ({ ok: false, error: 'boom' }) as McpCommandAck
    })
    const { updatePlanningElement } = createPlanningEditMethods(deps)
    await expect(updatePlanningElement('p1', 'n1', { text: 'y' })).rejects.toThrow(/failed: boom/)
    expect(audits.at(-1)?.status).toBe('failed')
  })
})

describe('createPlanningEditMethods — removePlanningElement', () => {
  it('sends a remove op after confirm and audits applied', async () => {
    const { deps, sent, audits } = makeDeps()
    const { removePlanningElement } = createPlanningEditMethods(deps)
    await removePlanningElement('p1', 'n1')
    expect(sent[0]).toMatchObject({
      type: 'patchPlanningEdit',
      id: 'p1',
      op: { op: 'remove', elementId: 'n1' }
    })
    expect(audits.map((a) => a.status)).toEqual(['applied'])
  })

  it('rejects removing an unknown element', async () => {
    const { deps, sent } = makeDeps()
    const { removePlanningElement } = createPlanningEditMethods(deps)
    await expect(removePlanningElement('p1', 'ghost')).rejects.toThrow(/element not found/)
    expect(sent).toEqual([])
  })
})
