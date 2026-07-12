import { describe, it, expect } from 'vitest'
import { MANIFEST_MAX_BOARDS, buildWorkspaceManifest } from './jarvisManifest'
import type { AppModel, AppModelBoard } from './appModel'

function model(boards: AppModelBoard[], groups: AppModel['canvas']['groups'] = []): AppModel {
  return {
    version: 1,
    boardTypes: [],
    tools: [],
    canvas: { boards, connectors: [], groups },
    rules: { spawnCap: 4, everyWriteGated: true }
  }
}

const board = (over: Partial<AppModelBoard> & { id: string }): AppModelBoard => ({
  type: 'terminal',
  title: 'auth api',
  status: 'running',
  ...over
})

describe('buildWorkspaceManifest (J3 semantic-targeting manifest)', () => {
  it('null model → null (the Workspace block is simply omitted)', () => {
    expect(buildWorkspaceManifest(null)).toBeNull()
  })

  it('empty canvas states so explicitly', () => {
    expect(buildWorkspaceManifest(model([]))).toContain('empty')
  })

  it('one line per board with id prefix, type, title, status', () => {
    const m = buildWorkspaceManifest(model([board({ id: 'abcdef1234567890' })]))
    expect(m).toContain('[abcdef12] terminal "auth api" · running')
    expect(m).toContain('Boards (1):')
  })

  it('geometry maps to coarse regions relative to the canvas bounds', () => {
    const m = buildWorkspaceManifest(
      model([
        board({ id: 'a'.repeat(12), x: 0, y: 0, w: 100, h: 100 }),
        board({ id: 'b'.repeat(12), title: 'tests', x: 900, y: 900, w: 100, h: 100 })
      ])
    )
    expect(m).toContain('top-left')
    expect(m).toContain('bottom-right')
  })

  it('group membership rides the board line and the groups summary', () => {
    const m = buildWorkspaceManifest(
      model(
        [board({ id: 'x'.repeat(12) })],
        [{ id: 'g1', name: 'Auth zone', boardIds: ['x'.repeat(12)] }]
      )
    )
    expect(m).toContain('group:Auth zone')
    expect(m).toContain('Groups: Auth zone(1)')
  })

  it('caps the board list and says how many were shown', () => {
    const boards = Array.from({ length: MANIFEST_MAX_BOARDS + 15 }, (_, i) =>
      board({ id: `id-${i}-${'0'.repeat(8)}` })
    )
    const m = buildWorkspaceManifest(model(boards)) as string
    expect(m).toContain(`Boards (${MANIFEST_MAX_BOARDS + 15}, showing ${MANIFEST_MAX_BOARDS}):`)
    expect(m.split('\n').filter((l) => l.startsWith('- [')).length).toBe(MANIFEST_MAX_BOARDS)
  })

  it('clips a runaway title', () => {
    const m = buildWorkspaceManifest(
      model([board({ id: 'y'.repeat(12), title: 'T'.repeat(120) })])
    ) as string
    expect(m).toContain('…')
    expect(m.length).toBeLessThan(300)
  })
})
