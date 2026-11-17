/**
 * WS-4 workspace lifecycle, renderer half (design §4.3). The dialogs collect the human's choices;
 * these helpers turn them into ONE ordered sequence against MAIN (`window.api.workspace`) and the
 * store, so the order that matters lives in one testable place:
 *
 *   create: MAIN allocates + stat-proves → only then the record is written → base remembered →
 *           starter boards placed → (ticked) the single dependency prompt is spent;
 *   delete: MAIN decides what happened on disk → only then the store drops / archives the record
 *           and keeps (project-level) or closes the boards (O-8).
 *
 * A record the store refuses after MAIN allocated is taken back (`abandon`, a clean-only removal),
 * so a failed create never leaves an orphan worktree under `.canvas/worktrees/`.
 */
import { useCanvasStore } from '../../store/canvasStore'
import { showToast } from '../../store/toastStore'
import { isWorkspaceNameTaken, type Workspace } from '../../lib/workspaceSchema'
import { AGENT_PRESETS } from '../boards/terminal/agentPresets'
import { sanitizeGroupName } from '../../../../shared/groupName'
import type { WorkspaceColor } from '../../../../shared/workspaceRules'
import type { WorkspaceGitMode, WorkspaceStatusResult } from '../../../../shared/workspaceIpcTypes'

export type WorkspaceApi = Window['api']['workspace']

/** How the base-branch dropdown was pre-filled (O-10). */
export interface BaseChoice {
  base: string
  /** `remembered` = from repoDefaults; `first` = no memory yet, confirm it; `fallback` = the
   *  remembered base no longer exists, so HEAD (the current branch) stands in. */
  kind: 'remembered' | 'first' | 'fallback'
  /** The remembered base that was not found (`fallback` only). */
  missing?: string
}

/** O-10 pre-fill: the remembered base when it still exists, else the repo's HEAD. */
export function pickBase(
  branches: { current: string | null; local: string[]; remote: string[] },
  remembered: string | undefined
): BaseChoice {
  const head = branches.current ?? 'HEAD'
  if (!remembered) return { base: head, kind: 'first' }
  const all = new Set(['HEAD', ...branches.local, ...branches.remote])
  return all.has(remembered)
    ? { base: remembered, kind: 'remembered' }
    : { base: head, kind: 'fallback', missing: remembered }
}

/** The starter terminal's launch line: one line, no control characters, bounded. */
export function sanitizeLaunch(raw: string): string {
  let s = ''
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0
    s += c <= 0x1f || c === 0x7f ? ' ' : ch
  }
  return s.replace(/ {2,}/g, ' ').trim().slice(0, 500)
}

/** The agent preset a launch line starts (its first word), for the board's `agentKind`. */
export function agentKindFor(launch: string): string | undefined {
  const bin = launch.trim().split(/\s+/)[0]
  return bin ? AGENT_PRESETS.find((p) => p.bin !== '' && p.bin === bin)?.id : undefined
}

export interface CreateWorkspaceInput {
  name: string
  goal: string
  color: WorkspaceColor
  /** Project-relative folder. */
  root: string
  mode: WorkspaceGitMode
  /** `worktree` mode. */
  base?: string
  /** `attach` mode. */
  branch?: string
  /** "Remember for this repo" (worktree mode). */
  remember: boolean
  /** "Ask the agent to install dependencies" (worktree modes). */
  deps: boolean
  terminal: boolean
  launchCommand: string
  browser: boolean
  /** World-space anchor for the starter boards. */
  at: { x: number; y: number }
}

export type CreateWorkspaceOutcome =
  | { ok: true; id: string; terminalId?: string; depsArmed: boolean }
  | { ok: false; reason: string }

/** Whether this input arms the dependency prompt: a git-backed workspace whose starter terminal
 *  runs an agent. A plain shell never gets the prompt — it would run it as a command. */
export function wantsDepsPrompt(input: CreateWorkspaceInput): boolean {
  return (
    input.mode !== 'folder' &&
    input.deps &&
    input.terminal &&
    sanitizeLaunch(input.launchCommand) !== ''
  )
}

export async function createWorkspaceFlow(
  input: CreateWorkspaceInput,
  api: WorkspaceApi = window.api.workspace
): Promise<CreateWorkspaceOutcome> {
  const name = sanitizeGroupName(input.name)
  if (!name) return { ok: false, reason: 'A workspace needs a name.' }
  if (isWorkspaceNameTaken(useCanvasStore.getState().workspaces, name)) {
    return { ok: false, reason: `A workspace named "${name}" already exists.` }
  }
  const launch = sanitizeLaunch(input.launchCommand)
  const depsArmed = wantsDepsPrompt(input)
  const res = await api.create({
    name,
    root: input.root,
    mode: input.mode,
    ...(input.mode === 'worktree' ? { base: input.base } : {}),
    ...(input.mode === 'attach' ? { branch: input.branch } : {}),
    deps: depsArmed
  })
  if (!res.ok) return res
  const store = useCanvasStore.getState()
  const id = store.createWorkspace({
    id: res.id,
    name,
    goal: input.goal,
    color: input.color,
    root: res.root,
    ...(res.worktree ? { worktrees: [res.worktree] } : {})
  })
  if (id === null) {
    if (res.worktree) await api.abandon(res.worktree.worktree).catch(() => undefined)
    return { ok: false, reason: 'The workspace could not be saved, so nothing was kept.' }
  }
  if (input.mode === 'worktree' && input.remember && res.worktree && input.base !== 'HEAD') {
    store.setRepoDefault(res.worktree.repoRoot, res.worktree.baseRef)
  }
  const kind = launch ? agentKindFor(launch) : undefined
  const { terminalId } = store.addWorkspaceStarters({
    workspaceId: id,
    at: input.at,
    ...(input.terminal
      ? {
          terminal: {
            cwd: res.cwd,
            ...(launch ? { launchCommand: launch } : {}),
            ...(kind ? { agentKind: kind } : {})
          }
        }
      : {}),
    browser: input.browser
  })
  const where = res.worktree
    ? ` · ${res.worktree.branch}${input.mode === 'worktree' ? ` off ${res.worktree.baseRef}` : ''}`
    : ''
  showToast({ message: `Workspace "${name}" created${where}` })
  if (depsArmed && terminalId) void sendDepsPrompt(api, id, terminalId)
  return { ok: true, id, ...(terminalId ? { terminalId } : {}), depsArmed }
}

/**
 * Spend the armed dependency prompt; the outcome is a toast (it lands after the agent boots). A
 * HELD prompt — the agent is asking its own first-run trust question, or never settled — stays
 * armed behind a sticky toast whose button is the human's "send it now" (`now`).
 */
export async function sendDepsPrompt(
  api: WorkspaceApi,
  workspaceId: string,
  terminalId: string,
  now = false
): Promise<void> {
  const r = await api.depsPrompt(workspaceId, terminalId, now).catch((err: unknown) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
    hold: undefined
  }))
  const id = `ws-deps-${workspaceId}`
  if (!r.ok && r.hold) {
    showToast({
      id,
      sticky: true,
      message:
        r.hold === 'trust-gate'
          ? 'The agent is asking whether to trust this new worktree. Answer it in the terminal, then send the dependency prompt.'
          : 'The agent has not settled yet. Send the dependency prompt once it is at its prompt.',
      action: {
        label: 'Send dependency prompt',
        run: () => void sendDepsPrompt(api, workspaceId, terminalId, true)
      }
    })
    return
  }
  showToast({
    id,
    ...(r.ok
      ? {
          message:
            r.delivery === 'ready'
              ? 'Asked the agent to install dependencies.'
              : 'Sent the dependency prompt — the agent had not confirmed it was ready, so check the terminal.'
        }
      : { message: `The dependency prompt was not sent: ${r.reason}`, kind: 'error' as const })
  })
}

/** `workspace:status`, retried while MAIN's mirror has not caught up with a just-made record. */
export async function statusWithRetry(
  api: WorkspaceApi,
  id: string,
  tries = 12
): Promise<WorkspaceStatusResult> {
  let r = await api.status(id)
  for (let i = 1; i < tries && !r.ok && r.reason === 'unknown-workspace'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    r = await api.status(id)
  }
  return r
}

/** The boards that belong to a workspace (docked swarm workers ride their host). */
export function boardIdsOf(workspaceId: string): string[] {
  return useCanvasStore
    .getState()
    .boards.filter((b) => b.workspaceId === workspaceId)
    .map((b) => b.id)
}

/** Apply a MAIN delete outcome to the store (O-8 board fate; archive keeps the record). */
export function finishDelete(
  ws: Workspace,
  outcome: 'record' | 'removed' | 'gone' | 'archived',
  closeBoards: boolean
): void {
  const store = useCanvasStore.getState()
  const ids = boardIdsOf(ws.id)
  if (closeBoards) for (const id of ids) useCanvasStore.getState().removeBoard(id)
  if (outcome === 'archived') {
    // The worktree stays on disk, so the record stays too (never an orphan under .canvas/worktrees);
    // the boards follow the human's Keep / Close choice exactly as for a full delete.
    if (!closeBoards) store.assignBoardsToWorkspace(ids, null)
    store.setWorkspaceArchived(ws.id, true)
    return
  }
  const wt = ws.worktrees?.[0]
  const dir = store.project.dir
  const gone = wt && dir && (outcome === 'removed' || outcome === 'gone')
  useCanvasStore
    .getState()
    .deleteWorkspace(ws.id, gone ? { cwdUnder: `${dir}/${wt.worktree}` } : undefined)
}
