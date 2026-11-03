/**
 * Project Workspaces WS-8 — the LIVE STATUS half of each workspace's `CONTEXT.md` (design:
 * docs/research/2026-11-02-project-workspaces §4.5, O-6). MAIN owns it; the user owns the notes half.
 *
 * Deterministic: no LLM, no network — so, unlike `project.md`, no consent gate. Sources:
 *   - the workspace record (name, goal, branch, base) — the MAIN mirror (`listWorkspaces`);
 *   - files changed — the allocator's own-files `status` of a git-backed workspace's worktree;
 *   - in progress — Kanban cards not in the last column + open checklist items, on its boards;
 *   - agents — its terminal boards: Claude via the recap facts, any other CLI as running/exited only;
 *   - recent results — `recordBoardResult`, the last 5, kept in the file so they survive a restart.
 *
 * Writing it safely (§4.5):
 *   - at most one write per 5 s per workspace, and none when the text (minus the clock) is unchanged;
 *   - ONLY between the markers: re-read just before writing, splice, keep every other byte;
 *   - atomic (`write-file-atomic`), and the file's mtime/size is re-checked right before the write —
 *     changed ⇒ start over (a tiny window up to the rename remains; accepted and documented);
 *   - paused while the workspace's Brief board holds unsaved edits (`BoardMirror.unsaved`);
 *   - missing/broken markers ⇒ a fresh block at the top and the whole old text kept below as notes.
 *
 * The project roll-up (`_project/CONTEXT.md`) follows the same rules, one line per workspace.
 */
import { statSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { BoardResult } from '@expanse-ade/mcp'
import type { BoardMirror, WorkspaceMirror } from './boardRegistry'
import type { RecapFacts } from './recapFacts'
import {
  PROJECT_CONTEXT_ID,
  STATUS_END,
  STATUS_START,
  STATUS_START_PREFIX,
  contextRelPath,
  effectiveRootAbs,
  ensureScaffold
} from './workspaceContext'

/** At most one status write per workspace per this window (§6: ≤ 5 s). */
export const STATUS_INTERVAL_MS = 5_000
/** How many results the file keeps (§6). */
export const RECENT_RESULTS_MAX = 5
/** First-event coalesce: a burst of mirror pushes becomes one refresh. */
const COALESCE_MS = 250
/** Cap on the in-progress and agent lists, so a huge board can't grow the file without bound. */
const LIST_MAX = 12
/** Cap on one interpolated label (a card title, a board title, a recap ask). */
const LABEL_MAX = 120
/** Re-read attempts when the file changes under us between the read and the write. */
const WRITE_ATTEMPTS = 3

const STAMP_RE = /^_Live status, .*_$/m

// ── Pure: rendering + splicing ─────────────────────────────────────────────────────────────────

/** `HH:MM` in local time. */
export function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * One line of user/agent-authored text, safe inside the block: control characters → spaces, no HTML
 * comment delimiters (a card titled `<!-- expanse:status:end -->` must not end the block early),
 * whitespace collapsed, capped.
 */
export function oneLine(raw: string, max = LABEL_MAX): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  let s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  s = s
    .replace(/<!--|-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

export interface StatusAgentLine {
  title: string
  /** `busy` / `waiting on you` / `idle` / `exited` (Claude) — `running` / `exited` (other CLIs). */
  state: string
  /** Claude only: the session title or the last ask. */
  detail?: string
  /** Claude only: TodoWrite progress. */
  todos?: { done: number; total: number }
}

export interface WorkspaceStatusInput {
  name: string
  goal: string
  /** Git-backed: branch, its base, and the own-files change count (`null` = unknown). */
  git?: { branch: string; baseRef: string; changed: number | null }
  /** Folder-only: the project-relative root. */
  folder?: string
  inProgress: string[]
  agents: StatusAgentLine[]
  /** Pre-formatted result lines, newest first. */
  results: string[]
  updatedAt: number
}

function capped(lines: string[], empty: string): string[] {
  if (lines.length === 0) return [`- ${empty}`]
  const shown = lines.slice(0, LIST_MAX)
  return lines.length > LIST_MAX ? [...shown, `- … and ${lines.length - LIST_MAX} more`] : shown
}

/** The whole status block for one workspace, markers included. */
export function renderWorkspaceStatus(i: WorkspaceStatusInput): string {
  const name = oneLine(i.name)
  const goal = oneLine(i.goal, 200)
  const where = i.git
    ? `Branch: ${oneLine(i.git.branch)} off ${oneLine(i.git.baseRef)}` +
      (i.git.changed === null
        ? ''
        : ` · ${i.git.changed} file${i.git.changed === 1 ? '' : 's'} changed`)
    : `Folder: ${i.folder === '.' || !i.folder ? 'the project folder' : oneLine(i.folder)}`
  const agents = i.agents.map((a) => {
    let line = `- ${oneLine(a.title)}  ${a.state}`
    if (a.detail) line += `  "${oneLine(a.detail, 80)}"`
    if (a.todos && a.todos.total > 0) line += `  · plan ${a.todos.done}/${a.todos.total}`
    return line
  })
  return [
    STATUS_START,
    `# ${goal ? `${name} — ${goal}` : name}`,
    `_Live status, updated by Expanse ${hhmm(i.updatedAt)}_`,
    '',
    `Goal: ${goal || '(none set)'}`,
    where,
    '',
    '## In progress',
    ...capped(i.inProgress, 'nothing in progress'),
    '',
    '## Agents',
    ...capped(agents, 'no terminals'),
    '',
    '## Recent results',
    ...(i.results.length > 0 ? i.results.slice(0, RECENT_RESULTS_MAX) : ['- none yet']),
    STATUS_END
  ].join('\n')
}

export interface ProjectRollupLine {
  name: string
  goal: string
  where: string
  inProgress: number
  busy: number
}

/** The project roll-up block: one line per workspace. */
export function renderProjectStatus(
  projectName: string,
  rows: ProjectRollupLine[],
  updatedAt: number
): string {
  const lines = rows.map((r) => {
    const goal = oneLine(r.goal, 200)
    return (
      `- **${oneLine(r.name)}**${goal ? ` — ${goal}` : ''} · ${r.where} · ` +
      `${r.inProgress} in progress · ${r.busy} busy agent${r.busy === 1 ? '' : 's'}`
    )
  })
  return [
    STATUS_START,
    `# ${oneLine(projectName)} — workspaces`,
    `_Live status, updated by Expanse ${hhmm(updatedAt)}_`,
    '',
    '## Workspaces',
    ...capped(lines, 'no workspaces'),
    STATUS_END
  ].join('\n')
}

/** The current status block in `text` (markers included), or `null` when the markers are missing/broken. */
export function extractStatusBlock(text: string): string | null {
  const start = text.indexOf(STATUS_START_PREFIX)
  if (start < 0) return null
  const end = text.indexOf(STATUS_END, start)
  return end < 0 ? null : text.slice(start, end + STATUS_END.length)
}

/**
 * Swap the status block in `text` for `block`, keeping every byte outside it. With missing or broken
 * markers the block goes on top and the WHOLE old text stays below it, as notes — user text is never
 * dropped.
 */
export function spliceStatus(text: string, block: string): string {
  const start = text.indexOf(STATUS_START_PREFIX)
  const end = start < 0 ? -1 : text.indexOf(STATUS_END, start)
  if (start >= 0 && end >= 0) {
    return text.slice(0, start) + block + text.slice(end + STATUS_END.length)
  }
  return text.length === 0 ? `${block}\n` : `${block}\n\n${text}`
}

/** A block minus its clock line — what "unchanged" is decided on. */
export function withoutStamp(block: string): string {
  return block.replace(STAMP_RE, '')
}

/** The result lines a previous run left in `block` (newest first), to seed the ring after a restart. */
export function parseRecentResults(block: string | null): string[] {
  if (!block) return []
  const at = block.indexOf('\n## Recent results\n')
  if (at < 0) return []
  return block
    .slice(at + '\n## Recent results\n'.length)
    .split('\n')
    .filter((l) => l.startsWith('- ') && l !== '- none yet')
    .slice(0, RECENT_RESULTS_MAX)
}

/** One result as a status line: `- HH:MM <board> · <status> — <summary>`. */
export function formatResultLine(boardTitle: string, r: BoardResult, now: number): string {
  const at = r.at ? Date.parse(r.at) : NaN
  const verdict = oneLine(r.status ?? 'result', 40)
  const summary = r.summary ? oneLine(r.summary.split('\n')[0] ?? '') : ''
  return `- ${hhmm(Number.isFinite(at) ? at : now)} ${oneLine(boardTitle, 60)} · ${verdict}${summary ? ` — ${summary}` : ''}`
}

// ── Pure: what the status says ─────────────────────────────────────────────────────────────────

/** Kanban cards not in the last column + open checklist items, on `boards`. */
export function inProgressLines(boards: readonly BoardMirror[]): string[] {
  const out: string[] = []
  for (const b of boards) {
    const cols = b.kanban?.columns ?? []
    // A 'category' board's columns are buckets, not stages: no column there means "done".
    if (b.kanban && cols.length > 0 && b.kanban.columnAxis !== 'category') {
      const last = cols[cols.length - 1].id
      const titleOf = new Map(cols.map((c) => [c.id, c.title]))
      for (const card of b.kanban.cards) {
        if (card.columnId === last || !titleOf.has(card.columnId)) continue
        out.push(
          `- [ ] ${oneLine(card.title)}   (Kanban: ${oneLine(titleOf.get(card.columnId)!, 40)})`
        )
      }
    }
    for (const el of b.planning?.elements ?? []) {
      if (el.kind !== 'checklist') continue
      for (const item of el.items ?? []) {
        if (!item.done) out.push(`- [ ] ${oneLine(item.label)}   (checklist)`)
      }
    }
  }
  return out
}

const CLAUDE_STATE: Record<string, string> = {
  spawning: 'busy',
  running: 'busy',
  'waiting-on-you': 'waiting on you',
  idle: 'idle',
  exited: 'exited',
  'spawn-failed': 'exited'
}

/** One line per terminal board: Claude from its recap facts, any other CLI running/exited only. */
export function agentLines(
  boards: readonly BoardMirror[],
  factsFor: (boardId: string) => RecapFacts | null
): StatusAgentLine[] {
  const out: StatusAgentLine[] = []
  for (const b of boards) {
    if (b.type !== 'terminal') continue
    const facts = factsFor(b.id)
    if (facts) {
      out.push({
        title: b.title,
        state: CLAUDE_STATE[facts.status] ?? facts.status,
        detail: facts.title ?? facts.lastAsk,
        todos: facts.todos ? { done: facts.todos.done, total: facts.todos.total } : undefined
      })
    } else {
      out.push({ title: b.title, state: b.status === 'running' ? 'running' : 'exited' })
    }
  }
  return out
}

/** Agents that count as busy in the roll-up: a Claude mid-turn, or any other CLI still running. */
function busyCount(agents: readonly StatusAgentLine[]): number {
  return agents.filter((a) => a.state === 'busy' || a.state === 'running').length
}

// ── The writer ─────────────────────────────────────────────────────────────────────────────────

export interface WorkspaceStatusDeps {
  getProjectDir: () => string | null
  listWorkspaces: () => WorkspaceMirror[]
  listBoards: () => BoardMirror[]
  /** Claude recap facts for a terminal board, or null (no transcript / not Claude). */
  recapFacts: (boardId: string) => RecapFacts | null
  /** Own-files change count of a worktree (the allocator's `status`); null when unknown. */
  changedFiles: (worktreeAbs: string) => Promise<number | null>
  /** After a write: tell the renderer the file changed (its Brief reloads if it has no edits). */
  onWritten?: (relPath: string) => void
  now?: () => number
  intervalMs?: number
  /** Test seam: runs between the read and the pre-write mtime check. */
  beforeCommit?: (file: string) => void
}

export interface WorkspaceStatusWriter {
  /** Something in the mirror changed: refresh every workspace (each throttled on its own). */
  scheduleAll(): void
  /** Refresh the workspace `boardId` belongs to (recap settle). */
  scheduleForBoard(boardId: string): void
  /** A board recorded a result: remember it (last 5) and refresh its workspace. */
  onResult(boardId: string, result: BoardResult): void
  /** Run one refresh now, ignoring the throttle (tests; returns whether the file was written). */
  refreshNow(workspaceId: string): Promise<boolean>
  /** Project switch / quit: drop timers and per-workspace memory. */
  reset(): void
}

interface WsState {
  timer: ReturnType<typeof setTimeout> | null
  lastRun: number
  running: boolean
  rerun: boolean
  results: string[] | null
}

export function createWorkspaceStatusWriter(deps: WorkspaceStatusDeps): WorkspaceStatusWriter {
  const now = deps.now ?? Date.now
  const interval = deps.intervalMs ?? STATUS_INTERVAL_MS
  const states = new Map<string, WsState>()

  const stateOf = (id: string): WsState => {
    let st = states.get(id)
    if (!st) {
      st = { timer: null, lastRun: -Infinity, running: false, rerun: false, results: null }
      states.set(id, st)
    }
    return st
  }

  /** The Brief for `id` holds unsaved edits ⇒ hold off (the human's buffer wins). */
  const briefUnsaved = (id: string): boolean => {
    const rel = contextRelPath(id)
    return deps.listBoards().some((b) => b.type === 'file' && b.path === rel && b.unsaved === true)
  }

  /** Splice `block` into `file`; false when unchanged, paused-by-race, or out of attempts. */
  const commit = (file: string, block: string): boolean => {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const before = statSync(file)
      const text = readFileSync(file, 'utf8')
      const current = extractStatusBlock(text)
      if (current !== null && withoutStamp(current) === withoutStamp(block)) return false
      const next = spliceStatus(text, block)
      deps.beforeCommit?.(file)
      const after = statSync(file)
      if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) continue // start over
      writeFileAtomic.sync(file, next, 'utf8')
      return true
    }
    return false
  }

  /** Seed the results ring from the file once per session, so the last 5 survive a restart. */
  const resultsOf = (projectDir: string, ws: { id: string; name: string }): string[] => {
    const st = stateOf(ws.id)
    if (st.results === null) {
      let block: string | null = null
      const file = ensureScaffold(projectDir, ws)
      if (file) {
        try {
          block = extractStatusBlock(readFileSync(file, 'utf8'))
        } catch {
          block = null
        }
      }
      st.results = parseRecentResults(block)
    }
    return st.results
  }

  const collect = async (
    projectDir: string,
    ws: WorkspaceMirror,
    members: BoardMirror[]
  ): Promise<WorkspaceStatusInput> => {
    const wt = ws.worktrees?.[0]
    let git: WorkspaceStatusInput['git']
    if (wt) {
      let changed: number | null = null
      try {
        changed = await deps.changedFiles(effectiveRootAbs(projectDir, ws))
      } catch {
        changed = null
      }
      git = { branch: wt.branch, baseRef: wt.baseRef, changed }
    }
    return {
      name: ws.name,
      goal: ws.goal,
      git,
      folder: wt ? undefined : ws.root,
      inProgress: inProgressLines(members),
      agents: agentLines(members, deps.recapFacts),
      results: resultsOf(projectDir, ws),
      updatedAt: now()
    }
  }

  const write = (projectDir: string, id: string, name: string, block: string): boolean => {
    const file = ensureScaffold(projectDir, { id, name })
    if (!file) return false
    const wrote = commit(file, block)
    if (wrote) deps.onWritten?.(contextRelPath(id))
    return wrote
  }

  const refreshProject = (projectDir: string): boolean => {
    if (briefUnsaved(PROJECT_CONTEXT_ID)) return false
    const boards = deps.listBoards()
    const rows = deps
      .listWorkspaces()
      .filter((w) => w.state !== 'archived')
      .map((w) => {
        const members = boards.filter((b) => b.workspaceId === w.id)
        const wt = w.worktrees?.[0]
        return {
          name: w.name,
          goal: w.goal,
          where: wt
            ? oneLine(wt.branch)
            : `folder ${w.root === '.' ? '(project)' : oneLine(w.root)}`,
          inProgress: inProgressLines(members).length,
          busy: busyCount(agentLines(members, deps.recapFacts))
        }
      })
    const block = renderProjectStatus(basename(projectDir), rows, now())
    return write(projectDir, PROJECT_CONTEXT_ID, basename(projectDir), block)
  }

  const refresh = async (id: string): Promise<boolean> => {
    const projectDir = deps.getProjectDir()
    if (!projectDir) return false
    if (id === PROJECT_CONTEXT_ID) return refreshProject(projectDir)
    const ws = deps.listWorkspaces().find((w) => w.id === id)
    if (!ws || ws.state === 'archived') return false
    if (briefUnsaved(id)) {
      schedule(id, interval) // paused: look again later; the save also re-publishes the mirror
      return false
    }
    const members = deps.listBoards().filter((b) => b.workspaceId === id)
    const input = await collect(projectDir, ws, members)
    if (deps.getProjectDir() !== projectDir) return false // project switched while git ran
    const wrote = write(projectDir, ws.id, ws.name, renderWorkspaceStatus(input))
    schedule(PROJECT_CONTEXT_ID)
    return wrote
  }

  const run = async (id: string): Promise<void> => {
    const st = stateOf(id)
    if (st.running) {
      st.rerun = true
      return
    }
    st.running = true
    st.lastRun = now()
    try {
      await refresh(id)
    } catch (err) {
      console.warn('[workspaceStatus] refresh failed (non-fatal)', err)
    } finally {
      st.running = false
      if (st.rerun) {
        st.rerun = false
        schedule(id)
      }
    }
  }

  function schedule(id: string, minWait = COALESCE_MS): void {
    const st = stateOf(id)
    if (st.timer) return
    const wait = Math.max(minWait, st.lastRun + interval - now())
    st.timer = setTimeout(() => {
      st.timer = null
      void run(id)
    }, wait)
  }

  const workspaceOf = (boardId: string): string | undefined => {
    const wsId = deps.listBoards().find((b) => b.id === boardId)?.workspaceId
    return wsId && deps.listWorkspaces().some((w) => w.id === wsId) ? wsId : undefined
  }

  return {
    scheduleAll() {
      if (!deps.getProjectDir()) return
      const live = deps.listWorkspaces().filter((w) => w.state !== 'archived')
      for (const w of live) schedule(w.id)
      if (live.length > 0) schedule(PROJECT_CONTEXT_ID)
    },
    scheduleForBoard(boardId) {
      const id = workspaceOf(boardId)
      if (id) schedule(id)
    },
    onResult(boardId, result) {
      if (!result.present) return
      const id = workspaceOf(boardId)
      const projectDir = deps.getProjectDir()
      if (!id || !projectDir) return
      const ws = deps.listWorkspaces().find((w) => w.id === id)!
      const title = deps.listBoards().find((b) => b.id === boardId)?.title ?? boardId
      const st = stateOf(id)
      st.results = [formatResultLine(title, result, now()), ...resultsOf(projectDir, ws)].slice(
        0,
        RECENT_RESULTS_MAX
      )
      schedule(id)
    },
    refreshNow: (id) => refresh(id),
    reset() {
      for (const st of states.values()) if (st.timer) clearTimeout(st.timer)
      states.clear()
    }
  }
}
