/**
 * WS-7 — the workspace-confinement policy (`workspaceScope`, design §4.4). Real temp dirs, so the
 * realpath layer is exercised for real: a `..` cwd, a junction/symlink escape and a missing folder
 * are refused with a sentence, and a project-level spawn into a workspace root joins it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  assertConfigureCwd,
  assertCwdInScope,
  assertTargetInScope,
  callerScope,
  placeSpawn,
  targetScopeError,
  workspaceBoardIds,
  workspaceName,
  type ScopeBoard,
  type WorkspaceScopeDeps
} from './workspaceScope'
import type { WorkspaceMirror } from './workspaceMirror'

let base: string
let project: string
let outside: string

const WORKSPACES: WorkspaceMirror[] = [
  { id: 'ws-api', name: 'API', goal: '', color: 'blue', root: 'api' },
  { id: 'ws-up', name: 'Uploader', goal: '', color: 'green', root: 'uploader' },
  { id: 'ws-src', name: 'API src', goal: '', color: 'amber', root: 'api/src' },
  { id: 'ws-old', name: 'Old', goal: '', color: 'violet', root: 'docs', state: 'archived' },
  { id: 'ws-gone', name: 'Gone', goal: '', color: 'teal', root: 'gone' }
]

const BOARDS: ScopeBoard[] = [
  { id: 'tApi', type: 'terminal', title: 'API agent', workspaceId: 'ws-api' },
  { id: 'tUp', type: 'terminal', title: 'Uploader agent', workspaceId: 'ws-up' },
  { id: 'pUp', type: 'planning', title: 'Uploader plan', workspaceId: 'ws-up' },
  { id: 'tProj', type: 'terminal', title: 'Project shell' },
  { id: 'kProj', type: 'kanban', title: 'Shared board' },
  { id: 'tGone', type: 'terminal', title: 'Gone agent', workspaceId: 'ws-gone' },
  { id: 'tDangling', type: 'terminal', title: 'Dangling', workspaceId: 'ws-deleted' },
  { id: 'wDock', type: 'terminal', title: 'Docked worker', workspaceId: 'ws-api', dockedIn: 'sw1' }
]

const deps = (over: Partial<WorkspaceScopeDeps> = {}): WorkspaceScopeDeps => ({
  boards: () => BOARDS,
  workspaces: () => WORKSPACES,
  projectDir: () => project,
  ...over
})

const API = { kind: 'workspace', ws: WORKSPACES[0] } as const
const PROJECT = { kind: 'project' } as const

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ws7-scope-'))
  project = path.join(base, 'my project') // spaced, like the real repo path
  outside = path.join(base, 'outside')
  for (const d of ['api/src', 'uploader', 'docs', 'tools']) {
    fs.mkdirSync(path.join(project, d), { recursive: true })
  }
  fs.mkdirSync(outside, { recursive: true })
  // 'junction' needs no privilege on Windows; it is ignored (plain dir symlink) elsewhere.
  fs.symlinkSync(outside, path.join(project, 'api', 'escape'), 'junction')
  fs.symlinkSync(outside, path.join(project, 'linked'), 'junction')
})

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe('callerScope', () => {
  it('no board id (the app orchestrator, Jarvis) is PROJECT', () => {
    expect(callerScope(deps(), undefined)).toEqual(PROJECT)
  })

  it('a board in a mirrored workspace is that workspace', () => {
    expect(callerScope(deps(), 'tApi')).toEqual(API)
  })

  it('a project-level, unknown or dangling-workspace board is PROJECT', () => {
    for (const id of ['tProj', 'nope', 'tDangling']) {
      expect(callerScope(deps(), id)).toEqual(PROJECT)
    }
  })
})

describe('assertCwdInScope — a workspace caller', () => {
  it('no cwd joins W and leaves the cwd to the PTY spawn (W root, WS-3)', () => {
    expect(assertCwdInScope(deps(), API, undefined, 'spawn_board')).toEqual({
      workspaceId: 'ws-api'
    })
    expect(assertCwdInScope(deps(), API, '   ', 'spawn_board')).toEqual({ workspaceId: 'ws-api' })
  })

  it('a relative cwd resolves under W; an absolute one inside W is kept', () => {
    const src = path.join(project, 'api', 'src')
    expect(assertCwdInScope(deps(), API, 'src', 'spawn_board')).toEqual({
      workspaceId: 'ws-api',
      cwd: src
    })
    expect(assertCwdInScope(deps(), API, src, 'spawn_board').cwd).toBe(src)
  })

  it.each([
    ['a `..` into another workspace', () => '../uploader'],
    ['another workspace by absolute path', () => path.join(project, 'uploader')],
    ['the project root', () => project],
    ['a folder outside the project', () => outside],
    ['a junction inside W that leads out', () => path.join(project, 'api', 'escape')]
  ])('refuses %s', (_label, cwd) => {
    expect(() => assertCwdInScope(deps(), API, cwd(), 'spawn_board')).toThrow(
      /spawn_board: cwd ".*" is outside workspace "API" \(api\/\) — boards in a workspace stay inside its folder\./
    )
  })

  it('the refusal is an invalid_input tool error', () => {
    try {
      assertCwdInScope(deps(), API, outside, 'spawn_board')
      expect.unreachable()
    } catch (err) {
      expect((err as { code?: string }).code).toBe('invalid_input')
    }
  })

  it('a cwd that does not exist is refused, not created or defaulted', () => {
    expect(() => assertCwdInScope(deps(), API, 'nope', 'spawn_board')).toThrow(
      'spawn_board: cwd "nope" is not an existing folder.'
    )
  })

  it('a workspace whose folder is gone refuses even without a cwd (no dead board)', () => {
    const gone = callerScope(deps(), 'tGone')
    expect(() => assertCwdInScope(deps(), gone, undefined, 'spawn_group')).toThrow(
      'spawn_group: workspace "Gone" folder is missing (gone/).'
    )
  })
})

describe('assertCwdInScope — a project caller', () => {
  it('no cwd stays project-level', () => {
    expect(assertCwdInScope(deps(), PROJECT, undefined, 'spawn_board')).toEqual({})
  })

  it('a cwd in the project but outside every workspace stays project-level', () => {
    expect(assertCwdInScope(deps(), PROJECT, 'tools', 'spawn_board')).toEqual({
      cwd: path.join(project, 'tools')
    })
  })

  it('a cwd inside a workspace root joins that workspace', () => {
    expect(assertCwdInScope(deps(), PROJECT, path.join(project, 'uploader'), 'x')).toEqual({
      cwd: path.join(project, 'uploader'),
      workspaceId: 'ws-up'
    })
  })

  it('nested roots: the deepest containing workspace wins', () => {
    expect(assertCwdInScope(deps(), PROJECT, 'api', 'x').workspaceId).toBe('ws-api')
    expect(assertCwdInScope(deps(), PROJECT, 'api/src', 'x').workspaceId).toBe('ws-src')
  })

  it('an archived workspace is never joined', () => {
    expect(assertCwdInScope(deps(), PROJECT, 'docs', 'x')).toEqual({
      cwd: path.join(project, 'docs')
    })
  })

  it.each([
    ['a folder outside the project', () => outside],
    ['a `..` out of the project', () => '..'],
    ['a junction in the project that leads out', () => path.join(project, 'linked')]
  ])('refuses %s', (_label, cwd) => {
    expect(() => assertCwdInScope(deps(), PROJECT, cwd(), 'spawn_board')).toThrow(
      /spawn_board: cwd ".*" is outside the project — boards start inside it\./
    )
  })

  it('no project open: nothing to escape, the cwd passes unchecked', () => {
    expect(assertCwdInScope(deps({ projectDir: () => null }), PROJECT, outside, 'x')).toEqual({
      cwd: outside
    })
  })
})

describe('placeSpawn', () => {
  it('a workspace caller spawns a terminal into W', () => {
    expect(placeSpawn(deps(), { type: 'terminal', sourceBoardId: 'tApi', cwd: 'src' })).toEqual({
      workspaceId: 'ws-api',
      cwd: path.join(project, 'api', 'src')
    })
  })

  it('a non-terminal joins the caller workspace; its cwd is left for the lifecycle refusal', () => {
    expect(placeSpawn(deps(), { type: 'planning', sourceBoardId: 'tApi', cwd: outside })).toEqual({
      workspaceId: 'ws-api'
    })
    expect(placeSpawn(deps(), { type: 'browser' })).toEqual({})
  })

  it('a swarm-docked worker stays project-level but inside the project', () => {
    const wt = path.join(project, 'tools')
    expect(
      placeSpawn(deps(), { type: 'terminal', sourceBoardId: 'tApi', dockedIn: 'sw1', cwd: wt })
    ).toEqual({ cwd: wt })
    expect(() => placeSpawn(deps(), { type: 'terminal', dockedIn: 'sw1', cwd: outside })).toThrow(
      /outside the project/
    )
  })

  it('workspaceName names the joined workspace', () => {
    expect(workspaceName(deps(), 'ws-up')).toBe('Uploader')
    expect(workspaceName(deps(), undefined)).toBeUndefined()
  })
})

describe('assertConfigureCwd — keyed on the TARGET, whoever calls', () => {
  const target = (id: string): ScopeBoard | undefined => BOARDS.find((b) => b.id === id)

  it('a workspace terminal keeps its cwd inside its workspace', () => {
    expect(assertConfigureCwd(deps(), target('tApi'), 'src')).toBe(path.join(project, 'api', 'src'))
    expect(() => assertConfigureCwd(deps(), target('tApi'), '../uploader')).toThrow(
      /configure_board: cwd "..\/uploader" is outside workspace "API"/
    )
  })

  it('a project-level terminal keeps its cwd inside the project (no spawn-then-configure bypass)', () => {
    expect(assertConfigureCwd(deps(), target('tProj'), 'uploader')).toBe(
      path.join(project, 'uploader')
    )
    expect(() => assertConfigureCwd(deps(), target('tProj'), outside)).toThrow(
      /configure_board: cwd ".*" is outside the project/
    )
  })

  it('a blank cwd, a non-terminal or an unknown target passes through untouched', () => {
    expect(assertConfigureCwd(deps(), target('tApi'), '')).toBe('')
    expect(assertConfigureCwd(deps(), target('kProj'), outside)).toBe(outside)
    expect(assertConfigureCwd(deps(), undefined, outside)).toBe(outside)
  })
})

describe('targetScopeError / assertTargetInScope', () => {
  it('a project caller may reach every board', () => {
    for (const b of BOARDS) expect(targetScopeError(deps(), PROJECT, b.id, 'x')).toBeNull()
  })

  it('a workspace caller may reach its own workspace and project-level boards', () => {
    for (const id of ['tApi', 'tProj', 'kProj', 'tDangling', 'unknown']) {
      expect(targetScopeError(deps(), API, id, 'relay_prompt')).toBeNull()
    }
  })

  it("refuses another workspace's board with a sentence naming both workspaces", () => {
    expect(targetScopeError(deps(), API, 'pUp', 'add_card')).toBe(
      'add_card: "Uploader plan" belongs to workspace "Uploader" — an agent in workspace "API" ' +
        "can only reach its own workspace's boards and project-level boards."
    )
    expect(() => assertTargetInScope(deps(), API, 'tUp', 'relay_prompt')).toThrow(
      /relay_prompt: "Uploader agent" belongs to workspace "Uploader"/
    )
    expect(() => assertTargetInScope(deps(), API, 'tApi', 'relay_prompt')).not.toThrow()
  })
})

describe('workspaceBoardIds', () => {
  it("lists a workspace's canvas boards (docked workers are not arrangeable)", () => {
    expect(workspaceBoardIds(deps(), 'ws-api')).toEqual(['tApi'])
    expect(workspaceBoardIds(deps(), 'ws-up')).toEqual(['tUp', 'pUp'])
  })
})
