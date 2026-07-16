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
      'spawn_board',
      'relay_prompt',
      'add_card',
      'update_card',
      'move_card',
      'visualize_plan'
    ])
    for (const banned of ['close_board', 'remove_card', 'remove_planning_element']) {
      expect(names).not.toContain(banned)
    }
  })

  it('read/focus/tidy auto-allow; everything else gates', () => {
    for (const name of JARVIS_AUTO_ALLOW) expect(isJarvisToolGated(name)).toBe(false)
    for (const name of [
      'spawn_board',
      'relay_prompt',
      'add_card',
      'update_card',
      'move_card',
      'visualize_plan'
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
