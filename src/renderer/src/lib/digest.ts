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
  CommandBoard,
  DataFlowBoard,
  FileBoard,
  KanbanBoard,
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

/**
 * The digest is a pure function of the persisted BOARDS — it reads neither the camera
 * `viewport` (so a settled-camera pan must NOT invalidate the memoised digest in Canvas —
 * CANVAS-01) nor `schemaVersion`. Taking the doc sans camera makes that independence
 * explicit in the type.
 */
type DigestDoc = Omit<CanvasDoc, 'viewport'>

function buildHeader(boards: Board[]): string {
  const n = boards.length
  const by = (t: BoardType): number => boards.filter((b) => b.type === t).length
  const extras: [BoardType, string][] = [
    ['command', 'command'],
    ['file', 'file'],
    ['dataflow', 'dataflow'],
    ['kanban', 'kanban']
  ]
  const extraText = extras
    .map(([t, label]) => [by(t), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `, ${count} ${label}`)
    .join('')
  return (
    `${n} board${n === 1 ? '' : 's'} — ${by('terminal')} terminal, ${by('browser')} browser, ${by('planning')} planning` +
    extraText
  )
}

function digestTerminal(b: TerminalBoard, d: DigestDoc): BoardDigest {
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
function digestBrowser(b: BrowserBoard, d: DigestDoc): BoardDigest {
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
  const diagramCount = b.elements.filter((e) => e.kind === 'diagram').length
  const fileRefCount = b.elements.filter((e) => e.kind === 'fileref').length
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
  if (diagramCount > 0) lines.push(`${diagramCount} diagram${diagramCount === 1 ? '' : 's'}`)
  if (fileRefCount > 0) lines.push(`${fileRefCount} file reference${fileRefCount === 1 ? '' : 's'}`)
  if (lines.length === 0) lines.push('Empty board')
  const totalItems = checklists.reduce((s, c) => s + c.items.length, 0)
  const totalDone = checklists.reduce((s, c) => s + c.items.filter((i) => i.done).length, 0)
  const status = checklists.length > 0 ? `${totalDone}/${totalItems} done` : 'notes'
  return { boardId: b.id, type: 'planning', title: b.title, status, lines }
}

function digestFile(b: FileBoard): BoardDigest {
  const lines: string[] = b.path ? [`File ${b.path}`] : ['No file bound']
  if (b.readOnly) lines.push('Read-only')
  return {
    boardId: b.id,
    type: 'file',
    title: b.title,
    status: b.path ? 'bound' : 'unbound',
    lines
  }
}

function digestCommand(b: CommandBoard): BoardDigest {
  // The Command board persists no content (its task queue is ephemeral commandStore state), so the
  // Tier-1 digest is just its identity — the orchestrator face for feature-zone tasks.
  return {
    boardId: b.id,
    type: 'command',
    title: b.title,
    status: 'orchestrator',
    lines: ['Orchestrates feature-zone tasks (terminal + planning + browser groups)']
  }
}

function digestDataFlow(b: DataFlowBoard): BoardDigest {
  // The Data-Flow board persists no content (its inferred model is ephemeral dataFlowStore state),
  // so the Tier-1 digest is just its identity + the Browser board it analyzes.
  return {
    boardId: b.id,
    type: 'dataflow',
    title: b.title,
    status: b.sourceBoardId ? 'bound' : 'unbound',
    lines: [
      b.sourceBoardId
        ? 'Visualizes a Browser board’s captured API surface (endpoints · schemas · entities · lineage)'
        : 'Unbound — bind it to a Browser board to infer its API surface'
    ]
  }
}

function digestKanban(b: KanbanBoard): BoardDigest {
  // Content-bearing (like planning): one line per column with its card count (+ WIP limit when set),
  // so the reopen digest shows the plan's shape at a glance without any LLM/runtime state.
  const lines: string[] = []
  for (const col of b.columns) {
    const n = b.cards.filter((c) => c.columnId === col.id).length
    lines.push(`${col.title}: ${n}${col.wip !== undefined ? `/${col.wip}` : ''}`)
  }
  if (b.columns.length === 0) lines.push('Empty board')
  const total = b.cards.length
  return {
    boardId: b.id,
    type: 'kanban',
    title: b.title,
    status: `${total} card${total === 1 ? '' : 's'}`,
    lines
  }
}

function digestBoard(b: Board, d: DigestDoc): BoardDigest {
  switch (b.type) {
    case 'terminal':
      return digestTerminal(b, d)
    case 'browser':
      return digestBrowser(b, d)
    case 'planning':
      return digestPlanning(b)
    case 'command':
      return digestCommand(b)
    case 'file':
      return digestFile(b)
    case 'dataflow':
      return digestDataFlow(b)
    case 'kanban':
      return digestKanban(b)
  }
}

export function buildDigest(d: DigestDoc): CanvasDigest {
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
