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

/** Common skeleton; per-type helpers fill `status` + `lines`. */
function base(b: Board): BoardDigest {
  return { boardId: b.id, type: b.type, title: b.title, status: '', lines: [] }
}

function digestTerminal(b: TerminalBoard, d: CanvasDoc): BoardDigest {
  const lines: string[] = []
  if (b.launchCommand) lines.push(`Runs \`${b.launchCommand}\``)
  else lines.push('No launch command set')
  if (b.cwd) lines.push(`cwd: ${b.cwd}`)
  if (b.port !== undefined) lines.push(`Dev server port ${b.port}`)
  const consumer = d.boards.find(
    (o): o is BrowserBoard => o.type === 'browser' && o.previewSourceId === b.id
  )
  if (consumer) lines.push(`Feeds preview "${consumer.title}"`)
  return {
    boardId: b.id,
    type: 'terminal',
    title: b.title,
    status: b.launchCommand ? 'ready' : 'idle',
    lines
  }
}
function digestBrowser(b: BrowserBoard, _doc: CanvasDoc): BoardDigest {
  return base(b)
}
function digestPlanning(b: PlanningBoard): BoardDigest {
  return base(b)
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

// `ChecklistElement` is imported here so later tasks (planning) need no import churn.
export type { ChecklistElement }
