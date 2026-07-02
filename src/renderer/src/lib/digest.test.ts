import { describe, it, expect } from 'vitest'
import { buildDigest, stripHeading } from './digest'
import type {
  CanvasDoc,
  TerminalBoard,
  BrowserBoard,
  PlanningBoard,
  PlanningElement,
  ChecklistElement,
  NoteElement,
  TextElement,
  ArrowElement,
  StrokeElement,
  ImageElement,
  DiagramElement,
  FileRefElement,
  CommandBoard,
  FileBoard,
  DataFlowBoard,
  KanbanBoard
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
  return { schemaVersion: 2, viewport: null, boards, connectors: [] }
}
function command(p: { id: string }): CommandBoard {
  return { type: 'command', x: 0, y: 0, w: 420, h: 340, title: 'Command', ...p }
}
function file(p: { id: string }): FileBoard {
  return { type: 'file', x: 0, y: 0, w: 420, h: 340, title: 'File', ...p }
}
function dataflow(p: { id: string }): DataFlowBoard {
  return { type: 'dataflow', x: 0, y: 0, w: 420, h: 340, title: 'Data Flow', ...p }
}
function kanban(p: { id: string }): KanbanBoard {
  return {
    type: 'kanban',
    x: 0,
    y: 0,
    w: 420,
    h: 340,
    title: 'Kanban',
    columns: [],
    cards: [],
    ...p
  }
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

  it('uses singular "board" for a single board', () => {
    expect(buildDigest(doc([terminal({ id: 't1' })])).header).toBe(
      '1 board — 1 terminal, 0 browser, 0 planning'
    )
  })

  it('breaks out file/dataflow/kanban board types alongside command (BUG-052)', () => {
    const d = buildDigest(
      doc([
        terminal({ id: 't1' }),
        command({ id: 'c1' }),
        file({ id: 'f1' }),
        dataflow({ id: 'df1' }),
        kanban({ id: 'k1' })
      ])
    )
    expect(d.header).toBe(
      '5 boards — 1 terminal, 0 browser, 0 planning, 1 command, 1 file, 1 dataflow, 1 kanban'
    )
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

  // BUG-063 regression: all linked browser consumers must be reported, not just the first
  it('BUG-063: reports all linked preview consumers (not just the first)', () => {
    const d = buildDigest(
      doc([
        terminal({ id: 't1', title: 'Dev', launchCommand: 'pnpm dev' }),
        browser({ id: 'b1', title: 'Mobile', previewSourceId: 't1', viewport: 'mobile' }),
        browser({ id: 'b2', title: 'Tablet', previewSourceId: 't1', viewport: 'tablet' }),
        browser({ id: 'b3', title: 'Desktop', previewSourceId: 't1', viewport: 'desktop' })
      ])
    )
    const t = d.boards[0]
    expect(t.lines).toContain('Feeds preview "Mobile"')
    expect(t.lines).toContain('Feeds preview "Tablet"')
    expect(t.lines).toContain('Feeds preview "Desktop"')
    // All three, not just one
    const feedLines = t.lines.filter((l) => l.startsWith('Feeds preview'))
    expect(feedLines).toHaveLength(3)
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
    expect(b.lines).toEqual([
      'URL http://localhost:5173',
      'Viewport desktop',
      'Preview of "Dev server"'
    ])
    // and the terminal side reports the reverse link
    expect(d.boards[0].lines).toContain('Feeds preview "Browser"')
  })

  it('falls back to the raw id when the source terminal is gone', () => {
    const d = buildDigest(doc([browser({ id: 'b1', previewSourceId: 'missing' })]))
    expect(d.boards[0].lines).toContain('Preview of "missing"')
  })
})

function checklist(title: string, done: number, total: number): ChecklistElement {
  const items = Array.from({ length: total }, (_, i) => ({
    id: `i${i}`,
    label: `item ${i}`,
    done: i < done
  }))
  return { kind: 'checklist', id: `c-${title}`, x: 0, y: 0, w: 240, h: 0, title, items }
}
function note(id: string): NoteElement {
  return { kind: 'note', id, x: 0, y: 0, w: 160, h: 120, tint: 'yellow', text: 'hi' }
}
function textEl(id: string): TextElement {
  return { kind: 'text', id, x: 0, y: 0, text: 'hello' }
}
function arrowEl(id: string): ArrowElement {
  return { kind: 'arrow', id, x: 0, y: 0, x2: 100, y2: 0 }
}
function strokeEl(id: string): StrokeElement {
  return { kind: 'stroke', id, x: 0, y: 0, points: [0, 0, 10, 10] }
}
function imageEl(id: string): ImageElement {
  return { kind: 'image', id, x: 0, y: 0, w: 200, h: 150, assetId: 'assets/img.png' }
}
function diagramEl(id: string): DiagramElement {
  return {
    kind: 'diagram',
    id,
    x: 0,
    y: 0,
    w: 200,
    h: 150,
    source: 'graph TD; A-->B',
    engine: 'mermaid'
  }
}
function fileRefEl(id: string): FileRefElement {
  return { kind: 'fileref', id, x: 0, y: 0, w: 200, h: 60, path: 'src/foo.ts', label: 'foo.ts' }
}

describe('buildDigest — planning', () => {
  it('reports checklist progress and note count', () => {
    const d = buildDigest(
      doc([
        planning({
          id: 'p1',
          elements: [checklist('Auth', 1, 3), checklist('UI', 2, 2), note('n1'), note('n2')]
        })
      ])
    )
    const p = d.boards[0]
    expect(p.lines).toEqual(['Auth: 1/3 done', 'UI: 2/2 done', '2 notes'])
    expect(p.status).toBe('3/5 done')
  })

  it('uses singular "note" for one note and notes status with no checklist', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [note('n1')] })]))
    expect(d.boards[0].lines).toEqual(['1 note'])
    expect(d.boards[0].status).toBe('notes')
  })

  it('labels a truly empty planning board', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [] })]))
    expect(d.boards[0].lines).toEqual(['Empty board'])
    expect(d.boards[0].status).toBe('notes')
  })

  // BUG-060 regression: boards with only text/arrow/stroke/image elements must NOT report 'Empty board'
  it('BUG-060: does not label a board with only text elements as Empty board', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [textEl('t1'), textEl('t2')] })]))
    const p = d.boards[0]
    expect(p.lines).not.toContain('Empty board')
    expect(p.lines).toContain('2 text elements')
    expect(p.status).toBe('notes')
  })

  it('BUG-060: does not label a board with only arrow elements as Empty board', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [arrowEl('a1')] })]))
    expect(d.boards[0].lines).not.toContain('Empty board')
    expect(d.boards[0].lines).toContain('1 arrow')
  })

  it('BUG-060: does not label a board with only stroke elements as Empty board', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [strokeEl('s1'), strokeEl('s2')] })]))
    expect(d.boards[0].lines).not.toContain('Empty board')
    expect(d.boards[0].lines).toContain('2 drawings')
  })

  it('BUG-060: does not label a board with only image elements as Empty board', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [imageEl('i1')] })]))
    expect(d.boards[0].lines).not.toContain('Empty board')
    expect(d.boards[0].lines).toContain('1 image')
  })

  // BUG-036 regression: boards with only diagram/fileref elements must NOT report 'Empty board'
  // (digestPlanning previously omitted these two kinds from the line/count set — sibling to BUG-060).
  it('BUG-036: does not label a board with only diagram elements as Empty board', () => {
    const d = buildDigest(
      doc([planning({ id: 'p1', elements: [diagramEl('d1'), diagramEl('d2')] })])
    )
    const p = d.boards[0]
    expect(p.lines).not.toContain('Empty board')
    expect(p.lines).toContain('2 diagrams')
  })

  it('BUG-036: does not label a board with only fileref elements as Empty board', () => {
    const d = buildDigest(doc([planning({ id: 'p1', elements: [fileRefEl('f1')] })]))
    expect(d.boards[0].lines).not.toContain('Empty board')
    expect(d.boards[0].lines).toContain('1 file reference')
  })

  it('BUG-060: reports all element kinds together', () => {
    const d = buildDigest(
      doc([
        planning({
          id: 'p1',
          elements: [
            checklist('Tasks', 1, 2),
            note('n1'),
            textEl('tx1'),
            arrowEl('ar1'),
            strokeEl('st1'),
            imageEl('im1'),
            diagramEl('di1'),
            fileRefEl('fr1')
          ]
        })
      ])
    )
    const p = d.boards[0]
    expect(p.lines).toContain('Tasks: 1/2 done')
    expect(p.lines).toContain('1 note')
    expect(p.lines).toContain('1 text element')
    expect(p.lines).toContain('1 arrow')
    expect(p.lines).toContain('1 drawing')
    expect(p.lines).toContain('1 image')
    expect(p.lines).toContain('1 diagram')
    expect(p.lines).toContain('1 file reference')
    expect(p.lines).not.toContain('Empty board')
  })
})

describe('stripHeading', () => {
  it('strips a leading "# title" line and the blank line after it', () => {
    expect(stripHeading('# Dev server\n\nRuns the Vite dev server on port 5173.\n')).toBe(
      'Runs the Vite dev server on port 5173.'
    )
  })

  it('keeps multi-paragraph prose intact below the heading', () => {
    expect(stripHeading('# Plan\n\nFirst line.\n\nSecond line.\n')).toBe(
      'First line.\n\nSecond line.'
    )
  })

  it('returns trimmed input unchanged when there is no heading', () => {
    expect(stripHeading('Just prose, no heading.\n')).toBe('Just prose, no heading.')
  })

  it('returns empty string when the file is only a heading', () => {
    expect(stripHeading('# Title only\n')).toBe('')
  })

  it('does not treat a non-heading hash (no trailing space) as a heading', () => {
    expect(stripHeading('#notaheading\nbody')).toBe('#notaheading\nbody')
  })

  it('handles CRLF line endings', () => {
    expect(stripHeading('# Title\r\n\r\nBody line.\r\n')).toBe('Body line.')
  })

  it('drains multiple blank lines after a heading-only file', () => {
    expect(stripHeading('# Title only\n\n')).toBe('')
  })
})
