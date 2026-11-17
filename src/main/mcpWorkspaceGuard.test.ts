/**
 * WS-7 — the confinement decorator (`guardWorkspaceScope`): which inner orchestrator call each
 * scope check guards, what it forwards, and that a refusal reaches the inner method NEVER (and is
 * audited). The path rules themselves are pinned in `workspaceScope.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { guardWorkspaceScope, type WorkspaceGuardDeps } from './mcpWorkspaceGuard'
import type { HostOrchestrator } from './mcpDispatchBatch'
import type { AuditInput } from './auditLog'
import type { ScopeBoard } from './workspaceScope'
import type { WorkspaceMirror } from './workspaceMirror'

let base: string
let project: string
let outside: string

const WORKSPACES: WorkspaceMirror[] = [
  { id: 'ws-api', name: 'API', goal: '', color: 'blue', root: 'api' },
  { id: 'ws-up', name: 'Uploader', goal: '', color: 'green', root: 'uploader' }
]
const BOARDS: ScopeBoard[] = [
  { id: 'tApi', type: 'terminal', title: 'API agent', workspaceId: 'ws-api' },
  { id: 'pApi', type: 'planning', title: 'API plan', workspaceId: 'ws-api' },
  { id: 'tUp', type: 'terminal', title: 'Uploader agent', workspaceId: 'ws-up' },
  { id: 'kUp', type: 'kanban', title: 'Uploader cards', workspaceId: 'ws-up' },
  { id: 'tProj', type: 'terminal', title: 'Project shell' },
  { id: 'kProj', type: 'kanban', title: 'Shared board' }
]

const audits: AuditInput[] = []
const deps: WorkspaceGuardDeps = {
  boards: () => BOARDS,
  workspaces: () => WORKSPACES,
  projectDir: () => project,
  audit: async (e) => {
    audits.push(e)
  }
}

/** Every method the guard wraps, as a spy that resolves a recognisable value. */
function fakeInner() {
  return {
    spawnBoard: vi.fn(async () => ({ id: 'new' })),
    spawnGroup: vi.fn(async () => ({ groupId: 'g', terminalId: 't' })),
    configureBoard: vi.fn(async () => {}),
    relayPrompt: vi.fn(async () => ({ delivery: 'ready' as const })),
    relayPrompts: vi.fn(async (items: Array<{ sourceId: string; targetId: string }>) =>
      items.map((i) => ({ ...i, status: 'relayed' as const, delivery: 'ready' as const }))
    ),
    closeBoard: vi.fn(async () => {}),
    addPlanningElements: vi.fn(async () => {}),
    updatePlanningElement: vi.fn(async () => {}),
    removePlanningElement: vi.fn(async () => {}),
    addCard: vi.fn(async () => ({ id: 'c1' })),
    moveCard: vi.fn(async () => {}),
    updateCard: vi.fn(async () => {}),
    removeCard: vi.fn(async () => {}),
    tidyCanvas: vi.fn(async () => ({ moved: 1 })),
    arrangeMainBoard: vi.fn(async () => ({ moved: 1 })),
    boardStatus: vi.fn(async () => 'idle')
  }
}

let inner: ReturnType<typeof fakeInner>
let guarded: ReturnType<typeof guardWorkspaceScope>

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws7-guard-'))
  project = path.join(base, 'proj')
  outside = path.join(base, 'outside')
  for (const d of ['api/src', 'uploader', 'tools']) {
    fs.mkdirSync(path.join(project, d), { recursive: true })
  }
  fs.mkdirSync(outside, { recursive: true })
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

beforeEach(() => {
  audits.length = 0
  inner = fakeInner()
  guarded = guardWorkspaceScope(inner as unknown as HostOrchestrator, deps)
})

describe('pass-through', () => {
  it('methods the guard does not wrap reach the inner orchestrator unchanged', async () => {
    await expect(guarded.boardStatus('tApi')).resolves.toBe('idle')
    expect(inner.boardStatus).toHaveBeenCalledWith('tApi')
  })
})

describe('spawn_board', () => {
  it("a workspace caller's terminal joins its workspace, cwd resolved under it", async () => {
    await guarded.spawnBoard({ type: 'terminal', sourceBoardId: 'tApi', cwd: 'src' })
    expect(inner.spawnBoard).toHaveBeenCalledWith({
      type: 'terminal',
      sourceBoardId: 'tApi',
      cwd: path.join(project, 'api', 'src'),
      workspaceId: 'ws-api'
    })
  })

  it('a workspaceId in the input is dropped — membership comes from the caller', async () => {
    const forged = { type: 'planning', workspaceId: 'ws-up' } as { type: string }
    await guarded.spawnBoard(forged)
    expect(inner.spawnBoard).toHaveBeenCalledWith({ type: 'planning' })
  })

  it('a project caller spawning into a workspace root joins it', async () => {
    await guarded.spawnBoard({ type: 'terminal', cwd: path.join(project, 'uploader') })
    expect(inner.spawnBoard).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-up' }))
  })

  it('a refused cwd never reaches the lifecycle (no board, no cap slot)', async () => {
    await expect(
      guarded.spawnBoard({ type: 'terminal', sourceBoardId: 'tApi', cwd: '../uploader' })
    ).rejects.toThrow(/outside workspace "API"/)
    await expect(guarded.spawnBoard({ type: 'terminal', cwd: outside })).rejects.toThrow(
      /outside the project/
    )
    expect(inner.spawnBoard).not.toHaveBeenCalled()
  })
})

describe('spawn_group', () => {
  it("a workspace lead's zone joins its workspace; a project caller's stays project-level", async () => {
    await guarded.spawnGroup({ name: 'Auth', sourceBoardId: 'tApi' })
    expect(inner.spawnGroup).toHaveBeenLastCalledWith({
      name: 'Auth',
      sourceBoardId: 'tApi',
      workspaceId: 'ws-api'
    })
    await guarded.spawnGroup({ name: 'Zone', workspaceId: 'ws-up' })
    expect(inner.spawnGroup).toHaveBeenLastCalledWith({ name: 'Zone' })
  })
})

describe('configure_board', () => {
  it('keeps only the known config keys and resolves the cwd inside the target workspace', async () => {
    const config = { cwd: 'src', shell: 'pwsh', workspaceId: 'ws-up' } as { cwd: string }
    await guarded.configureBoard('tApi', config)
    expect(inner.configureBoard).toHaveBeenCalledWith('tApi', {
      shell: 'pwsh',
      cwd: path.join(project, 'api', 'src')
    })
  })

  it('a cwd outside the target workspace is refused + audited, never applied', async () => {
    await expect(guarded.configureBoard('tApi', { cwd: outside })).rejects.toThrow(
      /configure_board: cwd ".*" is outside workspace "API"/
    )
    expect(inner.configureBoard).not.toHaveBeenCalled()
    expect(audits).toEqual([
      expect.objectContaining({ type: 'configure_board', targetId: 'tApi', status: 'rejected' })
    ])
  })

  it('a kanban axis config passes through untouched', async () => {
    await guarded.configureBoard('kProj', { columnAxis: 'category', axisLabel: 'Area' })
    expect(inner.configureBoard).toHaveBeenCalledWith('kProj', {
      columnAxis: 'category',
      axisLabel: 'Area'
    })
  })
})

describe('relay_prompt / relay_prompts', () => {
  it("refuses a relay into another workspace's terminal, audited, before the gate", async () => {
    await expect(guarded.relayPrompt('tApi', 'tUp', 'go')).rejects.toThrow(
      /relay_prompt: "Uploader agent" belongs to workspace "Uploader"/
    )
    expect(inner.relayPrompt).not.toHaveBeenCalled()
    expect(audits[0]).toMatchObject({ type: 'relay_prompt', targetId: 'tUp', status: 'rejected' })
  })

  it('allows a relay inside the workspace, to a project-level terminal, and from PROJECT', async () => {
    await guarded.relayPrompt('tApi', 'tApi', 'a')
    await guarded.relayPrompt('tApi', 'tProj', 'b')
    await guarded.relayPrompt('tProj', 'tUp', 'c')
    expect(inner.relayPrompt).toHaveBeenCalledTimes(3)
  })

  it('a batch rejects out-of-scope rows per row and keeps the results positional', async () => {
    const results = await guarded.relayPrompts([
      { sourceId: 'tApi', targetId: 'tProj', text: 'a' },
      { sourceId: 'tApi', targetId: 'tUp', text: 'b' },
      { sourceId: 'tProj', targetId: 'tUp', text: 'c' }
    ])
    expect(inner.relayPrompts).toHaveBeenCalledWith([
      { sourceId: 'tApi', targetId: 'tProj', text: 'a' },
      { sourceId: 'tProj', targetId: 'tUp', text: 'c' }
    ])
    expect(results.map((r) => [r.targetId, r.status])).toEqual([
      ['tProj', 'relayed'],
      ['tUp', 'rejected'],
      ['tUp', 'relayed']
    ])
    expect(results[1].detail).toMatch(/belongs to workspace "Uploader"/)
    expect(audits).toHaveLength(1)
  })

  it('an all-rejected batch never calls the inner batch (no empty confirm)', async () => {
    const results = await guarded.relayPrompts([{ sourceId: 'tApi', targetId: 'tUp', text: 'x' }])
    expect(inner.relayPrompts).not.toHaveBeenCalled()
    expect(results[0].status).toBe('rejected')
  })
})

describe('writes with the trailing caller (the WS-9 package contract)', () => {
  const CALLS = [
    [
      'add_card',
      (c?: { sourceBoardId?: string }) => guarded.addCard('kUp', { columnId: 'a', title: 't' }, c)
    ],
    ['move_card', (c?: { sourceBoardId?: string }) => guarded.moveCard('kUp', 'c1', 'b', c)],
    [
      'update_card',
      (c?: { sourceBoardId?: string }) => guarded.updateCard('kUp', 'c1', { title: 'x' }, c)
    ],
    ['remove_card', (c?: { sourceBoardId?: string }) => guarded.removeCard('kUp', 'c1', c)],
    ['close_board', (c?: { sourceBoardId?: string }) => guarded.closeBoard('kUp', c)],
    [
      'configure_board',
      (c?: { sourceBoardId?: string }) => guarded.configureBoard('kUp', { axisLabel: 'x' }, c)
    ],
    [
      'add_planning_elements',
      (c?: { sourceBoardId?: string }) =>
        guarded.addPlanningElements('kUp', { elements: [] } as never, c)
    ],
    [
      'update_planning_element',
      (c?: { sourceBoardId?: string }) =>
        guarded.updatePlanningElement('kUp', 'e1', { text: 'x' } as never, c)
    ],
    [
      'remove_planning_element',
      (c?: { sourceBoardId?: string }) => guarded.removePlanningElement('kUp', 'e1', c)
    ]
  ] as const

  it.each(CALLS)(
    "%s: a workspace caller is refused on another workspace's board",
    async (tool, call) => {
      await expect(call({ sourceBoardId: 'tApi' })).rejects.toThrow(
        new RegExp(`^${tool}: "Uploader cards" belongs to workspace "Uploader"`)
      )
      expect(audits[0]).toMatchObject({ type: tool, targetId: 'kUp', status: 'rejected' })
    }
  )

  it.each(CALLS)(
    '%s: no caller (package 0.28) or an in-scope caller passes',
    async (_tool, call) => {
      await call()
      await call({ sourceBoardId: 'tUp' })
      await call({ sourceBoardId: 'tProj' })
      expect(audits).toEqual([])
    }
  )
})

describe('tidy_canvas / arrange_main_board', () => {
  it("a workspace caller with no scope arranges its own workspace's boards", async () => {
    await guarded.tidyCanvas({ sourceBoardId: 'tApi' })
    expect(inner.tidyCanvas).toHaveBeenCalledWith({
      sourceBoardId: 'tApi',
      scope: { boardIds: ['tApi', 'pApi'] }
    })
  })

  it('an explicit scope or a project caller is unchanged', async () => {
    await guarded.tidyCanvas({ sourceBoardId: 'tApi', scope: 'all' })
    await guarded.tidyCanvas({ mode: 'grid' })
    expect(inner.tidyCanvas.mock.calls).toEqual([
      [{ sourceBoardId: 'tApi', scope: 'all' }],
      [{ mode: 'grid' }]
    ])
  })

  it("arrange_main_board keeps the main board in the workspace scope even when it isn't in W", async () => {
    await guarded.arrangeMainBoard({ sourceBoardId: 'tApi', boardId: 'kProj' })
    expect(inner.arrangeMainBoard).toHaveBeenCalledWith({
      sourceBoardId: 'tApi',
      boardId: 'kProj',
      scope: { boardIds: ['tApi', 'pApi', 'kProj'] }
    })
  })
})
