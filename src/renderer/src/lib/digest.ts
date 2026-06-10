/**
 * Tier-1 context digest (pure). Turns a persisted canvas document into a structured
 * per-board summary using ONLY fields already on disk in canvas.json — no LLM, no key,
 * no network, no runtime state. The reopen digest panel (T-D2) renders this when no
 * cached Tier-2 prose exists; the Tier-2 loop (M-memory) layers semantic summaries on top.
 */
import type {
  Board,
  BoardType,
  BrowserBoard,
  CanvasDoc,
  ChecklistElement,
  PlanningBoard,
  TerminalBoard
} from './boardSchema'

/** One board's heuristic digest. `lines` are human-readable; `status` is a coarse label. */
export interface BoardDigest {
  boardId: string
  type: BoardType
  title: string
  status: string
  lines: string[]
}

/** The whole-canvas Tier-1 digest: a header line + one entry per board (doc order). */
export interface CanvasDigest {
  header: string
  boards: BoardDigest[]
}

function buildHeader(boards: Board[]): string {
  const n = boards.length
  const by = (t: BoardType): number => boards.filter((b) => b.type === t).length
  return `${n} board${n === 1 ? '' : 's'} — ${by('terminal')} terminal, ${by('browser')} browser, ${by('planning')} planning`
}

function digestTerminal(b: TerminalBoard, d: CanvasDoc): BoardDigest {
  const lines: string[] = []
  if (b.launchCommand) lines.push(`Runs \`${b.launchCommand}\``)
  else lines.push('No launch command set')
  if (b.cwd) lines.push(`cwd: ${b.cwd}`)
  if (b.port !== undefined) lines.push(`Dev server port ${b.port}`)
  const consumers = d.boards.filter(
    (o): o is BrowserBoard => o.type === 'browser' && o.previewSourceId === b.id
  )
  for (const consumer of consumers) lines.push(`Feeds preview "${consumer.title}"`)
  return {
    boardId: b.id,
    type: 'terminal',
    title: b.title,
    status: b.launchCommand ? 'ready' : 'idle',
    lines
  }
}
function digestBrowser(b: BrowserBoard, d: CanvasDoc): BoardDigest {
  const lines: string[] = [`URL ${b.url}`, `Viewport ${b.viewport}`]
  if (b.previewSourceId) {
    const src = d.boards.find((o) => o.id === b.previewSourceId)
    lines.push(`Preview of "${src?.title ?? b.previewSourceId}"`)
  }
  return {
    boardId: b.id,
    type: 'browser',
    title: b.title,
    status: b.previewSourceId ? 'linked' : 'static',
    lines
  }
}
function digestPlanning(b: PlanningBoard): BoardDigest {
  const checklists = b.elements.filter((e): e is ChecklistElement => e.kind === 'checklist')
  const noteCount = b.elements.filter((e) => e.kind === 'note').length
  const textCount = b.elements.filter((e) => e.kind === 'text').length
  const arrowCount = b.elements.filter((e) => e.kind === 'arrow').length
  const strokeCount = b.elements.filter((e) => e.kind === 'stroke').length
  const imageCount = b.elements.filter((e) => e.kind === 'image').length
  const lines: string[] = []
  for (const c of checklists) {
    const done = c.items.filter((i) => i.done).length
    lines.push(`${c.title}: ${done}/${c.items.length} done`)
  }
  if (noteCount > 0) lines.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`)
  if (textCount > 0) lines.push(`${textCount} text element${textCount === 1 ? '' : 's'}`)
  if (arrowCount > 0) lines.push(`${arrowCount} arrow${arrowCount === 1 ? '' : 's'}`)
  if (strokeCount > 0) lines.push(`${strokeCount} drawing${strokeCount === 1 ? '' : 's'}`)
  if (imageCount > 0) lines.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`)
  if (lines.length === 0) lines.push('Empty board')
  const totalItems = checklists.reduce((s, c) => s + c.items.length, 0)
  const totalDone = checklists.reduce((s, c) => s + c.items.filter((i) => i.done).length, 0)
  const status = checklists.length > 0 ? `${totalDone}/${totalItems} done` : 'notes'
  return { boardId: b.id, type: 'planning', title: b.title, status, lines }
}

function digestBoard(b: Board, d: CanvasDoc): BoardDigest {
  switch (b.type) {
    case 'terminal':
      return digestTerminal(b, d)
    case 'browser':
      return digestBrowser(b, d)
    case 'planning':
      return digestPlanning(b)
  }
}

export function buildDigest(d: CanvasDoc): CanvasDigest {
  return { header: buildHeader(d.boards), boards: d.boards.map((b) => digestBoard(b, d)) }
}

/**
 * T-M4: strip a leading Markdown `# heading` line (+ the blank lines after it) from cached
 * Tier-2 prose so the panel renders only the body — the card already shows the title. Pure:
 * a non-heading body (no leading `# `) is returned trimmed, unchanged.
 */
export function stripHeading(md: string): string {
  const lines = md.split(/\r?\n/)
  if (lines[0]?.startsWith('# ')) {
    lines.shift()
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  }
  return lines.join('\n').trim()
}
