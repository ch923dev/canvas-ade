/**
 * Jarvis J4 — jarvisTools unit tests: the curated catalog + risk tiers, reference
 * resolution (id / unique prefix / exact title; ambiguity asks, never guesses), the
 * MAIN-side arg validation (model output = untrusted), the spawn pre-confirm gate
 * (approve / decline), the deny-error mapping, and the injection-audit invariants
 * (no destructive tool in the catalog; outcome summaries built from validated args).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildJarvisToolDefs,
  executeJarvisTool,
  isJarvisToolGated,
  resolveBoardRef,
  JARVIS_AUTO_ALLOW,
  type JarvisCanvasFacet
} from './jarvisTools'
import type { AppModel } from './appModel'

function model(
  boards: Array<{ id: string; type?: string; title?: string }>,
  groups: Array<{ id: string; name: string; boardIds: string[] }> = []
): AppModel {
  return {
    version: 1,
    boardTypes: [],
    tools: [],
    canvas: {
      boards: boards.map((b) => ({
        id: b.id,
        type: b.type ?? 'terminal',
        title: b.title ?? 'auth api',
        status: 'running'
      })),
      connectors: [],
      groups
    },
    rules: { spawnCap: 4, everyWriteGated: true }
  }
}

const KANBAN_ID = 'k1k1k1k1-0000-0000-0000-000000000000'
const TERM_ID = 't2t2t2t2-0000-0000-0000-000000000000'

function makeFacet(over: Partial<JarvisCanvasFacet> = {}): JarvisCanvasFacet {
  return {
    describeApp: async () =>
      model([
        { id: KANBAN_ID, type: 'kanban', title: 'Sprint board' },
        { id: TERM_ID, type: 'terminal', title: 'auth api' }
      ]),
    spawnBoard: vi.fn(async () => ({ id: 'new-board-id-123456' })),
    dispatchPrompt: vi.fn(async () => ({ delivery: 'ready' as const })),
    addCard: vi.fn(async () => ({ id: 'card-9' })),
    updateCard: vi.fn(async () => {}),
    moveCard: vi.fn(async () => {}),
    visualizePlan: vi.fn(async () => ({ id: 'viz-board-id-123456' })),
    focusViewport: vi.fn(async () => ({ focused: 'board' as const, id: TERM_ID })),
    tidyCanvas: vi.fn(async () => ({ moved: 3 })),
    makeMainBoard: vi.fn(async () => ({ moved: 3, fitZoom: 0.7, readable: true })),
    describeContexts: vi.fn(async () => ({ version: 1 as const, contexts: [], ungrouped: [] })),
    groupBoards: vi.fn(async () => []),
    editGroups: vi.fn(async () => []),
    boardCards: vi.fn(async () => ({
      isKanban: true,
      columns: [
        { id: 'col-a', title: 'Backlog' },
        { id: 'col-b', title: 'Doing' }
      ]
    })),
    ...over
  }
}

const approve = async (): Promise<{ approved: boolean }> => ({ approved: true })

describe('catalog + risk tiers', () => {
  it('exposes exactly the curated set — nothing destructive', () => {
    const names = buildJarvisToolDefs().map((t) => t.name)
    expect(names).toEqual([
      'list_boards',
      'board_cards',
      'focus_viewport',
      'tidy_canvas',
      'make_main_board',
      'spawn_board',
      'relay_prompt',
      'add_card',
      'update_card',
      'move_card',
      'visualize_plan',
      'list_groups',
      'group_boards',
      'edit_groups'
    ])
    for (const banned of ['close_board', 'remove_card', 'remove_planning_element']) {
      expect(names).not.toContain(banned)
    }
  })

  it('read/focus/tidy/list_groups auto-allow; everything else gates', () => {
    for (const name of JARVIS_AUTO_ALLOW) expect(isJarvisToolGated(name)).toBe(false)
    for (const name of [
      'spawn_board',
      'relay_prompt',
      'add_card',
      'update_card',
      'move_card',
      'visualize_plan',
      'group_boards',
      'edit_groups'
    ]) {
      expect(isJarvisToolGated(name)).toBe(true)
    }
  })
})

describe('resolveBoardRef', () => {
  const m = model([
    { id: 'abcdef1234567890', title: 'Sprint board', type: 'kanban' },
    { id: 'abzzzz9876543210', title: 'auth api' },
    { id: 'cccccc1234567890', title: 'auth api' }
  ])

  it('resolves a full id, a unique ≥6-char prefix, and an exact title', () => {
    expect(resolveBoardRef(m, 'abcdef1234567890').title).toBe('Sprint board')
    expect(resolveBoardRef(m, 'abcdef').id).toBe('abcdef1234567890')
    expect(resolveBoardRef(m, 'sprint BOARD').id).toBe('abcdef1234567890')
  })

  it('an ambiguous title asks (throws with candidates), never guesses', () => {
    expect(() => resolveBoardRef(m, 'auth api')).toThrow(/ambiguous/)
  })

  it('ambiguity candidates are NUMBERED so "the second one" answers deterministically (J5)', () => {
    try {
      resolveBoardRef(m, 'auth api')
      expect.unreachable('should have thrown')
    } catch (err) {
      const msg = (err as Error).message
      expect(msg).toMatch(/1\. \[/)
      expect(msg).toMatch(/2\. \[/)
      expect(msg).toContain('which NUMBER')
    }
  })

  it('a short prefix does not resolve (guessing surface)', () => {
    expect(() => resolveBoardRef(m, 'ab')).toThrow(/no board/)
  })

  it('a type mismatch is a typed refusal', () => {
    expect(() => resolveBoardRef(m, 'abcdef', 'terminal')).toThrow(/is a kanban/)
  })
})

describe('executeJarvisTool', () => {
  it('add_card resolves the board + defaults to the FIRST column', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'add_card',
      { board: 'k1k1k1', title: 'smoke test' },
      { facet, confirm: approve }
    )
    expect(r.isError).toBe(false)
    expect(facet.addCard).toHaveBeenCalledWith(KANBAN_ID, {
      columnId: 'col-a',
      title: 'smoke test'
    })
    expect(r.content).toContain('card-9')
    expect(r.summary).toContain('smoke test')
  })

  it('add_card resolves a column by exact title', async () => {
    const facet = makeFacet()
    await executeJarvisTool(
      'add_card',
      { board: 'Sprint board', title: 'x', column: 'doing' },
      { facet, confirm: approve }
    )
    expect(facet.addCard).toHaveBeenCalledWith(KANBAN_ID, { columnId: 'col-b', title: 'x' })
  })

  it('add_card refuses a non-kanban board before any call', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'add_card',
      { board: 'auth api', title: 'x' },
      { facet, confirm: approve }
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/is a terminal/)
    expect(facet.addCard).not.toHaveBeenCalled()
  })

  it('spawn_board pays the Jarvis pre-confirm; decline changes nothing', async () => {
    const facet = makeFacet()
    const confirm = vi.fn(async (_req: { title: string; body: string }) => ({ approved: false }))
    const r = await executeJarvisTool(
      'spawn_board',
      { type: 'terminal', title: 'migration', launch_command: 'claude' },
      { facet, confirm }
    )
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0].body).toContain('running: claude')
    expect(r.denied).toBe(true)
    expect(r.isError).toBe(true)
    expect(facet.spawnBoard).not.toHaveBeenCalled()
  })

  it('spawn_board approved maps launch_command → the sanitized spawn prompt param', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'spawn_board',
      { type: 'terminal', title: 'migration', launch_command: 'claude', cwd: 'M:/x' },
      { facet, confirm: approve }
    )
    expect(r.isError).toBe(false)
    expect(facet.spawnBoard).toHaveBeenCalledWith({
      type: 'terminal',
      title: 'migration',
      prompt: 'claude',
      cwd: 'M:/x'
    })
  })

  it('spawn_board refuses kanban BEFORE the confirm gate (visualize_plan owns that path)', async () => {
    const facet = makeFacet()
    const confirm = vi.fn(approve)
    const r = await executeJarvisTool(
      'spawn_board',
      { type: 'kanban', title: 'bug tracker' },
      { facet, confirm }
    )
    expect(r.isError).toBe(true)
    expect(r.content).toContain('visualize_plan')
    // The human is never asked to approve a structurally impossible spawn.
    expect(confirm).not.toHaveBeenCalled()
    expect(facet.spawnBoard).not.toHaveBeenCalled()
  })

  it('spawn_board no longer advertises kanban (schema mirrors the SPAWNABLE allowlist)', () => {
    const def = buildJarvisToolDefs().find((t) => t.name === 'spawn_board')
    expect(def).toBeDefined()
    const props = def!.input_schema.properties as Record<string, { enum?: string[] }>
    expect(props.type.enum).toEqual(['terminal', 'browser', 'planning'])
    expect(def!.description).toContain('visualize_plan')
  })

  it('relay_prompt requires a TERMINAL target and reports delivery', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'relay_prompt',
      { board: 'auth api', text: 'run the tests' },
      { facet, confirm: approve }
    )
    expect(r.isError).toBe(false)
    expect(facet.dispatchPrompt).toHaveBeenCalledWith(TERM_ID, 'run the tests')
    expect(r.content).toContain('ready')
    const wrong = await executeJarvisTool(
      'relay_prompt',
      { board: 'Sprint board', text: 'x' },
      { facet, confirm: approve }
    )
    expect(wrong.isError).toBe(true)
  })

  it('a gate DENY thrown by the orchestrator maps to denied (not a generic error)', async () => {
    const facet = makeFacet({
      addCard: vi.fn(async () => {
        throw new Error('add_card: write denied by the human gate')
      })
    })
    const r = await executeJarvisTool(
      'add_card',
      { board: 'k1k1k1', title: 'x' },
      { facet, confirm: approve }
    )
    expect(r.denied).toBe(true)
    expect(r.isError).toBe(true)
  })

  it('validation: missing/oversized args refuse before any facet call', async () => {
    const facet = makeFacet()
    expect(
      (await executeJarvisTool('add_card', { board: 'k1k1k1' }, { facet, confirm: approve }))
        .isError
    ).toBe(true)
    expect(
      (
        await executeJarvisTool(
          'relay_prompt',
          { board: 'auth api', text: 'x'.repeat(5000) },
          { facet, confirm: approve }
        )
      ).isError
    ).toBe(true)
    expect(facet.dispatchPrompt).not.toHaveBeenCalled()
  })

  it('focus_viewport / tidy_canvas run without any confirm (auto-allow tier)', async () => {
    const facet = makeFacet()
    const confirm = vi.fn(approve)
    const f = await executeJarvisTool('focus_viewport', { board: 'auth api' }, { facet, confirm })
    const t = await executeJarvisTool('tidy_canvas', {}, { facet, confirm })
    expect(f.isError).toBe(false)
    expect(t.isError).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('tidy_canvas has NO mode (implicit roles) and only an optional boards / group scope', () => {
    const def = buildJarvisToolDefs().find((d) => d.name === 'tidy_canvas')!
    const props = (def.input_schema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).toEqual(['boards', 'group'])
    expect(def.description).toMatch(/tidy the api and notes group/)
    expect(def.description).toMatch(/use make_main_board instead/)
    expect(def.input_schema).toMatchObject({ additionalProperties: false })
    expect(isJarvisToolGated('tidy_canvas')).toBe(false) // tier unchanged: READ, auto-allow
  })

  it('tidy_canvas with no args forwards {} — the whole-canvas implicit roles', async () => {
    const facet = makeFacet()
    await executeJarvisTool('tidy_canvas', {}, { facet, confirm: vi.fn(approve) })
    expect(facet.tidyCanvas).toHaveBeenCalledWith({})
  })

  it('tidy_canvas resolves boards (id prefix or exact title) to full ids (S12)', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'tidy_canvas',
      { boards: [TERM_ID.slice(0, 8), 'Sprint board'] },
      { facet, confirm: vi.fn(approve) }
    )
    expect(r.isError).toBe(false)
    expect(facet.tidyCanvas).toHaveBeenCalledWith({ boardIds: [TERM_ID, KANBAN_ID] })
  })

  it('tidy_canvas DROPS unknown references; all-unknown boards is a no-op (facet never called)', async () => {
    const facet = makeFacet()
    const one = await executeJarvisTool(
      'tidy_canvas',
      { boards: ['auth api', 'ghost'] },
      { facet, confirm: vi.fn(approve) }
    )
    expect(one.isError).toBe(false)
    expect(facet.tidyCanvas).toHaveBeenCalledWith({ boardIds: [TERM_ID] })
    const none = await executeJarvisTool(
      'tidy_canvas',
      { boards: ['ghost', 'phantom'] },
      { facet, confirm: vi.fn(approve) }
    )
    expect(none.isError).toBe(false)
    expect(facet.tidyCanvas).toHaveBeenCalledTimes(1)
  })

  it('make_main_board: required board + optional side enum; auto-allow tier; points away from tidy', () => {
    const def = buildJarvisToolDefs().find((d) => d.name === 'make_main_board')!
    expect(def.input_schema).toMatchObject({
      required: ['board'],
      additionalProperties: false,
      properties: { side: { enum: ['auto', 'right', 'left', 'bottom', 'top'] } }
    })
    expect(def.description).toMatch(/make the browser the main one/)
    expect(def.description).toMatch(/EVERY other board/)
    expect(isJarvisToolGated('make_main_board')).toBe(false)
  })

  it('make_main_board resolves the board strictly and forwards it (+ side) to the facet', async () => {
    const facet = makeFacet()
    const confirm = vi.fn(approve)
    const r = await executeJarvisTool('make_main_board', { board: 'auth api' }, { facet, confirm })
    expect(r.isError).toBe(false)
    expect(facet.makeMainBoard).toHaveBeenCalledWith({ boardId: TERM_ID })
    expect(r.summary).toBe('make_main_board · "auth api" main · 3 board(s) moved')
    expect(confirm).not.toHaveBeenCalled()
    await executeJarvisTool(
      'make_main_board',
      { board: TERM_ID.slice(0, 8), side: 'left' },
      { facet, confirm }
    )
    expect(facet.makeMainBoard).toHaveBeenLastCalledWith({ boardId: TERM_ID, side: 'left' })
    expect(facet.tidyCanvas).not.toHaveBeenCalled() // never a fallback plain tidy
  })

  it('make_main_board FAILS loudly on an unknown board, a missing board or a bad side', async () => {
    const facet = makeFacet()
    for (const input of [{ board: 'ghost' }, {}, { board: 'auth api', side: 'diagonal' }]) {
      const r = await executeJarvisTool('make_main_board', input, {
        facet,
        confirm: vi.fn(approve)
      })
      expect(r.isError).toBe(true)
    }
    expect(facet.makeMainBoard).not.toHaveBeenCalled()
  })

  it('make_main_board surfaces the facet error (docked / gone board) instead of tidying', async () => {
    const facet = makeFacet({
      makeMainBoard: vi.fn(async () => {
        throw new Error('that board is not on the canvas (or it is docked inside a swarm board)')
      })
    })
    const r = await executeJarvisTool(
      'make_main_board',
      { board: 'auth api' },
      {
        facet,
        confirm: vi.fn(approve)
      }
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/docked inside a swarm board/)
  })

  it('tidy_canvas rejects a malformed boards list (model output is untrusted)', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool(
      'tidy_canvas',
      { boards: 'auth api' },
      { facet, confirm: vi.fn(approve) }
    )
    expect(r.isError).toBe(true)
    expect(facet.tidyCanvas).not.toHaveBeenCalled()
  })

  it('list_boards projects id8 + title + status (never page content fields)', async () => {
    const facet = makeFacet()
    const r = await executeJarvisTool('list_boards', {}, { facet, confirm: approve })
    const parsed = JSON.parse(r.content) as { boards: Array<Record<string, unknown>> }
    expect(parsed.boards[0].id).toBe(KANBAN_ID.slice(0, 8))
    expect(Object.keys(parsed.boards[0]).sort()).toEqual(['id', 'status', 'title', 'type'])
  })

  it('an unknown tool name refuses', async () => {
    const r = await executeJarvisTool('close_board', {}, { facet: makeFacet(), confirm: approve })
    expect(r.isError).toBe(true)
  })
})

describe('tidy_canvas group (I3 — "tidy the api and notes group")', () => {
  const G_API = 'gapi0000-0000-0000-0000-000000000000'
  const G_DUP1 = 'gdup1111-0000-0000-0000-000000000000'
  const G_DUP2 = 'gdup2222-0000-0000-0000-000000000000'
  const withGroups = (over: Partial<JarvisCanvasFacet> = {}): JarvisCanvasFacet =>
    makeFacet({
      describeApp: async () =>
        model(
          [
            { id: KANBAN_ID, type: 'kanban', title: 'Sprint board' },
            { id: TERM_ID, type: 'terminal', title: 'auth api' }
          ],
          [
            { id: G_API, name: 'api and notes', boardIds: [TERM_ID] },
            { id: G_DUP1, name: 'Docs', boardIds: [KANBAN_ID] },
            { id: G_DUP2, name: 'docs', boardIds: [] }
          ]
        ),
      ...over
    })

  it('by exact name (case-insensitive) or id ⇒ scope { groupId }, no confirm (READ tier)', async () => {
    const facet = withGroups()
    const confirm = vi.fn(approve)
    const r = await executeJarvisTool('tidy_canvas', { group: 'API and Notes' }, { facet, confirm })
    expect(r.isError).toBe(false)
    expect(facet.tidyCanvas).toHaveBeenCalledWith({ groupId: G_API })
    expect(r.summary).toBe('tidy_canvas · group "api and notes" · 3 board(s) moved')
    await executeJarvisTool('tidy_canvas', { group: G_API }, { facet, confirm })
    await executeJarvisTool('tidy_canvas', { group: G_API.slice(0, 8) }, { facet, confirm })
    expect(facet.tidyCanvas).toHaveBeenCalledTimes(3)
    expect(facet.tidyCanvas).toHaveBeenLastCalledWith({ groupId: G_API })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('says when the group moved to open space (the C6 relocated fact)', async () => {
    const facet = withGroups({
      tidyCanvas: vi.fn(async () => ({ moved: 3, relocated: true as const }))
    })
    const r = await executeJarvisTool(
      'tidy_canvas',
      { group: 'api and notes' },
      {
        facet,
        confirm: vi.fn(approve)
      }
    )
    expect(r.summary).toBe('tidy_canvas · group "api and notes" · 3 board(s) moved to open space')
    expect(JSON.parse(r.content)).toEqual({ moved: 3, relocated: true })
  })

  it('an unknown group FAILS (never a fallback tidy); an ambiguous one lists numbered candidates', async () => {
    const facet = withGroups()
    const unknown = await executeJarvisTool(
      'tidy_canvas',
      { group: 'ghost' },
      {
        facet,
        confirm: vi.fn(approve)
      }
    )
    expect(unknown.isError).toBe(true)
    expect(unknown.content).toMatch(/no group matches "ghost"/)
    const ambiguous = await executeJarvisTool(
      'tidy_canvas',
      { group: 'docs' },
      {
        facet,
        confirm: vi.fn(approve)
      }
    )
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.content).toMatch(/ambiguous — candidates: 1\. \[gdup1111\] "Docs" {2}2\./)
    expect(facet.tidyCanvas).not.toHaveBeenCalled()
  })

  it('group + boards together is rejected (pass at most one)', async () => {
    const facet = withGroups()
    const r = await executeJarvisTool(
      'tidy_canvas',
      { group: 'api and notes', boards: ['auth api'] },
      { facet, confirm: vi.fn(approve) }
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/at most one of boards \/ group/)
    expect(facet.tidyCanvas).not.toHaveBeenCalled()
  })

  it('a non-string group is rejected (model output is untrusted)', async () => {
    const facet = withGroups()
    const r = await executeJarvisTool(
      'tidy_canvas',
      { group: 7 },
      {
        facet,
        confirm: vi.fn(approve)
      }
    )
    expect(r.isError).toBe(true)
    expect(facet.tidyCanvas).not.toHaveBeenCalled()
  })
})
