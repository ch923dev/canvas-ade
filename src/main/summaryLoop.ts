/**
 * T-M3: the Tier-2 autonomous summary loop. A {boardId} change-intent (from the T-M2
 * detector) → re-read the board from disk → summarize its CONTENT via the budgeted
 * runSummarize → cache the prose into <project>/.canvas/memory/board-<id>.md + refresh
 * MEMORY.md/project.md. The FIRST autonomous-spend path in the app.
 *
 * 🔒 Opt-in (no key → no-provider → no spend / no write), capped (goes through the
 * budgeted runSummarize — no second egress), passive output (the summary is untrusted
 * passive context: written + later shown/MCP-read, it NEVER triggers an action). The key
 * never leaves MAIN / never lands in .canvas/.
 *
 * PROCESS-BOUNDARY NOTE: MAIN cannot import the renderer's boardSchema/digest.ts
 * (tsconfig.node = src/main/**), so the board content is picked here defensively from the
 * `unknown` doc, mirroring the fields digest.ts/memoryEngine.ts surface (terminal
 * launchCommand/cwd/port; browser url/viewport; planning checklist titles+items + note
 * text).
 */
import { runSummarize, defaultDeps, type FetchLike, type SummarizeInput } from './llmService'
import { readLlmConfig } from './llmConfig'
import { createKeyStore, type Encryptor } from './llmKeyStore'
import { createBudgetStore } from './llmBudget'
import { createCanvasMemory } from './canvasMemory'
import { projectName, type ProjectResult } from './projectStore'
import type { SummarizeIntent } from './memoryEngine'

/** Cap the board-content text fed to the model (canvas.json has no live scrollback). */
export const MAX_INPUT_CHARS = 4000

const SYSTEM =
  'Summarize what this board is for in 1-2 sentences. Be concise and factual; do not invent details.'

type RawBoard = { id?: unknown; type?: unknown; title?: unknown; [k: string]: unknown }

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

/** The meaningful, human-readable content slice of one board (mirrors digest.ts fields). */
function boardContent(b: RawBoard): string {
  const title = str(b.title)
  switch (b.type) {
    case 'terminal':
      return [
        `Terminal board "${title}".`,
        str(b.launchCommand) && `Runs: ${str(b.launchCommand)}`,
        str(b.cwd) && `cwd: ${str(b.cwd)}`,
        num(b.port) && `Dev server port: ${num(b.port)}`
      ]
        .filter(Boolean)
        .join('\n')
    case 'browser':
      return [
        `Browser preview board "${title}".`,
        str(b.url) && `URL: ${str(b.url)}`,
        str(b.viewport) && `Viewport: ${str(b.viewport)}`
      ]
        .filter(Boolean)
        .join('\n')
    case 'planning': {
      const els = Array.isArray(b.elements) ? (b.elements as RawBoard[]) : []
      const lines: string[] = [`Planning board "${title}".`]
      for (const e of els) {
        if (e.kind === 'checklist') {
          const items = Array.isArray(e.items) ? (e.items as RawBoard[]) : []
          lines.push(`Checklist "${str(e.title)}":`)
          for (const i of items) lines.push(`- [${i.done === true ? 'x' : ' '}] ${str(i.label)}`)
        } else if (e.kind === 'note') {
          lines.push(`Note: ${str(e.text)}`)
        }
      }
      return lines.join('\n')
    }
    default:
      return `Board "${title}" (${str(b.type) || 'unknown'}).`
  }
}

/** Pure: a board → a capped SummarizeInput. Never throws on malformed input. */
export function buildSummarizeInput(board: unknown): SummarizeInput {
  const b = (board ?? {}) as RawBoard
  const text = boardContent(b).slice(0, MAX_INPUT_CHARS)
  return { system: SYSTEM, text: text.length > 0 ? text : 'Empty board.' }
}

function boardsOf(doc: unknown): RawBoard[] {
  const boards = (doc as { boards?: unknown })?.boards
  return Array.isArray(boards) ? (boards as RawBoard[]) : []
}

/** Pure: rebuild MEMORY.md — one line per board, ` ✓` when a cached summary exists. */
export function buildMemoryIndex(doc: unknown, hasSummary: (id: string) => boolean): string {
  const lines = ['# Memory', '']
  for (const b of boardsOf(doc)) {
    const id = str(b.id)
    if (!id) continue
    const mark = hasSummary(id) ? ' ✓' : ''
    lines.push(
      `- ${str(b.title) || '(untitled)'} (${str(b.type) || 'unknown'}) — board-${id}.md${mark}`
    )
  }
  return lines.join('\n') + '\n'
}

/** Pure: a small project-level roll-up (header + board counts). */
export function buildProjectRollup(name: string, doc: unknown): string {
  const boards = boardsOf(doc)
  const by = (t: string): number => boards.filter((b) => b.type === t).length
  const n = boards.length
  return (
    `# ${name}\n\n` +
    `${n} board${n === 1 ? '' : 's'}: ` +
    `${by('terminal')} terminal, ${by('browser')} browser, ${by('planning')} planning\n`
  )
}

export interface SummaryLoopDeps {
  /** Where the file-backed key/budget stores live (userData; e2e temp dir). */
  llmDataDir: string
  /** safeStorage encryptor (real in prod; a fake in unit tests — unused on the mock path). */
  encryptor: Encryptor
  /** The current open project dir, or null. */
  getCurrentDir: () => string | null
  /** Read a project's doc from disk (post-save). */
  readProject: (dir: string) => ProjectResult
  /** Clock for the per-day budget (default new Date()). */
  now?: () => Date
  /** Transport (default global fetch); the mock seam short-circuits it under e2e. */
  fetch?: FetchLike
  /** Env override (default process.env); tests pass CANVAS_LLM_MOCK to force the mock. */
  env?: Record<string, string | undefined>
}

export interface SummaryLoop {
  /** Handle one detector intent: read → summarize → write. Best-effort; never throws. */
  onIntent(intent: SummarizeIntent): Promise<void>
}

export function createSummaryLoop(deps: SummaryLoopDeps): SummaryLoop {
  const inFlight = new Set<string>()
  const fetchImpl = deps.fetch ?? defaultDeps().fetch
  const env = deps.env ?? process.env
  const now = deps.now ?? ((): Date => new Date())

  return {
    async onIntent({ boardId }) {
      if (inFlight.has(boardId)) return // a slow call for this board is already running
      inFlight.add(boardId)
      try {
        const dir = deps.getCurrentDir()
        if (!dir) return
        const r = deps.readProject(dir)
        if (!r.ok) return
        const boards = (r.doc as { boards?: unknown })?.boards
        const board = Array.isArray(boards)
          ? (boards as { id?: unknown }[]).find((b) => b.id === boardId)
          : undefined
        if (!board) return // deleted between the debounce and the fire

        const config = readLlmConfig(deps.llmDataDir)
        const result = await runSummarize(config, buildSummarizeInput(board), {
          fetch: fetchImpl,
          env,
          keyStore: createKeyStore(deps.llmDataDir, deps.encryptor),
          budget: createBudgetStore(deps.llmDataDir, now)
        })
        if (!result.ok) return // no-provider / budget-exceeded / provider-error → Tier-1 stays

        const mem = createCanvasMemory(dir)
        mem.writeBoard(
          boardId,
          `# ${str((board as RawBoard).title) || boardId}\n\n${result.text}\n`
        )
        mem.writeIndex(buildMemoryIndex(r.doc, (id) => mem.readBoard(id) !== undefined))
        mem.writeProject(buildProjectRollup(projectName(dir), r.doc))
      } catch (err) {
        console.warn('[summaryLoop] onIntent failed (non-fatal)', err)
      } finally {
        inFlight.delete(boardId)
      }
    }
  }
}
