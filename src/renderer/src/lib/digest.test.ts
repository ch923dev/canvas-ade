import { describe, it, expect } from 'vitest'
import { buildDigest } from './digest'
import type {
  CanvasDoc,
  TerminalBoard,
  BrowserBoard,
  PlanningBoard,
  PlanningElement
} from './boardSchema'

// ── test builders (minimal valid boards) ─────────────────────────────────────
function terminal(p: Partial<TerminalBoard> & { id: string }): TerminalBoard {
  return { type: 'terminal', x: 0, y: 0, w: 420, h: 340, title: 'Terminal', ...p }
}
function browser(p: Partial<BrowserBoard> & { id: string }): BrowserBoard {
  return {
    type: 'browser',
    x: 0,
    y: 0,
    w: 700,
    h: 500,
    title: 'Browser',
    url: 'http://localhost:5173',
    viewport: 'desktop',
    ...p
  }
}
function planning(
  p: Partial<PlanningBoard> & { id: string; elements?: PlanningElement[] }
): PlanningBoard {
  return { type: 'planning', x: 0, y: 0, w: 516, h: 366, title: 'Planning', elements: [], ...p }
}
function doc(boards: CanvasDoc['boards']): CanvasDoc {
  return { schemaVersion: 2, viewport: null, boards }
}

describe('buildDigest — header', () => {
  it('summarizes an empty canvas', () => {
    const d = buildDigest(doc([]))
    expect(d.header).toBe('0 boards — 0 terminal, 0 browser, 0 planning')
    expect(d.boards).toEqual([])
  })

  it('counts boards by type and carries one digest per board', () => {
    const d = buildDigest(
      doc([terminal({ id: 't1' }), browser({ id: 'b1' }), planning({ id: 'p1' })])
    )
    expect(d.header).toBe('3 boards — 1 terminal, 1 browser, 1 planning')
    expect(d.boards.map((x) => x.boardId)).toEqual(['t1', 'b1', 'p1'])
    expect(d.boards.map((x) => x.type)).toEqual(['terminal', 'browser', 'planning'])
    expect(d.boards.every((x) => typeof x.title === 'string')).toBe(true)
  })
})

describe('buildDigest — terminal', () => {
  it('reports launchCommand, cwd and port', () => {
    const d = buildDigest(
      doc([terminal({ id: 't1', launchCommand: 'claude', cwd: 'Z:/app', port: 5173 })])
    )
    const t = d.boards[0]
    expect(t.status).toBe('ready')
    expect(t.lines).toEqual(['Runs `claude`', 'cwd: Z:/app', 'Dev server port 5173'])
  })

  it('flags a terminal with no launch command as idle', () => {
    const d = buildDigest(doc([terminal({ id: 't1' })]))
    expect(d.boards[0].status).toBe('idle')
    expect(d.boards[0].lines).toEqual(['No launch command set'])
  })
})

describe('buildDigest — browser', () => {
  it('reports url and viewport for an unlinked browser', () => {
    const d = buildDigest(
      doc([browser({ id: 'b1', url: 'http://localhost:3000', viewport: 'mobile' })])
    )
    const b = d.boards[0]
    expect(b.status).toBe('static')
    expect(b.lines).toEqual(['URL http://localhost:3000', 'Viewport mobile'])
  })

  it('names the source terminal when previewSourceId is set', () => {
    const d = buildDigest(
      doc([
        terminal({ id: 't1', title: 'Dev server', launchCommand: 'pnpm dev', port: 5173 }),
        browser({ id: 'b1', previewSourceId: 't1' })
      ])
    )
    const b = d.boards[1]
    expect(b.status).toBe('linked')
    expect(b.lines).toContain('Preview of "Dev server"')
    // and the terminal side reports the reverse link
    expect(d.boards[0].lines).toContain('Feeds preview "Browser"')
  })

  it('falls back to the raw id when the source terminal is gone', () => {
    const d = buildDigest(doc([browser({ id: 'b1', previewSourceId: 'missing' })]))
    expect(d.boards[0].lines).toContain('Preview of "missing"')
  })
})
