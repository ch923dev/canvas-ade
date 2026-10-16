import { describe, it, expect, vi } from 'vitest'
import type { BoardOutput, BoardResult, MemoryDoc } from '@expanse-ade/mcp'
import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
import type { AuditInput } from './auditLog'
import type { FindingsPublishOutcome, FindingsPublishResult } from './findingsPublish'

/**
 * P4 `publish_findings` — the orchestrator forward (`./mcpFindings`). The regression this pins:
 * PR #400 wired `publishFindings` onto the REGISTRY but `buildOrchestrator` never exposed it, and
 * the package registers the tool only when `typeof orchestrator.publishFindings === 'function'`
 * — so the tool was missing from every tier's tools/list. The over-the-wire proof (real package
 * server, per-tier tools/list) lives in `mcp.tools.integration.test.ts`; this suite pins the
 * presence rule, the arg delegation and the agent-path audit line.
 */

const EMPTY_OUTPUT: BoardOutput = { text: '', total: 0, returned: 0, droppedOlder: false }
const EMPTY_RESULT: BoardResult = { present: false }
const EMPTY_MEMORY: MemoryDoc = { present: false, text: '' }

interface Harness {
  registry: BoardRegistry
  audits: AuditInput[]
  confirms: number
}

function harness(publishFindings?: BoardRegistry['publishFindings']): Harness {
  const audits: AuditInput[] = []
  const h: Harness = {
    audits,
    confirms: 0,
    registry: {
      listBoards: () => [{ id: 'k1', type: 'kanban', title: 'Findings' }],
      listSessions: () => [],
      listConnectors: () => [],
      readOutput: () => EMPTY_OUTPUT,
      readResult: () => EMPTY_RESULT,
      readMemory: () => EMPTY_MEMORY,
      readSummary: () => EMPTY_MEMORY,
      drainPty: async () => {},
      writeToPty: () => true,
      recordResult: () => {},
      subscribeStatus: () => () => {},
      sendCommand: async (cmd) => ({ ok: true, type: cmd.type }),
      confirm: async () => {
        h.confirms++
        return { approved: true }
      },
      audit: async (input) => {
        audits.push(input)
      },
      ...(publishFindings ? { publishFindings } : {})
    }
  }
  return h
}

const result = (
  outcome: FindingsPublishOutcome,
  over: Partial<FindingsPublishResult> = {}
): FindingsPublishResult => ({
  ok: outcome !== 'refused' && outcome !== 'target-gone' && outcome !== 'write-failed',
  published: outcome === 'published' ? 2 : 0,
  summary: `summary:${outcome}`,
  outcome,
  ...over
})

describe('orchestrator publishFindings (P4 forward)', () => {
  it('🔒 is ABSENT (no key at all) when the registry does not wire it — the package then skips the tool', () => {
    const orch = buildOrchestrator(harness().registry)
    // Not merely undefined-valued: the package tests `typeof … === 'function'`, but a present key
    // would still leak into an `in`/spread probe, so the contract is "no key".
    expect('publishFindings' in orch).toBe(false)
    expect(orch.publishFindings).toBeUndefined()
  })

  it('is a function when the registry wires it (the P1: it used to be dropped here)', () => {
    const orch = buildOrchestrator(harness(async () => result('published')).registry)
    expect(typeof orch.publishFindings).toBe('function')
  })

  it('delegates boardId + opts through verbatim and returns the registry result unchanged', async () => {
    const publish = vi.fn(async () => result('published'))
    const orch = buildOrchestrator(harness(publish).registry)
    const r = await orch.publishFindings!('k1', { lane: 'review' })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith('k1', { lane: 'review' })
    expect(r).toEqual(result('published'))
  })

  it('forwards an absent opts as absent (the package passes undefined when no lane is given)', async () => {
    const publish = vi.fn(async () => result('published'))
    const orch = buildOrchestrator(harness(publish).registry)
    await orch.publishFindings!('k1')
    expect(publish).toHaveBeenCalledWith('k1', undefined)
  })

  it('works when invoked detached from the orchestrator (the package calls it via .call)', async () => {
    const publish = vi.fn(async () => result('published'))
    const orch = buildOrchestrator(harness(publish).registry)
    const detached = orch.publishFindings!
    await expect(detached.call({}, 'k1')).resolves.toMatchObject({ ok: true })
  })

  it('🔒 adds NO second confirm — the registry path owns the one confirmBatch modal', async () => {
    const h = harness(async () => result('published'))
    const orch = buildOrchestrator(h.registry)
    await orch.publishFindings!('k1')
    expect(h.confirms).toBe(0)
  })

  it.each<[FindingsPublishOutcome, string]>([
    ['published', 'applied'],
    ['declined', 'denied'],
    ['empty', 'rejected'],
    ['refused', 'rejected'],
    ['target-gone', 'rejected'],
    ['write-failed', 'failed']
  ])('🔒 audits outcome "%s" as %s (content-less, summary in detail)', async (outcome, status) => {
    const h = harness(async () => result(outcome))
    const orch = buildOrchestrator(h.registry)
    await orch.publishFindings!('k1')
    expect(h.audits).toEqual([
      {
        type: 'publish_findings',
        targetId: 'k1',
        prompt: '',
        nonce: '',
        status,
        detail: `summary:${outcome}`
      }
    ])
  })

  it('records the lane override in the audit detail', async () => {
    const h = harness(async () => result('published'))
    await buildOrchestrator(h.registry).publishFindings!('k1', { lane: 'review' })
    expect(h.audits[0].detail).toBe('summary:published · lane=review')
  })

  it('never audits an unknown outcome as the default `dispatched` — falls back coarsely', async () => {
    const landed = harness(async () => ({ ...result('published'), outcome: undefined as never }))
    await buildOrchestrator(landed.registry).publishFindings!('k1')
    expect(landed.audits[0].status).toBe('applied')
    const nothing = harness(async () => ({ ...result('empty'), outcome: undefined as never }))
    await buildOrchestrator(nothing.registry).publishFindings!('k1')
    expect(nothing.audits[0].status).toBe('rejected')
  })

  it('audits `failed` and re-throws when the registry publish itself throws', async () => {
    const h = harness(async () => {
      throw new Error('confirm channel gone')
    })
    await expect(buildOrchestrator(h.registry).publishFindings!('k1')).rejects.toThrow(
      'confirm channel gone'
    )
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({
      status: 'failed',
      detail: 'publish threw: confirm channel gone'
    })
  })

  it('🔒 a failed audit append AFTER a landed publish does NOT throw (a retry would duplicate cards)', async () => {
    const h = harness(async () => result('published'))
    h.registry.audit = async () => {
      throw new Error('disk full')
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(buildOrchestrator(h.registry).publishFindings!('k1')).resolves.toEqual(
        result('published')
      )
      expect(err).toHaveBeenCalledWith(expect.stringContaining('forensic gap'), expect.any(Error))
    } finally {
      err.mockRestore()
    }
  })
})
