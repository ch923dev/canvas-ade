/**
 * Workspace slice — the v24 Project Workspaces store actions (design: docs/research/
 * 2026-11-02-project-workspaces §4.1). Extracted from canvasStore via the DI seam (sliceTypes.ts).
 *
 * TWO HISTORY CLASSES (read before touching):
 *   - The workspace RECORDS (`workspaces`, `repoDefaults`) are SETTINGS-CLASS, like the backdrop:
 *     create / delete / rename / edit-goal never touch past/future. They will carry irreversible
 *     side effects once WS-4 lands (worktree add/remove), so an undo must never "un-create" one.
 *   - A board's MEMBERSHIP (`board.workspaceId`) lives on the board, so assign / unassign is a normal
 *     undoable step through `trackedChange` (the `reflectPresent: false` group-op contract).
 *   Delete straddles the two: the record leaves untracked, and its boards become project-level (O-8)
 *   on EVERY rail — present, past, future and any armed gesture checkpoint — so no undo or redo can
 *   resurrect a board pointing at a workspace that no longer exists.
 *
 * No worktree side effects here (WS-4 owns `workspace:create/delete` IPC); the store only keeps the
 * record. `trackedChange` + `lastRecorded` stay OWNED by canvasStore (sliceTypes contract).
 */
import type { Board } from '../../lib/boardSchema'
import {
  checkWorkspace,
  isWorkspaceNameTaken,
  type RepoDefaults,
  type Workspace,
  type WorkspaceWorktree
} from '../../lib/workspaceSchema'
import { sanitizeGroupName } from '../../../../shared/groupName'
import {
  nextWorkspaceColor,
  sanitizeWorkspaceGoal,
  type WorkspaceColor
} from '../../../../shared/workspaceRules'
import type { CanvasSnapshot } from '../canvasStore'
import type { GetCanvasState, SetCanvasState, SliceDeps } from './sliceTypes'

/** What a caller supplies to create a workspace. `id` is MAIN-minted once WS-4 lands; omitted ⇒ the
 *  store mints one. `color` omitted ⇒ the first token no other workspace uses. */
export interface WorkspaceInput {
  id?: string
  name: string
  goal?: string
  color?: WorkspaceColor
  root: string
  worktrees?: WorkspaceWorktree[]
}

/** The workspace state + actions canvasStore's `CanvasState` extends (the LayoutSliceState shape). */
export interface WorkspaceSliceState {
  /** v24 project workspaces. SETTINGS-CLASS — persisted, never on the undo rail. */
  workspaces: Workspace[]
  /** v24 (O-10) remembered base branch per repo root. SETTINGS-CLASS. */
  repoDefaults: RepoDefaults
  /** Create a workspace record (not undoable). Returns its id, or null when the input is invalid
   *  (blank name, a root outside the project, a bad worktree) or the name is already taken. */
  createWorkspace: (input: WorkspaceInput) => string | null
  /** Delete a workspace record (not undoable). Its boards stay, as project-level boards (O-8). */
  deleteWorkspace: (id: string) => void
  /** Rename (not undoable). False when the id is unknown, the name is blank, or it is taken. */
  renameWorkspace: (id: string, name: string) => boolean
  /** Edit the goal (not undoable). The raw text is normalized to one line of ≤ 200. */
  setWorkspaceGoal: (id: string, goal: string) => void
  /**
   * Assign boards to a workspace, or unassign them with `null` — ONE undoable step. A swarm board
   * brings its docked workers along (they always follow their host); a docked worker passed on its
   * own is ignored for the same reason. No-op for an unknown workspace or when nothing changes.
   */
  assignBoardsToWorkspace: (boardIds: string[], workspaceId: string | null) => void
}

/** The v24 fields a freshly-loaded doc seeds into the store (canvasStore.applyLoadedDoc). */
export function loadedWorkspaceState(d: {
  workspaces?: Workspace[]
  repoDefaults?: RepoDefaults
}): Pick<WorkspaceSliceState, 'workspaces' | 'repoDefaults'> {
  return { workspaces: d.workspaces ?? [], repoDefaults: d.repoDefaults ?? {} }
}

/** Clear every board's membership in `workspaceId`. Returns the SAME array when nothing referred
 *  (the applyBoardPatch no-change convention, so rail snapshots keep their refs). */
export function clearWorkspaceRefs(boards: Board[], workspaceId: string): Board[] {
  if (!boards.some((b) => b.workspaceId === workspaceId)) return boards
  return boards.map((b) => (b.workspaceId === workspaceId ? withoutWorkspace(b) : b))
}

/** A copy of `b` with no `workspaceId` key (absent, not `undefined` — the persisted shape). */
function withoutWorkspace(b: Board): Board {
  const next = { ...b }
  delete next.workspaceId
  return next
}

/** Rewrite `boards` in every snapshot of a rail; the SAME rail ref when no snapshot changed. */
function mapRail(rail: CanvasSnapshot[], apply: (b: Board[]) => Board[]): CanvasSnapshot[] {
  let changed = false
  const next = rail.map((snap) => {
    const boards = apply(snap.boards)
    if (boards === snap.boards) return snap
    changed = true
    return { ...snap, boards }
  })
  return changed ? next : rail
}

export function createWorkspaceSlice(
  set: SetCanvasState,
  get: GetCanvasState,
  deps: SliceDeps
): WorkspaceSliceState {
  const { trackedChange, newId } = deps

  const patchRecord = (id: string, change: Partial<Workspace>): void =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...change } : w)) }))

  return {
    workspaces: [],
    repoDefaults: {},

    createWorkspace: (input) => {
      const { workspaces } = get()
      const name = sanitizeGroupName(input.name)
      if (name === '' || isWorkspaceNameTaken(workspaces, name)) return null
      const id = input.id ?? newId()
      if (workspaces.some((w) => w.id === id)) return null
      // checkWorkspace is the load validator too, so the store can never write a record it would
      // refuse (or silently drop) on the next open.
      const v = checkWorkspace({
        id,
        name,
        goal: sanitizeWorkspaceGoal(input.goal ?? ''),
        color: input.color ?? nextWorkspaceColor(workspaces),
        root: input.root,
        ...(input.worktrees ? { worktrees: input.worktrees } : {})
      })
      if (!v.ok) return null
      set((s) => ({ workspaces: [...s.workspaces, v.workspace] }))
      return id
    },

    deleteWorkspace: (id) => {
      if (!get().workspaces.some((w) => w.id === id)) return
      const clear = (boards: Board[]): Board[] => clearWorkspaceRefs(boards, id)
      // An armed gesture checkpoint is consumed onto `past` later — rewrite it too, or the first
      // edit after this delete would record a snapshot that still points at the dead workspace.
      deps.rewritePendingBoards?.(clear)
      set((s) => ({
        workspaces: s.workspaces.filter((w) => w.id !== id),
        boards: clear(s.boards),
        past: mapRail(s.past, clear),
        future: mapRail(s.future, clear)
      }))
    },

    renameWorkspace: (id, raw) => {
      const name = sanitizeGroupName(raw)
      const w = get().workspaces.find((x) => x.id === id)
      if (!w || name === '' || isWorkspaceNameTaken(get().workspaces, name, id)) return false
      if (w.name !== name) patchRecord(id, { name })
      return true
    },

    setWorkspaceGoal: (id, raw) => {
      const goal = sanitizeWorkspaceGoal(raw)
      const w = get().workspaces.find((x) => x.id === id)
      if (w && w.goal !== goal) patchRecord(id, { goal })
    },

    assignBoardsToWorkspace: (boardIds, workspaceId) =>
      set((s) => {
        if (workspaceId !== null && !s.workspaces.some((w) => w.id === workspaceId)) return s
        const picked = new Set(boardIds)
        // A docked worker follows its host swarm board, never its own selection.
        const follows = (b: Board): boolean =>
          b.type === 'terminal' && b.dockedIn !== undefined
            ? picked.has(b.dockedIn)
            : picked.has(b.id)
        let changed = false
        const boards = s.boards.map((b) => {
          if (!follows(b) || b.workspaceId === (workspaceId ?? undefined)) return b
          changed = true
          return workspaceId !== null ? { ...b, workspaceId } : withoutWorkspace(b)
        })
        if (!changed) return s
        return trackedChange(s, { boards }, { reflectPresent: false })
      })
  }
}
