/**
 * WS-7 workspace confinement over the REAL wire: the pinned `@expanse-ade/mcp` package's tools, fed
 * the host orchestrator exactly as `startMcpServer` builds it (`guardWorkspaceScope` over
 * `buildOrchestrator`), on a stub registry that mirrors two workspaces and a real temp project.
 *
 * What only this layer shows: that the guard actually sits on the path the package calls (a guard
 * applied to the wrong object type-checks fine and confines nothing), that the caller's scope comes
 * from the TOKEN-bound board, and that a refusal reaches the agent as `invalid_input` with no
 * renderer command sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { McpCommand, McpCommandAck } from './mcpCommand'
import type { AuditInput } from './auditLog'
import { startMcpToolsHarness, type McpTier, type McpToolsHarness } from './mcpToolsHarness'

let base: string
let project: string
let outside: string

const sent: McpCommand[] = []
const audits: AuditInput[] = []
const confirm = vi.fn(async () => ({ approved: true }))
const sendCommand = async (cmd: McpCommand): Promise<McpCommandAck> => {
  sent.push(cmd)
  return { ok: true, type: cmd.type, ...(cmd.type === 'tidyBoards' ? { moved: 1 } : {}) }
}

/** The structured error code the package's tool boundary puts on a failed result. */
function errorCode(r: unknown): string | undefined {
  return (r as { structuredContent?: { error?: { code?: string } } })?.structuredContent?.error
    ?.code
}
const text = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text).join('')

let h: McpToolsHarness

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws7-wire-'))
  project = path.join(base, 'proj')
  outside = path.join(base, 'outside')
  for (const d of ['api/src', 'uploader', 'tools']) {
    fs.mkdirSync(path.join(project, d), { recursive: true })
  }
  fs.mkdirSync(outside, { recursive: true })
  h = await startMcpToolsHarness({
    registry: {
      listBoards: () => [
        { id: 't1', type: 'terminal', title: 'API agent', status: 'idle', workspaceId: 'ws-api' },
        {
          id: 't2',
          type: 'terminal',
          title: 'Uploader agent',
          status: 'idle',
          workspaceId: 'ws-up'
        },
        { id: 't3', type: 'terminal', title: 'Project shell', status: 'idle' },
        { id: 'p1', type: 'planning', title: 'API plan', workspaceId: 'ws-api' }
      ],
      listWorkspaces: () => [
        { id: 'ws-api', name: 'API', goal: '', color: 'blue', root: 'api' },
        { id: 'ws-up', name: 'Uploader', goal: '', color: 'green', root: 'uploader' }
      ],
      currentProjectDir: () => project,
      // Orchestration cables everywhere, so a refusal can only be the workspace rule.
      listConnectors: () =>
        ['t2', 't3'].map((target) => ({
          id: `c-${target}`,
          sourceId: 't1',
          targetId: target,
          kind: 'orchestration'
        })),
      sendCommand,
      confirm,
      audit: async (e) => {
        audits.push(e)
      }
    }
  })
})

afterAll(async () => {
  await h?.close()
  fs.rmSync(base, { recursive: true, force: true })
})

beforeEach(() => {
  sent.length = 0
  audits.length = 0
  confirm.mockClear()
})

async function call(tier: McpTier, name: string, args: Record<string, unknown>) {
  const s = await h.connect(tier, { boardId: 't1' })
  try {
    return await s.client.callTool({ name, arguments: args })
  } finally {
    await s.close()
  }
}

describe('spawn_board', () => {
  it("a workspace agent's spawn joins its workspace (scope from the TOKEN's board)", async () => {
    const r = await call('connected', 'spawn_board', { type: 'terminal' })
    expect(r.isError).toBeFalsy()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'addBoard',
      board: { type: 'terminal', workspaceId: 'ws-api' },
      connector: { sourceId: 't1' }
    })
  })

  it('a workspace agent cannot start a terminal outside its workspace', async () => {
    for (const cwd of [outside, path.join(project, 'uploader'), '../uploader']) {
      const r = await call('connected', 'spawn_board', { type: 'terminal', cwd })
      expect(r.isError).toBe(true)
      expect(errorCode(r)).toBe('invalid_input')
      expect(text(r)).toMatch(/is outside workspace "API" \(api\/\)/)
    }
    expect(sent).toEqual([])
  })

  it('the orchestrator tier is project-scoped: a workspace root joins it, outside is refused', async () => {
    const joined = await call('orchestrator', 'spawn_board', {
      type: 'terminal',
      cwd: path.join(project, 'uploader')
    })
    expect(joined.isError).toBeFalsy()
    expect(sent[0]).toMatchObject({
      type: 'addBoard',
      board: { cwd: path.join(project, 'uploader'), workspaceId: 'ws-up' }
    })
    const refused = await call('orchestrator', 'spawn_board', { type: 'terminal', cwd: outside })
    expect(errorCode(refused)).toBe('invalid_input')
    expect(text(refused)).toMatch(/is outside the project/)
    expect(sent).toHaveLength(1)
  })
})

describe('configure_board', () => {
  it("keeps a terminal's new cwd inside the TARGET's workspace", async () => {
    const ok = await call('connected', 'configure_board', { id: 't1', cwd: 'src' })
    expect(ok.isError).toBeFalsy()
    expect(sent[0]).toEqual({
      type: 'configureBoard',
      id: 't1',
      patch: { cwd: path.join(project, 'api', 'src') }
    })
    const refused = await call('connected', 'configure_board', { id: 't2', cwd: outside })
    expect(errorCode(refused)).toBe('invalid_input')
    expect(text(refused)).toMatch(/is outside workspace "Uploader"/)
    expect(sent).toHaveLength(1)
    expect(audits).toContainEqual(
      expect.objectContaining({ type: 'configure_board', targetId: 't2', status: 'rejected' })
    )
  })
})

describe('relay_prompt', () => {
  it("refuses a relay into another workspace's terminal even along a cable", async () => {
    const r = await call('connected', 'relay_prompt', {
      sourceId: 't1',
      targetId: 't2',
      prompt: 'take this'
    })
    expect(errorCode(r)).toBe('invalid_input')
    expect(text(r)).toMatch(
      /relay_prompt: "Uploader agent" belongs to workspace "Uploader" — an agent in workspace "API"/
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(audits).toContainEqual(
      expect.objectContaining({ type: 'relay_prompt', targetId: 't2', status: 'rejected' })
    )
  })

  it('a relay to a project-level terminal still reaches the human confirm', async () => {
    await call('connected', 'relay_prompt', { sourceId: 't1', targetId: 't3', prompt: 'hi' })
    expect(confirm).toHaveBeenCalled()
  })
})

describe('tidy_canvas', () => {
  it("a workspace agent's scope-less tidy arranges its own workspace", async () => {
    const r = await call('connected', 'tidy_canvas', {})
    expect(r.isError).toBeFalsy()
    expect(sent[0]).toMatchObject({ type: 'tidyBoards', scope: { boardIds: ['t1', 'p1'] } })
  })

  it('the orchestrator tier still tidies the whole canvas', async () => {
    await call('orchestrator', 'tidy_canvas', { mode: 'grid' })
    expect(sent[0]).toEqual({ type: 'tidyBoards', mode: 'grid' })
  })
})
