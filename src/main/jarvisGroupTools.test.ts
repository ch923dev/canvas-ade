/**
 * Spatial I1 — Jarvis's group tools (jarvisGroupTools.ts), driven through `executeJarvisTool` so
 * the catalog + executor wiring is exercised too. Pins the tiers (list_groups auto-allow, the
 * writes gated with NO Jarvis pre-confirm — the orchestrator's batch modal is the one confirm),
 * reference resolution (ambiguity asks), MAIN-side arg validation, the per-row outcome mapping,
 * and one pass through the REAL `createGroupsMethods` gate (one confirm, one command).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildJarvisToolDefs,
  executeJarvisTool,
  isJarvisToolGated,
  type JarvisCanvasFacet
} from './jarvisTools'
import type { AppModel } from './appModel'
import type { ContextsDigest, GroupRowResult, GroupsRegistry } from './mcpGroups'
import { createGroupsMethods } from './mcpGroups'
import type { ConfirmBatchRequest } from './mcpConfirm'
import type { McpCommand } from './mcpCommand'

const API = 'aaaa1111-0000-0000-0000-000000000001'
const WEB = 'bbbb2222-0000-0000-0000-000000000002'
const NOTE1 = 'cccc3333-0000-0000-0000-000000000003'
const NOTE2 = 'dddd4444-0000-0000-0000-000000000004'
const BILLING = 'gggg0001-0000-0000-0000-000000000000'
const OPS = 'gggg0002-0000-0000-0000-000000000000'

function model(groups: AppModel['canvas']['groups'] = []): AppModel {
  return {
    version: 1,
    boardTypes: [],
    tools: [],
    canvas: {
      boards: [
        { id: API, type: 'terminal', title: 'API server', status: 'running' },
        { id: WEB, type: 'browser', title: 'localhost:3000', status: 'idle' },
        { id: NOTE1, type: 'planning', title: 'Notes', status: 'idle' },
        { id: NOTE2, type: 'planning', title: 'Notes', status: 'idle' }
      ],
      connectors: [],
      groups
    },
    rules: { spawnCap: 4, everyWriteGated: true }
  }
}

const GROUPS = [
  { id: BILLING, name: 'Billing', boardIds: [API, 'gone-board-id-123'] },
  { id: OPS, name: 'Ops', boardIds: [WEB] }
]

function makeFacet(over: Partial<JarvisCanvasFacet> = {}): JarvisCanvasFacet {
  const none = vi.fn(async () => {
    throw new Error('not under test')
  })
  return {
    describeApp: async () => model(GROUPS),
    spawnBoard: none,
    dispatchPrompt: none,
    addCard: none,
    updateCard: none,
    moveCard: none,
    visualizePlan: none,
    focusViewport: none,
    tidyCanvas: none,
    makeMainBoard: none,
    boardCards: none,
    describeContexts: vi.fn(
      async (): Promise<ContextsDigest> => ({ version: 1, contexts: [], ungrouped: [] })
    ),
    groupBoards: vi.fn(
      async (input: { groups: unknown[] }): Promise<GroupRowResult[]> =>
        input.groups.map((_, k) => ({ status: 'created', groupId: `new-group-${k}-xyz` }))
    ),
    editGroups: vi.fn(
      async (input: { ops: unknown[] }): Promise<GroupRowResult[]> =>
        input.ops.map(() => ({ status: 'applied' }))
    ),
    ...over
  }
}

/** A Jarvis-side pre-confirm must NEVER fire for group tools (the batch modal is the confirm). */
const confirm = vi.fn(async () => ({ approved: true }))

describe('catalog + tiers', () => {
  it('adds list_groups (auto-allow) and the two gated writes', () => {
    const names = buildJarvisToolDefs().map((t) => t.name)
    expect(names.slice(-3)).toEqual(['list_groups', 'group_boards', 'edit_groups'])
    expect(isJarvisToolGated('list_groups')).toBe(false)
    expect(isJarvisToolGated('group_boards')).toBe(true)
    expect(isJarvisToolGated('edit_groups')).toBe(true)
  })
})

describe('group_boards', () => {
  it('resolves board refs (title / id prefix), dedups, and makes ONE orchestrator call', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'group_boards',
      {
        groups: [
          { name: 'API stack', boards: ['API server', 'bbbb2222', API] },
          { name: 'Notes', boards: ['cccc3333', 'dddd4444'] }
        ]
      },
      { facet, confirm }
    )
    expect(facet.groupBoards).toHaveBeenCalledTimes(1)
    expect(facet.groupBoards).toHaveBeenCalledWith({
      groups: [
        { name: 'API stack', boardIds: [API, WEB] },
        { name: 'Notes', boardIds: [NOTE1, NOTE2] }
      ]
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(r).toMatchObject({ isError: false, denied: false })
    expect(r.summary).toBe('group_boards · "API stack", "Notes" · 2 done')
    expect(JSON.parse(r.content)).toEqual({
      rows: [
        { name: 'API stack', status: 'created', groupId: 'new-grou' },
        { name: 'Notes', status: 'created', groupId: 'new-grou' }
      ]
    })
  })

  it('an ambiguous title asks with numbered candidates — nothing reaches the orchestrator', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'group_boards',
      { groups: [{ name: 'Notes', boards: ['Notes'] }] },
      { facet, confirm }
    )
    expect(r).toMatchObject({ isError: true, denied: false })
    expect(r.content).toMatch(/ambiguous — candidates: 1\. \[cccc3333\].*2\. \[dddd4444\]/)
    expect(facet.groupBoards).not.toHaveBeenCalled()
  })

  it('🔒 validates the model-authored args before anything is asked', async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{}, /"groups" \(non-empty array\) is required/],
      [{ groups: [] }, /"groups" \(non-empty array\) is required/],
      [{ groups: Array.from({ length: 11 }, () => ({})) }, /at most 10/],
      [{ groups: ['x'] }, /groups\[0\] must be an object/],
      [{ groups: [{ boards: [API] }] }, /"name" \(string\) is required/],
      [{ groups: [{ name: 'x'.repeat(201), boards: [API] }] }, /exceeds 200/],
      [{ groups: [{ name: 'A', boards: [] }] }, /"boards" \(non-empty array\)/],
      [{ groups: [{ name: 'A', boards: Array(51).fill(API) }] }, /at most 50/],
      [{ groups: [{ name: 'A', boards: [7] }] }, /boards\[0\] must be a board reference/],
      [{ groups: [{ name: 'A', boards: ['nope'] }] }, /no board matches "nope"/]
    ]
    for (const [input, msg] of bad) {
      const facet = makeFacet()
      const r = await executeJarvisTool('group_boards', input, { facet, confirm })
      expect(r.isError).toBe(true)
      expect(r.denied).toBe(false)
      expect(r.content).toMatch(msg)
      expect(facet.groupBoards).not.toHaveBeenCalled()
    }
  })

  it('every row declined ⇒ a DENIED outcome that says nothing changed', async () => {
    const facet = makeFacet({
      groupBoards: vi.fn(async () => [{ status: 'denied' as const }, { status: 'denied' as const }])
    })
    const r = await executeJarvisTool(
      'group_boards',
      {
        groups: [
          { name: 'A', boards: [API] },
          { name: 'B', boards: [WEB] }
        ]
      },
      { facet, confirm }
    )
    expect(r).toMatchObject({ isError: true, denied: true })
    expect(r.content).toBe('the user declined — nothing changed')
    expect(r.summary).toBe('group_boards · "A", "B" · 2 declined')
  })

  it('a partial approval reports every row; all-rejected is an error with the details', async () => {
    const mixed = makeFacet({
      groupBoards: vi.fn(async () => [
        { status: 'created' as const, groupId: 'g-new-000001' },
        { status: 'denied' as const }
      ])
    })
    const two = {
      groups: [
        { name: 'A', boards: [API] },
        { name: 'B', boards: [WEB] }
      ]
    }
    const r = await executeJarvisTool('group_boards', two, { facet: mixed, confirm })
    expect(r).toMatchObject({ isError: false, denied: false })
    expect(JSON.parse(r.content).rows.map((x: { status: string }) => x.status)).toEqual([
      'created',
      'denied'
    ])
    const rejected = makeFacet({
      groupBoards: vi.fn(async () => [
        { status: 'rejected' as const, detail: 'board is docked' },
        { status: 'denied' as const }
      ])
    })
    const e = await executeJarvisTool('group_boards', two, { facet: rejected, confirm })
    expect(e).toMatchObject({ isError: true, denied: false })
    expect(e.content).toContain('board is docked')
    expect(e.summary).toBe('group_boards · "A", "B" · 1 declined, 1 rejected')
  })

  it('shows the SANITIZED name (what the human sees in the confirm), never invisible chars', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'group_boards',
      { groups: [{ name: 'Auth‮​ flow', boards: [API] }] },
      { facet, confirm }
    )
    expect(r.summary).toBe('group_boards · "Auth flow" · 1 done')
  })
})

describe('edit_groups', () => {
  it('resolves groups by name (case-insensitive) or [id] prefix and builds the ops in order', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'edit_groups',
      {
        ops: [
          { op: 'rename', group: 'billing', name: 'Payments' },
          { op: 'add', group: 'gggg0002', boards: ['cccc3333'] },
          // A member no longer on the canvas is still removable by its id.
          { op: 'remove', group: 'Billing', boards: ['gone-board-id-123'] },
          { op: 'ungroup', group: 'Ops' }
        ]
      },
      { facet, confirm }
    )
    expect(facet.editGroups).toHaveBeenCalledWith({
      ops: [
        { op: 'rename', groupId: BILLING, name: 'Payments' },
        { op: 'add', groupId: OPS, boardIds: [NOTE1] },
        { op: 'remove', groupId: BILLING, boardIds: ['gone-board-id-123'] },
        { op: 'ungroup', groupId: OPS }
      ]
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(r).toMatchObject({ isError: false, denied: false })
    expect(r.summary).toBe(
      'edit_groups · "Billing" → "Payments", +"Ops", −"Billing", ungroup "Ops" · 4 done'
    )
  })

  it('🔒 refuses an off-enum op, a missing rename name, an unknown or ambiguous group', async () => {
    const dupes = [
      { id: 'hhhh0001-x', name: 'Twin', boardIds: [API] },
      { id: 'hhhh0002-x', name: 'twin', boardIds: [WEB] }
    ]
    const cases: Array<[Record<string, unknown>, RegExp, AppModel['canvas']['groups']?]> = [
      [{ ops: [{ op: 'explode', group: 'Ops' }] }, /ops\[0\]\.op must be/],
      [{ ops: [{ op: 'rename', group: 'Ops' }] }, /"name" \(string\) is required/],
      [{ ops: [{ op: 'add', group: 'Ops' }] }, /"boards" \(non-empty array\)/],
      [{ ops: [{ op: 'ungroup', group: 'Nope' }] }, /no group matches "Nope"/],
      [
        { ops: [{ op: 'ungroup', group: 'Twin' }] },
        /ambiguous — candidates: 1\. \[hhhh0001\]/,
        dupes
      ],
      [{ ops: Array.from({ length: 11 }, () => ({ op: 'ungroup', group: 'Ops' })) }, /at most 10/]
    ]
    for (const [input, msg, groups] of cases) {
      const facet = makeFacet(groups ? { describeApp: async () => model(groups) } : {})
      const r = await executeJarvisTool('edit_groups', input, { facet, confirm })
      expect(r).toMatchObject({ isError: true, denied: false })
      expect(r.content).toMatch(msg)
      expect(facet.editGroups).not.toHaveBeenCalled()
    }
  })
})

describe('list_groups', () => {
  it('projects the groups + the suggestions that would change something (no confirm)', async () => {
    const facet = makeFacet({
      describeContexts: vi.fn(
        async (): Promise<ContextsDigest> => ({
          version: 1,
          contexts: [
            {
              key: 'k1',
              suggestedName: 'API server',
              boardIds: [API, WEB],
              signals: ['preview'],
              confidence: 'high'
            },
            // IS an existing group, nothing to add ⇒ not a suggestion.
            {
              key: 'k2',
              suggestedName: 'Ops',
              boardIds: [WEB],
              signals: ['cwd'],
              confidence: 'medium',
              existingGroupId: OPS
            },
            {
              key: 'k3',
              suggestedName: 'Billing',
              boardIds: [API, NOTE1],
              signals: ['title'],
              confidence: 'low',
              existingGroupId: BILLING,
              addBoardIds: [NOTE1]
            }
          ],
          ungrouped: [NOTE2]
        })
      )
    })
    const r = await executeJarvisTool('list_groups', {}, { facet, confirm })
    expect(r).toMatchObject({ isError: false, summary: 'list_groups · 2 group(s), 2 suggested' })
    expect(JSON.parse(r.content)).toEqual({
      groups: [
        { id: 'gggg0001', name: 'Billing', boards: ['aaaa1111', 'gone-boa'] },
        { id: 'gggg0002', name: 'Ops', boards: ['bbbb2222'] }
      ],
      suggested: [
        {
          name: 'API server',
          confidence: 'high',
          linkedBy: ['preview'],
          boards: ['aaaa1111', 'bbbb2222']
        },
        {
          name: 'Billing',
          confidence: 'low',
          linkedBy: ['title'],
          boards: ['aaaa1111', 'cccc3333'],
          extendsGroup: 'gggg0001',
          add: ['cccc3333']
        }
      ],
      ungrouped: ['dddd4444']
    })
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('through the REAL group gate (createGroupsMethods)', () => {
  it('ONE batch confirm, ONE applyGroups command, the human-approved rows only', async () => {
    const requests: ConfirmBatchRequest[] = []
    const sent: McpCommand[] = []
    const registry: GroupsRegistry = {
      listBoards: () => model().canvas.boards.map(({ id, type, title }) => ({ id, type, title })),
      listConnectors: () => [],
      currentProjectDir: () => '/r',
      sendCommand: async (cmd) => {
        sent.push(cmd)
        return { ok: true, type: cmd.type, groupIds: ['g-real-1'] }
      },
      confirmBatch: async (req) => {
        requests.push(req)
        return { decisions: [{ approved: true }, { approved: false }] }
      }
    }
    const gate = createGroupsMethods(registry, { listGroups: () => [], audit: async () => {} })
    const facet = makeFacet({
      describeApp: async () => model(),
      groupBoards: (input) => gate.groupBoards(input),
      editGroups: (input) => gate.editGroups(input)
    })
    const r = await executeJarvisTool(
      'group_boards',
      {
        groups: [
          { name: 'API stack', boards: ['API server', 'localhost:3000'] },
          { name: 'Notes', boards: ['cccc3333', 'dddd4444'] }
        ]
      },
      { facet, confirm }
    )
    expect(requests).toHaveLength(1)
    expect(requests[0].items.map((i) => i.label)).toEqual([
      'API stack · 2 boards',
      'Notes · 2 boards'
    ])
    expect(sent).toEqual([
      { type: 'applyGroups', create: [{ name: 'API stack', boardIds: [API, WEB] }], edits: [] }
    ])
    expect(confirm).not.toHaveBeenCalled()
    expect(JSON.parse(r.content).rows).toEqual([
      { name: 'API stack', status: 'created', groupId: 'g-real-1' },
      { name: 'Notes', status: 'denied' }
    ])
  })
})
