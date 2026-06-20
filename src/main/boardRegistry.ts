import type { IpcMain, BrowserWindow, IpcMainEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/** Minimal board projection the renderer pushes to MAIN (control plane; no content). */
export interface BoardMirror {
  id: string
  type: string
  title: string
  /**
   * Coarse status bucket derived by the renderer from the live runtime stores
   * (T1.1). Absent when the renderer predates T1.1 (the adapter then falls back to
   * a PTY/presence-derived bucket). Validated against {@link STATUS_BUCKETS}.
   */
  status?: string
  /**
   * Terminal agent-preset id the human chose (schema v10 `agentKind`) — `'claude'`,
   * `'codex'`, … — so an orchestrator can route by capability. Open string, length-capped
   * like the other fields; absent on non-terminal boards and pre-v10 terminals.
   */
  agentKind?: string
  /**
   * Whether this terminal participates in activity monitoring (schema v10). Absent ⇒
   * monitored (opt-out, not opt-in). `false` keeps a plain shell out of the agent-facing
   * `canvas://attention` queue + its notifier (Phase B). Coerced to a strict boolean.
   */
  monitorActivity?: boolean
  /**
   * File board's project-relative path (file-tree S5; `type:'file'` only) — forwarded to the
   * agent-facing `canvas://boards` view so an agent knows WHICH file an open File board points
   * at. Length-capped like the other fields; absent on non-file / unbound boards. Path only,
   * never file CONTENT.
   */
  path?: string
  /**
   * Planning board's referenced files (file-tree S5; `type:'planning'` only) — the path + label
   * of each `fileref` element, so an agent can see the files a human pinned to a plan. Bounded
   * ({@link MAX_FILEREFS}) and length-capped per entry. Absent when none.
   */
  fileRefs?: FileRefMirror[]
}

/** A single agent-readable file reference on the board mirror (file-tree S5). Path only, no content. */
export interface FileRefMirror {
  path: string
  label: string
}

/**
 * A board↔board connector the renderer mirrors to MAIN (M2). Only `orchestration` edges
 * authorize dispatch (T4.6 relay_prompt); `preview` edges are the Browser→Terminal link.
 * Directional: `sourceId → targetId`. Mirror of `Connector` in `renderer/.../boardSchema.ts`.
 */
export interface ConnectorMirror {
  id: string
  sourceId: string
  targetId: string
  kind: 'preview' | 'orchestration'
}

/** Connector kinds a renderer may publish; an unrecognized kind is dropped. */
const CONNECTOR_KINDS: ReadonlySet<string> = new Set(['preview', 'orchestration'])

/**
 * A Named Board Group the renderer mirrors to MAIN (PR-5). A group is a user-named set of
 * boards (a "feature zone") — a board may belong to many groups; named-empty groups survive.
 * Mirror of `NamedGroup` in `renderer/.../boardSchema.ts`. Read-only on MAIN: the app-model's
 * `canvas.groups` projects this so the orchestrator/agent can reason about feature zones.
 */
export interface GroupMirror {
  id: string
  name: string
  boardIds: string[]
}

/**
 * The buckets a renderer is allowed to publish (mirror of `BoardStatusBucket` in
 * `renderer/src/store/boardStatus.ts`). `status` arrives over an IPC channel, so an
 * unrecognized value is dropped — never forwarded to agents as-is.
 */
const STATUS_BUCKETS: ReadonlySet<string> = new Set([
  'idle',
  'running',
  'awaiting-review',
  'blocked',
  'failed',
  'static'
])

/** A coarse per-board status change (M5). `status` is a STATUS_BUCKETS value, or 'gone'. */
export interface BoardStatusChange {
  id: string
  status: string
  /**
   * Mirror of {@link BoardMirror.monitorActivity} at the time of the change (Phase B). The
   * MCP attention notifier gates its push on `monitorActivity !== false`; carrying it on the
   * change lets the notifier decide membership without a second board lookup. Omitted on a
   * `'gone'` change (the board is leaving — its flag no longer matters).
   */
  monitorActivity?: boolean
}

/**
 * Pure differ: the per-board status changes between two snapshots (M5 event-driven attention).
 * Emits a change for any board whose known bucket changed or first appeared WITH a bucket, and a
 * `{ status: 'gone' }` for any id present before and now absent. A board newly appearing WITHOUT a
 * bucket is skipped (the renderer always buckets now; the bucketless fallback is legacy).
 * Inputs are sanitized mirrors (`sanitizeSnapshot` already dropped unknown buckets), so this does
 * no bucket re-validation — it just diffs.
 *
 * Phase B: also emits when only `monitorActivity` flipped (status unchanged) — so a mid-session
 * monitor opt-out/opt-in still drives the attention notifier's leave/enter — and carries the
 * current `monitorActivity` on every (non-`gone`) change.
 */
export function diffStatus(prev: BoardMirror[], next: BoardMirror[]): BoardStatusChange[] {
  const prevById = new Map(prev.map((b) => [b.id, b]))
  const nextIds = new Set(next.map((b) => b.id))
  const changes: BoardStatusChange[] = []
  for (const b of next) {
    if (b.status === undefined) continue
    const before = prevById.get(b.id)
    const statusChanged = b.status !== before?.status
    const monitorChanged = b.monitorActivity !== before?.monitorActivity
    if (statusChanged || monitorChanged) {
      changes.push({ id: b.id, status: b.status, monitorActivity: b.monitorActivity })
    }
  }
  for (const b of prev) {
    if (!nextIds.has(b.id)) changes.push({ id: b.id, status: 'gone' })
  }
  return changes
}

let mirror: BoardMirror[] = []
let connectorMirror: ConnectorMirror[] = []
let groupMirror: GroupMirror[] = []

/** Listeners notified on each per-board status change (M5 event-driven attention). */
const statusListeners = new Set<(change: BoardStatusChange) => void>()

function emitStatus(change: BoardStatusChange): void {
  for (const cb of statusListeners) {
    try {
      cb(change)
    } catch {
      // 🔒 Isolate a throwing listener so one bad subscriber can't break the push fan-out.
    }
  }
}

/** Replace the stored snapshot and emit the per-board status diffs (M5). Groups (PR-5) are
 *  metadata-only — stored, never diffed (no status transition rides on group membership). */
function applySnapshot(
  nextBoards: BoardMirror[],
  nextConnectors: ConnectorMirror[],
  nextGroups: GroupMirror[] = []
): void {
  const changes = diffStatus(mirror, nextBoards)
  mirror = nextBoards
  connectorMirror = nextConnectors
  groupMirror = nextGroups
  for (const c of changes) emitStatus(c)
}

/**
 * Subscribe to per-board status changes (M5). Returns an unsubscribe fn. The MCP adapter forwards
 * these so the handoff await-idle (and, in PR2, the barriers + canvas://attention notifier) wakes
 * on real board state instead of polling.
 * Note: a `'gone'` change is emitted for ANY board that left the canvas, including one that never
 * carried a known status bucket — treat `'gone'` as a presence signal, not a bucket transition.
 */
export function subscribeBoardStatus(listener: (change: BoardStatusChange) => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** Test seam — apply a snapshot through the diff/emit path (unit tests only). */
export function __applySnapshotForTest(
  boards: BoardMirror[],
  connectors: ConnectorMirror[] = [],
  groups: GroupMirror[] = []
): void {
  applySnapshot(boards, connectors, groups)
}

/** Test seam — clear all status listeners between tests (unit tests only). */
export function __clearStatusListenersForTest(): void {
  statusListeners.clear()
}

/** Bound the snapshot so a forged/oversized push on mcp:boards can't grow MAIN memory. */
const MAX_BOARDS = 500
const MAX_CONNECTORS = 1000
const MAX_GROUPS = 200
/** Cap a single group's membership so one forged group can't grow MAIN memory unbounded. */
const MAX_GROUP_MEMBERS = 500
/** Cap a single planning board's mirrored file references (file-tree S5) so a forged push can't grow MAIN memory. */
const MAX_FILEREFS = 500
const MAX_FIELD_LEN = 256

/**
 * Keep only well-formed {path,label} file references; drop anything else (file-tree S5). Bounded
 * like the other snapshot fields — mcp:boards is an IPC channel — at most MAX_FILEREFS entries,
 * each `path`/`label` at most MAX_FIELD_LEN chars (over-length / non-string entry dropped). Returns
 * `undefined` (not `[]`) when the input is not a non-empty array of valid refs, so the entry omits
 * the field rather than carrying an empty array.
 */
function sanitizeFileRefs(input: unknown): FileRefMirror[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: FileRefMirror[] = []
  for (const r of input) {
    if (out.length >= MAX_FILEREFS) break
    if (
      r &&
      typeof r === 'object' &&
      typeof (r as FileRefMirror).path === 'string' &&
      typeof (r as FileRefMirror).label === 'string'
    ) {
      const { path, label } = r as FileRefMirror
      if (path.length === 0 || path.length > MAX_FIELD_LEN || label.length > MAX_FIELD_LEN) continue
      out.push({ path, label })
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Keep only well-formed {id,type,title} string entries; drop anything else.
 * Bounded: at most MAX_BOARDS entries, each field at most MAX_FIELD_LEN chars —
 * the renderer is trusted, but mcp:boards is an IPC channel, so a malformed/oversized
 * payload is capped rather than retained wholesale. `type` is intentionally left an
 * open string (forward board types are allowed); an unrecognized type maps to status
 * 'unknown' downstream rather than being dropped.
 */
export function sanitizeSnapshot(input: unknown): BoardMirror[] {
  if (!Array.isArray(input)) return []
  const out: BoardMirror[] = []
  for (const b of input) {
    if (out.length >= MAX_BOARDS) break
    if (
      b &&
      typeof b === 'object' &&
      typeof (b as BoardMirror).id === 'string' &&
      typeof (b as BoardMirror).type === 'string' &&
      typeof (b as BoardMirror).title === 'string'
    ) {
      const { id, type, title, status, agentKind, monitorActivity, path, fileRefs } =
        b as BoardMirror
      if (
        id.length > MAX_FIELD_LEN ||
        type.length > MAX_FIELD_LEN ||
        title.length > MAX_FIELD_LEN
      ) {
        continue
      }
      const entry: BoardMirror = { id, type, title }
      // Attach status only when it is a known bucket; an invalid/absent value is
      // dropped so the adapter falls back rather than forwarding garbage.
      if (typeof status === 'string' && STATUS_BUCKETS.has(status)) entry.status = status
      // v10 agent identity (Phase B): agentKind is an open string, length-capped like the
      // others (over-length / non-string → field dropped, board kept — a forward preset id is
      // valid). monitorActivity is attached only as a strict boolean (anything else → absent,
      // which reads as monitored downstream — the safe default).
      if (typeof agentKind === 'string' && agentKind.length <= MAX_FIELD_LEN) {
        entry.agentKind = agentKind
      }
      if (typeof monitorActivity === 'boolean') entry.monitorActivity = monitorActivity
      // file-tree S5: file board path (length-capped string) + planning fileRefs (bounded list).
      // The renderer only sets these for the relevant board type, but mcp:boards is an IPC
      // channel, so validate/cap rather than trust — a bad value drops the field, keeps the board.
      if (typeof path === 'string' && path.length > 0 && path.length <= MAX_FIELD_LEN) {
        entry.path = path
      }
      const refs = sanitizeFileRefs(fileRefs)
      if (refs !== undefined) entry.fileRefs = refs
      out.push(entry)
    }
  }
  return out
}

/**
 * Keep only well-formed {id,sourceId,targetId,kind} connector entries; drop anything else.
 * Bounded like {@link sanitizeSnapshot} — mcp:boards is an IPC channel, so a malformed/
 * oversized payload is capped. An unrecognized `kind` is dropped (never forwarded).
 */
export function sanitizeConnectors(input: unknown): ConnectorMirror[] {
  if (!Array.isArray(input)) return []
  const out: ConnectorMirror[] = []
  for (const c of input) {
    if (out.length >= MAX_CONNECTORS) break
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as ConnectorMirror).id === 'string' &&
      typeof (c as ConnectorMirror).sourceId === 'string' &&
      typeof (c as ConnectorMirror).targetId === 'string' &&
      typeof (c as ConnectorMirror).kind === 'string' &&
      CONNECTOR_KINDS.has((c as ConnectorMirror).kind)
    ) {
      const { id, sourceId, targetId, kind } = c as ConnectorMirror
      if (
        id.length > MAX_FIELD_LEN ||
        sourceId.length > MAX_FIELD_LEN ||
        targetId.length > MAX_FIELD_LEN
      ) {
        continue
      }
      out.push({ id, sourceId, targetId, kind })
    }
  }
  return out
}

/**
 * Keep only well-formed {id,name,boardIds:string[]} group entries; drop anything else (PR-5).
 * Bounded like {@link sanitizeSnapshot} — mcp:boards is an IPC channel, so a malformed/oversized
 * payload is capped: at most MAX_GROUPS groups, MAX_FIELD_LEN per id/name, MAX_GROUP_MEMBERS
 * boardIds each (non-string / over-length members dropped). A board may belong to many groups, so
 * `boardIds` is NOT cross-validated against the live board set here — `name` is an open string.
 */
export function sanitizeGroups(input: unknown): GroupMirror[] {
  if (!Array.isArray(input)) return []
  const out: GroupMirror[] = []
  for (const g of input) {
    if (out.length >= MAX_GROUPS) break
    if (
      g &&
      typeof g === 'object' &&
      typeof (g as GroupMirror).id === 'string' &&
      typeof (g as GroupMirror).name === 'string' &&
      Array.isArray((g as GroupMirror).boardIds)
    ) {
      const { id, name, boardIds } = g as GroupMirror
      if (id.length > MAX_FIELD_LEN || name.length > MAX_FIELD_LEN) continue
      const members: string[] = []
      for (const bid of boardIds) {
        if (members.length >= MAX_GROUP_MEMBERS) break
        if (typeof bid === 'string' && bid.length <= MAX_FIELD_LEN) members.push(bid)
      }
      out.push({ id, name, boardIds: members })
    }
  }
  return out
}

/** Last snapshot the renderer pushed (empty until the renderer mounts + publishes). */
export function listBoardMirror(): BoardMirror[] {
  return mirror
}

/** Last connector snapshot the renderer pushed (orchestration + preview edges). */
export function listConnectors(): ConnectorMirror[] {
  return connectorMirror
}

/** Last Named Group snapshot the renderer pushed (PR-5; empty until the renderer publishes). */
export function listGroups(): GroupMirror[] {
  return groupMirror
}

/** Test seam — set the mirror directly (unit tests only). */
export function __setMirrorForTest(next: BoardMirror[]): void {
  mirror = next
}

/** Test seam — set the connector mirror directly (unit tests only). */
export function __setConnectorsForTest(next: ConnectorMirror[]): void {
  connectorMirror = next
}

/** Test seam — set the group mirror directly (unit tests only). */
export function __setGroupsForTest(next: GroupMirror[]): void {
  groupMirror = next
}

/**
 * Register the renderer→MAIN board-snapshot channel. Sender-guarded so only the
 * main window's main frame can publish (mirrors pty.ts's isForeignSender). The
 * snapshot is control-plane metadata only — never board content.
 *
 * Accepts either the legacy boards-only array OR the `{ boards, connectors, groups }` payload
 * (T4.6 added connectors; PR-5 added groups). An array → connectors + groups stay [].
 */
export function registerBoardRegistryHandler(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.on('mcp:boards', (e: IpcMainEvent, payload: unknown) => {
    // BUG-033: use the canonical isForeignSender (ipcGuard.ts) instead of the stale inline copy.
    // The inline copy failed OPEN when getWin() returned null (boot window before createWindow),
    // and threw "Object has been destroyed" on a destroyed-but-non-null window.
    if (isForeignSender(e, getWin)) return
    if (Array.isArray(payload)) {
      // Legacy / version-skew only: a renderer predating T4.6 sends a bare boards array.
      applySnapshot(sanitizeSnapshot(payload), [], [])
    } else if (payload && typeof payload === 'object') {
      const { boards, connectors, groups } = payload as {
        boards?: unknown
        connectors?: unknown
        groups?: unknown
      }
      applySnapshot(
        sanitizeSnapshot(boards),
        sanitizeConnectors(connectors),
        sanitizeGroups(groups)
      )
    }
  })
}
