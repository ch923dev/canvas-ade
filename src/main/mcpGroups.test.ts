/**
 * `mcpGroups` (spatial I1, SPEC C5/C7, D2, DESIGN W1): `canvas://contexts`, `group_boards` and
 * `edit_groups` against a stub registry. Pins row validation, ONE confirm + ONE command per call,
 * the W1 rows (labels, bodies, low-confidence rows unchecked, disclose), the post-confirm re-check,
 * the fail-closed paths and the per-row audit.
 */
import { describe, expect, it, vi } from 'vitest'
import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { ConfirmBatchDecision, ConfirmBatchRequest } from './mcpConfirm'
import type { DispatchStatus } from './mcpRegistry'
import { createGroupsMethods, MAX_GROUP_BATCH, type GroupsRegistry } from './mcpGroups'
import { McpToolError } from './mcpToolError'

type Board = ReturnType<GroupsRegistry['listBoards']>[number] & { cwd?: string }
interface Group {
  id: string
  name: string
  boardIds: string[]
}

const BOARDS: Board[] = [
  { id: 't1', type: 'terminal', title: 'claude — auth', cwd: '/r/auth' },
  { id: 'b1', type: 'browser', title: 'localhost:5173/login', previewSourceId: 't1' },
  { id: 'p1', type: 'planning', title: 'Auth plan' },
  { id: 't2', type: 'terminal', title: 'stripe webhook', cwd: '/r/billing' },
  { id: 'p2', type: 'planning', title: 'Billing checklist', fileRefs: [] },
  { id: 't3', type: 'terminal', title: 'Terminal', cwd: '/r/billing' },
  { id: 'n1', type: 'planning', title: 'Notes' },
  { id: 'f1', type: 'file', title: 'README.md', path: 'README.md' },
  { id: 's1', type: 'swarm', title: 'Swarm' },
  { id: 'w1', type: 'terminal', title: 'worker', dockedIn: 's1' }
]

function harness(
  opts: {
    groups?: Group[]
    decide?: (req: ConfirmBatchRequest) => ConfirmBatchDecision
    ack?: (cmd: McpCommand) => McpCommandAck
    noConfirm?: boolean
    /** Runs while the confirm is "open" — mutate the mirror to model a TOCTOU change. */
    duringConfirm?: () => void
  } = {}
) {
  const boards = [...BOARDS]
  const groups: Group[] = opts.groups ?? []
  const requests: ConfirmBatchRequest[] = []
  const sent: McpCommand[] = []
  const audits: Array<{ type: string; targetId: string; status: DispatchStatus; detail?: string }> =
    []
  const registry: GroupsRegistry = {
    listBoards: () => boards,
    listConnectors: () => [],
    currentProjectDir: () => '/r',
    sendCommand: async (cmd) => {
      sent.push(cmd)
      if (opts.ack) return opts.ack(cmd)
      const create = cmd.type === 'applyGroups' ? cmd.create : []
      return { ok: true, type: cmd.type, groupIds: create.map((_, i) => `new-${i}`) }
    },
    ...(opts.noConfirm
      ? {}
      : {
          confirmBatch: async (req: ConfirmBatchRequest) => {
            requests.push(req)
            opts.duringConfirm?.()
            return opts.decide
              ? opts.decide(req)
              : { decisions: req.items.map(() => ({ approved: true })) }
          }
        })
  }
  const methods = createGroupsMethods(registry, {
    listGroups: () => groups.map((g) => ({ ...g, boardIds: [...g.boardIds] })),
    audit: async (input) => {
      audits.push(input)
    },
    pathCase: 'sensitive'
  })
  return { methods, boards, groups, requests, sent, audits }
}

/** Approve exactly the listed row indexes of the (single) confirm. */
const approveOnly =
  (...rows: number[]) =>
  (req: ConfirmBatchRequest): ConfirmBatchDecision => ({
    decisions: req.items.map((_, k) => ({ approved: rows.includes(k) }))
  })

describe('describeContexts (canvas://contexts v1)', () => {
  it('returns C3 contexts + the ungrouped canvas boards (docked workers excluded), sorted', async () => {
    const { methods } = harness({ groups: [{ id: 'g1', name: 'Docs', boardIds: ['n1', 'f1'] }] })
    const digest = await methods.describeContexts()
    expect(digest.version).toBe(1)
    const byGroup = digest.contexts.find((c) => c.existingGroupId === 'g1')
    expect(byGroup).toMatchObject({ suggestedName: 'Docs', boardIds: ['f1', 'n1'] })
    // t1 drives b1 (preview) — one high-confidence proposal.
    expect(digest.contexts).toContainEqual(
      expect.objectContaining({ boardIds: ['b1', 't1'], confidence: 'high', signals: ['preview'] })
    )
    // t2 + t3 share a cwd — medium.
    expect(digest.contexts).toContainEqual(
      expect.objectContaining({ boardIds: ['t2', 't3'], confidence: 'medium', signals: ['cwd'] })
    )
    expect(digest.ungrouped).toEqual(['b1', 'p1', 'p2', 's1', 't1', 't2', 't3'])
    expect(digest.ungrouped).not.toContain('w1')
  })

  it('a cwd equal to the project root carries no signal (projectRoot from the registry)', async () => {
    const { methods, boards } = harness()
    boards.splice(
      0,
      boards.length,
      ...[
        { id: 'a', type: 'terminal', title: 'Terminal', cwd: '/r' },
        { id: 'b', type: 'terminal', title: 'Terminal', cwd: '/r' }
      ]
    )
    expect((await methods.describeContexts()).contexts).toEqual([])
  })
})

describe('group_boards — ONE batch confirm, ONE applyGroups (D2)', () => {
  const PROPOSAL = {
    groups: [
      { name: 'Auth flow', boardIds: ['t1', 'b1'] },
      { name: 'Billing', boardIds: ['t2', 't3'] },
      { name: 'Misc', boardIds: ['p1', 'f1'] }
    ]
  }

  it('builds the W1 modal: title, blurb, one row per group, low-confidence rows unchecked', async () => {
    const { methods, requests } = harness()
    await methods.groupBoards(PROPOSAL)
    expect(requests).toHaveLength(1)
    const [req] = requests
    expect(req.title).toBe('Group 3 sets of boards')
    expect(req.blurb).toBe(
      'An agent proposes grouping these boards. Grouping only draws a named outline around them — ' +
        'nothing moves, nothing runs. All approved groups undo together with one Ctrl+Z.'
    )
    expect(req.items.map((i) => i.label)).toEqual([
      'Auth flow · 2 boards',
      'Billing · 2 boards',
      'Misc · 2 boards'
    ])
    expect(req.items[0].body).toBe(
      'Terminal "claude — auth" · Browser "localhost:5173/login"\nlinked by: preview'
    )
    // t3's title is the default "Terminal" ⇒ two terminals collapse to "Terminal ×2".
    expect(req.items[1].body).toBe('Terminal ×2\nlinked by: same folder')
    expect(req.items[2].body).toBe(
      'Plan "Auth plan" · File "README.md"\nno link between these boards was detected (low confidence)'
    )
    expect(req.items.map((i) => i.preselected)).toEqual([true, true, false])
    expect(req.disclose).toBeUndefined()
  })

  it('applies ONLY the approved rows in ONE command and returns per-row statuses in input order', async () => {
    const { methods, sent } = harness({ decide: approveOnly(0, 2) })
    const out = await methods.groupBoards(PROPOSAL)
    expect(sent).toEqual([
      {
        type: 'applyGroups',
        create: [
          { name: 'Auth flow', boardIds: ['t1', 'b1'] },
          { name: 'Misc', boardIds: ['p1', 'f1'] }
        ],
        edits: []
      }
    ])
    expect(out).toEqual([
      { status: 'created', groupId: 'new-0' },
      { status: 'denied' },
      { status: 'created', groupId: 'new-1' }
    ])
  })

  it('denying every row sends nothing', async () => {
    const { methods, sent } = harness({ decide: approveOnly() })
    const out = await methods.groupBoards(PROPOSAL)
    expect(sent).toEqual([])
    expect(out.map((r) => r.status)).toEqual(['denied', 'denied', 'denied'])
  })

  it('rejects invalid rows WITHOUT showing them: unknown / docked board, blank name', async () => {
    const { methods, requests, sent } = harness()
    const out = await methods.groupBoards({
      groups: [
        { name: 'Ghost', boardIds: ['t1', 'nope'] },
        { name: 'Docked', boardIds: ['t2', 'w1'] },
        { name: '️\u{E0041}', boardIds: ['p1', 'p2'] },
        { name: 'Real', boardIds: ['t2', 't3'] }
      ]
    })
    expect(out[0]).toEqual({ status: 'rejected', detail: 'unknown board id: nope' })
    expect(out[1]).toEqual({
      status: 'rejected',
      detail: 'board w1 is docked in a swarm board, not on the canvas'
    })
    expect(out[2]).toEqual({
      status: 'rejected',
      detail: 'the name is empty once control and invisible characters are removed'
    })
    expect(out[3]).toEqual({ status: 'created', groupId: 'new-0' })
    expect(requests).toHaveLength(1)
    expect(requests[0].items.map((i) => i.label)).toEqual(['Real · 2 boards'])
    expect(requests[0].title).toBe('Group 1 set of boards')
    expect(requests[0].disclose).toBe('3 more proposed groups could not be used and are not shown.')
    expect(sent).toHaveLength(1)
  })

  it('no valid row ⇒ no confirm and no command', async () => {
    const { methods, requests, sent } = harness()
    const out = await methods.groupBoards({ groups: [{ name: 'X', boardIds: ['nope'] }] })
    expect(out).toEqual([{ status: 'rejected', detail: 'unknown board id: nope' }])
    expect(requests).toEqual([])
    expect(sent).toEqual([])
  })

  it('sanitizes the name (tag smuggling, bidi) before it reaches the row or the command', async () => {
    const { methods, requests, sent } = harness()
    await methods.groupBoards({
      groups: [{ name: 'Au‮th\u{E0041}\u{E0042}  flow', boardIds: ['t1', 'b1'] }]
    })
    expect(requests[0].items[0].label).toBe('Auth flow · 2 boards')
    expect((sent[0] as Extract<McpCommand, { type: 'applyGroups' }>).create[0].name).toBe(
      'Auth flow'
    )
  })

  it('shows the WHOLE name the human approves; only long board titles are clamped', async () => {
    const h = harness()
    h.boards.push({ id: 'long', type: 'terminal', title: 'T'.repeat(70) })
    const name = 'N'.repeat(80)
    await h.methods.groupBoards({ groups: [{ name, boardIds: ['long', 'p1'] }] })
    const [item] = h.requests[0].items
    expect(item.label).toBe(`${name} · 2 boards`)
    expect(item.body.split('\n')[0]).toBe(`Terminal "${'T'.repeat(39)}…" · Plan "Auth plan"`)
  })

  it('discloses members that are already in another group (multi-membership)', async () => {
    const { methods, requests } = harness({
      groups: [{ name: 'Docs', id: 'g1', boardIds: ['p1', 'n1'] }]
    })
    await methods.groupBoards({ groups: [{ name: 'Auth', boardIds: ['t1', 'b1', 'p1'] }] })
    expect(requests[0].disclose).toBe('1 board is already in "Docs" and stays there too.')
  })

  it('🔒 fail-closed: no confirm seam ⇒ every valid row denied, nothing sent', async () => {
    const { methods, sent } = harness({ noConfirm: true })
    const out = await methods.groupBoards(PROPOSAL)
    expect(out.map((r) => r.status)).toEqual(['denied', 'denied', 'denied'])
    expect(sent).toEqual([])
  })

  it('🔒 a short / malformed reply denies the rows it does not explicitly approve', async () => {
    const { methods, sent } = harness({
      decide: () => ({ decisions: [{ approved: true }, { approved: 'yes' as unknown as boolean }] })
    })
    const out = await methods.groupBoards(PROPOSAL)
    expect(out.map((r) => r.status)).toEqual(['created', 'denied', 'denied'])
    expect(sent).toHaveLength(1)
  })

  it('🔒 TOCTOU: a board removed while the modal was open rejects that row; the rest apply', async () => {
    const h = harness({
      duringConfirm: () => {
        const i = h.boards.findIndex((b) => b.id === 'b1')
        h.boards.splice(i, 1)
      }
    })
    const out = await h.methods.groupBoards(PROPOSAL)
    expect(out[0]).toEqual({
      status: 'rejected',
      detail: 'the canvas changed while the confirm was open: unknown board id: b1'
    })
    expect(out.slice(1).map((r) => r.status)).toEqual(['created', 'created'])
    const cmd = h.sent[0] as Extract<McpCommand, { type: 'applyGroups' }>
    expect(cmd.create.map((c) => c.name)).toEqual(['Billing', 'Misc'])
  })

  it('a failed command rejects every approved row and audits them as failed', async () => {
    const { methods, audits } = harness({
      decide: approveOnly(0),
      ack: () => ({ ok: false, error: 'applyGroups: unknown or docked board in create[0]' })
    })
    const out = await methods.groupBoards(PROPOSAL)
    expect(out[0]).toEqual({
      status: 'rejected',
      detail: 'the canvas did not apply it: applyGroups: unknown or docked board in create[0]'
    })
    expect(audits.map((a) => a.status)).toEqual(['failed', 'denied', 'denied'])
  })

  it('audits EVERY row (type, status vocabulary, caller), content-less', async () => {
    const { methods, audits } = harness({ decide: approveOnly(0) })
    await methods.groupBoards({
      groups: [...PROPOSAL.groups.slice(0, 2), { name: 'Bad', boardIds: ['zzz'] }],
      sourceBoardId: 't1'
    })
    expect(audits).toHaveLength(3)
    expect(audits.every((a) => a.type === 'group_boards')).toBe(true)
    expect(audits.map((a) => a.status)).toEqual(['applied', 'denied', 'rejected'])
    expect(audits[0].targetId).toBe('new-0')
    expect(audits[0].detail).toBe('name="Auth flow" boards=t1,b1 · by=t1')
    expect(audits[2].detail).toBe('name="Bad" boards=zzz · by=t1 · unknown board id: zzz')
  })

  it('an orchestrator-tier call (no sourceBoardId) is gated the same way (D2: every tier)', async () => {
    const { methods, requests, audits } = harness()
    await methods.groupBoards({ groups: [PROPOSAL.groups[0]] })
    expect(requests).toHaveLength(1)
    expect(audits[0].detail).toContain('by=orchestrator')
  })

  it('an audit sink that throws never turns a landed write into an error', async () => {
    const h = harness()
    const methods = createGroupsMethods(
      {
        listBoards: () => h.boards,
        listConnectors: () => [],
        sendCommand: async (cmd) => ({ ok: true, type: cmd.type, groupIds: ['g-x'] }),
        confirmBatch: async (req) => ({ decisions: req.items.map(() => ({ approved: true })) })
      },
      {
        listGroups: () => [],
        audit: async () => {
          throw new Error('disk full')
        }
      }
    )
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(methods.groupBoards({ groups: [PROPOSAL.groups[0]] })).resolves.toEqual([
      { status: 'created', groupId: 'g-x' }
    ])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('🔒 a malformed batch is invalid_input before anything is shown', async () => {
    const { methods, requests } = harness()
    const tooMany = Array.from({ length: MAX_GROUP_BATCH + 1 }, () => PROPOSAL.groups[0])
    for (const groups of [[], tooMany, 'x', undefined]) {
      const call = methods.groupBoards({ groups } as never)
      await expect(call).rejects.toBeInstanceOf(McpToolError)
      await expect(call).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(requests).toEqual([])
  })

  it('dedupes member ids and caps a row at MAX_GROUP_MEMBERS', async () => {
    const { methods, sent } = harness()
    const out = await methods.groupBoards({
      groups: [
        { name: 'Dupes', boardIds: ['t1', 'b1', 't1'] },
        { name: 'Huge', boardIds: Array.from({ length: 51 }, (_, i) => `x${i}`) }
      ]
    })
    expect((sent[0] as Extract<McpCommand, { type: 'applyGroups' }>).create[0].boardIds).toEqual([
      't1',
      'b1'
    ])
    expect(out[1]).toEqual({ status: 'rejected', detail: 'at most 50 boards per row' })
  })
})

describe('edit_groups — ONE batch confirm, ops applied in order', () => {
  const GROUPS: Group[] = [
    { id: 'gA', name: 'Auth', boardIds: ['t1', 'b1'] },
    { id: 'gB', name: 'Billing', boardIds: ['t2', 't3'] },
    { id: 'gM', name: 'Misc', boardIds: ['n1', 'f1'] }
  ]

  it('renders the W1 edit rows (rename / add / remove / ungroup)', async () => {
    const { methods, requests } = harness({ groups: GROUPS })
    await methods.editGroups({
      ops: [
        { op: 'rename', groupId: 'gA', name: 'Auth flow' },
        { op: 'add', groupId: 'gB', boardIds: ['p2'] },
        { op: 'remove', groupId: 'gB', boardIds: ['t3'] },
        { op: 'ungroup', groupId: 'gM' }
      ]
    })
    const [req] = requests
    expect(req.title).toBe('Edit groups · 4 changes')
    expect(req.items.map((i) => i.label)).toEqual([
      'Rename "Auth" → "Auth flow"',
      'Add 1 board to "Billing"',
      'Remove 1 board from "Billing"',
      'Ungroup "Misc" (boards stay put)'
    ])
    expect(req.items[1].body).toBe('Plan "Billing checklist"')
    expect(req.items[3].body).toBe('Plan "Notes" · File "README.md"')
    expect(req.items.every((i) => i.preselected === undefined)).toBe(true)
  })

  it('sends ONE applyGroups with only the approved ops; per-op statuses in order', async () => {
    const { methods, sent } = harness({ groups: GROUPS, decide: approveOnly(0, 2) })
    const out = await methods.editGroups({
      ops: [
        { op: 'rename', groupId: 'gA', name: 'Auth flow' },
        { op: 'add', groupId: 'gB', boardIds: ['p2'] },
        { op: 'ungroup', groupId: 'gM' }
      ]
    })
    expect(sent).toEqual([
      {
        type: 'applyGroups',
        create: [],
        edits: [
          { op: 'rename', groupId: 'gA', name: 'Auth flow' },
          { op: 'ungroup', groupId: 'gM' }
        ]
      }
    ])
    expect(out).toEqual([{ status: 'applied' }, { status: 'denied' }, { status: 'applied' }])
  })

  it('rejects ops that cannot apply, without showing them', async () => {
    const { methods, requests } = harness({ groups: GROUPS })
    const out = await methods.editGroups({
      ops: [
        { op: 'rename', groupId: 'nope', name: 'X' },
        { op: 'rename', groupId: 'gA', name: ' Auth ' },
        { op: 'add', groupId: 'gA', boardIds: ['t1'] },
        { op: 'add', groupId: 'gA', boardIds: ['w1'] },
        { op: 'remove', groupId: 'gA', boardIds: ['t2'] },
        { op: 'explode', groupId: 'gA' } as never,
        { op: 'ungroup', groupId: 'gB' }
      ]
    })
    expect(out.map((r) => r.detail ?? r.status)).toEqual([
      'unknown group id: nope',
      'the group is already named "Auth"',
      'every board is already in the group',
      'board w1 is docked in a swarm board, not on the canvas',
      'board t2 is not in the group',
      'unknown op: explode',
      'applied'
    ])
    expect(requests[0].items).toHaveLength(1)
    expect(requests[0].disclose).toBe(
      '6 more proposed changes could not be used and are not shown.'
    )
  })

  it('an add sends only the boards that are not members yet', async () => {
    const { methods, sent } = harness({ groups: GROUPS })
    await methods.editGroups({ ops: [{ op: 'add', groupId: 'gA', boardIds: ['t1', 'p1'] }] })
    expect((sent[0] as Extract<McpCommand, { type: 'applyGroups' }>).edits).toEqual([
      { op: 'add', groupId: 'gA', boardIds: ['p1'] }
    ])
  })

  it('a remove of every member says the group ends', async () => {
    const { methods, requests } = harness({ groups: GROUPS })
    await methods.editGroups({ ops: [{ op: 'remove', groupId: 'gA', boardIds: ['t1', 'b1'] }] })
    expect(requests[0].items[0].label).toBe('Remove 2 boards from "Auth" (the group ends)')
  })

  it('an approved op after an approved ungroup of the same group is rejected, not sent', async () => {
    const { methods, sent } = harness({ groups: GROUPS })
    const out = await methods.editGroups({
      ops: [
        { op: 'ungroup', groupId: 'gA' },
        { op: 'rename', groupId: 'gA', name: 'Gone' },
        { op: 'remove', groupId: 'gB', boardIds: ['t2', 't3'] },
        { op: 'add', groupId: 'gB', boardIds: ['p2'] }
      ]
    })
    expect(out).toEqual([
      { status: 'applied' },
      { status: 'rejected', detail: 'an earlier change in this batch removed the group' },
      { status: 'applied' },
      { status: 'rejected', detail: 'an earlier change in this batch removed the group' }
    ])
    expect((sent[0] as Extract<McpCommand, { type: 'applyGroups' }>).edits).toHaveLength(2)
  })

  it('…but if the human DENIES that ungroup, the later op on the group still applies', async () => {
    const { methods } = harness({ groups: GROUPS, decide: approveOnly(1) })
    const out = await methods.editGroups({
      ops: [
        { op: 'ungroup', groupId: 'gA' },
        { op: 'rename', groupId: 'gA', name: 'Kept' }
      ]
    })
    expect(out).toEqual([{ status: 'denied' }, { status: 'applied' }])
  })

  it('audits every op with its group id and the caller', async () => {
    const { methods, audits } = harness({ groups: GROUPS, decide: approveOnly(0) })
    await methods.editGroups({
      ops: [
        { op: 'rename', groupId: 'gA', name: 'Auth flow' },
        { op: 'ungroup', groupId: 'gM' }
      ],
      sourceBoardId: 't2'
    })
    expect(audits).toEqual([
      {
        type: 'edit_groups',
        targetId: 'gA',
        prompt: '',
        nonce: '',
        status: 'applied',
        detail: 'op=rename name="Auth flow" · by=t2'
      },
      {
        type: 'edit_groups',
        targetId: 'gM',
        prompt: '',
        nonce: '',
        status: 'denied',
        detail: 'op=ungroup · by=t2'
      }
    ])
  })
})
